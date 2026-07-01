// Provider-agnostic LLM plumbing, shared by every feature that can upgrade
// from rule-based to LLM-generated output (research briefs, sector scout,
// discovery rationale, thesis claims, event extraction). Keeping it here —
// not inside a feature module — keeps the dependency graph clean: features
// import the provider, never each other.
//
// All output is labelled model-generated interpretation — never presented as
// fact — and every caller keeps a deterministic rule-based fallback.

export interface LLMProvider {
  name: string;
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  constructor(
    private apiKey: string,
    private model = process.env.LLM_MODEL || "claude-sonnet-4-6",
  ) {}

  async complete(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
}

/**
 * Configured provider, or null for the rule-based fallback. Pass `model` to
 * override the default (e.g. the cheap extraction model for batched calls).
 */
export function getProvider(model?: string): LLMProvider | null {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, model);
  }
  return null;
}

/**
 * First JSON object/array in a raw LLM response, parsed — or null when absent
 * or invalid, so callers can fall back to rules. Pure; no IO.
 */
export function extractJson<T>(raw: string, shape: "object" | "array" = "object"): T | null {
  const match = raw.match(shape === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/)?.[0];
  if (!match) return null;
  try {
    return JSON.parse(match) as T;
  } catch {
    return null;
  }
}

/**
 * complete() + extractJson() in one step. Returns null on any failure — API
 * error, no JSON in the response, unparseable JSON — so every caller degrades
 * to its rule-based path with a single `?? fallback`.
 */
export async function completeJson<T>(
  provider: LLMProvider,
  prompt: string,
  opts: { maxTokens?: number; shape?: "object" | "array" } = {},
): Promise<T | null> {
  try {
    const raw = await provider.complete(prompt, { maxTokens: opts.maxTokens });
    return extractJson<T>(raw, opts.shape ?? "object");
  } catch {
    return null;
  }
}

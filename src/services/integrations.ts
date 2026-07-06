// Which optional integrations are configured (env-derived, server-only).
// Single source for the checks re-rolled across /status, the settings API,
// and page-level "is Alpaca connected" gates. Only booleans/modes ever leave
// this module — never the secrets themselves.

export interface IntegrationsStatus {
  alpacaConfigured: boolean;
  alpacaMode: "paper" | "live";
  llmConfigured: boolean;
  llmProvider: string;
}

export function integrationsStatus(): IntegrationsStatus {
  return {
    alpacaConfigured: Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET),
    alpacaMode: process.env.ALPACA_MODE === "live" ? "live" : "paper",
    llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    llmProvider: process.env.LLM_PROVIDER ?? "anthropic",
  };
}

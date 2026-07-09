// Position sizing and trade risk math. Pure functions, fully tested.

export interface PositionSizeInput {
  accountValue: number;
  riskPerTradePercent: number; // e.g. 1 = risk 1% of account
  entryPrice: number;
  stopLoss: number;
  maxPositionWeightPercent?: number; // cap position value as % of account
}

export interface PositionSizeResult {
  shares: number;
  positionValue: number;
  maxLossIfStopped: number;
  riskPerShare: number;
  cappedByConcentration: boolean;
  warnings: string[];
}

export function suggestPositionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    accountValue,
    riskPerTradePercent,
    entryPrice,
    stopLoss,
    maxPositionWeightPercent = 20,
  } = input;
  const warnings: string[] = [];

  const riskPerShare = Math.abs(entryPrice - stopLoss);
  if (riskPerShare <= 0 || !isFinite(riskPerShare)) {
    return {
      shares: 0,
      positionValue: 0,
      maxLossIfStopped: 0,
      riskPerShare: 0,
      cappedByConcentration: false,
      warnings: ["Stop-loss equals entry — cannot size the position."],
    };
  }
  if (entryPrice <= 0 || accountValue <= 0) {
    return {
      shares: 0,
      positionValue: 0,
      maxLossIfStopped: 0,
      riskPerShare,
      cappedByConcentration: false,
      warnings: ["Invalid entry price or account value."],
    };
  }

  const riskBudget = accountValue * (riskPerTradePercent / 100);
  let shares = Math.floor(riskBudget / riskPerShare);

  const maxPositionValue = accountValue * (maxPositionWeightPercent / 100);
  let capped = false;
  if (shares * entryPrice > maxPositionValue) {
    shares = Math.floor(maxPositionValue / entryPrice);
    capped = true;
    warnings.push(
      `Position capped at ${maxPositionWeightPercent}% of account (concentration limit).`,
    );
  }
  if (shares === 0) {
    warnings.push("Risk budget too small for even one share at this stop distance.");
  }
  const stopDistancePct = (riskPerShare / entryPrice) * 100;
  if (stopDistancePct > 15) {
    warnings.push(
      `Stop is ${stopDistancePct.toFixed(0)}% away — wide stop, small size. Consider a tighter setup.`,
    );
  }

  return {
    shares,
    positionValue: shares * entryPrice,
    maxLossIfStopped: shares * riskPerShare,
    riskPerShare,
    cappedByConcentration: capped,
    warnings,
  };
}

export function riskRewardRatio(
  entry: number,
  stop: number,
  target: number,
  direction: "long" | "short" = "long",
): number | null {
  const risk = direction === "long" ? entry - stop : stop - entry;
  const reward = direction === "long" ? target - entry : entry - target;
  if (risk <= 0 || !isFinite(risk)) return null;
  if (reward <= 0) return 0;
  return reward / risk;
}

export interface ConcentrationInput {
  positions: { ticker: string; value: number; sector?: string | null }[];
  accountValue: number;
  maxPositionWeightPercent: number;
  maxSectorWeightPercent: number;
}

export function concentrationWarnings(input: ConcentrationInput): string[] {
  const { positions, accountValue, maxPositionWeightPercent, maxSectorWeightPercent } = input;
  const warnings: string[] = [];
  if (accountValue <= 0) return warnings;

  for (const p of positions) {
    const weight = (p.value / accountValue) * 100;
    if (weight > maxPositionWeightPercent) {
      warnings.push(
        `${p.ticker} is ${weight.toFixed(0)}% of the account (cap ${maxPositionWeightPercent}%).`,
      );
    }
  }
  const sectorTotals = new Map<string, number>();
  for (const p of positions) {
    if (!p.sector) continue;
    sectorTotals.set(p.sector, (sectorTotals.get(p.sector) ?? 0) + p.value);
  }
  for (const [sector, value] of sectorTotals) {
    const weight = (value / accountValue) * 100;
    if (weight > maxSectorWeightPercent) {
      warnings.push(
        `${sector} sector is ${weight.toFixed(0)}% of the account (cap ${maxSectorWeightPercent}%).`,
      );
    }
  }
  return warnings;
}

/** Validate a proposed trade against risk rules. Returns blocking problems. */
export function validateProposedTrade(input: {
  entry: number;
  stop: number | null;
  target: number | null;
  direction?: "long" | "short";
  minRiskReward: number;
  daysToEarnings?: number | null;
  avoidEarningsWithinDays: number;
}): string[] {
  const problems: string[] = [];
  if (input.stop == null) {
    problems.push("No clear stop-loss — avoid trades without a defined exit.");
  }
  if (input.target == null) {
    problems.push("No target defined — risk/reward cannot be evaluated.");
  }
  if (input.stop != null && input.target != null) {
    const rr = riskRewardRatio(input.entry, input.stop, input.target, input.direction ?? "long");
    if (rr == null) {
      problems.push("Stop is on the wrong side of entry.");
    } else if (rr < input.minRiskReward) {
      problems.push(
        `Risk/reward ${rr.toFixed(1)}:1 is below your ${input.minRiskReward}:1 minimum.`,
      );
    }
  }
  if (
    input.avoidEarningsWithinDays > 0 &&
    input.daysToEarnings != null &&
    input.daysToEarnings >= 0 &&
    input.daysToEarnings <= input.avoidEarningsWithinDays
  ) {
    problems.push(`Earnings in ${input.daysToEarnings} day(s) — inside your avoid window.`);
  }
  return problems;
}

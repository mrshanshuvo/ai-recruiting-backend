/**
 * Dynamic AI Token Inference Pricing Configuration (Decision DEC-18 / ADR-0015)
 *
 * Provides a standardized per-model cost table per 1M input/output tokens.
 *
 * NOTE ON FREE TIER USAGE:
 * In reality, Google AI Studio / Gemini free-tier usage incurs $0.00 USD out-of-pocket costs.
 * The dollar figures calculated here and shown across dashboards and chat cards represent
 * standard enterprise API rate estimates for capacity planning and inference cost visibility.
 * All cost metrics are explicitly labeled as "Estimated Cost".
 */

export interface ModelPricing {
  promptCostPer1M: number;
  completionCostPer1M: number;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  // Gemini 3.1 Flash-Lite (Primary high-throughput model)
  'gemini-3.1-flash-lite': {
    promptCostPer1M: 0.075,
    completionCostPer1M: 0.30,
  },
  // Gemini 3.7 Flash (Fallback / Advanced Reasoning)
  'gemini-3.7-flash': {
    promptCostPer1M: 0.15,
    completionCostPer1M: 0.60,
  },
  // Gemini 2.0 Flash Lite
  'gemini-2.0-flash-lite': {
    promptCostPer1M: 0.075,
    completionCostPer1M: 0.30,
  },
  // Gemini 2.0 Flash
  'gemini-2.0-flash': {
    promptCostPer1M: 0.10,
    completionCostPer1M: 0.40,
  },
  // Gemini 1.5 Pro
  'gemini-1.5-pro': {
    promptCostPer1M: 1.25,
    completionCostPer1M: 5.00,
  },
};

export const DEFAULT_MODEL_PRICING: ModelPricing = {
  promptCostPer1M: 0.075,
  completionCostPer1M: 0.30,
};

/**
 * Calculates estimated cost in USD based on model pricing table.
 */
export function calculateEstimatedCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = MODEL_PRICING_TABLE[model] || DEFAULT_MODEL_PRICING;
  const cost =
    (promptTokens * pricing.promptCostPer1M + completionTokens * pricing.completionCostPer1M) /
    1000000;
  return Number(cost.toFixed(6));
}


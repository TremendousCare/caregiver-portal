// Per-model token pricing for the agent metrics dashboard.
//
// Anthropic published prices, $ per 1 million tokens. Hardcoded today
// because prices change quarterly at most. Future work: surface this as
// an `app_settings.model_prices` JSONB row editable from Settings UI so
// finance can update without a deploy.
//
// Last updated: 2026-05-12 by Phase 1.4.

const PRICING_USD_PER_1M = {
  // Sonnet family
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':          { input: 3.00, output: 15.00 },
  'claude-sonnet-4-7':          { input: 3.00, output: 15.00 },

  // Haiku family
  'claude-haiku-4-5-20251001':  { input: 1.00, output: 5.00 },
  'claude-haiku-4-5':           { input: 1.00, output: 5.00 },

  // Opus family
  'claude-opus-4-5':            { input: 15.00, output: 75.00 },
  'claude-opus-4-7':            { input: 15.00, output: 75.00 },
};

const FALLBACK_PRICE = { input: 3.00, output: 15.00 }; // Sonnet 4.x default

export function priceForModel(model) {
  if (!model) return FALLBACK_PRICE;
  return PRICING_USD_PER_1M[model] || FALLBACK_PRICE;
}

export function computeCostUsd(inputTokens, outputTokens, model) {
  const { input, output } = priceForModel(model);
  return (
    (Number(inputTokens) || 0) * (input / 1_000_000) +
    (Number(outputTokens) || 0) * (output / 1_000_000)
  );
}

export function isKnownModel(model) {
  return !!model && Object.prototype.hasOwnProperty.call(PRICING_USD_PER_1M, model);
}

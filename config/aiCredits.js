// config/aiCredits.js
const supabase = require("./supabaseClient");

const CREDIT_VALUE_CAD = 5 / 1000;

const MODEL_PRICING_USD = {
  "gemini-2.5-flash": { input: 0.30 / 1_000_000, output: 2.50 / 1_000_000 },
  "gemini-2.5-pro": {
    input: 1.25 / 1_000_000, output: 10.00 / 1_000_000,
    inputLong: 2.50 / 1_000_000, outputLong: 15.00 / 1_000_000,
  },
};

const PLAN_CREDIT_ALLOWANCE = { free: 1000, pro: 2000 };

let cachedRate = 1.42; // fallback default, used until the first successful DB read

async function getUsdToCadRate() {
  const { data, error } = await supabase.from("fx_rate_cache").select("usd_to_cad").eq("id", 1).single();
  if (!error && data?.usd_to_cad) cachedRate = data.usd_to_cad;
  return cachedRate;
}

async function calculateCreditsUsed(model, usage) {
  const rate = await getUsdToCadRate();
  const pricing = MODEL_PRICING_USD[model];
  const isLongContext = usage.promptTokenCount > 200_000;
  const inputRate = (isLongContext && pricing.inputLong ? pricing.inputLong : pricing.input) * rate;
  const outputRate = (isLongContext && pricing.outputLong ? pricing.outputLong : pricing.output) * rate;

  const costCad = usage.promptTokenCount * inputRate + usage.candidatesTokenCount * outputRate;
  return Math.ceil(costCad / CREDIT_VALUE_CAD);
}

module.exports = { CREDIT_VALUE_CAD, PLAN_CREDIT_ALLOWANCE, calculateCreditsUsed, getUsdToCadRate };
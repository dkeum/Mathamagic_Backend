// api/cron/refresh-fx-rate.js
const supabase = require("../../config/supabaseClient");

module.exports = async function refreshFxRate(req, res) {
  try {
    const response = await fetch("https://api.frankfurter.dev/v2/latest?base=USD&symbols=CAD");
    const data = await response.json();
    const rate = data.rates.CAD;

    if (!rate || typeof rate !== "number") throw new Error("Invalid rate response");

    await supabase
      .from("fx_rate_cache")
      .update({ usd_to_cad: rate, updated_at: new Date().toISOString() })
      .eq("id", 1);

    res.status(200).json({ updated: true, rate });
  } catch (err) {
    console.error("FX rate refresh failed, keeping last known rate:", err);
    res.status(200).json({ updated: false }); // don't fail the cron — stale rate is fine for a day
  }
};
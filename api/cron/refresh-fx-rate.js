const supabase = require("../../config/supabaseClient");

const refreshFxRate = async (req, res) => {
  // Vercel auto-injects CRON_SECRET as an env var and sends it as the
  // Authorization header on cron-triggered requests — verify it so
  // this endpoint can't be triggered by anyone who finds the URL.
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const response = await fetch("https://api.frankfurter.dev/v2/latest?base=USD&symbols=CAD");
    const data = await response.json();
    const rate = data.rates?.CAD;

    if (!rate || typeof rate !== "number") {
      throw new Error("Invalid rate response");
    }

    // Update the database
    const { error } = await supabase
      .from("fx_rate_cache")
      .update({ usd_to_cad: rate, updated_at: new Date().toISOString() })
      .eq("id", 1);

    if (error) {
      throw error;
    }

    return res.status(200).json({ updated: true, rate });
  } catch (err) {
    console.error("FX rate refresh failed, keeping last known rate:", err);
    // don't error the cron — stale rate is fine for a day
    return res.status(200).json({ updated: false }); 
  }
};

module.exports = {
  refreshFxRate
};
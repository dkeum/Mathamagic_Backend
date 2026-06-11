const { check, validationResult } = require("express-validator");
const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

/**
 * @desc    Join the waitlist & process viral loop referrals
 * @route   POST /api/waitlist/join
 * @access  Public
 */
const joinWaitlist = asyncHandler(async (req, res) => {
  console.log("Received waitlist join request with body:", req.body);

  // 1. Run validation rules inline for rapid execution
  await check("email", "Please include a valid email address").isEmail().normalizeEmail().run(req);
  await check("referred_by").optional().trim().run(req);

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // CRITICAL FIX: Grab the sanitized email output by express-validator, NOT the raw req.body
  const sanitizedEmail = req.body.email; 
  const { referred_by } = req.body;

  try {
    // 2. Check if the user is already on the waitlist
    const { data: existingUser, error: fetchError } = await supabase
      .from("waitlist")
      .select("id, email, referral_token, referral_count")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (existingUser) {
      return res.status(200).json({
        message: "Already on the waitlist!",
        user: {
          email: existingUser.email,
          referralToken: existingUser.referral_token,
          referralCount: existingUser.referral_count,
        },
      });
    }

    // 3. Generate a clean, mobile-friendly 6-character alphanumeric referral token
    const uniqueToken = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 4. Handle referral link tracking logic
    let referrerId = null;
    if (referred_by) {
      const { data: referrer, error: referrerError } = await supabase
        .from("waitlist")
        .select("id, referral_count")
        .eq("referral_token", referred_by)
        .maybeSingle();

      if (referrer && !referrerError) {
        referrerId = referrer.id;

        // Bump the referrer up the list by incrementing their score
        await supabase
          .from("waitlist")
          .update({ referral_count: referrer.referral_count + 1 })
          .eq("id", referrer.id);
      }
    }

    // 5. Commit the new signup record
    // CRITICAL FIX: Destructure the payload array returned by insert instead of chaining .single()
    const { data: insertedRows, error: insertError } = await supabase
      .from("waitlist")
      .insert([
        {
          email: sanitizedEmail,
          referral_token: uniqueToken,
          referred_by_id: referrerId,
          referral_count: 0,
        }
      ])
      .select(); // Returns an array of modified rows safely across all environments

    if (insertError) throw insertError;
    if (!insertedRows || insertedRows.length === 0) {
      throw new Error("No data returned from database insertion.");
    }

    const newUser = insertedRows[0];

    return res.status(201).json({
      message: "Successfully joined the waitlist!",
      user: {
        email: newUser.email,
        referralToken: newUser.referral_token,
        referralCount: newUser.referral_count,
      },
    });
  } catch (error) {
    // Enhanced logging so you can monitor exceptions inside your local backend console terminal
    console.error("Supabase Operation Failure Exception Stack:", error);
    return res.status(500).json({ error: error.message || "Server error saving waitlist spot." });
  }
});

/**
 * @desc    Fetch real-time counter metrics for landing page social proof
 * @route   GET /api/waitlist/stats
 * @access  Public
 */
const getStats = asyncHandler(async (req, res) => {
  try {
    // Uses a lightweight count query avoiding heavy data row transfer payloads
    const { count, error } = await supabase
      .from("waitlist")
      .select("*", { count: "exact", head: true });

    if (error) throw error;

    return res.status(200).json({
      total_signups: count || 0,
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not fetch telemetry metrics." });
  }
});

/**
 * @desc    Fetch top referrers to display on the post-signup gamification block
 * @route   GET /api/waitlist/leaderboard
 * @access  Public
 */
const getLeaderboard = asyncHandler(async (req, res) => {
  try {
    const { data: leaders, error } = await supabase
      .from("waitlist")
      .select("referral_token, referral_count")
      .order("referral_count", { ascending: false })
      .limit(10);

    if (error) throw error;

    // Mask tokens slightly to safeguard email user privacy on the client public UI
    const sanitizedLeaders = leaders.map((leader, index) => ({
      rank: index + 1,
      user_alias: `User_${leader.referral_token}`,
      referrals: leader.referral_count,
    }));

    return res.status(200).json(sanitizedLeaders);
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve leaderboard rankings." });
  }
});

module.exports = {
  joinWaitlist,
  getStats,
  getLeaderboard,
};
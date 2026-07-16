const asyncHandler = require("express-async-handler");
const STRIPE_API_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY;
const stripe = require("stripe")(STRIPE_API_SECRET_KEY);

const supabase = require("../config/supabaseClient");

// Check if the current environment is set to development
const isDev = process.env.NODE_ENV === "DEVELOPMENT";

const PRICE_IDS = {
    self_study: isDev
        ? (process.env.TEST_STRIPE_PRICE_SELF_STUDY || "price_1Td1FoRv5XPjIybS2GNrcDDN").trim()
        : (process.env.STRIPE_PRICE_SELF_STUDY || "price_1TqL05RrpzjNnAA9c3MS9swD").trim(),
    student_pro: isDev
        ? (process.env.TEST_STRIPE_PRICE_STUDENT_PRO || "price_1Td43kRv5XPjIybSvLaoLLlg").trim()
        : (process.env.STRIPE_PRICE_STUDENT_PRO || "price_1TqL1tRrpzjNnAA90LmbKOfZ").trim(),
};

// Newer Stripe API versions moved current_period_start/end off the
// top-level Subscription object onto each subscription item, to support
// items with independently timed billing cycles. Check both locations so
// this keeps working regardless of which shape the current API version
// (or any Stripe account setting) hands back.
const getSubscriptionPeriod = (subscription) => {
    const item = subscription?.items?.data?.[0];
    return {
        start: subscription?.current_period_start ?? item?.current_period_start ?? null,
        end: subscription?.current_period_end ?? item?.current_period_end ?? null,
    };
};

// Safe wrapper — returns null instead of throwing when the unix timestamp
// is missing/undefined, so a shape mismatch degrades gracefully instead of
// crashing the request.
const toISOStringSafe = (unixSeconds) =>
    unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;

// ── Shared auth helper ─────────────────────────────────────────
// Verifies the bearer token against Supabase and returns the authenticated
// user's id. Never trust a userId sent in the request body/query for
// anything security-sensitive — always derive it from the verified token.
const getVerifiedUserId = async (req) => {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;

    if (!token) {
        return { userId: null, error: "Missing or invalid token." };
    }

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
        return { userId: null, error: "Unauthorized user." };
    }

    // Student table uses Supabase's auth user id as its own id — adjust
    // this lookup if your schema maps auth users to Student rows differently
    // (e.g. via an email join) rather than a 1:1 id match.
    return { userId: user.id, error: null };
};

// @desc    Create a Stripe Checkout Session for subscriptions
// @route   POST /payment/create-checkout-session
// @access  Private
const createCheckoutSession = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { email, plan } = req.body;

    // console.log("Processing request data payload:");
    // console.log(userId, email, plan);

    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    // 1. Fetch from Student table using correct casing and column names
    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("had_trial, stripe_customer_id")
        .eq("id", userId)
        .single();

    if (studentError || !student) {
        console.error("Student lookup failed:", studentError);
        return res.status(404).json({ error: "Student record not found" });
    }

    const hadTrial = student.had_trial ?? false;
    const existingCustomerId = student.stripe_customer_id;

    const selectedPriceId = PRICE_IDS[plan];
    if (!selectedPriceId) {
        return res.status(400).json({ error: "Invalid subscription tier selection" });
    }

    const origin = process.env.VITE_ENVIRONMENT === "DEVELOPMENT"
        ? "http://localhost:5173"
        : "https://mathmagick.com";

    const sessionParams = {
        client_reference_id: userId,
        payment_method_types: ['card'],
        line_items: [{ price: selectedPriceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${origin}/showpersonaldata`,
        cancel_url: `${origin}/pricing`,
    };

    if (existingCustomerId) {
        sessionParams.customer = existingCustomerId;
    } else {
        sessionParams.customer_email = email;
    }

    if (!hadTrial) {
        sessionParams.subscription_data = { trial_period_days: 7 };
    }

    try {
        const session = await stripe.checkout.sessions.create(sessionParams);
        return res.status(200).json({ id: session.id, url: session.url });
    } catch (stripeError) {
        console.error("Stripe checkout failed:", stripeError);
        return res.status(500).json({ error: "Payment gateway integration failed" });
    }
});

// @desc    Cancel a user's active Stripe subscription (at period end)
// @route   POST /payment/cancel-subscription
// @access  Private
const cancelSubscription = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("stripe_subscription_id")
        .eq("id", userId)
        .single();

    if (studentError || !student?.stripe_subscription_id) {
        return res.status(404).json({ error: "No active subscription found" });
    }

    const subscriptionId = student.stripe_subscription_id;

    const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
    });

    const { error: updateError } = await supabase
        .from("Student")
        .update({ subscription_status: "canceling" })
        .eq("id", userId);

    if (updateError) {
        console.error("Failed to update subscription status in DB:", updateError);
    }

    res.status(200).json({
        message: "Subscription will be cancelled at the end of the billing period",
        cancels_at: toISOStringSafe(subscription.cancel_at),
    });
});

// @desc    Pause a user's active subscription (stops billing, keeps subscription alive)
// @route   POST /payment/pause-subscription
// @access  Private
const pauseSubscription = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("stripe_subscription_id")
        .eq("id", userId)
        .single();

    if (studentError || !student?.stripe_subscription_id) {
        return res.status(404).json({ error: "No active subscription found" });
    }

    try {
        const subscription = await stripe.subscriptions.update(student.stripe_subscription_id, {
            pause_collection: {
                behavior: "void",
            },
        });

        const { error: updateError } = await supabase
            .from("Student")
            .update({ subscription_status: "paused" })
            .eq("id", userId);

        if (updateError) {
            console.error("Failed to update subscription_status to paused in DB:", updateError);
        }

        return res.status(200).json({
            message: "Subscription paused. No further charges until resumed.",
            status: subscription.status,
            pause_collection: subscription.pause_collection,
        });
    } catch (stripeError) {
        console.error("Stripe pause failed:", stripeError);
        return res.status(500).json({ error: "Failed to pause subscription" });
    }
});

// @desc    Resume a paused subscription
// @route   POST /payment/resume-subscription
// @access  Private
const resumeSubscription = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("stripe_subscription_id")
        .eq("id", userId)
        .single();

    if (studentError || !student?.stripe_subscription_id) {
        return res.status(404).json({ error: "No active subscription found" });
    }

    try {
        const subscription = await stripe.subscriptions.update(student.stripe_subscription_id, {
            pause_collection: null,
        });

        const { error: updateError } = await supabase
            .from("Student")
            .update({ subscription_status: subscription.status })
            .eq("id", userId);

        if (updateError) {
            console.error("Failed to update subscription_status after resume:", updateError);
        }

        return res.status(200).json({
            message: "Subscription resumed.",
            status: subscription.status,
        });
    } catch (stripeError) {
        console.error("Stripe resume failed:", stripeError);
        return res.status(500).json({ error: "Failed to resume subscription" });
    }
});

// @desc    Change plan tier (upgrade or downgrade) — same logic handles both directions
//          Upgrades apply immediately with proration. Downgrades are
//          scheduled to take effect at the end of the current billing
//          period — the customer keeps their current plan's access until
//          then, matching what they already paid for.
// @route   POST /payment/change-plan
// @access  Private
const changePlan = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { newPlan } = req.body;

    const newPriceId = PRICE_IDS[newPlan];
    if (!newPriceId) {
        return res.status(400).json({ error: "Invalid subscription tier selection" });
    }

    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("stripe_subscription_id")
        .eq("id", userId)
        .single();

    if (studentError || !student?.stripe_subscription_id) {
        return res.status(404).json({ error: "No active subscription found" });
    }

    try {
        const subscription = await stripe.subscriptions.retrieve(student.stripe_subscription_id);
        const currentItemId = subscription.items.data[0].id;
        const currentPriceId = subscription.items.data[0].price.id;

        if (currentPriceId === newPriceId) {
            return res.status(400).json({ error: "Already subscribed to this plan" });
        }

        // If this subscription is already on a schedule (e.g. a previously
        // scheduled downgrade), we need to work with that schedule rather
        // than assume the subscription is schedule-free.
        const existingScheduleId = subscription.schedule;
        const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(subscription);

        const tierOrder = ["self_study", "student_pro"];
        const currentPlanKey = Object.keys(PRICE_IDS).find((key) => PRICE_IDS[key] === currentPriceId);
        const isUpgrade = tierOrder.indexOf(newPlan) > tierOrder.indexOf(currentPlanKey);

        if (isUpgrade) {
            // ── Upgrade: apply immediately, prorate the difference ──
            // If a downgrade schedule is pending, release it first so the
            // upgrade takes precedence and we don't end up with a stale
            // scheduled downgrade fighting the immediate upgrade.
            if (existingScheduleId) {
                await stripe.subscriptionSchedules.release(existingScheduleId);
            }

            const updated = await stripe.subscriptions.update(student.stripe_subscription_id, {
                items: [{ id: currentItemId, price: newPriceId }],
                proration_behavior: "create_prorations",
            });

            // Upgrades take effect now, so it's safe to reflect that immediately.
            // (Webhook will also confirm this via customer.subscription.updated.)
            const { error: updateError } = await supabase
                .from("Student")
                .update({ plan_type: newPlan, subscription_status: updated.status })
                .eq("id", userId);

            if (updateError) {
                console.error("Failed to update plan_type in DB after upgrade:", updateError);
            }

            return res.status(200).json({
                message: "Plan upgraded — prorated charge applied immediately.",
                status: updated.status,
                new_plan: newPlan,
            });
        }

        // ── Downgrade: defer to end of current billing period ──
        // Do NOT touch Student.plan_type here — the plan hasn't actually
        // changed yet. The webhook handler updates it when the schedule's
        // second phase actually activates at period end.

        let schedule;
        if (existingScheduleId) {
            // A schedule already exists on this subscription — update its
            // upcoming phase instead of creating a second, conflicting one.
            schedule = await stripe.subscriptionSchedules.update(existingScheduleId, {
                phases: [
                    {
                        items: [{ price: currentPriceId, quantity: 1 }],
                        start_date: periodStart,
                        end_date: periodEnd,
                    },
                    {
                        items: [{ price: newPriceId, quantity: 1 }],
                        start_date: periodEnd,
                    },
                ],
            });
        } else {
            // First time scheduling a change for this subscription —
            // convert it into a schedule.
            schedule = await stripe.subscriptionSchedules.create({
                from_subscription: student.stripe_subscription_id,
            });

            schedule = await stripe.subscriptionSchedules.update(schedule.id, {
                phases: [
                    {
                        items: [{ price: currentPriceId, quantity: 1 }],
                        start_date: periodStart,
                        end_date: periodEnd,
                    },
                    {
                        items: [{ price: newPriceId, quantity: 1 }],
                        start_date: periodEnd,
                    },
                ],
            });
        }

        // Track the pending downgrade in your own DB so the frontend can
        // show "downgrading to X on <date>" without re-querying Stripe.
        const { error: pendingUpdateError } = await supabase
            .from("Student")
            .update({ pending_plan_type: newPlan })
            .eq("id", userId);

        if (pendingUpdateError) {
            console.error("Failed to record pending_plan_type in DB:", pendingUpdateError);
        }

        return res.status(200).json({
            message: "Plan downgrade scheduled — takes effect at the end of your current billing period.",
            new_plan: newPlan,
            effective_at: toISOStringSafe(periodEnd),
        });
    } catch (stripeError) {
        console.error("Stripe plan change failed:", stripeError);
        return res.status(500).json({ error: "Failed to change subscription plan" });
    }
});

// @desc    Get a user's current subscription status
// @route   GET /payment/subscription-status
// @access  Private
const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) {
        return res.status(401).json({ error: authError });
    }

    const { data: student, error: studentError } = await supabase
        .from("Student")
        .select("stripe_subscription_id, stripe_customer_id, subscription_status, had_trial, plan_type")
        .eq("id", userId)
        .single();

    if (studentError) {
        console.error("Student lookup error:", studentError);
        return res.status(500).json({ error: "Internal server error" });
    }

    if (!student?.stripe_subscription_id) {
        return res.status(200).json({ status: "no_subscription", active: false });
    }
    console.log("the is the sub_id:", student.stripe_subscription_id.trim() , "ZZZZZZZZZZZZZZZZZZz")
    const subscription = await stripe.subscriptions.retrieve(student.stripe_subscription_id.trim());
    const { end: periodEnd } = getSubscriptionPeriod(subscription);

    const isPaused = !!subscription.pause_collection;
    const isCanceling = subscription.cancel_at_period_end;
    const isActive = ["active", "trialing"].includes(subscription.status) && !isPaused;

    res.status(200).json({
        active: isActive,
        paused: isPaused,
        status: subscription.status,
        plan: student.plan_type,
        cancel_at_period_end: isCanceling,
        current_period_end: toISOStringSafe(periodEnd),
        next_payment_date: isActive && !isCanceling ? toISOStringSafe(periodEnd) : null,
        trial_end: toISOStringSafe(subscription.trial_end),
        had_trial: student.had_trial ?? false,
    });
});

module.exports = {
    createCheckoutSession,
    cancelSubscription,
    pauseSubscription,
    resumeSubscription,
    changePlan,
    getSubscriptionStatus,
};
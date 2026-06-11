const asyncHandler = require("express-async-handler");
const STRIPE_API_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY;
const stripe = require("stripe")(STRIPE_API_SECRET_KEY);

const supabase = require("../config/supabaseClient");





// @desc    Create a Stripe Checkout Session for subscriptions
// @route   POST /payment/create-checkout-session
// @access  Private
// @desc    Create a Stripe Checkout Session for subscriptions
// @route   POST /payment/create-checkout-session
// @access  Private
// @desc    Create a Stripe Checkout Session for subscriptions
// @route   POST /payment/create-checkout-session
// @access  Private
const createCheckoutSession = asyncHandler(async (req, res) => {
    const { email, userId, plan } = req.body;

    console.log("Processing request data payload:");
    console.log(userId, email, plan);

    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }
    if (!userId) {
        return res.status(400).json({ error: "User identity verification failed" });
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

    // 2. Resolve Price IDs
    const PRICE_IDS = {
        self_study: process.env.STRIPE_PRICE_SELF_STUDY || "price_1Td1FoRv5XPjIybS2GNrcDDN",
        student_pro: process.env.STRIPE_PRICE_STUDENT_PRO || "price_1Td43kRv5XPjIybSvLaoLLlg",
        academic_excellent: process.env.STRIPE_PRICE_EXCELLENCE || "price_1Td44gRv5XPjIybS4Gv43ibj", // <-- Changed from excellence to excellent
    };

    const selectedPriceId = PRICE_IDS[plan];
    if (!selectedPriceId) {
        return res.status(400).json({ error: "Invalid subscription tier selection" });
    }

    const origin = process.env.VITE_ENVIRONMENT === "DEVELOPMENT"
        ? "http://localhost:5173"
        : "https://mathamagic.vercel.app";

    // 3. Define configuration parameters base object cleanly
    const sessionParams = {
        client_reference_id: userId, // Keeps track of the Supabase user ID inside Stripe webhooks
        payment_method_types: ['card'],
        line_items: [{ price: selectedPriceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${origin}/showpersonaldata`,
        cancel_url: `${origin}/pricing`,
    };

    // 4. Attach existing customer ID or let Stripe create one based on their email
    if (existingCustomerId) {
        sessionParams.customer = existingCustomerId;
    } else {
        sessionParams.customer_email = email;
    }

    // 5. Apply trial only if student hasn't had one before
    if (!hadTrial) {
        sessionParams.subscription_data = { trial_period_days: 7 };
    }

    try {
        // 6. Create Stripe session using the consolidated params
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
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "User identity verification failed" });
    }

    // Fetch the subscription ID stored in your DB
    const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("stripe_subscription_id")
        .eq("id", userId)
        .single();

    if (profileError || !profile?.stripe_subscription_id) {
        return res.status(404).json({ error: "No active subscription found" });
    }

    const subscriptionId = profile.stripe_subscription_id;

    // Cancel at period end so user keeps access until billing cycle ends
    const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
    });

    // Reflect the pending cancellation in your DB
    const { error: updateError } = await supabase
        .from("profiles")
        .update({ subscription_status: "canceling" })
        .eq("id", userId);

    if (updateError) {
        console.error("Failed to update subscription status in DB:", updateError);
        // Non-fatal — Stripe is source of truth; webhook will sync it
    }

    res.status(200).json({
        message: "Subscription will be cancelled at the end of the billing period",
        cancels_at: new Date(subscription.cancel_at * 1000).toISOString(),
    });
});

// @desc    Get a user's current subscription status
// @route   GET /payment/subscription-status
// @access  Private
const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const userId = req.query.userId || req.user?.id;

    if (!userId) {
        return res.status(400).json({ error: "User identity verification failed" });
    }

    // Pull the subscription ID from your DB
    const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("stripe_subscription_id, stripe_customer_id, subscription_status, had_trial")
        .eq("id", userId)
        .single();

    if (profileError) {
        console.error("Profile lookup error:", profileError);
        return res.status(500).json({ error: "Internal server error" });
    }

    if (!profile?.stripe_subscription_id) {
        return res.status(200).json({ status: "no_subscription", active: false });
    }

    // Fetch live status from Stripe (don't rely solely on your DB)
    const subscription = await stripe.subscriptions.retrieve(
        profile.stripe_subscription_id
    );

    const isActive = ["active", "trialing"].includes(subscription.status);

    res.status(200).json({
        active: isActive,
        status: subscription.status, // active | trialing | past_due | canceled | incomplete
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        trial_end: subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null,
        had_trial: profile.had_trial ?? false,
    });
});

module.exports = {
    createCheckoutSession,
    cancelSubscription,
    getSubscriptionStatus,
};
const asyncHandler = require("express-async-handler");
const STRIPE_API_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY;
const stripe = require("stripe")(STRIPE_API_SECRET_KEY);
const supabase = require("../config/supabaseClient");

// Price ID Mapping
const PRICE_IDS = {
    self_study:          process.env.STRIPE_PRICE_SELF_STUDY  || "price_1Td1FoRv5XPjIybS2GNrcDDN",
    student_pro:         process.env.STRIPE_PRICE_STUDENT_PRO || "price_1Td43kRv5XPjIybSvLaoLLlg",
    academic_excellence: process.env.STRIPE_PRICE_EXCELLENCE  || "price_1Td44gRv5XPjIybS4Gv43ibj",
};

// AI credits allocated per plan
const PLAN_AI_CREDITS = {
    self_study:          100,
    student_pro:         500,
    academic_excellence: 2500,
    free:                0,
};

const stripeWebhookHandler = asyncHandler(async (req, res) => {
    const sig           = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`❌ Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const dataObject = event.data.object;

    switch (event.type) {

        // ── Case A: Initial purchase or trial start ───────────────
        case "checkout.session.completed": {
            const userId         = dataObject.client_reference_id;
            const subscriptionId = dataObject.subscription;
            const stripeCustomerId = dataObject.customer;

            if (!userId) {
                console.error("❌ Missing client_reference_id in checkout session");
                return res.status(400).send("Missing client_reference_id");
            }

            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId      = subscription.items.data[0].price.id;

            await upsertSubscription({
                userId,
                subscriptionId,
                stripeCustomerId,
                priceId,
                status:            subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodStart: subscription.current_period_start,
                currentPeriodEnd:   subscription.current_period_end,
                trialEnd:           subscription.trial_end,
            });
            break;
        }

        // ── Case B: Upgrades, downgrades, renewals, cancellations ─
        case "customer.subscription.updated": {
            const subscriptionId   = dataObject.id;
            const stripeCustomerId = dataObject.customer;
            const priceId          = dataObject.items.data[0].price.id;
            const status           = dataObject.status;
            const cancelAtPeriodEnd = dataObject.cancel_at_period_end;

            let userId = await findUserIdBySubscriptionId(subscriptionId);
            if (!userId) {
                console.error(`⚠️ Could not map subscription ${subscriptionId} to a user.`);
                break;
            }

            await upsertSubscription({
                userId,
                subscriptionId,
                stripeCustomerId,
                priceId,
                status,
                cancelAtPeriodEnd,
                currentPeriodStart: dataObject.current_period_start,
                currentPeriodEnd:   dataObject.current_period_end,
                trialEnd:           dataObject.trial_end,
            });
            break;
        }

        // ── Case C: Subscription expired or cancelled ─────────────
        case "customer.subscription.deleted": {
            const subscriptionId = dataObject.id;
            await revokeSubscription(subscriptionId);
            break;
        }

        // ── Case D: Payment failed ────────────────────────────────
        case "invoice.payment_failed": {
            console.log(`⚠️ Payment failed for customer: ${dataObject.customer}`);
            break;
        }

        default:
            console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
});

/* ===================================================================
   DATABASE ABSTRACTIONS
   ===================================================================
*/

async function upsertSubscription({
    userId,
    subscriptionId,
    stripeCustomerId,
    priceId,
    status,
    cancelAtPeriodEnd,
    currentPeriodStart,
    currentPeriodEnd,
    trialEnd,
}) {
    const hasActiveAccess = ["active", "trialing"].includes(status);
    const isTrialing      = status === "trialing";

    // Resolve plan type from price ID
    let internalPlanType = "self_study"; // fallback
    if (priceId === PRICE_IDS.student_pro)         internalPlanType = "student_pro";
    if (priceId === PRICE_IDS.academic_excellence)  internalPlanType = "academic_excellence";

    const resolvedPlan = hasActiveAccess ? internalPlanType : "free";

    // Assign AI credits based on plan — only on active payment, not on cancellation
    const aiCredits = hasActiveAccess ? (PLAN_AI_CREDITS[resolvedPlan] ?? 0) : 0;

    // Convert Unix timestamps to ISO strings for Supabase
    const subscriptionStart = currentPeriodStart
        ? new Date(currentPeriodStart * 1000).toISOString()
        : null;
    const subscriptionEnd = currentPeriodEnd
        ? new Date(currentPeriodEnd * 1000).toISOString()
        : null;
    const trialEndDate = trialEnd
        ? new Date(trialEnd * 1000).toISOString()
        : null;

    console.log(`🔄 Upserting subscription for User ${userId}:`);
    console.log(`   plan_type: ${resolvedPlan} | status: ${status} | AI_Credit: ${aiCredits}`);

    const { error } = await supabase
        .from("Student")
        .update({
            // Plan & subscription identity
            plan_type:              resolvedPlan,
            stripe_customer_id:     stripeCustomerId,
            stripe_subscription_id: subscriptionId,
            subscription_status:    status,

            // Access flag
            isSubscribed: hasActiveAccess,

            // Trial tracking — once true, never set back to false (prevents abuse)
            ...(isTrialing && { had_trial: true }),
            ...(trialEndDate && { trial_end: trialEndDate }),

            // Billing period dates
            ...(subscriptionStart && { subscription_start: subscriptionStart }),
            ...(subscriptionEnd   && { subscription_end:   subscriptionEnd   }),

            // AI credits — only update when there's active access
            ...(hasActiveAccess && { AI_Credit: aiCredits }),
        })
        .eq("id", userId);

    if (error) {
        console.error("❌ Supabase upsert error:", error.message);
        throw error;
    }

    console.log(`✅ Student ${userId} updated — plan: ${resolvedPlan}, credits: ${aiCredits}`);
}

async function revokeSubscription(subscriptionId) {
    console.log(`🔒 Revoking access for subscription: ${subscriptionId}`);

    const { error } = await supabase
        .from("Student")
        .update({
            plan_type:           "free",
            isSubscribed:        false,
            subscription_status: "canceled",
            AI_Credit:           0,
        })
        .eq("stripe_subscription_id", subscriptionId);

    if (error) {
        console.error("❌ Supabase revocation error:", error.message);
        throw error;
    }

    console.log(`✅ Subscription ${subscriptionId} revoked — access removed`);
}

async function findUserIdBySubscriptionId(subscriptionId) {
    const { data, error } = await supabase
        .from("Student")
        .select("id")
        .eq("stripe_subscription_id", subscriptionId)
        .maybeSingle();

    if (error) {
        console.error("❌ Error finding student by subscription ID:", error.message);
        return null;
    }

    return data ? data.id : null;
}

module.exports = {
    stripeWebhookHandler,
    upsertSubscription,
    revokeSubscription,
    findUserIdBySubscriptionId,
};
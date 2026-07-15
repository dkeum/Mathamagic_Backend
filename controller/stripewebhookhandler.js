const asyncHandler = require("express-async-handler");
const nodemailer = require("nodemailer");
const STRIPE_API_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY;
const stripe = require("stripe")(STRIPE_API_SECRET_KEY);
const supabase = require("../config/supabaseClient");
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;



// Reverse-lookup: Stripe price ID -> your internal plan key
const IS_DEV = process.env.NODE_ENV === "DEVELOPMENT";

const PRICE_IDS = {
    self_study: (
        IS_DEV
            ? process.env.TEST_STRIPE_PRICE_SELF_STUDY
            : process.env.STRIPE_PRICE_SELF_STUDY
    )?.trim(),
    student_pro: (
        IS_DEV
            ? process.env.TEST_STRIPE_PRICE_STUDENT_PRO
            : process.env.STRIPE_PRICE_STUDENT_PRO
    )?.trim(),
};

// AI credits allocated per plan (full monthly wallet amount)
const PLAN_AI_CREDITS = {
    self_study:  4000,
    student_pro: 10000,
    free:        50,
};

// Trial allocation
const TRIAL_AI_CREDITS = 1000;

// Newer Stripe API versions moved current_period_start/end off the
// top-level Subscription object onto each subscription item. Check both
// locations so this keeps working regardless of API version.
const getSubscriptionPeriod = (subscription) => {
    const item = subscription?.items?.data?.[0];
    return {
        start: subscription?.current_period_start ?? item?.current_period_start ?? null,
        end: subscription?.current_period_end ?? item?.current_period_end ?? null,
    };
};

/* ===================================================================
   EMAIL CONFIGURATION (NODEMAILER)
   =================================================================== */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NOREPLY_GMAIL,
    pass: process.env.NOREPLY_GMAIL_APP_PASSWORD,
  },
});

/* ===================================================================
   WEBHOOK HANDLER
   =================================================================== */
const stripewebhookhandler = asyncHandler(async (req, res) => {
    const sig           = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        // IMPORTANT: Ensure req.body is the raw buffer, not parsed JSON!
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
            const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(subscription);

            await upsertSubscription({
                userId,
                subscriptionId,
                stripeCustomerId,
                priceId,
                status:            subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodStart: periodStart,
                currentPeriodEnd:   periodEnd,
                trialEnd:           subscription.trial_end,
                resetCredits:       "always",
            });
            break;
        }

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

            const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(dataObject);

            await upsertSubscription({
                userId,
                subscriptionId,
                stripeCustomerId,
                priceId,
                status,
                cancelAtPeriodEnd,
                currentPeriodStart: periodStart,
                currentPeriodEnd:   periodEnd,
                trialEnd:           dataObject.trial_end,
                resetCredits:       "on_plan_change",
            });
            break;
        }

        case "customer.subscription.deleted": {
            const subscriptionId = dataObject.id;
            await revokeSubscription(subscriptionId);
            break;
        }

        case "invoice.payment_succeeded": {
            const subscriptionId = dataObject.subscription;
            if (!subscriptionId) break;

            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId      = subscription.items.data[0].price.id;
            const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(subscription);

            const userId = await findUserIdBySubscriptionId(subscriptionId);
            if (userId) {
                await upsertSubscription({
                    userId,
                    subscriptionId,
                    stripeCustomerId: dataObject.customer,
                    priceId,
                    status:            subscription.status,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                    currentPeriodStart: periodStart,
                    currentPeriodEnd:   periodEnd,
                    trialEnd:           subscription.trial_end,
                    resetCredits:       "always",
                });
                console.log(`✅ Invoice paid & subscription renewed for user: ${userId}`);
            }
            break;
        }

        case "invoice.payment_failed": {
            console.log(`⚠️ Payment failed for customer: ${dataObject.customer}`);

            let customerEmail = dataObject.customer_email;
            const hostedInvoiceUrl = dataObject.hosted_invoice_url;

            if (!customerEmail) {
                try {
                    const customer = await stripe.customers.retrieve(dataObject.customer);
                    customerEmail = customer.email;
                } catch (error) {
                    console.error("❌ Failed to retrieve customer email for failed payment:", error.message);
                }
            }

            if (customerEmail && hostedInvoiceUrl) {
                await sendPaymentFailedEmail(customerEmail, hostedInvoiceUrl);
            }
            break;
        }

        default:
            console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
});

/* ===================================================================
   EMAIL ABSTRACTION
   =================================================================== */
async function sendPaymentFailedEmail(email, invoiceUrl) {
    try {
        await transporter.sendMail({
            from: `"Your App Name" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Action Required: Your subscription payment failed",
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>Payment Failed</h2>
                    <p>Hi there,</p>
                    <p>We attempted to process your recent subscription payment, but the charge was declined.</p>
                    <p>To ensure your access isn't interrupted, please update your payment method and settle your invoice using the secure link below:</p>
                    <a href="${invoiceUrl}" style="display: inline-block; padding: 10px 20px; color: #fff; background-color: #635bff; text-decoration: none; border-radius: 5px; margin-top: 10px;">
                        Update Payment & Pay Invoice
                    </a>
                    <p style="margin-top: 20px; color: #555;">Thank you!</p>
                </div>
            `,
        });
        console.log(`📧 Payment failure email successfully sent to ${email}`);
    } catch (error) {
        console.error("❌ Error sending payment failed email:", error.message);
    }
}

/* ===================================================================
   DATABASE ABSTRACTIONS
   =================================================================== */

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
    resetCredits = "always",
}) {
    const hasActiveAccess = ["active", "trialing"].includes(status);
    const isTrialing      = status === "trialing";

    // Resolve plan type from price ID — explicit match against every known
    // plan; falls through to null (not "self_study") if nothing matches,
    // so a bad/stale price ID is loud instead of silently miscategorized.
    let internalPlanType = null;
    if (priceId === PRICE_IDS.self_study)  internalPlanType = "self_study";
    if (priceId === PRICE_IDS.student_pro) internalPlanType = "student_pro";

    if (!internalPlanType) {
        console.error(`❌ Unrecognized priceId "${priceId}" — does not match any PRICE_IDS entry (IS_DEV=${IS_DEV}). Falling back to "self_study" but this should be investigated.`);
        internalPlanType = "self_study";
    }

    const resolvedPlan = hasActiveAccess ? internalPlanType : "free";

    const subscriptionStart = currentPeriodStart
        ? new Date(currentPeriodStart * 1000).toISOString()
        : null;
    const subscriptionEnd = currentPeriodEnd
        ? new Date(currentPeriodEnd * 1000).toISOString()
        : null;
    const trialEndDate = trialEnd
        ? new Date(trialEnd * 1000).toISOString()
        : null;

    let creditUpdate = {};

    if (!hasActiveAccess) {
        creditUpdate = { AI_Credit: 0 };
    } else if (resetCredits === "always") {
        creditUpdate = {
            AI_Credit: isTrialing ? TRIAL_AI_CREDITS : (PLAN_AI_CREDITS[resolvedPlan] ?? 0)
        };
    } else if (resetCredits === "on_plan_change") {
        const { data: existing, error: fetchError } = await supabase
            .from("Student")
            .select("plan_type")
            .eq("id", userId)
            .maybeSingle();

        if (fetchError) {
            console.error("❌ Error fetching existing student for plan comparison:", fetchError.message);
        }

        const planChanged = !existing || existing.plan_type !== resolvedPlan;
        if (planChanged) {
            creditUpdate = {
                AI_Credit: isTrialing ? TRIAL_AI_CREDITS : (PLAN_AI_CREDITS[resolvedPlan] ?? 0)
            };
            console.log(`🔁 Plan changed for ${userId}: ${existing?.plan_type ?? "unknown"} -> ${resolvedPlan}. Resetting wallet.`);
        } else {
            console.log(`↔️ Plan unchanged for ${userId} (${resolvedPlan}). Preserving current AI_Credit balance.`);
        }
    }

    console.log(`🔄 Upserting subscription for User ${userId}:`);
    console.log(`   priceId: ${priceId} | resolvedPlan: ${resolvedPlan} | status: ${status} | credit_update: ${JSON.stringify(creditUpdate)}`);

    const { error } = await supabase
        .from("Student")
        .update({
            plan_type:              resolvedPlan,
            stripe_customer_id:     stripeCustomerId,
            stripe_subscription_id: subscriptionId,
            subscription_status:    status,

            isSubscribed: hasActiveAccess,

            ...(isTrialing && { had_trial: true }),
            ...(trialEndDate && { trial_end: trialEndDate }),

            ...(subscriptionStart && { subscription_start: subscriptionStart }),
            ...(subscriptionEnd   && { subscription_end:   subscriptionEnd   }),

            ...creditUpdate,
        })
        .eq("id", userId);

    if (error) {
        console.error("❌ Supabase upsert error:", error.message);
        throw error;
    }

    console.log(`✅ Student ${userId} updated — plan: ${resolvedPlan}`);
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
    stripewebhookhandler,
    upsertSubscription,
    revokeSubscription,
    findUserIdBySubscriptionId,
};
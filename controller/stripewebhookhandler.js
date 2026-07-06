const asyncHandler = require("express-async-handler");
const nodemailer = require("nodemailer");
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

        // ── Case B: Upgrades, downgrades, cancellations ───────────
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

        // ── Case D: Payment Succeeded (Renewals) ──────────────────
        case "invoice.payment_succeeded": {
            const subscriptionId = dataObject.subscription;
            if (!subscriptionId) break; // Ignore one-off invoices, focus on subscriptions

            // Fetch the latest subscription state to extend the user's access period
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId      = subscription.items.data[0].price.id;

            const userId = await findUserIdBySubscriptionId(subscriptionId);
            if (userId) {
                await upsertSubscription({
                    userId,
                    subscriptionId,
                    stripeCustomerId: dataObject.customer,
                    priceId,
                    status:            subscription.status,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                    currentPeriodStart: subscription.current_period_start,
                    currentPeriodEnd:   subscription.current_period_end,
                    trialEnd:           subscription.trial_end,
                });
                console.log(`✅ Invoice paid & subscription renewed for user: ${userId}`);
            }
            break;
        }

        // ── Case E: Payment Failed (Send Email) ───────────────────
        case "invoice.payment_failed": {
            console.log(`⚠️ Payment failed for customer: ${dataObject.customer}`);
            
            // Stripe usually provides the customer_email on the invoice object
            let customerEmail = dataObject.customer_email;
            const hostedInvoiceUrl = dataObject.hosted_invoice_url; // URL where they can pay manually
            
            // If email isn't on the invoice, fetch the customer directly
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
}) {
    const hasActiveAccess = ["active", "trialing"].includes(status);
    const isTrialing      = status === "trialing";

    // Resolve plan type from price ID
    let internalPlanType = "self_study"; // fallback
    if (priceId === PRICE_IDS.student_pro)         internalPlanType = "student_pro";
    if (priceId === PRICE_IDS.academic_excellence) internalPlanType = "academic_excellence";

    const resolvedPlan = hasActiveAccess ? internalPlanType : "free";

    // Assign AI credits based on plan — only on active payment
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
            plan_type:              resolvedPlan,
            stripe_customer_id:     stripeCustomerId,
            stripe_subscription_id: subscriptionId,
            subscription_status:    status,

            isSubscribed: hasActiveAccess,

            ...(isTrialing && { had_trial: true }),
            ...(trialEndDate && { trial_end: trialEndDate }),

            ...(subscriptionStart && { subscription_start: subscriptionStart }),
            ...(subscriptionEnd   && { subscription_end:   subscriptionEnd   }),

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
    stripewebhookhandler,
    upsertSubscription,
    revokeSubscription,
    findUserIdBySubscriptionId,
};
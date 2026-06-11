const express = require("express");
const router = express.Router();

const stripeController = require("../controller/stripeController");


// ── Webhook ──────────────────────────────────────────────────
// MUST be before express.json() middleware — Stripe needs the raw body
// Make sure in your server.js you have:
// app.use("/payment/webhook", express.raw({ type: "application/json" }))

// ── Checkout ─────────────────────────────────────────────────
router.post(
    "/payment/create-checkout-session",
    stripeController.createCheckoutSession
);

// ── Subscription management ───────────────────────────────────
router.post(
    "/payment/cancel-subscription",
    stripeController.cancelSubscription
);

router.get(
    "/payment/subscription-status",
    stripeController.getSubscriptionStatus
);

module.exports = router;
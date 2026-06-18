const express = require("express");
const router = express.Router();

const stripeWebhookController = require("../controller/stripewebhookhandler");

// ── Webhook ──────────────────────────────────────────────────
// MUST be before express.json() middleware — Stripe needs the raw body
// Make sure in your server.js you have:
// app.use("/payment/webhook", express.raw({ type: "application/json" }))
router.post(
    "/payment/webhook",
    stripeWebhookController.stripewebhookhandler
);


module.exports = router;
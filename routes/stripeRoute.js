const express = require("express");
const router = express.Router();

const stripeController = require("../controller/stripeController");


// ── Webhook ──────────────────────────────────────────────────
// MUST be before express.json() middleware — Stripe needs the raw body
// Make sure in your server.js you have:
// app.use("/payment/webhook", express.raw({ type: "application/json" }))

// Only apply CORS headers and OPTIONS handlers in non-development environments
if (process.env.NODE_ENV !== "DEVELOPMENT") {

  const setCorsHeaders = (req, res, next) => {
    // res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
     res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  };

  router.use(setCorsHeaders);

  // OPTIONS handler for preflight requests
  router.options("/payment/create-checkout-session", (req, res) => res.sendStatus(204));
  router.options("/payment/cancel-subscription", (req, res) => res.sendStatus(204));
  router.options("/payment/subscription-status", (req, res) => res.sendStatus(204));
  router.options("/payment/pause-subscription", (req, res) => res.sendStatus(204));
  router.options("/payment/resume-subscription", (req, res) => res.sendStatus(204));
  router.options("/payment/change-plan", (req, res) => res.sendStatus(204));
   router.options("/payment/subscription-status", (req, res) => res.sendStatus(204));

}


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

router.post(
    "/payment/pause-subscription",
    stripeController.pauseSubscription
);

router.post(
    "/payment/resume-subscription",
    stripeController.resumeSubscription
);

router.post(
    "/payment/change-plan",
    stripeController.changePlan
);

router.get(
    "/payment/subscription-status",
    stripeController.getSubscriptionStatus
);

module.exports = router;
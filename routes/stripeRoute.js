const express = require("express");
const router = express.Router();

const stripeController = require("../controller/stripeController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");


// ── Webhook ──────────────────────────────────────────────────

applyCustomCors(router)

// don't add with credientals in teh frontned because of stripe redirect.


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
const express = require("express");
const router = express.Router();

const stripeWebhookController = require("../controller/stripewebhookhandler");

router.post(
  "/payment/webhook",
  stripeWebhookController.stripewebhookhandler
);

router.post(
  "/test/stripewebhook",
  stripeWebhookController.stripewebhookhandler
);

module.exports = router;
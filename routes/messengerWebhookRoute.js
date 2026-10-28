const express = require('express');
const router = express.Router();
const {
  verifyWebhook,
  verifySignature,
  handleWebhook,
} = require('../controller/messengerWebhookController');

router.get('/webhooks/messenger', verifyWebhook);
router.post('/webhooks/messenger', verifySignature, handleWebhook);

module.exports = router;
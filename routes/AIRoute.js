const express = require("express");
const router = express.Router();

const aiController = require("../controller/AIController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

applyCustomCors(router);

// AI routes
router.post("/ai/verify-answers", aiController.verifyAnswers);
router.post("/ai/verify-answer", aiController.verifyAnswer);
router.post("/ai/chat", aiController.chat);
router.post("/ai/chat-file", aiController.chatFile);
router.post("/ai/read-question", aiController.readQuestion);

module.exports = router;
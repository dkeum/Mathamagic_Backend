const express = require("express");
const router = express.Router();

const questionController = require("../controller/questionController");

// Only apply CORS headers and OPTIONS handlers in non-development environments
if (process.env.NODE_ENV !== "DEVELOPMENT") {

  const setCorsHeaders = (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  };

  router.use(setCorsHeaders);

  // OPTIONS handler for preflight requests
  router.options("/questions/:topic/:section", (req, res) => res.sendStatus(204));
  router.options("/questions/save-marks", (req, res) => res.sendStatus(204));
  router.options("/questions/get-questions", (req, res) => res.sendStatus(204));
  router.options("/questions/fix-questions", (req, res) => res.sendStatus(204));
  router.options("/questions/fix-mistakes", (req, res) => res.sendStatus(204));
}

// Actual route handler
router.get("/questions/:topic/:section", questionController.getQuestions);
router.post("/questions/save-marks", questionController.saveQuestionMarks);
router.get("/questions/get-questions", questionController.getRecordedAnswers)
router.post("/questions/fix-questions", questionController.fixRecordedAnswers)
router.post("/questions/fixed-mistakes", questionController.fixMistakes)

module.exports = router;

const express = require("express");
const router = express.Router();

const finalExamController = require("../controller/finalExamController");

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

//   getTopics_FinalExam,
//   generateFinalExam,
//   submitFinalExamMarks

  // OPTIONS handler for preflight requests
  router.options("/final-exam/topic", (req, res) => res.sendStatus(204));
  router.options("/final-exam/generate", (req, res) => res.sendStatus(204));
  router.options("/final-exam/save-marks", (req, res) => res.sendStatus(204));


}

// Actual route handler
router.get("/final-exam/topics", finalExamController.getTopics_FinalExam);
router.post("/final-exam/submit", finalExamController.submitFinalExamMarks);
router.post("/final-exam/generate", finalExamController.generateFinalExam)


module.exports = router;

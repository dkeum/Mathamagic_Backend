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
  router.options("/section/:section", (req, res) => res.sendStatus(204));
}

// Actual route handler
router.get("/section/:section", questionController.getQuestions);

module.exports = router;

const express = require("express");
const router = express.Router();

const questionController = require("../controller/questionController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {

//   const setCorsHeaders = (req, res, next) => {
//     // res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
//     res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
//     res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
//     res.setHeader("Access-Control-Allow-Headers", "Content-Type");
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     next();
//   };

//   router.use(setCorsHeaders);

//   // OPTIONS handler for preflight requests
//   router.options("/questions/:topic/:section", (req, res) => res.sendStatus(204));
//   router.options("/questions/save-marks", (req, res) => res.sendStatus(204));
//   router.options("/questions/get-questions", (req, res) => res.sendStatus(204));
//   router.options("/questions/fixed-mistakes", (req, res) => res.sendStatus(204));


// }


applyCustomCors(router)

// Actual route handler
router.get("/questions/:topic/:section", questionController.getQuestions);
router.post("/questions/save-marks", questionController.saveQuestionMarks);
router.get("/questions/mistakes", questionController.getMistakes)
router.post("/questions/fixed-mistakes", questionController.fixMistakes)



module.exports = router;

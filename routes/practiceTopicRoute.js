const express = require("express");
const multer = require("multer");

const router = express.Router();

const practiceTopicController = require("../controller/practiceTopicController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {
//   const setCorsHeaders = (req, res, next) => {
//     // res.setHeader(
//     //   "Access-Control-Allow-Origin",
//     //   "https://mathamagic.vercel.app"
//     // );
//      res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
//     res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
//     res.setHeader("Access-Control-Allow-Headers", "Content-Type");
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     next();
//   };

//   router.use(setCorsHeaders);

//   router.options("/practice-bank", (req, res) => res.sendStatus(204));

// }


applyCustomCors(router)

// Actual route handler
router.get("/practice-bank", practiceTopicController.getPracticeBank);


module.exports = router;

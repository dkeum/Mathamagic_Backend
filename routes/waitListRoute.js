const express = require("express");
const multer = require("multer");

const router = express.Router();
const upload = multer(); // memory storage (keeps file in req.file.buffer)
const waitlistController = require("../controller/waitListController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {
//   const setCorsHeaders = (req, res, next) => {
//     // res.setHeader(
//     //   "Access-Control-Allow-Origin",
//     //   "https://mathamagic.vercel.app"
//     // );
//     res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
//     res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
//     res.setHeader("Access-Control-Allow-Headers", "Content-Type");
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     next();
//   };

//   router.use(setCorsHeaders);

//   // OPTIONS handlers for preflight requests
//   router.options("/join", (req, res) => res.sendStatus(204));
//   router.options("/stats", (req, res) => res.sendStatus(204));
//   router.options("/leaderboard", (req, res) => res.sendStatus(204));
// }


applyCustomCors(router)

// Actual route handlers linked to your external controller
router.post("/join", waitlistController.joinWaitlist);
router.get("/stats", waitlistController.getStats);
router.get("/leaderboard", waitlistController.getLeaderboard);

//EDIT

module.exports = router;
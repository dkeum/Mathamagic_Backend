const express = require("express");
const router = express.Router();


const aiController = require("../controller/AIController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {

//     const setCorsHeaders = (req, res, next) => {
//         // res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
//         res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
//         res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
//         res.setHeader("Access-Control-Allow-Headers", "Content-Type");
//         res.setHeader("Access-Control-Allow-Credentials", "true");
//         next();
//     };

//     router.use(setCorsHeaders);


//     router.options("/ai/verify-answers", (req, res) => res.sendStatus(204));
//     router.options("/ai/verify-answer", (req, res) => res.sendStatus(204));
//     router.options("/ai/chat", (req, res) => res.sendStatus(204));
//     router.options("/ai/read-question", (req, res) => res.sendStatus(204));


// }

applyCustomCors(router)

// AI routes — verifyAnswers/verifyAnswer/chat live in aiController, not questionController
router.post("/ai/verify-answers", aiController.verifyAnswers);
router.post("/ai/verify-answer", aiController.verifyAnswer);
router.post("/ai/chat", aiController.chat);
router.post("/ai/read-question", aiController.readQuestion)

module.exports = router;
const express = require("express");
const router = express.Router();


const aiController = require("../controller/aiController");

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


    router.options("/ai/verify-answers", (req, res) => res.sendStatus(204));
    router.options("/ai/verify-answer", (req, res) => res.sendStatus(204));
    router.options("/ai/chat", (req, res) => res.sendStatus(204));


}


// AI routes — verifyAnswers/verifyAnswer/chat live in aiController, not questionController
router.post("/ai/verify-answers", aiController.verifyAnswers);
router.post("/ai/verify-answer", aiController.verifyAnswer);
router.post("/ai/chat", aiController.chat);

module.exports = router;
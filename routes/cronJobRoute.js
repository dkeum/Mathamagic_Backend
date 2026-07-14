const express = require("express");
const router = express.Router();

const { cleanUpOldVideos } = require("../api/cron/cleanupvideos");

const {refreshFxRate} = require("../api/cron/refresh-fx-rate")

if (process.env.NODE_ENV !== "DEVELOPMENT") {
    const setCorsHeaders = (req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); // Added Authorization for the cron secret
        res.setHeader("Access-Control-Allow-Credentials", "true");
        next();
    };

    router.use(setCorsHeaders);
}


// Vercel Cron Endpoint
router.get("/cron/cleanup", cleanUpOldVideos);
router.get("/cron/refresh-fx-rate", refreshFxRate);

module.exports = router;
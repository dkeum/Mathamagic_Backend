const express = require("express");
const router = express.Router();

const { googleCalendarWatchRefresh } = require("../api/cron/googleCalendar_WatchRefresh");
const { googleCalendarWebhook } = require("../controller/4_GoogleCalendar_Webhook");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Register BEFORE applyCustomCors so Google's requests (no Origin header) aren't rejected
router.post("/google-calendar/webhook", googleCalendarWebhook);
router.get("/cron/google-calendar-watch-refresh", googleCalendarWatchRefresh);

applyCustomCors(router);

module.exports = router;
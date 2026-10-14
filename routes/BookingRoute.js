
const express = require("express");
const router = express.Router();

const { googleCalendarWatchRefresh } = require("../api/cron/googleCalendar_WatchRefresh");
const { googleCalendarWebhook } = require("../controller/4_GoogleCalendar_Webhook");
const {
    getBookings,
    sendBookingEmail,
    downloadIcs,
    cancelBooking,
    rescheduleBooking,
} = require("../controller/bookingLinks");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Everything registered BEFORE applyCustomCors skips the CORS check. These routes need that because
// the callers don't send a browser Origin the CORS helper would accept:
//  - Google's webhook and your cron (no Origin header)
//  - /bookings/email, called server-to-server by the webhook (protected by x-internal-token)
//  - the email links (ics / cancel / reschedule) are opened directly by a parent clicking in their inbox,
//    and the confirm button posts back to this same API, so there's no cross-site request to check
router.post("/google-calendar/webhook", googleCalendarWebhook);

router.get("/cron/google-calendar-watch-refresh", googleCalendarWatchRefresh);

// Booking a call flow
// router.post("/bookings/email", sendBookingEmail);
router.get("/bookings/ics", downloadIcs);
router.get("/bookings/cancel", cancelBooking); // shows the confirm page
router.post("/bookings/cancel", cancelBooking); // does the cancel
router.get("/bookings/reschedule", rescheduleBooking); // shows the confirm page
router.post("/bookings/reschedule", rescheduleBooking); // cancels, then sends them to pick a new time

applyCustomCors(router);

// Admin only: this returns every booker's name and email. Put your auth middleware in front before enabling it.
// router.get("/bookings", getBookings);

module.exports = router;



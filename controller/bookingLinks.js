const jwt = require("jsonwebtoken");
const supabase = require("../config/leadSupabaseClient");
const calendar = require("../config/googleCalendarClient");
const { stamp } = require("./email_template/bookingEmailTemplates");

function readToken(req, action) {
    const p = jwt.verify(req.query.token, process.env.EMAIL_VERIFY_SECRET);
    if (p.action !== action) throw new Error("wrong action");
    return p.bookingId;
}

const page = (body) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">${body}</body>`;

// GET /api/bookings/ics?token=...
async function downloadIcs(req, res) {
    try {
        const id = readToken(req, "ics");
        const { data: b } = await supabase.from("bookings").select("*").eq("id", id).single();
        const ics = [
            "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mathmagick//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
            `UID:${b.google_event_id}@mathmagick.com`,
            `DTSTAMP:${stamp(new Date())}`,
            `DTSTART:${stamp(b.start_time)}`,
            `DTEND:${stamp(b.end_time)}`,
            "SUMMARY:Mathmagick call",
            `DESCRIPTION:Join: ${b.meet_link || ""}`,
            `LOCATION:${b.meet_link || ""}`,
            "END:VEVENT", "END:VCALENDAR",
        ].join("\r\n");
        res.set({
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="mathmagick-call.ics"'
        });
        res.send(ics);
    } catch { res.status(400).send("Invalid or expired link."); }
}

function cancelOrReschedule(action) {
    return async (req, res) => {
        try {
            const id = readToken(req, action);
            const { data: b } = await supabase.from("bookings").select("*").eq("id", id).single();

            if (b.status !== "confirmed") return res.send(page("<p>This booking has already been cancelled.</p>"));
            if (new Date(b.start_time) - Date.now() < 2 * 60 * 60 * 1000) {
                return res.send(page("<p>Sorry, changes need at least 2 hours’ notice. Please reply to my email and I’ll sort it out.</p>"));
            }

            if (req.method === "GET") {
                const label = action === "cancel" ? "Cancel my call" : "Cancel and pick a new time";
                return res.send(page(`<h2>${label}?</h2>
          <form method="POST" action="${req.originalUrl}"><button style="padding:12px 24px;font-size:16px;">Yes, continue</button></form>`));
            }

            await calendar.events.delete({
                calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: b.google_event_id, sendUpdates: "none",
            });
            // Google then notifies your webhook, and handleEvent cancels the reminders

            if (action === "reschedule") return res.redirect(process.env.BOOKING_PAGE_URL);
            return res.send(page("<p>Your call has been cancelled.</p>"));
        } catch (e) {
            console.error(`${action} failed:`, e.message);
            res.status(400).send("Invalid or expired link.");
        }
    };
}

module.exports = {
    downloadIcs,
    cancelBooking: cancelOrReschedule("cancel"),
    rescheduleBooking: cancelOrReschedule("reschedule"),
};
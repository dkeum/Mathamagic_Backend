const asyncHandler = require("express-async-handler");
const supabase = require("../config/leadSupabaseClient"); // service role client
const calendar = require("../config/googleCalendarClient"); // your authed google.calendar(...)
const transporter = require("../config/mailer"); // <- adjust: your nodemailer transporter
const TEMPLATES = require("./bookingEmailTemplates");

const API_BASE = (process.env.API_BASE_URL || "").replace(/\/$/, ""); // e.g. https://api.mathmagick.com/api
const SITE_URL = (process.env.FRONTEND_URL || "https://mathmagick.com").replace(/\/$/, "");
const CANCEL_NOTICE_MS = 2 * 60 * 60 * 1000; // matches "please give 2 hours notice" in the emails
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------- helpers */

const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function getBooking(id) {
    if (!UUID_RE.test(String(id || ""))) return null;
    const { data } = await supabase.from("bookings").select("*").eq("id", id).maybeSingle();
    return data || null;
}

// Replaces {{some.key}} with vars["some.key"]
const render = (text, vars) => text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => vars[k] ?? "");

function formatWhen(booking) {
    const tz = booking.timezone || process.env.DEFAULT_TIMEZONE || "America/Vancouver";
    const d = new Date(booking.start_time);
    const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    return {
        date: fmt({ weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d),
        time: fmt({ hour: "numeric", minute: "2-digit" }).format(d),
        tzName: fmt({ timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || tz,
    };
}

const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s) =>
    String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsFold = (line) => (line.match(/.{1,70}/g) || [""]).join("\r\n ");

function endOf(booking) {
    return booking.end_time || new Date(new Date(booking.start_time).getTime() + 30 * 60 * 1000).toISOString();
}

function linksFor(booking) {
    const meet = booking.meet_link || "";
    const gcal = new URLSearchParams({
        action: "TEMPLATE",
        text: "Call with Mathmagick",
        dates: `${icsDate(booking.start_time)}/${icsDate(endOf(booking))}`,
        details: `Math tutoring call.${meet ? `\nJoin: ${meet}` : ""}`,
        location: meet,
    });
    return {
        google: `https://calendar.google.com/calendar/render?${gcal}`,
        ics: `${API_BASE}/bookings/ics?id=${booking.id}`,
        cancel: `${API_BASE}/bookings/cancel?id=${booking.id}`,
        reschedule: `${API_BASE}/bookings/reschedule?id=${booking.id}`,
    };
}

function toHtml(text) {
    return esc(text)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .replace(/\n/g, "<br>");
}

// Small standalone HTML page for the cancel / reschedule links
function page(res, status, title, bodyHtml) {
    return res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1b2559}
h1{font-size:24px}button,a.btn{display:inline-block;font:600 16px system-ui;padding:10px 18px;border-radius:8px;border:0;background:#0b7a8c;color:#fff;text-decoration:none;cursor:pointer}
.muted{color:#5a6488}</style></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`);
}

/* ------------------------------------------------- POST /bookings/email */
// Called by the Google Calendar webhook. Body: { bookingId, template? } (template defaults to "email1").
// Details are read from the database, so any other fields in the body are ignored.
const sendBookingEmail = asyncHandler(async (req, res) => {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected || req.get("x-internal-token") !== expected) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { bookingId, template = "email1" } = req.body || {};
    const tpl = TEMPLATES[template];
    if (!tpl) return res.status(400).json({ error: `Unknown template "${template}"` });

    const booking = await getBooking(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "confirmed") {
        return res.status(200).json({ skipped: `Booking is ${booking.status}` });
    }
    if (!booking.booker_email) return res.status(400).json({ error: "Booking has no email" });

    const when = formatWhen(booking);
    const links = linksFor(booking);
    const vars = {
        "user.name": process.env.OWNER_NAME || "Mathmagick",
        "appointment.only_start_date": when.date,
        "appointment.only_start_time": when.time,
        "appointment.timezone": when.tzName,
        "appointment.meeting_location": booking.meet_link || "I'll send the link before the call",
        "appointment.add_to_google_calendar": links.google,
        "appointment.add_to_ical_outlook": links.ics,
        "appointment.cancellation_link": links.cancel,
        "appointment.reschedule_link": links.reschedule,
    };

    const text = render(tpl.body, vars);
    await transporter.sendMail({
        from: `"Mathmagick" <${process.env.NOREPLY_GMAIL}>`,
        replyTo: process.env.OWNER_EMAIL,
        to: booking.booker_email,
        subject: render(tpl.subject, vars),
        text,
        html: toHtml(text),
    });

    res.status(200).json({ ok: true, template, to: booking.booker_email });
});

/* --------------------------------------------------- GET /bookings/ics */
const downloadIcs = asyncHandler(async (req, res) => {
    const booking = await getBooking(req.query.id);
    if (!booking || !booking.start_time) return res.status(404).send("Booking not found.");
    if (booking.status === "cancelled") return res.status(410).send("This booking was cancelled.");

    const meet = booking.meet_link || "";
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Mathmagick//Booked Call//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${booking.id}@mathmagick.com`,
        `DTSTAMP:${icsDate(new Date())}`,
        `DTSTART:${icsDate(booking.start_time)}`,
        `DTEND:${icsDate(endOf(booking))}`,
        `SUMMARY:${icsText("Call with Mathmagick")}`,
        `DESCRIPTION:${icsText(`Math tutoring call.${meet ? `\nJoin: ${meet}` : ""}`)}`,
        ...(meet ? [`LOCATION:${icsText(meet)}`, `URL:${meet}`] : []),
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ];

    res.set({
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="mathmagick-call.ics"',
    });
    res.send(lines.map(icsFold).join("\r\n") + "\r\n");
});

/* ------------------------------ GET/POST /bookings/cancel and /reschedule */

// Cancels the Google event (which also emails the attendee) and updates the database.
// The calendar webhook will later see the cancellation too; it does the same updates, so that's harmless.
async function cancelBookingCore(booking) {
    try {
        await calendar.events.delete({
            calendarId: "primary",
            eventId: booking.google_event_id,
            sendUpdates: "all",
        });
    } catch (err) {
        if (![404, 410].includes(err.code)) throw err; // already gone is fine
    }

    await supabase
        .from("bookings")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", booking.id);
    await supabase.rpc("schedule_booking_messages", { p_booking_id: booking.id }); // cancels pending reminders
    if (booking.lead_id) {
        await supabase.from("leads").update({ stage: "cancelled" })
            .eq("id", booking.lead_id).eq("stage", "booked_call");
    }
}

// GET only shows a confirm button (so email link scanners can't cancel by accident); POST does the work.
function manageBooking(action) {
    const isCancel = action === "cancel";
    return asyncHandler(async (req, res) => {
        const booking = await getBooking(req.query.id);
        if (!booking) {
            return page(res, 404, "Link not valid", `<p class="muted">We couldn't find that booking. Please reply to your confirmation email and I'll sort it out.</p>`);
        }
        if (booking.status === "cancelled") {
            return page(res, 200, "Already cancelled", `<p>This call has already been cancelled.</p><p><a class="btn" href="${SITE_URL}/calendar-booking">Book a new time</a></p>`);
        }

        const msUntil = new Date(booking.start_time).getTime() - Date.now();
        if (msUntil <= 0) {
            return page(res, 200, "This call has already happened", `<p class="muted">Reply to your confirmation email if you'd like to book another one.</p>`);
        }
        if (msUntil < CANCEL_NOTICE_MS) {
            return page(res, 200, "Too close to the call", `<p>Your call starts in less than 2 hours, so it can't be changed from this link.</p><p class="muted">Please reply to your confirmation email and I'll help directly.</p>`);
        }

        const when = formatWhen(booking);
        const whenText = `${when.date}, ${when.time} ${when.tzName}`;
        const action_url = `${API_BASE}/bookings/${action}?id=${booking.id}`;

        if (req.method === "GET") {
            return page(
                res,
                200,
                isCancel ? "Cancel your call?" : "Reschedule your call?",
                `<p>Your call is booked for <b>${esc(whenText)}</b>.</p>
                 <p class="muted">${isCancel
                    ? "Cancelling frees up the time slot."
                    : "This cancels your current time, then takes you to pick a new one."}</p>
                 <form method="POST" action="${esc(action_url)}"><button type="submit">${isCancel ? "Yes, cancel my call" : "Yes, pick a new time"}</button></form>`
            );
        }

        // POST
        await cancelBookingCore(booking);
        if (isCancel) {
            return page(res, 200, "Your call has been cancelled", `<p>No problem. If you'd like to talk another time you can book again whenever you're ready.</p><p><a class="btn" href="${SITE_URL}/calendar-booking">Book a new time</a></p>`);
        }
        return res.redirect(303, `${SITE_URL}/calendar-booking`);
    });
}

const cancelBooking = manageBooking("cancel");
const rescheduleBooking = manageBooking("reschedule");

/* ---------------------------------------------------------- GET /bookings */
// @ GET /api/bookings?status=confirmed&from=2026-10-01&to=2026-10-31&limit=50&offset=0
const getBookings = asyncHandler(async (req, res) => {
    const { status, from, to, email } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let q = supabase
        .from("bookings")
        .select("*, lead:leads(id, first_name, stage)", { count: "exact" })
        .order("start_time", { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) q = q.eq("status", status);
    if (from) q = q.gte("start_time", from);
    if (to) q = q.lte("start_time", to);
    if (email) q = q.ilike("booker_email", email);

    const { data, error, count } = await q;
    if (error) {
        console.error("getBookings failed:", error.message);
        return res.status(500).json({ error: "Failed to load bookings." });
    }

    res.status(200).json({ bookings: data, total: count, limit, offset });
});

module.exports = { getBookings, sendBookingEmail, downloadIcs, cancelBooking, rescheduleBooking };

/*
Your flow notes, for reference:
1) Remove "lead follow up" tag, add "booked call" tag, move to booked-call opportunity   -> done in the webhook
2) Internal notification                                                                 -> done in the webhook
3) Wait ~1 min for the Zoom link, then send the booked-call confirmation email           -> sendBookingEmail("email1")
4) 24 hour reminder, 1 hour reminder                                                     -> call sendBookingEmail with template "email2" / "email3"
*/
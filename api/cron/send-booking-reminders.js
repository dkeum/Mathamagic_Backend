const supabase = require("../../config/leadSupabaseClient"); // service role client (same one the calendar webhook uses)

/**
 * Daily cron: sends the "your call is tomorrow" reminder (email2 in bookingEmailTemplates.js).
 *
 * "Tomorrow" means tomorrow's calendar day in REMINDER_TIMEZONE, not "exactly 24 hours from now".
 * That fits a once-a-day schedule: every call that starts tomorrow gets one reminder, no matter
 * what hour it's at, and nothing depends on the cron firing at an exact minute.
 *
 * How it works
 * - schedule_booking_messages (called by the calendar webhook) fills booking_messages with one
 *   pending email2 row per booking. This cron finds the pending rows whose call is tomorrow and sends them.
 *   Other template_key rows (e.g. the old email3 1-hour rows) are ignored.
 * - Rows are marked skipped (not sent) if the booking was cancelled, was rescheduled since the row
 *   was made, or the call isn't tomorrow anymore (e.g. it was booked same-day).
 * - Emails are sent through your existing POST /bookings/email route, same as the confirmation.
 */

// ---- Adjust these if needed ----
// "Tomorrow" is calculated in this timezone (Vercel crons themselves run in UTC)
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE || "America/Vancouver";
// booking_messages.template_key -> email template key in bookingEmailTemplates.js
const REMINDERS = {
    email2: { label: "day-before" },
};
// Values of your message_status enum. Check with: select enum_range(null::message_status);
const STATUS = { pending: "pending", sent: "sent", failed: "failed", skipped: "cancelled" };

const SEND_TRIES = 3; // retries happen inside the same run, because tomorrow's run would be too late
const BATCH_SIZE = 100;
// --------------------------------

// ---- Timezone helpers (no libraries needed) ----
function zonedParts(date, tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

// The instant a calendar day starts in the given timezone (d may overflow, e.g. d + 1)
function startOfZonedDay(y, m, d, tz) {
    const wallClockAsUtc = Date.UTC(y, m - 1, d);
    let instant = wallClockAsUtc;
    for (let i = 0; i < 2; i++) { // second pass fixes daylight-saving edges
        const p = zonedParts(new Date(instant), tz);
        const shownAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
        instant += wallClockAsUtc - shownAsUtc;
    }
    return new Date(instant);
}

// [start, end) of tomorrow's calendar day in REMINDER_TIMEZONE
function getTomorrowWindow() {
    const now = zonedParts(new Date(), REMINDER_TIMEZONE);
    return {
        start: startOfZonedDay(now.y, now.m, now.d + 1, REMINDER_TIMEZONE),
        end: startOfZonedDay(now.y, now.m, now.d + 2, REMINDER_TIMEZONE),
    };
}
// ------------------------------------------------

async function callBookingEmailRoute(payload) {
    if (!process.env.API_BASE_URL || !process.env.INTERNAL_API_TOKEN) {
        throw new Error("API_BASE_URL or INTERNAL_API_TOKEN is not set");
    }

    const res = await fetch(`${process.env.API_BASE_URL}/bookings/email`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-internal-token": process.env.INTERNAL_API_TOKEN,
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        throw new Error(`/bookings/email responded ${res.status}: ${await res.text()}`);
    }
}

async function sendWithRetry(payload) {
    let lastError;
    for (let attempt = 1; attempt <= SEND_TRIES; attempt++) {
        try {
            return await callBookingEmailRoute(payload);
        } catch (e) {
            lastError = e;
            if (attempt < SEND_TRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
        }
    }
    throw lastError;
}

async function markMessage(id, fields) {
    const { error } = await supabase.from("booking_messages").update(fields).eq("id", id);
    if (error) console.error(`Could not update booking_messages ${id}:`, error.message);
}

// Returns a reason string if this reminder should NOT be sent, otherwise null
function getSkipReason(msg, booking, window) {
    if (!booking) return "booking not found";
    if (booking.status !== "confirmed") return `booking is ${booking.status}`;
    if (!booking.booker_email) return "booking has no booker email";

    const start = new Date(booking.start_time).getTime();
    if (!Number.isFinite(start)) return "booking has no start time";

    // The call was moved after this row was created; schedule_booking_messages makes new rows for the new time
    if (msg.for_start_time && new Date(msg.for_start_time).getTime() !== start) {
        return "booking was rescheduled";
    }

    // Booked same-day, or already in the past: a "tomorrow" email would be wrong
    if (start < window.start.getTime()) return "call is not tomorrow";
    return null;
}

async function processDueReminders() {
    const window = getTomorrowWindow();

    const { data: due, error } = await supabase
        .from("booking_messages")
        .select(
            "id, template_key, for_start_time, attempts, " +
            "booking:bookings(id, status, start_time, end_time, booker_name, booker_email, timezone, meet_link)"
        )
        .eq("status", STATUS.pending)
        .in("template_key", Object.keys(REMINDERS))
        .lt("run_at", window.end.toISOString()) // anything whose reminder time is before the end of tomorrow
        .order("run_at", { ascending: true })
        .limit(BATCH_SIZE);
    if (error) throw error;

    const result = {
        window: `${window.start.toISOString()} to ${window.end.toISOString()}`,
        due: 0, sent: 0, skipped: 0, failed: 0,
    };

    for (const msg of due) {
        const booking = msg.booking;

        // Call is after tomorrow: leave the row for a later run
        const start = booking ? new Date(booking.start_time).getTime() : NaN;
        if (Number.isFinite(start) && start >= window.end.getTime()) continue;

        result.due++;

        // Claim the row: only one run can bump attempts from N to N+1, so overlapping runs can't double-send
        const { data: claimed } = await supabase
            .from("booking_messages")
            .update({ attempts: msg.attempts + 1 })
            .eq("id", msg.id)
            .eq("status", STATUS.pending)
            .eq("attempts", msg.attempts)
            .select("id")
            .maybeSingle();
        if (!claimed) continue;

        const skipReason = getSkipReason(msg, booking, window);
        if (skipReason) {
            await markMessage(msg.id, { status: STATUS.skipped, error: skipReason });
            result.skipped++;
            continue;
        }

        try {
            await sendWithRetry({
                bookingId: booking.id,
                templateKey: msg.template_key, // /bookings/email must honour this (defaults to email1)
                name: booking.booker_name,
                email: booking.booker_email,
                startTime: booking.start_time,
                endTime: booking.end_time,
                timezone: booking.timezone,
                meetLink: booking.meet_link,
            });
            await markMessage(msg.id, {
                status: STATUS.sent,
                sent_at: new Date().toISOString(),
                error: null,
            });
            result.sent++;
        } catch (e) {
            console.error(`Reminder failed for booking ${booking.id}:`, e.message);
            await markMessage(msg.id, { status: STATUS.failed, error: e.message.slice(0, 500) });
            result.failed++;
        }
    }

    return result;
}

async function sendBookingReminders(req, res) {
    // Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron invocations
    if (!process.env.CRON_SECRET) {
        console.error("CRON_SECRET is not set");
        return res.sendStatus(500);
    }
    if (req.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.sendStatus(401);
    }

    try {
        const result = await processDueReminders();
        console.log("Booking reminders:", result);
        return res.status(200).json(result);
    } catch (err) {
        console.error("send-booking-reminders failed:", err);
        return res.sendStatus(500);
    }
}

module.exports = { sendBookingReminders };
const supabase = require("../config/leadSupabaseClient"); // service role client
const transporter = require("../config/mailer");
const templates = require("./email_template/bookingEmailTemplates");

const SITE_URL = process.env.SITE_URL || "https://mathmagick.com";
const DEFAULT_TZ = "America/Vancouver";

// ---------- helpers ----------

function formatParts(startTime, timezone) {
    const tz = timezone || DEFAULT_TZ;
    const d = new Date(startTime);
    if (isNaN(d)) throw new Error("Invalid startTime");

    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(d);
    const tzName =
        new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
            .formatToParts(d)
            .find((p) => p.type === "timeZoneName")?.value || tz;

    return { date, time, tzName };
}

const toGcalDate = (iso) =>
    new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function buildCalendarLinks({ startTime, endTime, meetLink }) {
    // Fall back to a 30 minute call if no end time was passed
    const end = endTime || new Date(new Date(startTime).getTime() + 30 * 60000).toISOString();
    const title = "Mathmagick call";
    const details = meetLink ? `Join: ${meetLink}` : "Mathmagick call";

    const google = `https://calendar.google.com/calendar/render?${new URLSearchParams({
        action: "TEMPLATE",
        text: title,
        dates: `${toGcalDate(startTime)}/${toGcalDate(end)}`,
        details,
        location: meetLink || "",
    })}`;

    const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?${new URLSearchParams({
        path: "/calendar/action/compose",
        rru: "addevent",
        subject: title,
        startdt: new Date(startTime).toISOString(),
        enddt: new Date(end).toISOString(),
        body: details,
        location: meetLink || "",
    })}`;

    return { google, outlook };
}

// Has this person already been sent the program documents (any earlier booking or their lead row)?
async function hasReceivedDocs(email) {
    const e = email.toLowerCase();
    const { data: lead } = await supabase
        .from("leads").select("id")
        .eq("email", e).not("program_docs_sent_at", "is", null)
        .limit(1).maybeSingle();
    if (lead) return true;

    const { data: booking } = await supabase
        .from("bookings").select("id")
        .eq("booker_email", e).not("program_docs_sent_at", "is", null)
        .limit(1).maybeSingle();
    return !!booking;
}

// Keeps or removes {{#docs}} ... {{/docs}} blocks in a template
function applyDocsBlocks(text, includeDocs) {
    return text
        .replace(/\{\{#docs\}\}([\s\S]*?)\{\{\/docs\}\}/g, includeDocs ? "$1" : "")
        .replace(/\n{3,}/g, "\n\n");
}

function fillPlaceholders(text, values) {
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
        if (!(key in values)) console.warn(`Unknown email placeholder: ${key}`);
        return values[key] ?? "";
    });
}

function toHtml(text) {
    const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return escaped
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .replace(/\n/g, "<br>");
}

// ---------- core (callable directly from cron code, no HTTP needed) ----------

async function sendBookingEmailCore({
    template = "email1",
    email,
    startTime,
    endTime,
    timezone,
    meetLink,
    includeProgramDocs, // undefined = work it out from the database
    cancellationLink,
    rescheduleLink,
}) {
    const tpl = templates[template];
    if (!tpl) throw new Error(`Unknown email template: ${template}`);
    if (!email) throw new Error("email is required");
    if (!startTime) throw new Error("startTime is required");

    const includeDocs =
        typeof includeProgramDocs === "boolean"
            ? includeProgramDocs
            : !(await hasReceivedDocs(email));

    const { date, time, tzName } = formatParts(startTime, timezone);
    const links = buildCalendarLinks({ startTime, endTime, meetLink });

    const values = {
        "user.name": process.env.SENDER_NAME || "Dan", // the sender, not the parent
        "appointment.only_start_date": date,
        "appointment.only_start_time": time,
        "appointment.timezone": tzName,
        "appointment.meeting_location": meetLink || "(link will be sent before the call)",
        "appointment.add_to_google_calendar": links.google,
        "appointment.add_to_ical_outlook": links.outlook,
        "appointment.cancellation_link": cancellationLink || `${SITE_URL}/calendar-booking`,
        "appointment.reschedule_link": rescheduleLink || `${SITE_URL}/calendar-booking`,
    };

    const subjectRaw = !includeDocs && tpl.subjectNoDocs ? tpl.subjectNoDocs : tpl.subject;
    const subject = fillPlaceholders(subjectRaw, values);
    const text = fillPlaceholders(applyDocsBlocks(tpl.body, includeDocs), values);

    await transporter.sendMail({
        from: `"Mathmagick" <${process.env.NOREPLY_GMAIL}>`,
        replyTo: process.env.OWNER_EMAIL, // your emails ask parents to reply
        to: email,
        subject,
        text,
        html: toHtml(text),
    });
}

// ---------- Express handler: POST /bookings/email ----------

async function sendBookingEmail(req, res) {
    if (
        !process.env.INTERNAL_API_TOKEN ||
        req.get("x-internal-token") !== process.env.INTERNAL_API_TOKEN
    ) {
        return res.sendStatus(401);
    }

    try {
        await sendBookingEmailCore(req.body || {});
        return res.sendStatus(200);
    } catch (err) {
        console.error("sendBookingEmail failed:", err);
        const bad = /required|Unknown email template|Invalid startTime/.test(err.message);
        return res.status(bad ? 400 : 500).send(err.message);
    }
}

module.exports = { sendBookingEmail, sendBookingEmailCore };
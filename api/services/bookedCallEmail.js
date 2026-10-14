const jwt = require("jsonwebtoken");

const bookedCallTemplates = {
    booked_call_confirmation: {
        subject: "[Important] How to prepare for your call",
        body: `...your email1 body, unchanged...`,
    },
    booked_call_24h: {
        subject: "Your Mathmagick call is tomorrow",
        body: `...your email2 body, unchanged...`,
    },
    booked_call_1h: {
        subject: "We’re speaking in 1 hour",
        body: `...your email3 body, unchanged...`,
    },
};

// Throws on a missing variable, so a blank never goes out silently
function render(str, vars) {
    return str.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
        const v = vars[key];
        if (v == null || v === "") throw new Error(`Missing template variable: ${key}`);
        return v;
    });
}

function toHtml(text) {
    const escaped = text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    return `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#191c1e;">${linked.replace(/\n/g, "<br>")}</div>`;
}

function formatWhen(startIso, tz) {
    const d = new Date(startIso);
    const f = (opts) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts });
    return {
        date: f({ weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d),
        time: f({ hour: "numeric", minute: "2-digit", hour12: true }).format(d),
        tzName: f({ timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || tz,
    };
}

const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function googleCalendarUrl({ start, end, link }) {
    return "https://calendar.google.com/calendar/render?" + new URLSearchParams({
        action: "TEMPLATE",
        text: "Mathmagick call",
        dates: `${stamp(start)}/${stamp(end)}`,
        details: link ? `Join: ${link}` : "Mathmagick call",
        location: link || "",
    });
}

function signLink(bookingId, action) {
    const token = jwt.sign({ bookingId, action }, process.env.EMAIL_VERIFY_SECRET, { expiresIn: "60d" });
    return `${process.env.API_BASE_URL}/api/bookings/${action}?token=${token}`;
}

module.exports = { bookedCallTemplates, render, toHtml, formatWhen, googleCalendarUrl, signLink, stamp };
const supabase = require("../config/leadSupabaseClient");
const transporter = require("../config/mailer");
const {
    bookedCallTemplates, render, toHtml, formatWhen, googleCalendarUrl, signLink,
} = require("./bookedCallEmails");

async function runBookingWorker() {
    // Release rows stuck in 'processing' after a crash
    await supabase.from("booking_messages").update({ status: "pending" })
        .eq("status", "processing")
        .lt("run_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

    const { data: due, error } = await supabase.rpc("claim_due_booking_messages", { batch_size: 20 });
    if (error) return console.error("claim_due_booking_messages failed:", error.message);

    for (const m of due) {
        try {
            if (!m.booker_email) throw new Error("Booking has no booker email");

            // Confirmation: if the Zoom/Meet link isn't on the event yet, wait 2 more minutes once
            if (!m.meet_link && m.template_key === "booked_call_confirmation" && m.attempts < 2) {
                await supabase.from("booking_messages")
                    .update({ status: "pending", run_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() })
                    .eq("id", m.message_id);
                continue;
            }

            const tpl = bookedCallTemplates[m.template_key];
            if (!tpl) throw new Error(`No template for ${m.template_key}`);

            const tz = m.timezone || process.env.BUSINESS_TIMEZONE || "America/Vancouver";
            const when = formatWhen(m.start_time, tz);

            const vars = {
                "user.name": process.env.OWNER_NAME,
                "appointment.only_start_date": when.date,
                "appointment.only_start_time": when.time,
                "appointment.timezone": when.tzName,
                "appointment.meeting_location": m.meet_link || "I’ll send the link in a separate message shortly",
                "appointment.add_to_google_calendar": googleCalendarUrl({ start: m.start_time, end: m.end_time, link: m.meet_link }),
                "appointment.add_to_ical_outlook": signLink(m.booking_id, "ics"),
                "appointment.cancellation_link": signLink(m.booking_id, "cancel"),
                "appointment.reschedule_link": signLink(m.booking_id, "reschedule"),
            };

            const text = render(tpl.body, vars);
            await transporter.sendMail({
                from: `"${process.env.OWNER_NAME}" <${process.env.NOREPLY_GMAIL}>`,
                replyTo: process.env.REPLY_TO_EMAIL || process.env.OWNER_EMAIL,
                to: m.booker_email,
                subject: render(tpl.subject, vars),
                text,
                html: toHtml(text),
            });

            await supabase.rpc("complete_booking_message", { p_message_id: m.message_id, p_success: true });
        } catch (err) {
            console.error("booking message failed:", m.template_key, err.message);
            await supabase.rpc("complete_booking_message", {
                p_message_id: m.message_id, p_success: false, p_error: err.message,
            });
        }
    }
}

module.exports = { runBookingWorker };
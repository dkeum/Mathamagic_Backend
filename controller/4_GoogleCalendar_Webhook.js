const supabase = require("../config/leadSupabaseClient"); // service role client
const calendar = require("../config/googleCalendarClient"); // your authed google.calendar(...)
const transporter = require("../config/mailer"); // <- adjust: your nodemailer transporter (it was used but never imported)

/**
 * Calls your existing POST /bookings/email route.
 * API_BASE_URL must be the full base your router is mounted on, e.g. https://api.mathmagick.com/api
 * INTERNAL_API_TOKEN is a shared secret so only this webhook (not the public) can trigger the email.
 */
async function callBookingEmailRoute(payload) {
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

async function syncCalendarChanges(retry = true) {
    const { data: row } = await supabase
        .from("calendar_sync_state")
        .select("sync_token")
        .eq("calendar_id", "primary")
        .maybeSingle();

    const syncToken = row?.sync_token || undefined;
    const changed = [];
    let pageToken;
    let nextSyncToken;

    try {
        do {
            const { data } = await calendar.events.list({
                calendarId: "primary",
                singleEvents: true,
                showDeleted: true,
                conferenceDataVersion: 1,
                pageToken,
                ...(syncToken
                    ? { syncToken }
                    : { timeMin: new Date().toISOString() }), // timeMin can't be combined with syncToken
            });
            changed.push(...(data.items || []));
            pageToken = data.nextPageToken;
            nextSyncToken = data.nextSyncToken;
        } while (pageToken);
    } catch (err) {
        // 410 = sync token expired; throw it away and start over
        if (err.code === 410 && retry) {
            await supabase
                .from("calendar_sync_state")
                .update({ sync_token: null })
                .eq("calendar_id", "primary");
            return syncCalendarChanges(false);
        }
        throw err;
    }

    // Only save the token after the changes were processed successfully
    for (const event of changed) {
        await handleEvent(event);
    }

    await supabase.from("calendar_sync_state").upsert({
        calendar_id: "primary",
        sync_token: nextSyncToken,
        updated_at: new Date().toISOString(),
    });
}

async function handleEvent(event) {
    // Cancelled events from a sync only carry the id and status, nothing else
    if (event.status === "cancelled") {
        const { data: rows } = await supabase
            .from("bookings")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .eq("google_event_id", event.id)
            .select("id, lead_id");

        for (const row of rows || []) {
            await supabase.rpc("schedule_booking_messages", { p_booking_id: row.id }); // cancels pending reminders
            if (row.lead_id) {
                await supabase.from("leads").update({ stage: "cancelled" })
                    .eq("id", row.lead_id).eq("stage", "booked_call");
            }
        }
        return;
    }

    // The booker is the attendee who isn't you
    const me = (process.env.GOOGLE_CALENDAR_ID || "").toLowerCase();
    const guests = (event.attendees || []).filter(
        (a) => !a.resource && a.email?.toLowerCase() !== me
    );
    const booker = guests[0];
    const bookerEmail = booker?.email?.toLowerCase() || null;
    const bookerName = booker?.displayName || null;

    // Link to a lead if the email matches
    let leadId = null;
    if (bookerEmail) {
        const { data: lead } = await supabase
            .from("leads")
            .select("id")
            .eq("email", bookerEmail)
            .limit(1)
            .maybeSingle();
        leadId = lead?.id || null;
    }

    const videoEntry = event.conferenceData?.entryPoints?.find(
        (e) => e.entryPointType === "video"
    );
    const urlInText = `${event.location || ""} ${event.description || ""}`.match(
        /https?:\/\/[^\s"<]*(zoom\.us|teams\.microsoft\.com|meet\.google\.com)[^\s"<]*/i
    )?.[0];
    const meetLink = event.hangoutLink || videoEntry?.uri || urlInText || null;
    const startTime = event.start?.dateTime || event.start?.date || null;
    const endTime = event.end?.dateTime || event.end?.date || null;

    // Check BEFORE saving, so we know whether this booking is new
    const { data: existing } = await supabase
        .from("bookings").select("id").eq("google_event_id", event.id).maybeSingle();
    const isNew = !existing;

    // One save with every field (the booker's name and email are stored here)
    const { data: saved, error } = await supabase
        .from("bookings")
        .upsert(
            {
                google_event_id: event.id,
                status: "confirmed",
                title: event.summary || null,
                description: event.description || null,
                start_time: startTime,
                end_time: endTime,
                booker_email: bookerEmail,
                booker_name: bookerName,
                attendees: guests.map((a) => ({
                    email: a.email,
                    name: a.displayName,
                    response: a.responseStatus,
                })),
                meet_link: meetLink,
                lead_id: leadId,
                booked_at: event.created || null,
                timezone: event.start?.timeZone || null,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "google_event_id" }
        )
        .select("id, confirmation_email_sent_at")
        .single();
    if (error) throw error;

    // Move the lead to booked_call; the DB trigger cancels their pending follow-ups
    if (leadId) {
        await supabase
            .from("leads")
            .update({ stage: "booked_call" })
            .eq("id", leadId)
            .in("stage", ["new_lead", "cold_lead", "in_conversation", "follow_up"]);
        await supabase.rpc("apply_booked_call", { p_lead_id: leadId });
    }
    await supabase.rpc("schedule_booking_messages", { p_booking_id: saved.id });

    // Immediately call POST /bookings/email, once per booking.
    // confirmation_email_sent_at makes this safe if Google re-sends the same change.
    if (bookerEmail && !saved.confirmation_email_sent_at) {
        try {
            await callBookingEmailRoute({
                bookingId: saved.id,
                name: bookerName,
                email: bookerEmail,
                startTime,
                endTime,
                timezone: event.start?.timeZone || null,
                meetLink,
            });
            await supabase
                .from("bookings")
                .update({ confirmation_email_sent_at: new Date().toISOString() })
                .eq("id", saved.id);
        } catch (e) {
            // Never let an email problem break the calendar sync
            console.error("booking email failed:", e.message);
        }
    }

    if (isNew) {
        // Internal notification (never let this break the sync)
        transporter.sendMail({
            from: `"Mathmagick" <${process.env.NOREPLY_GMAIL}>`,
            to: process.env.OWNER_EMAIL,
            subject: `New booked call: ${bookerName || bookerEmail || "unknown"}`,
            text: `${bookerEmail || "No email"}\n${event.start?.dateTime}\n${meetLink || ""}`,
        }).catch((e) => console.error("owner notification failed:", e.message));
    }
}

async function googleCalendarWebhook(req, res) {
    if (req.get("X-Goog-Channel-Token") !== process.env.GOOGLE_WEBHOOK_TOKEN) {
        return res.sendStatus(401);
    }

    // Sent once right after the channel is created; nothing to fetch yet
    if (req.get("X-Goog-Resource-State") === "sync") {
        return res.sendStatus(200);
    }

    try {
        // Do the work BEFORE responding: Vercel freezes the function once the response is sent
        await syncCalendarChanges();
        return res.sendStatus(200);
    } catch (err) {
        console.error("calendar webhook failed:", err);
        return res.sendStatus(500); // Google retries with backoff
    }
}

module.exports = { googleCalendarWebhook };
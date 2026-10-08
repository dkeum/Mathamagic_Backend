const supabase = require("../config/leadSupabaseClient"); // service role client
const calendar = require("../config/googleCalendarClient"); // your authed google.calendar(...)

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
        await supabase
            .from("bookings")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .eq("google_event_id", event.id);
        return;
    }

    // The booker is the attendee who isn't you
    const me = (process.env.GOOGLE_CALENDAR_ID || "").toLowerCase();
    const guests = (event.attendees || []).filter(
        (a) => !a.resource && a.email?.toLowerCase() !== me
    );
    const booker = guests[0];
    const bookerEmail = booker?.email?.toLowerCase() || null;

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

    await supabase.from("bookings").upsert(
        {
            google_event_id: event.id,
            status: "confirmed",
            title: event.summary || null,
            description: event.description || null,
            start_time: event.start?.dateTime || event.start?.date || null,
            end_time: event.end?.dateTime || event.end?.date || null,
            booker_email: bookerEmail,
            booker_name: booker?.displayName || null,
            attendees: guests.map((a) => ({
                email: a.email,
                name: a.displayName,
                response: a.responseStatus,
            })),
            meet_link: event.hangoutLink || videoEntry?.uri || urlInText || null,
            lead_id: leadId,
            booked_at: event.created || null,
            updated_at: new Date().toISOString(),
        },
        { onConflict: "google_event_id" }
    );

    // Move the lead to booked_call; the DB trigger cancels their pending follow-ups
    if (leadId) {
        await supabase
            .from("leads")
            .update({ stage: "booked_call" })
            .eq("id", leadId)
            .in("stage", ["new_lead", "cold_lead", "in_conversation", "follow_up"]);
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
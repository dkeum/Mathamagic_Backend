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
    if (event.status === "cancelled") {
        // booking cancelled or deleted
        return;
    }
    // new or updated event: event.id, event.start, event.attendees, ...
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
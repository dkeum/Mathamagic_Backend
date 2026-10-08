const crypto = require("crypto");
const supabase = require("../../config/leadSupabaseClient");
const calendar = require("../../config/googleCalendarClient");

async function googleCalendarWatchRefresh(req, res) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized access" });
    }

    try {
        const { data: old } = await supabase
            .from("calendar_sync_state")
            .select("channel_id, resource_id")
            .eq("calendar_id", "primary")
            .maybeSingle();

        // Create the new channel first so there's no gap in coverage
        const { data: ch } = await calendar.events.watch({
            calendarId: "primary",
            requestBody: {
                id: crypto.randomUUID(),
                type: "web_hook",
                address: "https://mathamagic-backend.vercel.app/api/google-calendar/webhook",
                token: process.env.GOOGLE_WEBHOOK_TOKEN,
            },
        });

        await supabase.from("calendar_sync_state").upsert({
            calendar_id: "primary",
            channel_id: ch.id,
            resource_id: ch.resourceId,
            channel_expires_at: new Date(Number(ch.expiration)).toISOString(),
            updated_at: new Date().toISOString(),
        });

        // Stop the old one so you don't get duplicate notifications
        if (old?.channel_id && old?.resource_id) {
            await calendar.channels
                .stop({ requestBody: { id: old.channel_id, resourceId: old.resource_id } })
                .catch(() => { }); // already expired is fine
        }

        return res.status(200).json({ ok: true, expires: ch.expiration });
    } catch (err) {
        console.error("watch refresh failed:", err);
        return res.status(500).json({ error: "Watch refresh failed" });
    }
}

module.exports = { googleCalendarWatchRefresh };
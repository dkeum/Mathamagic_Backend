const supabase = require("../config/leadSupabaseClient"); // service role client

// These columns come from the leads table plus the migration from earlier
// (grade_level, is_qualified, first_message_at, calendar_link_*, lost_*, enroll*).
const LEAD_COLUMNS = [
    "id", "first_name", "email", "phone", "stage", "source", "created_at",
    "grade_level", "is_qualified", "first_message_at",
    "email_provided_at", "phone_provided_at",
    "calendar_link_clicked_at", "calendar_link_click_count",
    "messages_sent", "last_message_at", "last_response_at",
    "opportunity_active", "lost_reason", "lost_at",
    "enrolled_at", "enrollment_type",
].join(", ");

async function getLeadsDashboard(req, res) {
    try {
        // Same cookie auth you use elsewhere
        const token = req.cookies?.access_token;
        if (!token) return res.sendStatus(401);

        const { data: auth, error: authError } = await supabase.auth.getUser(token);
        if (authError || !auth?.user) return res.sendStatus(401);

        // Owner only: your own Supabase user id (same value the Messenger webhook uses)
        if (!process.env.OWNER_USER_ID || auth.user.id !== process.env.OWNER_USER_ID) {
            return res.sendStatus(403);
        }

        const { data: leads, error } = await supabase
            .from("leads")
            .select(LEAD_COLUMNS)
            .order("created_at", { ascending: false })
            .limit(1000);
        if (error) throw error;

        // Last inbound / outbound Messenger message per lead (view defined in the SQL below)
        const { data: activity, error: activityError } = await supabase
            .from("lead_messenger_activity")
            .select("lead_id, last_inbound_at, last_outbound_at");
        if (activityError) throw activityError;

        const byLead = new Map((activity || []).map((a) => [a.lead_id, a]));

        return res.json({
            leads: leads.map((l) => ({
                ...l,
                last_inbound_at: byLead.get(l.id)?.last_inbound_at || null,
                last_outbound_at: byLead.get(l.id)?.last_outbound_at || null,
            })),
        });
    } catch (err) {
        console.error("getLeadsDashboard failed:", err);
        return res.sendStatus(500);
    }
}

module.exports = { getLeadsDashboard };

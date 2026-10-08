// Trigger Google calendar Event

// Booked call Flow


/*
1) Remove Lead Follpw up tag

Booked call tag added


move to book call opportunity

internal notification

remove from all other workflows

wait 1 min fto allow zoom link generateion

booked call confirmation text/ email

wait before 24 


reminder text 

wait before 1 hours 

1 hour email reminder

1 hour text reminder


*/


// controllers/bookingsController.js
const asyncHandler = require("express-async-handler");
const supabase = require("../config/leadSupabaseClient"); // service role client

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

module.exports = { getBookings };
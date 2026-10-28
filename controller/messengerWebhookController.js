const crypto = require('crypto');
const supabaseAdmin = require('../config/supabaseClient'); // match your other controllers

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

// GET: Meta's one-time verification handshake
exports.verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
};

// Middleware: confirm the POST really came from Meta
exports.verifySignature = (req, res, next) => {
    const secret = process.env.FB_APP_SECRET;
    const sig = req.get('x-hub-signature-256') || '';
    if (!secret || !req.rawBody) return res.sendStatus(401);

    const expected =
        'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

    if (
        sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
        return res.sendStatus(401);
    }
    next();
};

// POST: incoming events
exports.handleWebhook = async (req, res) => {
    if (req.body.object !== 'page') return res.sendStatus(404);

    try {
        for (const entry of req.body.entry || []) {
            for (const evt of entry.messaging || []) {
                if (!evt.message || evt.message.is_echo) continue; // skip your own replies
                await captureContact(evt);
            }
        }
    } catch (err) {
        console.error('messenger webhook error', err);
    }

    // finish the work BEFORE responding: Vercel freezes the function after the response
    return res.sendStatus(200);
};

// ---------- helpers ----------

async function getProfileName(psid) {
    try {
        const r = await fetch(
            `https://graph.facebook.com/v23.0/${psid}?fields=first_name&access_token=${process.env.MESSENGER_PAGE_TOKEN}`
        );
        const j = await r.json();
        return j.first_name || null;
    } catch {
        return null;
    }
}

async function captureContact(evt) {
    const psid = evt.sender.id;
    const text = evt.message.text || evt.message.quick_reply?.payload || '';
    const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() || null;
    const phone = text.match(PHONE_RE)?.[0] || null;
    if (!email && !phone) return;

    const { data: existing } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('messenger_psid', psid)
        .maybeSingle();

    let leadId = existing?.id;

    if (leadId) {
        const patch = { updated_at: new Date().toISOString() };
        if (email) patch.email = email;
        if (phone) patch.phone = phone;
        const { error } = await supabaseAdmin.from('leads').update(patch).eq('id', leadId);
        if (error) throw error;
    } else {
        const first_name = (await getProfileName(psid)) || 'Messenger lead';
        const { data, error } = await supabaseAdmin
            .from('leads')
            .insert({
                owner_id: process.env.OWNER_USER_ID,
                first_name,
                email,
                phone,
                messenger_psid: psid,
                source: 'facebook_messenger',
            })
            .select('id')
            .single();
        if (error) throw error;
        leadId = data.id;
    }

    const { error: evtError } = await supabaseAdmin.from('lead_events').insert({
        lead_id: leadId,
        event_type: 'messenger_contact_captured',
        detail: { email: !!email, phone: !!phone },
    });
    if (evtError) console.error('lead_events insert failed', evtError);
}
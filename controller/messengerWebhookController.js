const crypto = require('crypto');
// NOTE: your calendar code uses ../config/leadSupabaseClient (service role) for the leads tables.
// Make sure this client also bypasses RLS, or the inserts below will fail silently.
const supabaseAdmin = require('../config/supabaseClient');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const GRADE_RE = /\b(?:grade\s*)?(9|10|nine|ten)(?:th)?\b/i;

const LEAD_COLS =
    'id, email, phone, stage, is_qualified, first_message_at, email_provided_at, phone_provided_at';

// ---------- unchanged: verifyWebhook, verifySignature ----------
exports.verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
};

exports.verifySignature = (req, res, next) => {
    const secret = process.env.FB_APP_SECRET;
    const sig = req.get('x-hub-signature-256') || '';

    if (!secret) {
        console.error('signature: FB_APP_SECRET is not set in Vercel');
        return res.sendStatus(401);
    }
    if (!req.rawBody) {
        console.error('signature: req.rawBody is missing (JSON parser is not saving it)');
        return res.sendStatus(401);
    }

    const expected =
        'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

    if (
        sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
        console.error('signature: mismatch', { hasHeader: !!sig, secretLength: secret.length });
        return res.sendStatus(401);
    }
    next();
};

// ---------- changed: incoming events ----------
exports.handleWebhook = async (req, res) => {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry || []) {
        for (const evt of entry.messaging || []) {
            try {
                if (evt.message?.is_echo) await handleEcho(evt);        // your replies / automation
                else if (evt.message || evt.postback) await handleInbound(evt); // their messages
            } catch (err) {
                // one bad event must not block the rest of the batch
                console.error('messenger event failed:', err);
            }
        }
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

function detectGrade(text) {
    // remove emails/phones first so digits in them can't look like a grade
    const cleaned = text.replace(EMAIL_RE, ' ').replace(PHONE_RE, ' ');
    const m = cleaned.match(GRADE_RE);
    if (!m) return null;
    const v = m[1].toLowerCase();
    return v === 'nine' ? 9 : v === 'ten' ? 10 : Number(v);
}

async function findLead(psid) {
    const { data, error } = await supabaseAdmin
        .from('leads').select(LEAD_COLS).eq('messenger_psid', psid).maybeSingle();
    if (error) throw error;
    return data;
}

async function findOrCreateLead(psid) {
    const existing = await findLead(psid);
    if (existing) return existing;

    const first_name = (await getProfileName(psid)) || 'Messenger lead';
    const { data, error } = await supabaseAdmin
        .from('leads')
        .insert({
            owner_id: process.env.OWNER_USER_ID,
            first_name,
            messenger_psid: psid,
            source: 'facebook_messenger',
        })
        .select(LEAD_COLS)
        .single();

    if (error) {
        // two events for a new person arrived at once; the other one created the lead
        if (error.code === '23505') return findLead(psid);
        throw error;
    }
    return data;
}

// ---------- their message ----------
async function handleInbound(evt) {
    const psid = evt.sender.id;
    const text =
        evt.message?.text ||
        evt.message?.quick_reply?.payload ||
        evt.postback?.payload ||
        evt.postback?.title ||
        '';
    const ts = new Date(evt.timestamp || Date.now()).toISOString();

    const lead = await findOrCreateLead(psid);

    // Log the message; if Meta re-sent it, stop here
    const { error: msgErr } = await supabaseAdmin.from('messenger_messages').insert({
        lead_id: lead.id,
        psid,
        direction: 'inbound',
        body: text || (evt.message?.attachments ? '[attachment]' : null),
        mid: evt.message?.mid || null,
        created_at: ts,
    });
    if (msgErr) {
        if (msgErr.code === '23505') return;
        throw msgErr;
    }

    const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() || null;
    const phone = text.match(PHONE_RE)?.[0] || null;
    const grade = detectGrade(text);

    const patch = { updated_at: new Date().toISOString(), last_response_at: ts };
    if (!lead.first_message_at) patch.first_message_at = ts;
    if (lead.stage === 'new_lead') patch.stage = 'in_conversation';

    if (email && email !== lead.email) {
        patch.email = email;
        patch.email_provided_at = lead.email_provided_at || ts;
    }
    if (phone && phone !== lead.phone) {
        patch.phone = phone;
        patch.phone_provided_at = lead.phone_provided_at || ts;
    }
    const newlyQualified = !!grade && !lead.is_qualified;
    if (newlyQualified) {
        patch.grade_level = grade;
        patch.is_qualified = true;
        patch.qualified_at = ts;
    }

    const { error } = await supabaseAdmin.from('leads').update(patch).eq('id', lead.id);
    if (error) throw error;

    const events = [];
    if (patch.email || patch.phone) {
        events.push({
            lead_id: lead.id,
            event_type: 'messenger_contact_captured',
            detail: { email: !!patch.email, phone: !!patch.phone },
        });
    }
    if (newlyQualified) {
        events.push({
            lead_id: lead.id,
            event_type: 'messenger_qualified',
            detail: { grade },
        });
    }
    if (events.length) {
        const { error: evtError } = await supabaseAdmin.from('lead_events').insert(events);
        if (evtError) console.error('lead_events insert failed', evtError);
    }
}

// ---------- your reply (typed by you or sent by the ad automation) ----------
async function handleEcho(evt) {
    const psid = evt.recipient.id; // for echoes, the customer is the recipient
    const lead = await findLead(psid); // don't create a lead from an outbound message

    const { error } = await supabaseAdmin.from('messenger_messages').insert({
        lead_id: lead?.id || null,
        psid,
        direction: 'outbound',
        body: evt.message?.text || (evt.message?.attachments ? '[attachment]' : null),
        mid: evt.message?.mid || null,
        created_at: new Date(evt.timestamp || Date.now()).toISOString(),
    });
    if (error && error.code !== '23505') throw error;
}
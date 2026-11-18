const crypto = require('crypto');
// Same service-role client the calendar webhook and the dashboard use
const supabaseAdmin = require('../config/leadSupabaseClient');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const GRADE_RE = /\b(?:grade\s*)?(9|10|nine|ten)(?:th)?\b/i;

const PLACEHOLDER_NAME = 'Messenger lead';

const LEAD_COLS =
    'id, first_name, email, phone, stage, is_qualified, first_message_at, email_provided_at, phone_provided_at';

// ---------- GET: Meta's one-time verification handshake ----------
exports.verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
};

// ---------- Middleware: confirm the POST really came from Meta ----------
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

// ---------- POST: incoming events ----------
exports.handleWebhook = async (req, res) => {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry || []) {
        // "standby" holds events while Business Suite automation has control of the chat.
        // Duplicates between the two lists are harmless: every message is de-duplicated by its id.
        const events = [...(entry.messaging || []), ...(entry.standby || [])];

        for (const evt of events) {
            try {
                if (evt.message?.is_echo) await handleEcho(evt); // your replies / automation
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
            `https://graph.facebook.com/v23.0/${psid}?fields=first_name,last_name`,
            { headers: { Authorization: `Bearer ${process.env.MESSENGER_PAGE_TOKEN}` } }
        );
        const j = await r.json();
        if (j.error) {
            console.error('profile lookup failed:', j.error.code, j.error.message);
            return null;
        }
        return j.first_name || null;
    } catch (e) {
        console.error('profile lookup error:', e.message);
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

// "(604) 555-1234", "604-555-1234" and "+1 604 555 1234" all count as the same number
const digitsOnly = (s) => (s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// Unique id used to recognise a message Meta delivers twice
function messageId(evt, psid) {
    return (
        evt.message?.mid ||
        evt.postback?.mid ||
        (evt.postback ? `postback:${psid}:${evt.timestamp}` : null)
    );
}

async function messageAlreadyLogged(mid) {
    const { data, error } = await supabaseAdmin
        .from('messenger_messages').select('id').eq('mid', mid).maybeSingle();
    if (error) throw error;
    return !!data;
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

    const first_name = (await getProfileName(psid)) || PLACEHOLDER_NAME;
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
        // Two events for a new person arrived at once; the other one created the lead
        // (leads.messenger_psid is unique, so only one insert can win).
        if (error.code === '23505') return findLead(psid);
        throw error;
    }

    // Your automation's first reply can arrive before the lead exists; attach those messages now
    const { error: linkError } = await supabaseAdmin
        .from('messenger_messages')
        .update({ lead_id: data.id })
        .eq('psid', psid)
        .is('lead_id', null);
    if (linkError) console.error('linking earlier messages failed:', linkError.message);

    return data;
}

// The same email on a different lead (e.g. a parent who messaged from two accounts).
// We only flag it for review; merging leads automatically could mix up two people.
async function flagDuplicateEmail(leadId, email) {
    const { data, error } = await supabaseAdmin
        .from('leads').select('id').eq('email', email).neq('id', leadId).limit(5);
    if (error) {
        console.error('duplicate email check failed:', error.message);
        return;
    }
    if (data?.length) {
        const { error: evtError } = await supabaseAdmin.from('lead_events').insert({
            lead_id: leadId,
            event_type: 'duplicate_email_detected',
            detail: { other_lead_ids: data.map((d) => d.id) },
        });
        if (evtError) console.error('lead_events insert failed', evtError);
    }
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
    const mid = messageId(evt, psid);

    // Duplicate delivery? Stop before doing any work (no lead lookup, no name request)
    if (mid && (await messageAlreadyLogged(mid))) return;

    const lead = await findOrCreateLead(psid);

    // Log the message. The unique index on mid also catches two copies arriving at the same moment.
    const { error: msgErr } = await supabaseAdmin.from('messenger_messages').insert({
        lead_id: lead.id,
        psid,
        direction: 'inbound',
        body: text || (evt.message?.attachments ? '[attachment]' : null),
        mid,
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

    // Retry the name lookup until it works (it only runs while the name is still the placeholder)
    if (!lead.first_name || lead.first_name === PLACEHOLDER_NAME) {
        const name = await getProfileName(psid);
        if (name) patch.first_name = name;
    }

    // Only treat it as new when the value actually differs
    if (email && email !== (lead.email || '').toLowerCase()) {
        patch.email = email;
        patch.email_provided_at = lead.email_provided_at || ts;
    }
    if (phone && digitsOnly(phone) !== digitsOnly(lead.phone)) {
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

    if (patch.email) await flagDuplicateEmail(lead.id, patch.email);
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
    // 23505 = Meta delivered this echo twice; the unique mid index rejected the copy
    if (error && error.code !== '23505') throw error;
}
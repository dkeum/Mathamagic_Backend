const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const axios = require("axios");


// LEAD FOLLOW UP FUNNEL

// I want to enter a first name, email, Lead Stage, # of Email/MSG Sent/ Cold Leads/ in Conversation / Booked Call / No Show /  Cancelled / Deposit / Not Closed (Bad Fit) / Follow up / Closed

// Flow After adding in 5 mins later. 
/**
 
New Lead Notification 

Opt In Consent

1st Direct Direct Application Lead Email 

Wait One Hour 

Direct Applcication EMail  #1 


Wait 1 Day

Direct Applcication EMail  #2
Wait 1 Day
Direct Applcication EMail  #3
Wait 1 Day
Direct Applcication EMail  #4
Wait 1 Day
Direct Applcication EMail  #5
Wait 1 Day
Direct Applcication EMail  #6
Wait 1 Day
Direct Applcication EMail  #7
Wait 1 Day


# after 7 days of no response. 
Add to Cold leads Stage 
Remove Lead Tag
Add Lead Follow up Tag 

wait 10 days

Remove opportunity 







 */


const cron = require("node-cron");
const supabase = require("../config/supabaseClient"); // must use the SERVICE ROLE key




const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const supabase = require("../config/leadSupabaseClient");
const transporter = require("../config/mailer");

const BASE_URL =
    process.env.NODE_ENV === "DEVELOPMENT"
        ? "http://localhost:5173"
        : "https://mathmagick.com";
const API_URL = process.env.API_BASE_URL; // where /api/leads/unsubscribe lives

// ---- Templates: template_key -> { subject, body(firstName) } -------------
// body returns the inner HTML only; layout() wraps it.
const templates = {
    opt_in_consent: {
        subject: "Quick confirmation, {{first_name}}",
        body: (n) => `<p>Hi ${n}, thanks for your interest in Mathmagick...</p>`,
    },
    da_lead_email: {
        subject: "Your next step with Mathmagick",
        body: (n) => `<p>Hi ${n}, ...</p>`,
    },
    da_email_1: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_2: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_3: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_4: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_5: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_6: { subject: "Following up", body: (n) => `<p>Hi ${n}, ...</p>` },
    da_email_7: { subject: "Last note from us", body: (n) => `<p>Hi ${n}, ...</p>` },
};

function layout(inner, unsubscribeUrl) {
    return `<!DOCTYPE html><html><body style="margin:0;padding:24px 0;background:#f7f9fb;font-family:Arial,sans-serif;color:#191c1e;">
  <table role="presentation" width="100%"><tr><td align="center">
    <table role="presentation" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid #e0e3e5;border-radius:12px;">
      <tr><td style="padding:24px;border-bottom:1px solid #e0e3e5;">
        <span style="font-size:22px;font-weight:700;color:#0035b9;">🧮 Mathmagick</span></td></tr>
      <tr><td style="padding:32px;font-size:16px;line-height:1.6;color:#444654;">${inner}</td></tr>
      <tr><td style="padding:20px 24px;background:#f2f4f6;text-align:center;font-size:12px;color:#747686;">
        © 2026 Mathmagick &middot; <a href="${unsubscribeUrl}" style="color:#747686;">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendEmail(msg) {
    // Internal notification goes to you, not the lead.
    if (msg.template_key === "new_lead_notification") {
        return transporter.sendMail({
            from: `"Mathmagick" <${process.env.NOREPLY_GMAIL}>`,
            to: process.env.OWNER_EMAIL,
            subject: `New lead: ${msg.first_name} (${msg.email})`,
            text: `${msg.first_name} <${msg.email}> just entered the funnel.`,
        });
    }

    const tpl = templates[msg.template_key];
    if (!tpl) throw new Error(`No template for ${msg.template_key}`);

    const token = jwt.sign({ leadId: msg.lead_id }, process.env.EMAIL_VERIFY_SECRET, {
        expiresIn: "365d",
    });
    const unsubscribeUrl = `${API_URL}/api/leads/unsubscribe?token=${token}`;

    return transporter.sendMail({
        from: `"Mathmagick" <${process.env.NOREPLY_GMAIL}>`,
        replyTo: process.env.REPLY_TO_EMAIL || process.env.OWNER_EMAIL,
        to: msg.email,
        subject: tpl.subject.replace("{{first_name}}", msg.first_name),
        html: layout(tpl.body(msg.first_name), unsubscribeUrl),
        headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
        },
    });
}

async function runLeadWorker() {
    // DB-only steps (mark cold, remove opportunity)
    const { error: actErr } = await supabase.rpc("process_due_actions");
    if (actErr) console.error("process_due_actions failed:", actErr.message);

    // Release rows stuck in 'processing' after a crash
    await supabase
        .from("scheduled_messages")
        .update({ status: "pending" })
        .eq("status", "processing")
        .lt("run_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

    const { data: due, error } = await supabase.rpc("claim_due_messages", { batch_size: 20 });
    if (error) return console.error("claim_due_messages failed:", error.message);

    for (const msg of due) {
        try {
            await sendEmail(msg);
            await supabase.rpc("complete_scheduled_message", {
                p_message_id: msg.message_id,
                p_success: true,
            });
        } catch (err) {
            console.error("send failed:", msg.template_key, err.message);
            await supabase.rpc("complete_scheduled_message", {
                p_message_id: msg.message_id,
                p_success: false,
                p_error: err.message,
            });
        }
    }
}

let running = false;
function startLeadWorker() {
    cron.schedule("* * * * *", async () => {
        if (running) return;
        running = true;
        try { await runLeadWorker(); } finally { running = false; }
    });
}

module.exports = { startLeadWorker, runLeadWorker };

async function sendEmail({ email, first_name, template_key }) {
    // call your email provider here (axios, SDK, etc.)
}

async function runLeadWorker() {
    const { data: due, error } = await supabase.rpc("claim_due_messages", { batch_size: 20 });
    if (error) return console.error("claim failed:", error.message);

    for (const msg of due) {
        try {
            await sendEmail(msg);
            await supabase.rpc("complete_scheduled_message", {
                p_message_id: msg.message_id,
                p_success: true,
            });
        } catch (err) {
            await supabase.rpc("complete_scheduled_message", {
                p_message_id: msg.message_id,
                p_success: false,
                p_error: err.message,
            });
        }
    }
}

let running = false;
cron.schedule("* * * * *", async () => {
    if (running) return; // don't overlap if a run takes over a minute
    running = true;
    try { await runLeadWorker(); } finally { running = false; }
});



const unsubscribe = asyncHandler(async (req, res) => {
    try {
        const { leadId } = jwt.verify(req.query.token, process.env.EMAIL_VERIFY_SECRET);
        await supabase
            .from("leads")
            .update({ unsubscribed_at: new Date().toISOString() })
            .eq("id", leadId);
        res.send("You've been unsubscribed.");
    } catch {
        res.status(400).send("Invalid or expired link.");
    }
});
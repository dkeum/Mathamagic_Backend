const supabase = require("../../config/supabaseClient");
const { Type } = require("@google/genai");
const {
    resolveModel,
    hasCredits,
    chargeCredits,
} = require("../aiController"); // CONFIRM ACTUAL PATH

const { calculateCreditsUsed } = require("../../config/aiCredits");


const { GoogleGenAI } = require("@google/genai");
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, vertexai: true });

const STRENGTH_THRESHOLD = 90;
const NEEDS_ATTENTION_THRESHOLD = 60;
const FOCUS_MIN_RATIO = 0.4;
const FOCUS_MAX_RATIO = 2.5;
const MAX_HARD_SKILLS = 10;

// ---------------------------------------------------------------------------
// Progress: completion (cumulative snapshot) + mastery (period-scoped)
// ---------------------------------------------------------------------------
async function computeProgress(studentId, sectionIds, periodStart, periodEnd, timeCommitmentHours) {
    const { data: progressRows, error: progressErr } = await supabase
        .from("student_section_progress")
        .select("section_id, completed")
        .eq("student_ID", studentId)
        .in("section_id", sectionIds);
    if (progressErr) throw progressErr;

    const completedCount = (progressRows || []).filter((p) => p.completed).length;
    const completion_pct = sectionIds.length > 0
        ? Math.round((completedCount / sectionIds.length) * 100)
        : 0;

    const { data: attempts, error: attemptsErr } = await supabase
        .from("student_question_attempt")
        .select("is_correct")
        .eq("student_ID", studentId)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd);
    if (attemptsErr) throw attemptsErr;

    const total = attempts?.length || 0;
    const correct = (attempts || []).filter((a) => a.is_correct).length;
    const mastery = total > 0 ? Math.round((correct / total) * 100) : 0;

    const { data: sessions, error: sessionsErr } = await supabase
        .from("student_session")
        .select("duration_minutes")
        .eq("student_ID", studentId)
        .gte("start_time", periodStart)
        .lte("start_time", periodEnd);
    if (sessionsErr) throw sessionsErr;

    const totalMinutes = (sessions || []).reduce((sum, s) => sum + parseFloat(s.duration_minutes || 0), 0);
    const periodWeeks = Math.max(1, (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24 * 7));
    const goalMinutes = (timeCommitmentHours || 0) * 60 * periodWeeks;
    const time_commitment_pct = goalMinutes > 0 ? Math.min(100, Math.round((totalMinutes / goalMinutes) * 100)) : 0;

    return { completion_pct, mastery, time_commitment_pct };
}

// ---------------------------------------------------------------------------
// Grade breakdown: per-section accuracy within the period, bucketed
// ---------------------------------------------------------------------------
async function computeGradeBreakdown(studentId, sections, periodStart, periodEnd) {
    const { data: attempts, error } = await supabase
        .from("student_question_attempt")
        .select("section_id, is_correct")
        .eq("student_ID", studentId)
        .in("section_id", sections.map((s) => s.id))
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd);
    if (error) throw error;

    const bySection = {};
    (attempts || []).forEach((a) => {
        if (!bySection[a.section_id]) bySection[a.section_id] = { correct: 0, total: 0 };
        bySection[a.section_id].total += 1;
        if (a.is_correct) bySection[a.section_id].correct += 1;
    });

    const strengths = [];
    const developing = [];
    const needs_attention = [];

    for (const section of sections) {
        const stats = bySection[section.id];
        if (!stats || stats.total === 0) continue; // no attempts this period — nothing to grade

        const grade = Math.round((stats.correct / stats.total) * 100);
        const entry = { section_id: section.id, name: section.name, grade };

        if (grade >= STRENGTH_THRESHOLD) strengths.push(entry);
        else if (grade <= NEEDS_ATTENTION_THRESHOLD) needs_attention.push(entry);
        else developing.push(entry);
    }

    return { strengths, developing, needs_attention };
}

// ---------------------------------------------------------------------------
// Persistence: of questions first missed in-period, what fraction were
// eventually answered correctly (any later attempt, same period)?
// ---------------------------------------------------------------------------
async function computePersistence(studentId, periodStart, periodEnd) {
    const { data: attempts, error } = await supabase
        .from("student_question_attempt")
        .select("question_id, is_correct, attempted_at")
        .eq("student_ID", studentId)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd)
        .order("attempted_at", { ascending: true });
    if (error) throw error;

    const byQuestion = {};
    (attempts || []).forEach((a) => {
        (byQuestion[a.question_id] ||= []).push(a);
    });

    let missedFirst = 0;
    let recovered = 0;

    for (const list of Object.values(byQuestion)) {
        if (list[0].is_correct === false) {
            missedFirst += 1;
            if (list.slice(1).some((a) => a.is_correct === true)) recovered += 1;
        }
    }

    const score = missedFirst > 0 ? Math.round((recovered / missedFirst) * 100) : null; // null = no missed questions to measure
    return { score, missedFirst, recovered };
}

// ---------------------------------------------------------------------------
// Independence: fraction of attempts made without AI assistance
// ---------------------------------------------------------------------------
async function computeIndependence(studentId, periodStart, periodEnd) {
    const { data: attempts, error } = await supabase
        .from("student_question_attempt")
        .select("used_ai_chat, used_ai_video, used_extra_tools")
        .eq("student_ID", studentId)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd);
    if (error) throw error;

    const total = attempts?.length || 0;
    if (total === 0) return { score: null, total: 0 };

    const unassisted = attempts.filter(
        (a) => !a.used_ai_chat && !a.used_ai_video && !a.used_extra_tools
    ).length;

    return { score: Math.round((unassisted / total) * 100), total };
}

// ---------------------------------------------------------------------------
// Consistency: active days ÷ days in period
// ---------------------------------------------------------------------------
async function computeConsistency(studentId, periodStart, periodEnd) {
    const { data: sessions, error } = await supabase
        .from("student_session")
        .select("start_time")
        .eq("student_ID", studentId)
        .gte("start_time", periodStart)
        .lte("start_time", periodEnd);
    if (error) throw error;

    const activeDays = new Set((sessions || []).map((s) => s.start_time.slice(0, 10))).size;
    const periodDays = Math.max(1, Math.ceil((new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24)));

    return { score: Math.round((activeDays / periodDays) * 100), activeDays, periodDays };
}

// ---------------------------------------------------------------------------
// Focus: student's time-per-question vs. peer median for that same
// question, same period. Heuristic band, not a hard rule.
// ---------------------------------------------------------------------------
async function computeFocus(studentId, periodStart, periodEnd) {
    const { data: studentAttempts, error: studentErr } = await supabase
        .from("student_question_attempt")
        .select("question_id, time_spent_seconds")
        .eq("student_ID", studentId)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd)
        .not("time_spent_seconds", "is", null);
    if (studentErr) throw studentErr;

    if (!studentAttempts || studentAttempts.length === 0) return { score: null };

    const questionIds = [...new Set(studentAttempts.map((a) => a.question_id))];

    const { data: peerAttempts, error: peerErr } = await supabase
        .from("student_question_attempt")
        .select("question_id, time_spent_seconds")
        .in("question_id", questionIds)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd)
        .not("time_spent_seconds", "is", null);
    if (peerErr) throw peerErr;

    const timesByQuestion = {};
    (peerAttempts || []).forEach((a) => {
        (timesByQuestion[a.question_id] ||= []).push(a.time_spent_seconds);
    });

    function median(arr) {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }

    let inRange = 0;
    let measured = 0;

    for (const attempt of studentAttempts) {
        const peerTimes = timesByQuestion[attempt.question_id];
        if (!peerTimes || peerTimes.length < 2) continue; // not enough peer data for this question
        const peerMedian = median(peerTimes);
        if (peerMedian <= 0) continue;

        measured += 1;
        const ratio = attempt.time_spent_seconds / peerMedian;
        if (ratio >= FOCUS_MIN_RATIO && ratio <= FOCUS_MAX_RATIO) inRange += 1;
    }

    return { score: measured > 0 ? Math.round((inRange / measured) * 100) : null, measured };
}

// ---------------------------------------------------------------------------
// Error checking: of wrong attempts, how many got corrected afterward
// ---------------------------------------------------------------------------
async function computeErrorChecking(studentId, periodStart, periodEnd) {
    const { data: attempts, error } = await supabase
        .from("student_question_attempt")
        .select("is_correct, corrected_at")
        .eq("student_ID", studentId)
        .eq("is_correct", false)
        .gte("attempted_at", periodStart)
        .lte("attempted_at", periodEnd);
    if (error) throw error;

    const total = attempts?.length || 0;
    if (total === 0) return { score: null, total: 0 };

    const corrected = attempts.filter((a) => a.corrected_at !== null).length;
    return { score: Math.round((corrected / total) * 100), total, corrected };
}

// ---------------------------------------------------------------------------
// Hard skills: aggregate cached skills_obtained/skills_missed across all
// sections (already computed by the knowledge tree pipeline — no new AI call)
// ---------------------------------------------------------------------------
async function computeHardSkills(studentId, sectionIds) {
    const { data: progressRows, error } = await supabase
        .from("student_section_progress")
        .select("skills_obtained, skills_missed")
        .eq("student_ID", studentId)
        .in("section_id", sectionIds);
    if (error) throw error;

    const mastered = new Set();
    const needsWork = new Set();

    (progressRows || []).forEach((p) => {
        (p.skills_obtained || []).forEach((s) => mastered.add(s));
        (p.skills_missed || []).forEach((s) => needsWork.add(s));
    });

    return {
        mastered: [...mastered].slice(0, MAX_HARD_SKILLS),
        needs_work: [...needsWork].slice(0, MAX_HARD_SKILLS),
    };
}

// ---------------------------------------------------------------------------
// AI: recommendations + errors to fix, synthesized from everything computed
// above. Returns nulls (not a thrown error) on failure so a broken AI call
// doesn't block the rest of a working report.
// ---------------------------------------------------------------------------
async function generateRecommendations(student, reportData) {
    if (!hasCredits(student)) {
        return { recommendations: [], errors_to_fix: [], tokensUsed: 0, creditsUsed: 0, skippedForCredits: true };
    }

    const model = resolveModel(student.plan_type);
    const prompt = `You are summarizing a math student's progress report. Based on this data, write concise, encouraging, actionable output.

Data:
${JSON.stringify(reportData, null, 2)}

Rules:
- "recommendations": 3-5 short, specific, actionable suggestions (max 15 words each).
- "errors_to_fix": up to 5 concrete recurring mistake patterns drawn from "needs_attention" sections and "needs_work" skills (max 12 words each).
- No filler, no generic encouragement-only lines — every item must be actionable or specific.
- Return ONLY JSON in exactly this shape:
{"recommendations": ["...", "..."], "errors_to_fix": ["...", "..."]}`;

    try {
        const response = await genAI.models.generateContent({
            model,
            contents: prompt,
            config: {
                systemInstruction: "You write concise, specific progress-report summaries for a math tutoring platform.",
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
                        errors_to_fix: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ["recommendations", "errors_to_fix"],
                },
            },
        });

        const parsed = JSON.parse(response.text);
        const tokensUsed = response.usageMetadata?.totalTokenCount || 0;
        const creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);

        return {
            recommendations: parsed.recommendations || [],
            errors_to_fix: parsed.errors_to_fix || [],
            tokensUsed,
            creditsUsed,
            skippedForCredits: false,
        };
    } catch (err) {
        console.error(`Recommendation generation failed for student ${student.id}:`, err);
        return { recommendations: [], errors_to_fix: [], tokensUsed: 0, creditsUsed: 0, skippedForCredits: false };
    }
}

module.exports = {
    computeProgress,
    computeGradeBreakdown,
    computePersistence,
    computeIndependence,
    computeConsistency,
    computeFocus,
    computeErrorChecking,
    computeHardSkills,
    generateRecommendations,
};
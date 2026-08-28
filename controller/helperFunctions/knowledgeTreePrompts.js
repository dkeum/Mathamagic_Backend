// knowledgeTreeHelpers.js
const supabase = require("../../config/supabaseClient");
const { calculateCreditsUsed } = require("../../config/aiCredits");
const { GoogleGenAI } = require("@google/genai");
const {
    resolveModel,
    hasCredits,
    chargeCredits,
} = require("../AIController"); // CONFIRM ACTUAL PATH — placeholder based on relative-import depth


const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, vertexai: true });

const { Type } = require("@google/genai");

const MAX_SKILLS_PER_SECTION = 5;
const QUESTION_TEXT_TRUNCATE = 200;
const RECENT_ATTEMPT_LIMIT = 30;
const MIN_MISTAKES = 5;
const PARALLEL_THRESHOLD = 500;

async function fetchUnprocessedAttempts(studentId, sectionId) {
    const { data: recent, error: recentErr } = await supabase
        .from("student_question_attempt")
        .select(`
          id, is_correct, answer_given,
          question:question_id ( question, formula )
        `)
        .eq("student_ID", studentId)
        .eq("section_id", sectionId)
        .eq("kt_processed", false)
        .order("id", { ascending: false })
        .limit(RECENT_ATTEMPT_LIMIT);
    if (recentErr) throw recentErr;

    if (!recent || recent.length === 0) return [];

    const mistakeCount = recent.filter((a) => a.is_correct === false).length;
    if (mistakeCount >= MIN_MISTAKES) return recent;

    const excludeIds = recent.map((a) => a.id);
    const needed = MIN_MISTAKES - mistakeCount;

    const { data: extraMistakes, error: extraErr } = await supabase
        .from("student_question_attempt")
        .select(`
          id, is_correct, answer_given,
          question:question_id ( question, formula )
        `)
        .eq("student_ID", studentId)
        .eq("section_id", sectionId)
        .eq("kt_processed", false)
        .eq("is_correct", false)
        .not("id", "in", `(${excludeIds.join(",")})`)
        .order("id", { ascending: false })
        .limit(needed);
    if (extraErr) throw extraErr;

    return [...recent, ...(extraMistakes || [])];
}

function buildSkillPrompt({ sectionName, priorObtained, priorMissed, attempts }) {
    const attemptLines = attempts.map((a) => {
        const q = (a.question?.question || "").slice(0, QUESTION_TEXT_TRUNCATE);
        return `- [${a.is_correct ? "CORRECT" : "WRONG"}] Q: ${q} | Student answer: ${a.answer_given || "(none)"}`;
    }).join("\n");

    return `You are updating a student's skill mastery summary for the math section "${sectionName}".

Current mastered skills: ${priorObtained.length ? priorObtained.join("; ") : "(none yet)"}
Current skills needing work: ${priorMissed.length ? priorMissed.join("; ") : "(none yet)"}

New question attempts since last update:
${attemptLines}

Update the two lists based on this new evidence. Rules:
- Each skill phrase must be 2-6 words, concrete, no filler ("Apply chain rule to polynomials", not "Understanding of chain rule concepts").
- Max ${MAX_SKILLS_PER_SECTION} items per list, no duplicates, a skill cannot appear in both lists.
- Prioritize the most recent/strongest evidence; drop weaker/older entries if the list would exceed the cap.
- If a skill in "needs work" is now consistently answered correctly, move it to "mastered".
- Return ONLY JSON in exactly this shape:
{"obtained": ["...", "..."], "missed": ["...", "..."]}`;
}

async function runSkillExtraction(student, section, attempts, priorObtained, priorMissed) {
    const prompt = buildSkillPrompt({
        sectionName: section.name,
        priorObtained,
        priorMissed,
        attempts,
    });
    const model = resolveModel(student.plan_type) || "gemini-3.5-flash";

    const response = await genAI.models.generateContent({
        model,
        contents: prompt,
        config: {
            systemInstruction: "You are a concise skill-mastery summarizer for a math tutoring platform.",
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    obtained: { type: Type.ARRAY, items: { type: Type.STRING } },
                    missed: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ["obtained", "missed"],
            },
        },
    });

    const parsed = JSON.parse(response.text);
    const tokensUsed = response.usageMetadata?.totalTokenCount || 0;
    const creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);

    const obtained = (parsed.obtained || []).slice(0, MAX_SKILLS_PER_SECTION);
    const missed = (parsed.missed || []).slice(0, MAX_SKILLS_PER_SECTION);

    const { error: upsertErr } = await supabase
        .from("student_section_progress")
        .upsert({
            student_ID: student.id,
            section_id: section.id,
            skills_obtained: obtained,
            skills_missed: missed,
            skills_generated_at: new Date().toISOString(),
        }, { onConflict: "student_ID,section_id" });
    if (upsertErr) throw upsertErr;

    const { error: markErr } = await supabase
        .from("student_question_attempt")
        .update({ kt_processed: true })
        .in("id", attempts.map((a) => a.id));
    if (markErr) throw markErr;

    return { obtained, missed, tokensUsed, creditsUsed };
}

// SEQUENTIAL path: precise per-section gating + charging, for small balances.
// `student` here is a live-updating copy — `AI_Credit` gets refreshed after
// each charge so hasCredits() reflects the real-time balance mid-batch.
async function updateSectionSkillsSequential(student, section, progressRow) {
    const attempts = await fetchUnprocessedAttempts(student.id, section.id);
    const priorObtained = progressRow?.skills_obtained || [];
    const priorMissed = progressRow?.skills_missed || [];

    if (attempts.length === 0) {
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, creditsRemaining: student.AI_Credit, skippedForCredits: false };
    }
    if (!hasCredits(student)) {
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, creditsRemaining: student.AI_Credit, skippedForCredits: true };
    }

    let result;
    try {
        result = await runSkillExtraction(student, section, attempts, priorObtained, priorMissed);
    } catch (err) {
        console.error(`Skill extraction failed for section ${section.id}, student ${student.id}:`, err);
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, creditsRemaining: student.AI_Credit, skippedForCredits: false };
    }

    const charged = await chargeCredits(student.id, result.creditsUsed);
    // chargeCredits returns null on failure — don't let that corrupt the running balance
    const newRemaining = charged ?? student.AI_Credit;

    return { ...result, creditsRemaining: newRemaining, skippedForCredits: false };
}

// PARALLEL path: single up-front gate via hasCredits(), no per-call charging
// (caller sums and charges once after Promise.all).
async function updateSectionSkillsParallel(student, section, progressRow, creditsAvailable) {
    const attempts = await fetchUnprocessedAttempts(student.id, section.id);
    const priorObtained = progressRow?.skills_obtained || [];
    const priorMissed = progressRow?.skills_missed || [];

    if (attempts.length === 0) {
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, skippedForCredits: false };
    }
    if (!creditsAvailable) {
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, skippedForCredits: true };
    }

    try {
        const result = await runSkillExtraction(student, section, attempts, priorObtained, priorMissed);
        return { ...result, skippedForCredits: false };
    } catch (err) {
        console.error(`Skill extraction failed for section ${section.id}, student ${student.id}:`, err);
        return { obtained: priorObtained, missed: priorMissed, tokensUsed: 0, creditsUsed: 0, skippedForCredits: false };
    }
}

function computeSectionStatus(progressRow, isFirstIncomplete) {
    if (progressRow?.completed) return "completed";
    if (isFirstIncomplete) return "next";
    return "locked";
}

module.exports = {
    PARALLEL_THRESHOLD,
    updateSectionSkillsSequential,
    updateSectionSkillsParallel,
    computeSectionStatus,
};
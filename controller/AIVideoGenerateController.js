const axios = require("axios");
const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

const FREE_VIDEO_LIMIT_PER_DAY = 1;
const VIDEO_CREDIT_COST = 10;

// ─────────────────────────────────────────────────────────────────────────────
// GET /ai-video/stream-explanation
// Intercepts query data context, forwards to Docker, and pipes response chunks
// Checks free-daily-use, falls back to AI_Credit, only charges on success
// ─────────────────────────────────────────────────────────────────────────────
const streamAIExplanationVideo = asyncHandler(async (req, res) => {
    // console.log("was called");
    const { questionId, topicId, sectionId, questionText, topicName, sectionName } = req.query;

    if (!questionId) {
        return res.status(400).json({ error: "Missing required question parameter values." });
    }

    // console.log("auth is done")
    // ── Auth ────────────────────────────────────────────────────
    const token = req.cookies?.access_token;
    if (!token) {
        return res.status(401).json({ error: "Missing or invalid token." });
    }

    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser(token);
    if (userError || !user) {
        return res.status(401).json({ error: "Unauthorized user." });
    }
    // console.log("user is ", user.email)
    // ── Load student credit/plan/free-use state ───────────────────
    const { data: studentData, error: studentError } = await supabase
        .from("Student")
        .select("id, AI_Credit, plan_type, last_free_video_at")
        .eq("email", user.email)
        .single();

    if (studentError || !studentData) {
        return res.status(404).json({ error: "Student not found." });
    }

    console.log(studentError)

    const { id: studentId, AI_Credit, plan_type, last_free_video_at } = studentData;

    // ── Determine free eligibility (resets daily) ─────────────────
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    console.log(studentId, AI_Credit, plan_type, last_free_video_at)

    const isFreeAvailable =
        !last_free_video_at || new Date(last_free_video_at) < startOfToday;

    let is_free_generation = false;

    if (isFreeAvailable) {
        is_free_generation = true;
    } else if ((AI_Credit ?? 0) < VIDEO_CREDIT_COST) {
        return res.status(403).json({
            message: "Not Enough Credits",
            error: "Insufficient credits.",
            ai_credits: AI_Credit ?? 0,
            required: VIDEO_CREDIT_COST,
        });
    }
    console.log("reached in")

    // ── Tier → model selection ─────────────────────────────────────
    const isPro = plan_type === "pro";
    const ai_tier = isPro ? "pro" : "free";
    const model_used = isPro
        ? "google/gemini-advanced"
        : "openrouter/basic";

    const remainingCreditsAfterSuccess = is_free_generation
        ? (AI_Credit ?? 0)
        : Math.max(0, (AI_Credit ?? 0) - VIDEO_CREDIT_COST);

    // ── Log a pending video_generation row ──────────────────────────
    const { data: videoGenRow, error: videoGenError } = await supabase
        .from("video_generation")
        .insert({
            student_id: studentId,
            section_id: sectionId || null,
            status: "pending",
            is_free_generation,
            ai_tier,
            model_used,
            credits_charged: 0,
        })
        .select()
        .single();

    if (videoGenError || !videoGenRow) {
        console.error("Failed to create video_generation row:", videoGenError?.message);
        return res.status(500).json({ error: "Failed to start video generation." });
    }

    const videoGenId = videoGenRow.id;

    // ── Helper to finalize the row + charge credits/free-use ────────
    const finalizeSuccess = async () => {
        const creditsCharged = is_free_generation ? 0 : VIDEO_CREDIT_COST;

        await supabase
            .from("video_generation")
            .update({
                status: "success",
                credits_charged: creditsCharged,
                completed_at: new Date().toISOString(),
            })
            .eq("id", videoGenId);

        if (is_free_generation) {
            await supabase
                .from("Student")
                .update({ last_free_video_at: new Date().toISOString() })
                .eq("id", studentId);
        } else {
            await supabase
                .from("Student")
                .update({ AI_Credit: remainingCreditsAfterSuccess })
                .eq("id", studentId);
        }
    };

    const finalizeFailure = async (errorMessage) => {
        await supabase
            .from("video_generation")
            .update({
                status: "failed",
                error_message: errorMessage,
                completed_at: new Date().toISOString(),
            })
            .eq("id", videoGenId);
        // No Student row touched — free-use and credits stay untouched
    };

    try {
        console.log("trying flask response with ", questionId, topicId, sectionId, questionText);

        const dockerResponse = await axios({
            method: "post",
            url: "http://localhost:5000/generate-video",
            data: {
                student_question: (() => {
                    try { return decodeURIComponent(questionText || ""); }
                    catch { return questionText || ""; }
                })(),
                question_id: questionId,
                topic_id: topicId,
                section_id: sectionId,
                topic_name: (() => {
                    try { return decodeURIComponent(topicName || ""); }
                    catch { return topicName || ""; }
                })(),
                section_name: (() => {
                    try { return decodeURIComponent(sectionName || ""); }
                    catch { return sectionName || ""; }
                })(),
                ai_tier,
            },
            responseType: "stream",
            timeout: 180000,
        });

        // ── Forward Flask's REAL headers instead of hardcoding them ────
        // Content-Length matters for the frontend's blob fetch to assemble
        // the file correctly. Don't force chunked encoding over it.
        res.setHeader("Content-Type", dockerResponse.headers["content-type"] || "video/mp4");
        if (dockerResponse.headers["content-length"]) {
            res.setHeader("Content-Length", dockerResponse.headers["content-length"]);
        }
        res.status(dockerResponse.status);
        res.setHeader("X-AI-Credits-Remaining", String(remainingCreditsAfterSuccess));
        res.setHeader("Access-Control-Expose-Headers", "X-AI-Credits-Remaining");
        res.status(dockerResponse.status);

        let settled = false;

        dockerResponse.data.on("end", () => {
            if (!settled) {
                settled = true;
                finalizeSuccess().catch((e) =>
                    console.error("Failed to finalize video_generation success:", e.message)
                );
            }
        });

        dockerResponse.data.on("error", (streamErr) => {
            if (!settled) {
                settled = true;
                finalizeFailure(streamErr.message).catch((e) =>
                    console.error("Failed to finalize video_generation failure:", e.message)
                );
            }
        });

        dockerResponse.data.pipe(res);

        req.on("close", () => {
            if (dockerResponse.data && typeof dockerResponse.data.destroy === "function") {
                dockerResponse.data.destroy();
            }
            if (!settled) {
                settled = true;
                finalizeFailure("Client disconnected before stream completed.").catch((e) =>
                    console.error("Failed to finalize video_generation failure:", e.message)
                );
            }
        });

    } catch (error) {
        console.error("Flask video generation error:", error.message);
        await finalizeFailure(error.message);
        if (!res.headersSent) {
            return res.status(502).json({ error: "Failed to connect to Flask video generation server." });
        }
        res.end();
    }
});

module.exports = {
    //   generateAIVideo, // your pre-existing method
    streamAIExplanationVideo
};


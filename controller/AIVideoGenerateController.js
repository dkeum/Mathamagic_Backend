const axios = require("axios");
const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const { calculateCreditsUsed } = require("../config/aiCredits");

const VIDEO_CREDIT_COST_FALLBACK = 10; 

// ─────────────────────────────────────────────────────────────────────────────
// GET /ai-video/stream-explanation 
// Intercepts query data context, forwards to Docker, awaits JSON response,
// Checks AI_Credit, and only charges on success
// ─────────────────────────────────────────────────────────────────────────────
const streamAIExplanationVideo = asyncHandler(async (req, res) => {
    const { questionId, topicId, sectionId, questionText, topicName, sectionName } = req.query;

    if (!questionId) {
        return res.status(400).json({ error: "Missing required question parameter values." });
    }

    // ── Auth ────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;

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

    // ── Load student credit/plan state ───────────────────
    const { data: studentData, error: studentError } = await supabase
        .from("Student")
        .select("id, AI_Credit, plan_type")
        .eq("email", user.email)
        .single();

    if (studentError || !studentData) {
        return res.status(404).json({ error: "Student not found." });
    }

    const { id: studentId, AI_Credit, plan_type } = studentData;

    // ── Credit Guard ─────────────────────────────────────────────
    if ((AI_Credit ?? 0) <= 0) { 
        return res.status(403).json({
            message: "Not Enough Credits",
            error: "Insufficient credits.",
            ai_credits: AI_Credit ?? 0,
            required: 1,
        });
    }

    // ── Tier → model selection ─────────────────────────────────────
    const isPro = plan_type === "pro";
    const ai_tier = isPro ? "pro" : "free";
    const model_used = "gemini-3.5-flash";

    // ── Log a pending video_generation row ──────────────────────────
    const { data: videoGenRow, error: videoGenError } = await supabase
        .from("video_generation")
        .insert({
            student_id: studentId,
            section_id: sectionId || null,
            status: "pending",
            is_free_generation: false,
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

    // ── Helpers to finalize the row ───────────────────────────────
    const finalizeSuccess = async (calculatedCredits) => {
        await supabase
            .from("video_generation")
            .update({
                status: "success",
                credits_charged: calculatedCredits,
                completed_at: new Date().toISOString(),
            })
            .eq("id", videoGenId);

        if (calculatedCredits > 0) {
            const { data: remaining, error: rpcError } = await supabase.rpc("deduct_ai_credit", {
                p_student_id: studentId,
                p_amount: calculatedCredits,
            });
            if (rpcError) {
                console.error("Credit deduction failed via RPC during video generation:", rpcError);
                // Fallback to local math if the RPC has a connection issue
                return Math.max(0, (AI_Credit ?? 0) - calculatedCredits);
            }
            return remaining; // Return the exact balance from the database
        }
        return AI_Credit ?? 0;
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
    };

    // ── Call Flask Pipeline ────────────────────────────────────────
    try {

        console.log(process.env.INTERNAL_SERVICE_KEY)
        const dockerResponse = await axios({
            method: "post",
            url: `${process.env.VIDEO_SERVICE_URL}/generate-video`,
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
                gemini_model: model_used,
            },
            headers: {
                "X-Internal-Service-Key": process.env.INTERNAL_SERVICE_KEY,
            },
            responseType: "json", // Await JSON directly
            timeout: 360000,
        });

        const responseData = dockerResponse.data;

        console.log(responseData);

        // ── Parse tokens sent from Flask JSON payload ───────────
        const promptTokens = parseInt(responseData.input_tokens || "0", 10);
        const candidatesTokens = parseInt(responseData.output_tokens || "0", 10);
        
        let finalCreditsCost = 0;
        if (promptTokens > 0 || candidatesTokens > 0) {
            finalCreditsCost = await calculateCreditsUsed(model_used, {
                promptTokenCount: promptTokens,
                candidatesTokenCount: candidatesTokens
            });
            finalCreditsCost = Math.max(1, finalCreditsCost); // never charge less than 1 credit
        } else {
            finalCreditsCost = VIDEO_CREDIT_COST_FALLBACK;
        }

        // Finalize DB updates and deduct user credits
        const remainingCreditsAfterSuccess = await finalizeSuccess(finalCreditsCost);

        console.log(remainingCreditsAfterSuccess)

        // ── Return JSON to client ────────────────────────────────
        res.setHeader("X-AI-Credits-Remaining", String(remainingCreditsAfterSuccess));
        res.setHeader("Access-Control-Expose-Headers", "X-AI-Credits-Remaining");
        
        return res.status(200).json({
            video_url: responseData.video_url,
            video_path: responseData.video_path,
            credits_remaining: remainingCreditsAfterSuccess
        });

    } catch (error) {
        // Handle Axios errors (including 500s from Flask)
        const errorMessage = error.response?.data?.message || error.message || "Unknown error";
        console.error("Flask video generation error:", errorMessage);
        
        await finalizeFailure(errorMessage);
        
        if (!res.headersSent) {
            return res.status(502).json({ 
                error: "Failed to generate video.",
                details: errorMessage
            });
        }
    }
});


module.exports = {
    streamAIExplanationVideo
};
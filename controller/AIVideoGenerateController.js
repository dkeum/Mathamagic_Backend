const axios = require("axios");
const asyncHandler = require("express-async-handler");

// ─────────────────────────────────────────────────────────────────────────────
// GET /ai-video/stream-explanation
// Intercepts query data context, forwards to Docker, and pipes response chunks
// ─────────────────────────────────────────────────────────────────────────────
const streamAIExplanationVideo = asyncHandler(async (req, res) => {
    console.log("was called");
    const { questionId, topicId, sectionId, questionText, topicName, sectionName } = req.query;

    if (!questionId) {
        return res.status(400).json({ error: "Missing required question parameter values." });
    }

    try {
        console.log("trying flask response with ", questionId, topicId, sectionId, questionText);

        const dockerResponse = await axios({
            method: "post",
            url: "http://localhost:5000/generate-video",  // hyphen, not underscore
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
            },
            responseType: "stream",
            timeout: 180000,
        });

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Transfer-Encoding", "chunked");
        res.status(dockerResponse.status);

        dockerResponse.data.pipe(res);

        req.on("close", () => {
            if (dockerResponse.data && typeof dockerResponse.data.destroy === "function") {
                dockerResponse.data.destroy();
            }
        });

    } catch (error) {
        console.error("Flask video generation error:", error.message);
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
/**
 * testQuestionsRoutes.js
 * ----------------------
 * Backend routes for the internal TestQuestions.jsx dev page.
 *
 *   GET  /api/test-questions?topicIds=70,71&sectionIds=820
 *        -> resolves topicIds to their sections, unions with sectionIds,
 *           and returns every question in that set, joined with
 *           section/topic name and grade.
 *
 *   POST /api/test-questions/:questionId/image   (multipart/form-data, field "image")
 *        -> uploads the image to GitHub, then writes the resulting raw URL
 *           onto question.image_url for that question.
 *
 * Mount this in your main Express app, e.g.:
 *   const testQuestionsRoutes = require("./routes/testQuestionsRoutes");
 *   app.use("/api", testQuestionsRoutes);
 *
 * Requires: npm install multer
 *
 * Env vars used:
 *   GITHUB_TOKEN   fine-grained PAT with "Contents: Read and write" on the repo
 *   GITHUB_REPO    "owner/repo"
 *   GITHUB_BRANCH  defaults to "main"
 *
 * ⚠️ This is a dev/internal tool with no auth check of its own. Do not expose
 * it on a public route in production without adding your normal auth
 * middleware — it lets anyone who can reach it overwrite question images.
 */

const express = require("express");
const multer = require("multer");
const { randomUUID } = require("crypto");
const path = require("path");
const supabase = require("../../config/supabaseClient"); // adjust path to your project

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 5 MB
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_UPLOAD_DIR = "uploads";

const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function parseIdList(raw) {
    if (!raw) return [];
    return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n));
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/test-questions
// ──────────────────────────────────────────────────────────────────────────


router.get("/api/test-questions", async (req, res) => {
    try {
        const topicIds = parseIdList(req.query.topicIds);
        const sectionIdsParam = parseIdList(req.query.sectionIds);

        if (topicIds.length === 0 && sectionIdsParam.length === 0) {
            return res.status(400).json({ error: "Provide topicIds and/or sectionIds." });
        }

        const sectionIdSet = new Set(sectionIdsParam);

        if (topicIds.length) {
            const { data, error } = await supabase
                .from("Section")
                .select("id, topic_ID")
                .in("topic_ID", topicIds);

            if (error) throw error;
            (data || []).forEach((row) => sectionIdSet.add(row.id));
        }

        const sectionIds = [...sectionIdSet];

        if (sectionIds.length === 0) {
            return res.json({ questions: [] });
        }

        const { data: rows, error } = await supabase
            .from("question")
            .select(
                "id, question, hint, formula, difficulty, question_type, options, answer, image_url, section_id, Section(name, topic_ID, Topic(name, grade))"
            )
            .in("section_id", sectionIds);

        if (error) throw error;

        const questions = (rows || [])
            // Skip questions that already have an image URL
            .filter((row) => !row.image_url)
            .map((row) => ({
                id: row.id,
                question: row.question,
                hint: row.hint,
                formula: row.formula,
                difficulty: row.difficulty,
                question_type: row.question_type,
                options: row.options,
                answer: row.answer,
                image_url: row.image_url,
                section_id: row.section_id,
                section_name: row.Section?.name || null,
                topic_name: row.Section?.Topic?.name || null,
                grade: row.Section?.Topic?.grade || null,
            }));

        res.json({ questions });
    } catch (err) {
        console.error("GET /test-questions failed:", err);
        res.status(500).json({ error: "Failed to fetch questions." });
    }
});


// ──────────────────────────────────────────────────────────────────────────
// POST /api/test-questions/:questionId/image
// ──────────────────────────────────────────────────────────────────────────

router.post("/api/test-questions/:questionId/image", upload.single("image"), async (req, res) => {

    console.log("POST /test-questions/:questionId/image called with questionId:", req.params.questionId);
    try {
        if (!GITHUB_TOKEN || !GITHUB_REPO) {
            return res.status(500).json({ error: "GITHUB_TOKEN or GITHUB_REPO is not configured on the server." });
        }

        const questionId = Number(req.params.questionId);
        if (!Number.isInteger(questionId)) {
            return res.status(400).json({ error: "Invalid question ID." });
        }

        if (!req.file) {
            return res.status(400).json({ error: "No image file provided (expected field 'image')." });
        }

        let ext = path.extname(req.file.originalname || "").toLowerCase();
        if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
            ext = ".png"; // fall back rather than reject, since we already re-encode as needed
        }

        const filename = `${randomUUID()}${ext}`;
        const repoPath = `${GITHUB_UPLOAD_DIR}/${filename}`;

        const ghResponse = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`,
            {
                method: "PUT",
                headers: {
                    Authorization: `token ${GITHUB_TOKEN}`,
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    message: `Add image for question ${questionId}`,
                    branch: GITHUB_BRANCH,
                    content: req.file.buffer.toString("base64"),
                }),
            }
        );

        if (!ghResponse.ok) {
            const text = await ghResponse.text();
            console.error(`GitHub upload failed (${ghResponse.status}):`, text.slice(0, 300));
            const message =
                ghResponse.status === 401
                    ? "GitHub rejected the token (401). Check GITHUB_TOKEN is valid and has Contents: Read and write on this repo."
                    : ghResponse.status === 404
                        ? "GitHub repo not found (404). Check GITHUB_REPO is exactly 'owner/repo'."
                        : `GitHub upload failed (${ghResponse.status}).`;
            return res.status(502).json({ error: message });
        }

        const imageUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoPath}`;

        const { error: updateError } = await supabase
            .from("question")
            .update({ image_url: imageUrl })
            .eq("id", questionId);

        if (updateError) throw updateError;

        console.log(`Successfully uploaded image for question ${questionId} to GitHub and updated Supabase.`);
        res.json({ image_url: imageUrl });
    } catch (err) {
        console.error("POST /test-questions/:id/image failed:", err);
        res.status(500).json({ error: "Failed to upload image." });
    }
});

module.exports = router;
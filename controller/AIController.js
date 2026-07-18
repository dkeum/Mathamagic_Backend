const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const { GoogleGenAI } = require("@google/genai");
const { calculateCreditsUsed } = require("../config/aiCredits");

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, vertexai: true });

const PLAN_MODEL_MAP = {
  free: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
};
const DEFAULT_MODEL = "gemini-2.5-flash";

function resolveModel(planType) {
  const key = String(planType || "").toLowerCase().trim();
  return PLAN_MODEL_MAP[key] || DEFAULT_MODEL;
}

async function requireStudent(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) return { error: { status: 401, message: "Missing or invalid token." } };

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return { error: { status: 401, message: "Unauthorized user." } };

  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, plan_type, AI_Credit")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return { error: { status: 404, message: "Student not found." } };
  return { student };
}

// Block before making the (expensive) Gemini call at all if the student is already out.
// Actual cost isn't known until the response comes back, so the real charge happens after —
// this pre-check just stops calls from a student sitting at 0 or negative.
function hasCredits(student) {
  return (student.AI_Credit ?? 0) > 0;
}

async function chargeCredits(studentId, credits) {
  const { data, error } = await supabase.rpc("deduct_ai_credit", {
    p_student_id: studentId,
    p_amount: credits,
  });
  if (error) {
    console.error("Credit deduction failed:", error);
    return null;
  }
  return data; // remaining balance
}

// POST /ai/verify-answers
const verifyAnswers = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const { attempts, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!Array.isArray(attempts) || attempts.length === 0) {
    return res.status(400).json({ message: "attempts must be a non-empty array." });
  }

  try {
    const prompt = `You are an evaluation engine for a math platform.
Review each item and determine if "answer_given" is mathematically correct.

Data:
${JSON.stringify(attempts, null, 2)}

Return a JSON array of objects with "question_id" and "is_correct" (boolean).`;

    const response = await genAI.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const results = JSON.parse(response.text);
    const creditsUsed = calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ results });
  } catch (err) {
    console.error("verifyAnswers failed:", err);
    return res.status(500).json({ message: "Verification failed" });
  }
});

// POST /ai/verify-answer
const verifyAnswer = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const {
    question,
    correctAnswer,
    studentAnswerText,
    attachedImageUrl,
    attachedImageBase64,
    plan_type: clientPlanType,
  } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }

  try {
    const hasImage = !!(attachedImageUrl || attachedImageBase64);
    const promptText = correctAnswer != null
      ? `You are grading a single math answer.
Question: ${question}
Correct answer: ${correctAnswer}
Student's typed answer: ${studentAnswerText || "(none)"}
${hasImage ? "The student also attached an image of their work — consider it." : ""}
If the answer is incorrect, briefly explain what's wrong in one short sentence.
Return: {"is_correct": true or false, "reason": "<short explanation if incorrect, otherwise null>"}`
      : `You are grading a single math answer. There is no answer key — judge correctness using your own mathematical reasoning.
Question: ${question}
Student's typed answer: ${studentAnswerText || "(none)"}
${hasImage ? "The student also attached an image of their work — consider it." : ""}
If the answer is incorrect, briefly explain what's wrong in one short sentence.
Return: {"is_correct": true or false, "reason": "<short explanation if incorrect, otherwise null>"}`;

    const parts = [{ text: promptText }];

    if (attachedImageUrl) {
      const imgResponse = await fetch(attachedImageUrl);
      if (!imgResponse.ok) throw new Error(`Failed to fetch image from URL: ${attachedImageUrl}`);
      const arrayBuffer = await imgResponse.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";
      parts.push({ inlineData: { mimeType, data: base64Data } });
    } else if (attachedImageBase64) {
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: attachedImageBase64.split(",").pop() },
      });
    }

    const response = await genAI.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json" },
    });

    const parsed = JSON.parse(response.text);
    const creditsUsed = calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ is_correct: !!parsed.is_correct, reason: parsed.reason ?? null });
  } catch (err) {
    console.error("verifyAnswer failed:", err);
    return res.status(500).json({ message: "Verification failed", is_correct: false });
  }
});

// POST /ai/chat
// POST /ai/chat
const chat = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const { topic, section, currentQuestion, history, message, attachments, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!message?.trim() && !(attachments?.length > 0)) {
    return res.status(400).json({ message: "message or attachments required." });
  }

  try {
    const systemInstruction = `You are a helpful, encouraging math tutor for high school students.

  [RULES]
  1. Be concise, clear, and highly encouraging.
  2. Guide step-by-step without giving away the direct answer.
  3. Bold each step label like "**Step 1:**", "**Step 2:**", etc.
  4. Put a blank line (a full empty line, i.e. two newlines) between each step so they render as separate paragraphs in Markdown.
  5. Write ALL math expressions using LaTeX delimiters: $...$ for inline math (e.g. $\\frac{1}{2}$, $a^3$, $(-a^3)^2$) and $$...$$ for standalone equations on their own line. Never write exponents, fractions, or other math notation as plain text (e.g. a^3, 1/2) outside of $ delimiters.
  6. If images are attached, analyze them as part of the student's work.

  [CONTEXT]
  The student is working on "${topic}" — specifically "${section}".
  Current Question: "${currentQuestion?.question || "Not available"}"
  ${currentQuestion?.formula ? `Formula: ${currentQuestion.formula}` : "No specific formula provided."}
  ${currentQuestion?.hint ? `Hint: ${currentQuestion.hint}` : "No specific hint provided."}`;

    // Map text history
    const contents = (history || []).map((m) => ({
      role: m.role === "ai" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

    const currentParts = [{ text: message || "Check out this image." }];

    // Process Supabase image URLs
    if (attachments?.length > 0) {
      const imagePromises = attachments.map(async (url) => {
        try {
          // Fetch the image from the Supabase public URL
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch image from URL: ${url}`);

          const arrayBuffer = await response.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString('base64');
          const mimeType = response.headers.get('content-type') || 'image/jpeg';

          return {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          };
        } catch (fetchError) {
          console.error("Error fetching attachment:", fetchError);
          return null;
        }
      });

      // Wait for all images to be fetched and converted
      const resolvedImages = await Promise.all(imagePromises);

      // Append successfully processed images to the prompt parts
      resolvedImages.forEach((imgPart) => {
        if (imgPart) currentParts.push(imgPart);
      });
    }

    contents.push({ role: "user", parts: currentParts });

    const response = await genAI.models.generateContent({
      model,
      contents,
      config: { systemInstruction },
    });

    const creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);

    console.log("credit used", creditsUsed);
    const remaining = await chargeCredits(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ text: response.text || "I couldn't process that." });
  } catch (err) {
    console.error("AI chat failed:", err);
    return res.status(500).json({ message: "Chat failed" });
  }
});



// POST /ai/read-question
const readQuestion = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const { imageUrl, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!imageUrl) {
    return res.status(400).json({ message: "imageUrl is required." });
  }

  try {
    const promptText = `Look at the attached image of a math problem. Transcribe the question exactly as written, including all numbers, variables, and any given conditions. Respond with ONLY the question text, no preamble, no markdown, no extra commentary.`;

    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) throw new Error(`Failed to fetch image from URL: ${imageUrl}`);
    const arrayBuffer = await imgResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";

    const parts = [
      { text: promptText },
      { inlineData: { mimeType, data: base64Data } },
    ];

    const response = await genAI.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
    });

    const creditsUsed = calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ question: (response.text || "").trim() });
  } catch (err) {
    console.error("readQuestion failed:", err);
    return res.status(500).json({ message: "Failed to read question." });
  }
});

module.exports = { verifyAnswers, verifyAnswer, chat, readQuestion };
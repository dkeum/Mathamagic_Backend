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
  const token = req.cookies?.access_token;
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

  const { question, correctAnswer, studentAnswerText, attachedImageBase64, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!question || correctAnswer == null) {
    return res.status(400).json({ message: "question and correctAnswer are required." });
  }

  try {
    const promptText = `You are grading a single math answer.
    Question: ${question}
    Correct answer: ${correctAnswer}
    Student's typed answer: ${studentAnswerText || "(none)"}
    ${attachedImageBase64 ? "The student also attached an image of their work — consider it." : ""}
    Return: {"is_correct": true or false}`;

    const parts = [{ text: promptText }];
    if (attachedImageBase64) {
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
    return res.json({ is_correct: !!parsed.is_correct });
  } catch (err) {
    console.error("verifyAnswer failed:", err);
    return res.status(500).json({ message: "Verification failed", is_correct: false });
  }
});

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
    const systemInstruction = `You are a helpful, encouraging math tutor for grade 10 students.

[RULES]
1. Be concise, clear, and highly encouraging.
2. Guide step-by-step without giving away the direct answer.
3. Number steps as "Step 1:", "Step 2:", etc.
4. Use plain Markdown math (25 / 100, bold, +, -, ×, ÷, =) — no raw LaTeX like \\frac{}{}.
5. If images are attached, analyze them as part of the student's work.

[CONTEXT]
The student is working on "${topic}" — specifically "${section}".
Current Question: "${currentQuestion?.question || "Not available"}"
${currentQuestion?.formula ? `Formula: ${currentQuestion.formula}` : "No specific formula provided."}
${currentQuestion?.hint ? `Hint: ${currentQuestion.hint}` : "No specific hint provided."}`;

    const contents = (history || []).map((m) => ({
      role: m.role === "ai" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

    const currentParts = [{ text: message || "Check out this image." }];
    if (attachments?.length > 0) {
      attachments.forEach((base64) => {
        currentParts.push({ inlineData: { mimeType: "image/jpeg", data: base64.split(",").pop() } });
      });
    }
    contents.push({ role: "user", parts: currentParts });

    const response = await genAI.models.generateContent({
      model,
      contents,
      config: { systemInstruction },
    });

    const creditsUsed = calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ text: response.text || "I couldn't process that." });
  } catch (err) {
    console.error("AI chat failed:", err);
    return res.status(500).json({ message: "Chat failed" });
  }
});

module.exports = { verifyAnswers, verifyAnswer, chat };
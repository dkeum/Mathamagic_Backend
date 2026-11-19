const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const { GoogleGenAI } = require("@google/genai");
const { calculateCreditsUsed } = require("../config/aiCredits");

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  vertexai: true,
});

const PLAN_MODEL_MAP = {
  free: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
};
const DEFAULT_MODEL = "gemini-2.5-flash";

function resolveModel(planType) {
  const key = String(planType || "").toLowerCase().trim();
  return PLAN_MODEL_MAP[key] || DEFAULT_MODEL;
}

function formatMultiPartText(text = "") {
  return String(text)
    .replace(/\s+(?=\(?[a-e]\)\s)/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeHistory(history, maxTurns = 12, maxCharsPerTurn = 4000) {
  if (!Array.isArray(history)) return [];
  return history.slice(-maxTurns).map((m) => ({
    role: m.role === "ai" || m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.text || "").slice(0, maxCharsPerTurn) }],
  }));
}

async function requireStudent(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader
    ? authHeader.split(" ")[1]
    : req.cookies?.access_token;
  if (!token) {
    return { error: { status: 401, message: "Missing or invalid token." } };
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return { error: { status: 401, message: "Unauthorized user." } };
  }

  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, plan_type, AI_Credit")
    .eq("email", user.email)
    .single();

  if (studentError || !student) {
    return { error: { status: 404, message: "Student not found." } };
  }
  return { student };
}

async function recordAnswerKeyFlag(questionId, dbAnswer, aiSolution) {
  const { error } = await supabase.from("answer_key_flag").insert({
    question_id: questionId,
    db_answer: dbAnswer,
    ai_solution: aiSolution,
  });

  if (error) {
    console.error(
      `Failed to record answer_key_flag for question ${questionId}:`,
      error
    );
  }
}

function normalizeLatex(str) {
  if (!str) return "";

  let normalized = str.trim();
  normalized = normalized.replace(/\s+/g, "");
  normalized = normalized.replace(/\\(,|;|:|quad|qquad|!)/g, "");
  normalized = normalized.replace(/\\mathrm\{([^}]+)\}/g, "$1");

  const superscriptMap = {
    "⁰": "0",
    "¹": "1",
    "²": "2",
    "³": "3",
    "⁴": "4",
    "⁵": "5",
    "⁶": "6",
    "⁷": "7",
    "⁸": "8",
    "⁹": "9",
  };
  normalized = normalized.replace(
    /[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,
    (m) => "^" + superscriptMap[m]
  );

  normalized = normalized.toLowerCase();

  return normalized;
}

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
  return data;
}

async function recordAiUsage(studentId, credits, category = "ai_chat") {
  const usageDate = new Date().toISOString().slice(0, 10);

  const { error } = await supabase.rpc("record_ai_usage", {
    p_student_id: studentId,
    p_usage_date: usageDate,
    p_category: category,
    p_credits: credits,
  });

  if (error) {
    console.error("Failed to record AI usage:", error);
  }
}

async function getQuestionsByIds(questionIds) {
  const { data, error } = await supabase
    .from("question")
    .select("id, question, hint, formula, answer, options, question_type")
    .in("id", questionIds);

  if (error) {
    console.error("getQuestionsByIds failed:", error);
    return [];
  }

  return data || [];
}

function getCorrectOption(options) {
  if (!Array.isArray(options)) return { ok: false, correctOptions: [] };
  const correctOptions = options.filter((o) => o?.correct === true);
  return { ok: correctOptions.length === 1, correctOptions };
}

const verifyAnswers = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const { attempts, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!Array.isArray(attempts) || attempts.length === 0) {
    return res
      .status(400)
      .json({ message: "attempts must be a non-empty array." });
  }

  const questionIds = attempts.map((a) => a.question_id);
  const questions = await getQuestionsByIds(questionIds);
  const questionMap = new Map(questions.map((q) => [String(q.id), q]));

  const gradingData = attempts.map((a) => {
    const q = questionMap.get(String(a.question_id));
    return {
      question_id: a.question_id,
      question_type: q?.question_type ?? "free_response",
      question: q?.question ?? "",
      correct_answer: q?.answer ?? "",
      answer_given: a.answer_given,
      selected_label: a.selected_label ?? null,
      options: q?.options ?? null,
    };
  });

  const isMC = (g) =>
    g.question_type === "multiple_choice" && Array.isArray(g.options);
  const mcItems = gradingData.filter(isMC);
  const freeItems = gradingData.filter((g) => !isMC(g));

  try {
    const mcResults = [];
    for (const g of mcItems) {
      const { ok, correctOptions } = getCorrectOption(g.options);

      if (!ok) {
        console.warn(
          `Question ${g.question_id} has ${correctOptions.length} options marked correct (expected exactly 1) — flagging.`
        );
        await recordAnswerKeyFlag(
          g.question_id,
          JSON.stringify(g.options),
          `${correctOptions.length} options marked correct; expected exactly 1`
        );
        mcResults.push({
          question_id: g.question_id,
          is_correct:
            normalizeLatex(g.answer_given) === normalizeLatex(g.correct_answer),
        });
        continue;
      }

      const correctLabel = correctOptions[0].label;
      mcResults.push({
        question_id: g.question_id,
        is_correct: g.selected_label === correctLabel,
      });
    }

    let freeResults = [];
    let creditsUsed = 0;

    if (freeItems.length > 0) {
      const prompt = `You are an expert math evaluator for a math platform.

For each item, you are given "question", the answer key "correct_answer" (which may
occasionally be wrong or missing), and the student's "answer_given".

For every item:
1. Independently solve "question" yourself to determine the actual correct answer.
2. Compare "answer_given" against your own solution. Accept mathematically equivalent
   forms (simplified/unsimplified fractions, decimals vs fractions, reordered but
   equal expressions, equivalent trig/log forms, etc).
3. Also compare your own solution against "correct_answer" so mismatches between the
   answer key and reality can be flagged — do not let a wrong "correct_answer" override
   your own independent solving.

Data:
${JSON.stringify(freeItems, null, 2)}

Return a JSON array of objects, one per item, each with:
- "question_id"
- "is_correct": boolean, whether "answer_given" matches YOUR independently solved answer
- "answer_key_ok": boolean, whether "correct_answer" matches your independently solved answer (true if correct_answer was empty/missing and you had to solve from scratch)
- "correct_solution": your own computed correct answer, as a string

Include every question_id from the input, in the same order, exactly once.`;

      const response = await genAI.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: "application/json" },
      });

      const rawResults = JSON.parse(response.text);
      const resultMap = new Map(rawResults.map((r) => [String(r.question_id), r]));

      for (const g of freeItems) {
        const r = resultMap.get(String(g.question_id));

        if (!r) {
          freeResults.push({
            question_id: g.question_id,
            is_correct:
              normalizeLatex(g.answer_given) ===
              normalizeLatex(g.correct_answer),
          });
          continue;
        }

        if (r.answer_key_ok === false) {
          console.warn(
            `Answer key mismatch for question ${g.question_id}: DB has "${g.correct_answer}", model solved "${r.correct_solution}"`
          );
          await recordAnswerKeyFlag(
            g.question_id,
            g.correct_answer,
            r.correct_solution
          );
        }

        freeResults.push({
          question_id: g.question_id,
          is_correct: !!r.is_correct,
        });
      }

      creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);
    }

    const results = [...mcResults, ...freeResults];

    const remaining = await chargeCredits(student.id, creditsUsed);
    await recordAiUsage(student.id, creditsUsed);

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
    const promptText =
      correctAnswer != null
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
      if (!imgResponse.ok) {
        throw new Error(`Failed to fetch image from URL: ${attachedImageUrl}`);
      }
      const arrayBuffer = await imgResponse.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";
      parts.push({ inlineData: { mimeType, data: base64Data } });
    } else if (attachedImageBase64) {
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: attachedImageBase64.split(",").pop(),
        },
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
    await recordAiUsage(student.id, creditsUsed);

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({
      is_correct: !!parsed.is_correct,
      reason: parsed.reason ?? null,
    });
  } catch (err) {
    console.error("verifyAnswer failed:", err);
    return res
      .status(500)
      .json({ message: "Verification failed", is_correct: false });
  }
});

// POST /ai/chat
const chat = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const {
    topic,
    section,
    currentQuestion,
    history,
    message,
    attachments,
    plan_type: clientPlanType,
  } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!message?.trim() && !(attachments?.length > 0)) {
    return res
      .status(400)
      .json({ message: "message or attachments required." });
  }

  try {
    const formattedQuestion = formatMultiPartText(
      currentQuestion?.question || "Not available"
    );

    const systemInstruction = `You are a helpful, encouraging math tutor for high school students.

   [RULES]
  1. Be concise, clear, and highly encouraging.
  2. Guide step-by-step without giving away the direct answer.
  3. Bold each step label like "**Step 1:**", "**Step 2:**", etc.
  4. Put a blank line (a full empty line, i.e. two newlines) between each step so they render as separate paragraphs in Markdown.
  5. Whenever a question or response contains multi-part items like a), b), c), always put each part on its own new line.
  6. Write every math expression using LaTeX delimiters, and write each one only ONCE — never repeat the same expression twice in a row or restate it in plain text right after the LaTeX version.
  7. When an expression is the main focus of a step (the thing being explained or transformed), put it on its own separate line using display math: $$...$$. Use inline math ($...$) only for short expressions mentioned in passing within a sentence.
  8. If images are attached, analyze them as part of the student's work.

  [CONTEXT]
  The student is working on "${topic || "General Math"}" — specifically "${section || "Practice"
      }".
  Current Question: "${formattedQuestion}"
  ${currentQuestion?.formula
        ? `Formula: ${currentQuestion.formula}`
        : "No specific formula provided."
      }
  ${currentQuestion?.hint
        ? `Hint: ${currentQuestion.hint}`
        : "No specific hint provided."
      }`;

    const contents = sanitizeHistory(history, 12, 4000);
    const currentParts = [
      { text: String(message || "Check out this image.").slice(0, 4000) },
    ];

    if (attachments?.length > 0) {
      const imagePromises = attachments.slice(0, 4).map(async (url) => {
        try {
          if (typeof url !== "string" || !url.startsWith("http")) return null;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Failed to fetch image from URL: ${url}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");
          const mimeType = response.headers.get("content-type") || "image/jpeg";

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

      const resolvedImages = await Promise.all(imagePromises);
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
    const remaining = await chargeCredits(student.id, creditsUsed);
    await recordAiUsage(student.id, creditsUsed);

    const formattedText = formatMultiPartText(
      response.text || "I couldn't process that."
    );

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ text: formattedText });
  } catch (err) {
    console.error("AI chat failed:", err);
    return res.status(500).json({ message: "Chat failed" });
  }
});

// POST /ai/chat-file
const chatFile = asyncHandler(async (req, res) => {
  const { student, error } = await requireStudent(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (!hasCredits(student)) {
    return res.status(402).json({ message: "Out of AI credits." });
  }

  const { prompt, history, imageUrl, plan_type: clientPlanType } = req.body;
  const model = resolveModel(student.plan_type ?? clientPlanType);

  if (!prompt?.trim() && !imageUrl) {
    return res.status(400).json({ message: "prompt or imageUrl required." });
  }

  try {
    const systemInstruction = `You are a helpful math assistant helping a student with an uploaded PDF page or image. Always put multi-part items like a), b), c) on their own separate lines.`;

    const contents = sanitizeHistory(history, 10, 4000);
    const userParts = [
      { text: String(prompt || "Please help with this page.").slice(0, 4000) },
    ];

    if (imageUrl && typeof imageUrl === "string" && imageUrl.startsWith("http")) {
      const imgResponse = await fetch(imageUrl);
      if (imgResponse.ok) {
        const arrayBuffer = await imgResponse.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        const mimeType = imgResponse.headers.get("content-type") || "image/png";
        userParts.push({ inlineData: { mimeType, data: base64Data } });
      }
    }

    contents.push({ role: "user", parts: userParts });

    const response = await genAI.models.generateContent({
      model,
      contents,
      config: { systemInstruction },
    });

    const creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);
    await recordAiUsage(student.id, creditsUsed);

    const formattedReply = formatMultiPartText(
      response.text || "I couldn't process that."
    );

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ reply: formattedReply, text: formattedReply });
  } catch (err) {
    console.error("AI chat-file failed:", err);
    return res.status(500).json({ message: "File chat failed" });
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
    const promptText = `Look at the attached image of a math problem. Transcribe the question exactly as written, including all numbers, variables, and any given conditions. Put any multi-part labels like a), b), c) on their own separate lines. Respond with ONLY the question text, no preamble, no markdown, no extra commentary.`;

    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) {
      throw new Error(`Failed to fetch image from URL: ${imageUrl}`);
    }
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

    const creditsUsed = await calculateCreditsUsed(model, response.usageMetadata);
    const remaining = await chargeCredits(student.id, creditsUsed);
    await recordAiUsage(student.id, creditsUsed);

    const formattedQuestion = formatMultiPartText(response.text || "");

    res.set("X-AI-Credits-Remaining", remaining ?? student.AI_Credit);
    return res.json({ question: formattedQuestion });
  } catch (err) {
    console.error("readQuestion failed:", err);
    return res.status(500).json({ message: "Failed to read question." });
  }
});

module.exports = {
  verifyAnswers,
  verifyAnswer,
  chat,
  chatFile,
  readQuestion,
  chargeCredits,
  hasCredits,
  requireStudent,
  resolveModel,
  recordAiUsage,
};
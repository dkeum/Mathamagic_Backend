const { GoogleGenAI, Type } = require("@google/genai"); // Import Type for the schema
const { calculateCreditsUsed } = require("../../config/aiCredits");

// FIX 1: Remove vertexai: true if using a standard AI Studio API Key
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY, 
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

async function verifyAnswersWithGemini(attempts, student, chargeCredits) {
  const model = resolveModel(student.plan_type);

  // Moved the persona into systemInstruction (cleaner prompting)
  const prompt = `Review each item in the following data. Determine if the "answer_given" is mathematically equivalent to the "correct_answer".
  
Data:
${JSON.stringify(attempts, null, 2)}`;

  try {
    const response = await genAI.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: "You are an evaluation engine for a math platform.",
        responseMimeType: "application/json",
        // FIX 2: Force the exact JSON shape using responseSchema
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question_id: { type: Type.INTEGER }, // Or Type.STRING depending on your DB
              is_correct: { type: Type.BOOLEAN },
            },
            required: ["question_id", "is_correct"],
          },
        },
      },
    });

    // FIX 3: Safe parsing inside a try/catch
    const results = JSON.parse(response.text);

    const creditsUsed = await calculateCreditsUsed(
      model,
      response.usageMetadata
    );

    console.log("this is the credits used: ",creditsUsed)

    const remainingCredits = await chargeCredits(
      student.id,
      creditsUsed
    );

    return {
      results,
      remainingCredits,
    };
  } catch (error) {
    // Log the actual error for your server logs, but throw a clean error for the user
    console.error("Gemini Evaluation Failed:", error);
    throw new Error("Unable to evaluate answers with AI. Please try again.");
  }
}

module.exports = {
  verifyAnswersWithGemini,
};
const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const multer = require("multer");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const FormData = require("form-data");

// ✅ Use memory storage for serverless
const storage = multer.memoryStorage();
const upload = multer({ storage });
const uploadMiddleware = upload.single("file");

// @ POST
// ROUTE: /homework-help/upload-pdf
const uploadPdf = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  // Verify user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const githubUrls = [];

    // Prepare multipart/form-data for DynamicPDF
    const form = new FormData();
    form.append("pdf", req.file.buffer, {
      filename: req.file.originalname || "file.pdf",
      contentType: req.file.mimetype || "application/pdf",
    });

    // Call DynamicPDF REST API
    const dynamicPdfResponse = await axios.post(
      "https://api.dpdf.io/v1.0/pdf-image",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.DYNAMICPDF_API_KEY}`,
        },
        responseType: "arraybuffer",
      }
    );

    // Convert returned PNG bytes to base64
    const base64Image = Buffer.from(dynamicPdfResponse.data).toString("base64");

    // Upload to GitHub
    const uniqueFilename = `${uuidv4()}.png`;
    const response = await axios.put(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/uploads/${uniqueFilename}`,
      {
        message: `Upload PDF page`,
        content: base64Image,
        branch: process.env.GITHUB_BRANCH || "main",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    githubUrls.push(response.data.content.download_url);

    return res.status(200).json({
      message: "PDF uploaded and converted successfully",
      githubUrls,
    });
  } catch (error) {
    console.error("PDF upload error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to upload PDF." });
  }
});

// @ POST
// ROUTE: /homework-help/upload-image
const uploadImage = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  // Verify user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const uniqueFilename = `${uuidv4()}.png`;

    // Convert buffer -> base64
    const base64Image = req.file.buffer.toString("base64");

    // Upload to GitHub
    const response = await axios.put(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/uploads/${uniqueFilename}`,
      {
        message: `Upload image ${uniqueFilename}`,
        content: base64Image,
        branch: process.env.GITHUB_BRANCH || "main",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    return res.status(200).json({
      message: "Image uploaded successfully",
      githubUrls: [response.data.content.download_url],
    });
  } catch (error) {
    console.error("Image upload error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to upload image." });
  }
});




const DRILL_TYPES = ["mult-2x1", "mult-3x1", "div-2x1", "div-3x1"];
const DRILL_TOTAL_QUESTIONS = 80;
const DRILL_MAX_SECONDS = 600;

// Verifies the cookie token and returns the matching Student row.
// If Student.id is the same as the Supabase auth user id, you can skip the lookup and use user.id.
const getStudentFromRequest = async (req) => {
  const token = req.cookies?.access_token;
  if (!token) return { status: 401, error: "Missing or invalid token." };

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) return { status: 401, error: "Unauthorized user." };

  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .maybeSingle();
  if (studentError || !student) return { status: 404, error: "Student not found." };

  return { student };
};

// @ POST
// ROUTE: /drill/submit-marks
// BODY: { drillType, score, timeTakenSeconds }
const DrillsubmitMarks = asyncHandler(async (req, res) => {
  const auth = await getStudentFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { drillType, score, timeTakenSeconds } = req.body;

  if (!DRILL_TYPES.includes(drillType))
    return res.status(400).json({ error: "Invalid drill type." });
  if (!Number.isInteger(score) || score < 0 || score > DRILL_TOTAL_QUESTIONS)
    return res.status(400).json({ error: "Invalid score." });
  if (!Number.isInteger(timeTakenSeconds) || timeTakenSeconds < 0 || timeTakenSeconds > DRILL_MAX_SECONDS)
    return res.status(400).json({ error: "Invalid time." });

  try {
    const { error } = await supabase.from("drill_attempt").insert({
      student_id: auth.student.id,
      drill_type: drillType,
      score,
      total_questions: DRILL_TOTAL_QUESTIONS,
      time_taken_seconds: timeTakenSeconds,
    });
    if (error) throw error;

    return res.status(201).json({ message: "Drill score saved." });
  } catch (error) {
    console.error("Drill submit error:", error.message);
    return res.status(500).json({ error: "Failed to save drill score." });
  }
});

// @ POST
// ROUTE: /worksheet/submit-marks
// BODY: { accessCode, numCorrect }
const worksheetSubmitMarks = asyncHandler(async (req, res) => {
  const auth = await getStudentFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { accessCode, numCorrect } = req.body;
  const code = String(accessCode || "").trim().toUpperCase();

  if (!code) return res.status(400).json({ error: "Missing access code." });
  if (!Number.isInteger(numCorrect) || numCorrect < 0)
    return res.status(400).json({ error: "Invalid score." });

  try {
    // Grade, homework id and question count come from the DB, not the client.
    const { data: hw, error: hwError } = await supabase
      .from("homework")
      .select("id, grade, access_code, questions")
      .eq("access_code", code)
      .eq("is_published", true)
      .maybeSingle();
    if (hwError) throw hwError;
    if (!hw) return res.status(404).json({ error: "Homework not found." });

    const total = Array.isArray(hw.questions) ? hw.questions.length : 0;
    if (!total || numCorrect > total)
      return res.status(400).json({ error: "Score out of range." });

    const { error } = await supabase.from("homework_attempt").insert({
      student_id: auth.student.id,
      homework_id: hw.id,
      access_code: hw.access_code,
      grade: hw.grade,
      num_correct: numCorrect,
      total_questions: total,
    });
    if (error) throw error;

    return res.status(201).json({ message: "Worksheet score saved." });
  } catch (error) {
    console.error("Worksheet submit error:", error.message);
    return res.status(500).json({ error: "Failed to save worksheet score." });
  }
});

// Same auth as the submit functions, but using the shared supabase client.
const getStudentForRead = async (req) => {
  const token = req.cookies?.access_token;
  if (!token) return { status: 401, error: "Missing or invalid token." };

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) return { status: 401, error: "Unauthorized user." };

  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .maybeSingle();
  if (studentError || !student) return { status: 404, error: "Student not found." };

  return { student };
};

// @ GET
// ROUTE: /drill/get-marks
// Returns the student's last two drill attempts, newest first.
const getDrillMarks = asyncHandler(async (req, res) => {
  const auth = await getStudentForRead(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    const { data, error } = await supabase
      .from("drill_attempt")
      .select("drill_type, score, total_questions, time_taken_seconds, completed_at")
      .eq("student_id", auth.student.id)
      .order("completed_at", { ascending: false })
      .limit(20);
    if (error) throw error;

    return res.status(200).json({ marks: data });
  } catch (error) {
    console.error("Get drill marks error:", error.message);
    return res.status(500).json({ error: "Failed to load drill marks." });
  }
});

// @ GET
// ROUTE: /worksheet/get-marks
// Returns the student's last twenty worksheet attempts (newest first)
// plus every code/topic currently available in the homework table.
const getWorksheetMarks = asyncHandler(async (req, res) => {
  const auth = await getStudentForRead(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    const [marksResult, homeworkResult] = await Promise.all([
      supabase
        .from("homework_attempt")
        .select("access_code, grade, num_correct, total_questions, submitted_at")
        .eq("student_id", auth.student.id)
        .order("submitted_at", { ascending: false })
        .limit(20),
      supabase
        .from("homework")
        .select("access_code, topic_name, grade")
        .eq("is_published", true)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .order("grade", { ascending: true })
        .order("access_code", { ascending: true }),
    ]);

    if (marksResult.error) throw marksResult.error;
    if (homeworkResult.error) throw homeworkResult.error;

    return res.status(200).json({
      marks: marksResult.data,
      homework: homeworkResult.data,
    });
  } catch (error) {
    console.error("Get worksheet marks error:", error.message);
    return res.status(500).json({ error: "Failed to load worksheet marks." });
  }
});



module.exports = {
  uploadPdf,
  uploadMiddleware,
  uploadImage,
  worksheetSubmitMarks,
  DrillsubmitMarks,
  getDrillMarks,
  getWorksheetMarks,
};

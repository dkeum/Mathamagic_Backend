const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// GET /final-exam/topics
const getTopics_FinalExam = asyncHandler(async (req, res) => {

  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;

  // console.log(token)
  if (!token) return res.status(401).json({ error: "Missing token." });

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required" });

  // ─── 1. Auth ──────────────────────────────────────────────────────────────

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  // ─── 2. Fetch student ─────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return res.status(404).json({ error: "Student not found." });

  // ─── 3. Fetch topics for this class ───────────────────────────────────────
  const { data: topics, error: topicsError } = await supabase
    .from("Topic")
    .select("id, name, description")
    .eq("class_ID", classId);

  if (topicsError) return res.status(500).json({ error: topicsError.message });

  // ─── 4. Fetch all exam attempts for this student ───────────────────────────
  // Join through final_exam_session to get only this student's attempts
  const { data: attempts, error: attemptsError } = await supabase
    .from("final_exam_attempt")
    .select("topic_id, is_correct, session_id, final_exam_session!inner(student_id)")
    .eq("final_exam_session.student_id", student.id);

  if (attemptsError) return res.status(500).json({ error: attemptsError.message });

  // ─── 5. Compute mastery per topic ─────────────────────────────────────────
  // mastery = (correct attempts / total attempts) * 100, across all sessions
  const masteryMap = {};
  for (const attempt of attempts ?? []) {
    const tid = attempt.topic_id;
    if (!tid) continue;
    if (!masteryMap[tid]) masteryMap[tid] = { correct: 0, total: 0 };
    masteryMap[tid].total += 1;
    if (attempt.is_correct) masteryMap[tid].correct += 1;
  }

  // ─── 6. Attach mastery to each topic ──────────────────────────────────────
  const result = topics.map((t) => {
    const stats = masteryMap[t.id];
    const mastery = stats
      ? Math.round((stats.correct / stats.total) * 100)
      : 0;
    return { ...t, mastery, attempted: Boolean(stats) };
  });

  res.status(200).json(result);
});

// POST /final-exam/generate
const generateFinalExam = asyncHandler(async (req, res) => {
  const { selectedTopicIds, questionCount = 20 } = req.body;

  if (!selectedTopicIds?.length)
    return res.status(400).json({ error: "selectedTopicIds is required" });

  const questionsPerTopic = Math.floor(questionCount / selectedTopicIds.length);

  // Join answers so the frontend can verify correctness client-side / via Puter
  const { data, error } = await supabase
    .from("question")
    .select(`
      id,
      question,
      hint,
      formula,
      image_url,
      difficulty,
      section_id,
      topic_id,
      answer ( answer )
    `)
    .in("topic_id", selectedTopicIds);

  if (error) return res.status(500).json({ error: error.message });

  // Shuffle per topic, take questionsPerTopic from each
  const byTopic = {};
  for (const q of data) {
    if (!byTopic[q.topic_id]) byTopic[q.topic_id] = [];
    byTopic[q.topic_id].push(q);
  }

  const allQuestions = [];
  for (const topicId of selectedTopicIds) {
    const pool = byTopic[topicId] ?? [];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    // Flatten answer array → single string for convenience
    const sliced = pool.slice(0, questionsPerTopic).map((q) => ({
      ...q,
      correct_answer: q.answer?.[0]?.answer ?? null,
      answer: undefined, // don't expose the raw join array
    }));
    allQuestions.push(...sliced);
  }

  res.status(200).json(allQuestions);
});

// POST /final-exam/submit
const submitFinalExamMarks = asyncHandler(async (req, res) => {
  const { answers, total_seconds, started_at } = req.body;

  // ─── 1. Auth ──────────────────────────────────────────────────────────────
  const token = req.cookies?.access_token;

  // console.log(token)
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);


  // console.log(user)
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  // ─── 2. Fetch student ─────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID, cached_total_minutes")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return res.status(404).json({ error: "Student not found." });

  // ─── 3. Validate body ─────────────────────────────────────────────────────
  if (!answers?.length) return res.status(400).json({ error: "answers are required" });

  const correctCount = answers.filter((a) => a.is_correct).length;
  const totalScore = Math.round((correctCount / answers.length) * 100);
  const passed = totalScore >= 70;

  // ─── 4. Create session ────────────────────────────────────────────────────
  const { data: session, error: sessionErr } = await supabase
    .from("final_exam_session")
    .insert([{
      student_id: student.id,   // ← from auth, not body
      total_score: totalScore,
      passed,
      total_seconds: total_seconds ?? null,
      started_at: started_at ?? null,
    }])
    .select()
    .single();

  if (sessionErr) return res.status(500).json({ error: sessionErr.message });

  // ─── 5. Insert attempts ───────────────────────────────────────────────────
  const attempts = answers.map((a) => ({
    session_id: session.id,
    question_id: a.question_id,
    answer_given: a.answer_given,
    is_correct: a.is_correct,
    section_id: a.section_id ?? null,
    topic_id: a.topic_id ?? null,
    time_spent_seconds: a.time_spent_seconds ?? null,
  }));

  const { error: attemptErr } = await supabase
    .from("final_exam_attempt")
    .insert(attempts);

  if (attemptErr) return res.status(500).json({ error: attemptErr.message });

  res.status(200).json({
    message: "Exam submitted successfully",
    sessionId: session.id,
    totalScore,
    passed,
    correctCount,
    totalQuestions: answers.length,
  });
});

module.exports = {
  getTopics_FinalExam,
  generateFinalExam,
  submitFinalExamMarks,
};

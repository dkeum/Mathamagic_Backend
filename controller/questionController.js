const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");



//SEND an send email with with full name and description
const getQuestions = asyncHandler(async (req, res) => {
  const { topic, section } = req.params;
  const { class: classId } = req.query;
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;

  console.log(topic, section)

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  // Get topic ID scoped to class
  const { data: topicData, error: topicError } = await supabase
    .from("Topic")
    .select("id")
    .ilike("name", topic.trim())
    .eq("class_ID", classId)
    .single();

  if (topicError || !topicData) {
    return res.status(404).json({ error: "Topic not found." });
  }

  // Get section ID scoped to topic
  const { data: sectionData, error: sectionError } = await supabase
    .from("Section")
    .select("id")
    .eq("name", section)
    .eq("topic_ID", topicData.id)
    .single();

  if (sectionError || !sectionData) {
    return res.status(404).json({ error: "Section not found." });
  }

  // Fetch ALL questions for the section (removed .limit(10))
  const { data: allQuestions, error: questionsError } = await supabase
    .from("question")
    .select("*")
    .eq("section_id", sectionData.id);

  if (questionsError) {
    return res.status(500).json({ error: "Error fetching questions." });
  }

  if (!allQuestions?.length) {
    return res.status(404).json({ error: "No questions found for this section." });
  }

  // --- RANDOMIZATION LOGIC ---
  // Shuffle the array using a quick sort method and slice 10 items
  const questions = allQuestions
    .sort(() => 0.5 - Math.random())
    .slice(0, 10);

  const questionIds = questions.map((q) => q.id);

  // Fetch answers using real ID array
  const { data: answers, error: answersError } = await supabase
    .from("answer")
    .select("*")
    .in("question_ID", questionIds);

  if (answersError) {
    return res.status(500).json({ error: "Error fetching answers." });
  }

  // Merge answers into their parent questions
  const merged = questions.map((q) => ({
    ...q,
    answers: (answers || []).filter((a) => a.question_ID === q.id),
  }));

  return res.status(200).json({ questions: merged });
});

// @ POST
// ROUTE: /questions/save-marks
//
// Expected request body:
// {
//   topic_id:        number   — Topic.id
//   section_id:      number   — Section.id
//   grade:           number   — 0–100, percentage correct this attempt
//   start_time:      string   — ISO timestamp (when the user started the question set)
//   end_time:        string   — ISO timestamp (when they submitted)
//   timezone:        string   — e.g. "America/Vancouver" (optional)
//   recordedAnswers: Array<{
//     question_id:        number
//     answer_given:       string
//     is_correct:         boolean
//     time_spent_seconds: number
//     used_ai_video:      boolean
//     used_ai_chat:       boolean
//   }>
// }

const saveQuestionMarks = asyncHandler(async (req, res) => {
  const { topic_id, section_id, grade, start_time, end_time, recordedAnswers } =
    req.body;

  // ─── 1. Auth ────────────────────────────────────────────────────────────────
  const token = req.cookies?.access_token;
  if (!token)
    return res.status(401).json({ error: "Missing or invalid token." });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user)
    return res.status(401).json({ error: "Unauthorized user." });

  // ─── 2. Fetch student ────────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID")
    .eq("email", user.email)
    .single();

  if (studentError || !student) {
    return res.status(404).json({ error: "Student not found." });
  }

  const studentId = student.id;

  // ─── 3. Validate inputs ──────────────────────────────────────────────────────
  if (
    !topic_id ||
    !section_id ||
    grade == null ||
    !start_time ||
    !end_time ||
    !Array.isArray(recordedAnswers)
  ) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const parsedGrade = Number(grade);
  if (isNaN(parsedGrade) || parsedGrade < 0 || parsedGrade > 100) {
    return res
      .status(400)
      .json({ error: "grade must be a number between 0 and 100." });
  }

  // ─── 4. Insert student_session ───────────────────────────────────────────────
  const { error: sessionError } = await supabase
    .from("student_session")
    .insert({
      student_ID: studentId,
      start_time,
      end_time,
      timezone: req.body.timezone ?? null,
    });

  if (sessionError) {
    console.error("session insert error:", sessionError);
    return res.status(500).json({ error: "Failed to save session." });
  }

  // ─── 5. Insert/update student_question_attempt rows ──────────────────────────
  const wrongAnswerIds = recordedAnswers
    .filter((a) => !a.is_correct)
    .map((a) => a.question_id);

  let existingWrongAttempts = [];
  if (wrongAnswerIds.length > 0) {
    const { data: existing, error: fetchError } = await supabase
      .from("student_question_attempt")
      .select("id, question_id, section_id")
      .eq("student_ID", studentId)
      .eq("section_id", section_id)
      .eq("is_correct", false)
      .in("question_id", wrongAnswerIds);

    if (fetchError) {
      console.error("fetch existing attempts error:", fetchError);
      return res
        .status(500)
        .json({ error: "Failed to check existing attempts." });
    }
    existingWrongAttempts = existing ?? [];
  }

  const existingWrongMap = Object.fromEntries(
    existingWrongAttempts.map((row) => [row.question_id, row.id])
  );

  const toInsert = [];
  const toUpdate = [];

  for (const a of recordedAnswers) {
    const payload = {
      student_ID: studentId,
      question_id: a.question_id,
      section_id: section_id,
      is_correct: Boolean(a.is_correct),
      answer_given: a.answer_given ?? null,
      time_spent_seconds: a.time_spent_seconds ?? null,
      used_ai_video: Boolean(a.used_ai_video),
      used_ai_chat: Boolean(a.used_ai_chat),
      // ✅ FIX: always reset these so a re-attempted wrong question
      //         is treated as a fresh mistake, not a corrected one
      corrected_at: null,
      reviewed: false,
    };

    const existingId = !a.is_correct ? existingWrongMap[a.question_id] : null;

    if (existingId) {
      toUpdate.push({ id: existingId, payload });
    } else {
      toInsert.push(payload);
    }
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from("student_question_attempt")
      .insert(toInsert);

    if (insertError) {
      console.error("attempts insert error:", insertError);
      return res
        .status(500)
        .json({ error: "Failed to save question attempts." });
    }
  }

  for (const { id, payload } of toUpdate) {
    const { error: updateError } = await supabase
      .from("student_question_attempt")
      .update(payload)
      .eq("id", id);

    if (updateError) {
      console.error("attempts update error:", updateError);
      return res
        .status(500)
        .json({ error: "Failed to update question attempt." });
    }
  }

  // ─── 6. Upsert student_section_progress ──────────────────────────────────────
  const sectionStatus = parsedGrade >= 80 ? "completed" : "in_progress";

  const { data: existingProgress } = await supabase
    .from("student_section_progress")
    .select("id, mastery_score, completed")
    .eq("student_ID", studentId)
    .eq("section_id", section_id)
    .maybeSingle();

  const newMastery = parsedGrade / 100;
  const bestMastery = existingProgress
    ? Math.max(existingProgress.mastery_score ?? 0, newMastery)
    : newMastery;

  const bestStatus =
    existingProgress?.completed === true ? "completed" : sectionStatus;

  const progressPayload = {
    student_ID: studentId,
    section_id: section_id,
    mastery_score: bestMastery,
    completed: bestStatus === "completed",
    status: bestStatus,
    last_attempted_at: new Date().toISOString(),
  };

  let sectionProgressError;
  if (existingProgress) {
    ({ error: sectionProgressError } = await supabase
      .from("student_section_progress")
      .update(progressPayload)
      .eq("id", existingProgress.id));
  } else {
    ({ error: sectionProgressError } = await supabase
      .from("student_section_progress")
      .insert(progressPayload));
  }

  if (sectionProgressError) {
    console.error("section progress error:", sectionProgressError);
    return res
      .status(500)
      .json({ error: "Failed to update section progress." });
  }

  // ─── 7. Recompute & cache Student-level aggregates ───────────────────────────
  const { data: classTopics, error: classTopicsError } = await supabase
    .from("Topic")
    .select("id")
    .eq("class_ID", student.Class_ID);

  if (classTopicsError) {
    console.error("classTopics fetch error:", classTopicsError);
    return res.status(200).json({
      message: "Progress saved. Cache update skipped (could not resolve class topics).",
    });
  }

  const classTopicIds = (classTopics || []).map((t) => t.id);

  const [
    { data: allSections, error: allSectionsError },
    { data: allSessions, error: allSessionsError },
    { count: totalSectionCount, error: totalSectionsError },
  ] = await Promise.all([
    supabase
      .from("student_section_progress")
      .select("completed, mastery_score")
      .eq("student_ID", studentId),

    supabase
      .from("student_session")
      .select("duration_minutes")
      .eq("student_ID", studentId),

    supabase
      .from("Section")
      .select("id", { count: "exact", head: true })
      .in("topic_ID", classTopicIds),
  ]);

  if (allSectionsError || allSessionsError || totalSectionsError) {
    console.error("cache recalc fetch error:", {
      allSectionsError,
      allSessionsError,
      totalSectionsError,
    });
    return res.status(200).json({
      message: "Progress saved. Cache update skipped due to fetch error.",
    });
  }

  const overallGrade =
    allSections.length > 0
      ? Math.round(
        (allSections.reduce(
          (sum, s) => sum + (Number(s.mastery_score) || 0),
          0
        ) /
          allSections.length) *
        100
      )
      : 0;

  const totalMinutes = allSessions.reduce(
    (sum, s) => sum + (Number(s.duration_minutes) || 0),
    0
  );

  const completedSections = allSections.filter((s) => s.completed).length;
  const completionPct =
    totalSectionCount > 0
      ? Math.round((completedSections / totalSectionCount) * 100)
      : 0;

  const { error: cacheError } = await supabase
    .from("Student")
    .update({
      cached_overall_grade: overallGrade,
      cached_total_minutes: Math.round(totalMinutes),
      cached_completion_pct: completionPct,
      last_cache_updated_at: new Date().toISOString(),
    })
    .eq("id", studentId);

  if (cacheError) {
    console.error("cache update error:", cacheError);
  }

  return res.status(200).json({
    message: "Progress saved successfully.",
    summary: {
      section_status: bestStatus,
      grade: parsedGrade,
      overall_grade: overallGrade,
      total_minutes: Math.round(totalMinutes),
      completion_pct: completionPct,
    },
  });
});


// GET /questions/mistakes
const getMistakes = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token)
    return res.status(401).json({ error: "Missing or invalid token." });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user)
    return res.status(401).json({ error: "Unauthorized user." });

  // ─── 1. Fetch student ────────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !student) {
    return res.status(404).json({ error: "Student not found." });
  }

  // ─── 2. Fetch wrong attempts: unreviewed AND not yet corrected ───────────────
  const { data: wrongAttempts, error: attemptsError } = await supabase
    .from("student_question_attempt")
    .select(`
      id,
      question_id,
      section_id,
      answer_given,
      attempted_at,
      corrected_at,
      time_spent_seconds,
      used_ai_video,
      used_ai_chat,
      reviewed,
      question (
        id,
        question,
        hint,
        formula,
        image_url,
        difficulty,
        topic_id,
        answer ( id, answer )
      ),
      Section (
        id,
        name,
        difficulty,
        topic_ID,
        Topic (
          id,
          name
        )
      )
    `)
    .eq("student_ID", student.id)
    .eq("is_correct", false)
    .eq("reviewed", false)
    .is("corrected_at", null)  // ✅ excludes corrected mistakes
    .order("attempted_at", { ascending: false });

  if (attemptsError) {
    console.error("wrongAttempts fetch error:", attemptsError);
    return res.status(500).json({ error: "Failed to fetch mistakes." });
  }

  // ─── 3. Deduplicate — keep only the most recent attempt per question_id ───────
  const seenQuestions = new Set();
  const dedupedAttempts = [];
  for (const attempt of wrongAttempts) {
    if (!seenQuestions.has(attempt.question_id)) {
      seenQuestions.add(attempt.question_id);
      dedupedAttempts.push(attempt);
    }
  }

  // ─── 4. Group by topic, then by section ──────────────────────────────────────
  const topicMap = {};

  for (const attempt of dedupedAttempts) {
    const topic = attempt.Section?.Topic;
    const section = attempt.Section;

    const topicId = topic?.id ?? attempt.question?.topic_id ?? "unknown";
    const topicName = topic?.name ?? "Unknown Topic";
    const sectionId = section?.id ?? attempt.section_id ?? "unknown";
    const sectionName = section?.name ?? "Unknown Section";

    if (!topicMap[topicId]) {
      topicMap[topicId] = {
        topic_id: topicId,
        topic_name: topicName,
        total_mistakes: 0,
        sections: {},
      };
    }

    if (!topicMap[topicId].sections[sectionId]) {
      topicMap[topicId].sections[sectionId] = {
        section_id: sectionId,
        section_name: sectionName,
        difficulty: section?.difficulty ?? null,
        mistakes: [],
      };
    }

    topicMap[topicId].sections[sectionId].mistakes.push({
      attempt_id: attempt.id,
      question_id: attempt.question_id,
      question_text: attempt.question?.question ?? null,
      hint: attempt.question?.hint ?? null,
      formula: attempt.question?.formula ?? null,
      image_url: attempt.question?.image_url ?? null,
      difficulty: attempt.question?.difficulty ?? null,
      correct_answers: (attempt.question?.answer ?? []).map((a) => a.answer),
      answer_given: attempt.answer_given,
      attempted_at: attempt.attempted_at,
      time_spent_seconds: attempt.time_spent_seconds,
      used_ai_video: attempt.used_ai_video,
      used_ai_chat: attempt.used_ai_chat,
      reviewed: attempt.reviewed,
    });

    topicMap[topicId].total_mistakes += 1;
  }

  // ─── 5. Flatten into sorted arrays ───────────────────────────────────────────
  const topics = Object.values(topicMap)
    .map((t) => ({
      ...t,
      sections: Object.values(t.sections).sort(
        (a, b) => b.mistakes.length - a.mistakes.length
      ),
    }))
    .sort((a, b) => b.total_mistakes - a.total_mistakes);

  // ─── 6. Derive worst section for sidebar card ─────────────────────────────────
  let worstSection = null;
  let worstCount = 0;
  for (const topic of topics) {
    for (const section of topic.sections) {
      if (section.mistakes.length > worstCount) {
        worstCount = section.mistakes.length;
        worstSection = {
          topic_name: topic.topic_name,
          section_name: section.section_name,
          mistake_count: section.mistakes.length,
        };
      }
    }
  }

  return res.status(200).json({
    total_mistakes: dedupedAttempts.length,
    worst_section: worstSection,
    topics,
  });
});
// POST /questions/fixed-mistakes
const fixMistakes = asyncHandler(async (req, res) => {
  const { fixed_questions_id } = req.body;

  if (!Array.isArray(fixed_questions_id) || fixed_questions_id.length === 0) {
    return res
      .status(400)
      .json({ error: "fixed_questions_id must be a non-empty array." });
  }

  // ─── 1. Auth ─────────────────────────────────────────────────────────────────
  const token = req.cookies?.access_token;
  if (!token)
    return res.status(401).json({ error: "Missing or invalid token." });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user)
    return res.status(401).json({ error: "Unauthorized user." });

  // ─── 2. Fetch student ─────────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID, cached_total_minutes")
    .eq("email", user.email)
    .single();

  if (studentError || !student) {
    return res.status(404).json({ error: "Student not found." });
  }

  const studentId = student.id;

  // ─── 3. Find which sections are affected BEFORE stamping ─────────────────────
  const { data: targetedAttempts, error: fetchAttemptsError } = await supabase
    .from("student_question_attempt")
    .select("section_id")
    .eq("student_ID", studentId)
    .eq("is_correct", false)
    .is("corrected_at", null) // ← only stamp uncorrected ones
    .in("question_id", fixed_questions_id);

  if (fetchAttemptsError) {
    console.error("Error finding target sections:", fetchAttemptsError);
    return res
      .status(500)
      .json({ error: "Failed to resolve question sections." });
  }

  const affectedSectionIds = [
    ...new Set(targetedAttempts?.map((a) => a.section_id).filter(Boolean)),
  ];

  // ─── 4. Stamp corrected_at — preserve the row, just mark it as fixed ─────────
  const correctedAt = new Date().toISOString();

  const { error: stampError } = await supabase
    .from("student_question_attempt")
    .update({ corrected_at: correctedAt, reviewed: true })
    .eq("student_ID", studentId)
    .eq("is_correct", false)
    .eq("reviewed", false)
    .in("question_id", fixed_questions_id);

  if (stampError) {
    console.error("Failed to stamp corrected_at:", stampError);
    return res.status(500).json({ error: "Failed to record correction." });
  }

  // ─── 5. Recalculate mastery for each affected section ────────────────────────
  // Mastery = (total questions - remaining UNCORRECTED wrong attempts) / total questions
  // Corrected mistakes count as credit (corrected_at IS NOT NULL)
  for (const sectionId of affectedSectionIds) {
    const { count: totalSectionQuestions, error: countQuestionsError } =
      await supabase
        .from("question")
        .select("id", { count: "exact", head: true })
        .eq("section_id", sectionId);

    // Only count still-wrong, uncorrected attempts against the student
    const { count: remainingWrongCount, error: countWrongError } =
      await supabase
        .from("student_question_attempt")
        .select("id", { count: "exact", head: true })
        .eq("student_ID", studentId)
        .eq("section_id", sectionId)
        .eq("is_correct", false)
        .is("corrected_at", null); // ← uncorrected wrong only

    if (countQuestionsError || countWrongError || !totalSectionQuestions) {
      console.error("Section mastery recalc error:", {
        countQuestionsError,
        countWrongError,
      });
      continue;
    }

    const remainingWrong = remainingWrongCount ?? 0;
    const effectiveCorrect = totalSectionQuestions - remainingWrong;

    // Corrected mistakes give 85% credit — rewards effort without inflating score
    const { count: correctedCount } = await supabase
      .from("student_question_attempt")
      .select("id", { count: "exact", head: true })
      .eq("student_ID", studentId)
      .eq("section_id", sectionId)
      .eq("is_correct", false)
      .not("corrected_at", "is", null); // ← corrected wrong attempts

    const originalCorrect = effectiveCorrect - (correctedCount ?? 0);
    const newMastery = Math.min(
      (originalCorrect + (correctedCount ?? 0) * 0.85) / totalSectionQuestions,
      1.0
    );
    const sectionStatus = newMastery >= 0.8 ? "completed" : "in_progress";

    const { data: existingProgress } = await supabase
      .from("student_section_progress")
      .select("id, mastery_score")
      .eq("student_ID", studentId)
      .eq("section_id", sectionId)
      .maybeSingle();

    // Never let mastery regress
    const bestMastery = existingProgress
      ? Math.max(existingProgress.mastery_score ?? 0, newMastery)
      : newMastery;

    const bestStatus = bestMastery >= 0.8 ? "completed" : sectionStatus;

    const progressPayload = {
      student_ID: studentId,
      section_id: sectionId,
      mastery_score: bestMastery,
      completed: bestStatus === "completed",
      status: bestStatus,
      last_attempted_at: new Date().toISOString(),
    };

    if (existingProgress) {
      const { error: updateErr } = await supabase
        .from("student_section_progress")
        .update(progressPayload)
        .eq("id", existingProgress.id);
      if (updateErr) console.error("Section progress update error:", updateErr);
    } else {
      const { error: insertErr } = await supabase
        .from("student_section_progress")
        .insert(progressPayload);
      if (insertErr) console.error("Section progress insert error:", insertErr);
    }
  }

  // ─── 6. Recompute student-level cache ────────────────────────────────────────
  const { data: classTopics, error: classTopicsError } = await supabase
    .from("Topic")
    .select("id")
    .eq("class_ID", student.Class_ID);

  if (classTopicsError) {
    console.error("classTopics fetch error:", classTopicsError);
    return res
      .status(200)
      .json({ message: "Mistakes fixed. Cache update skipped." });
  }

  const classTopicIds = (classTopics || []).map((t) => t.id);

  const [
    { data: allSections, error: allSectionsError },
    { count: totalSectionCount, error: totalSectionsError },
  ] = await Promise.all([
    supabase
      .from("student_section_progress")
      .select("completed, mastery_score")
      .eq("student_ID", studentId),

    supabase
      .from("Section")
      .select("id", { count: "exact", head: true })
      .in("topic_ID", classTopicIds),
  ]);

  if (allSectionsError || totalSectionsError) {
    console.error("Cache recalc fetch error:", {
      allSectionsError,
      totalSectionsError,
    });
    return res
      .status(200)
      .json({ message: "Mistakes fixed. Cache update skipped." });
  }

  const overallGrade =
    allSections.length > 0
      ? Math.round(
        (allSections.reduce(
          (sum, s) => sum + (Number(s.mastery_score) || 0),
          0
        ) /
          allSections.length) *
        100
      )
      : 0;

  const completedSections = allSections.filter((s) => s.completed).length;
  const completionPct =
    totalSectionCount > 0
      ? Math.round((completedSections / totalSectionCount) * 100)
      : 0;

  const { error: cacheError } = await supabase
    .from("Student")
    .update({
      cached_overall_grade: overallGrade,
      cached_completion_pct: completionPct,
      last_cache_updated_at: new Date().toISOString(),
    })
    .eq("id", studentId);

  if (cacheError) {
    console.error("Student cache update error:", cacheError);
  }

  return res.status(200).json({
    message: "Mistake fixed successfully.",
    summary: {
      overall_grade: overallGrade,
      completion_pct: completionPct,
    },
  });
});




module.exports = {
  getQuestions,
  saveQuestionMarks,
  getMistakes,
  fixMistakes,
};

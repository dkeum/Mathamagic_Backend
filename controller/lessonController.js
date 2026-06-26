const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// ─────────────────────────────────────────────────────────────────────────────
// GET /:classID/lesson/
// ─────────────────────────────────────────────────────────────────────────────
const getLessons = asyncHandler(async (req, res) => {
  const { topic, section } = req.params;
  const { class: classId } = req.query;
  const token = req.cookies?.access_token;

  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  const { data: topicData, error: topicError } = await supabase
    .from("Topic")
    .select("id")
    .ilike("name", topic.trim())
    .eq("class_ID", classId)
    .single();

  if (topicError || !topicData) return res.status(404).json({ error: "Topic not found." });

  const { data: sectionData, error: sectionError } = await supabase
    .from("Section")
    .select("id")
    .eq("name", section)
    .eq("topic_ID", topicData.id)
    .single();

  if (sectionError || !sectionData) return res.status(404).json({ error: "Section not found." });

  const { data: questions, error: questionsError } = await supabase
    .from("question")
    .select("*")
    .eq("section_id", sectionData.id)
    .limit(10);

  if (questionsError) return res.status(500).json({ error: "Error fetching questions." });
  if (!questions?.length) return res.status(404).json({ error: "No questions found for this section." });

  const questionIds = questions.map((q) => q.id);

  const { data: answers, error: answersError } = await supabase
    .from("answer")
    .select("*")
    .in("question_ID", questionIds);

  if (answersError) return res.status(500).json({ error: "Error fetching answers." });

  const merged = questions.map((q) => ({
    ...q,
    answers: (answers || []).filter((a) => a.question_ID === q.id),
  }));

  return res.status(200).json({ questions: merged });
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /:classID/topics-with-sections
// Returns topics + sections with video_watched state and minutes this week.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /:classID/topics-with-sections
// Returns topics + sections with video_watched state and minutes this week.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /:classID/topics-with-sections
// Returns topics + sections with video_watched state, practice minutes, 
// and the next sequential 'resume_target' uncompleted section.
// ─────────────────────────────────────────────────────────────────────────────
const getTopicsWithSections = asyncHandler(async (req, res) => {
  const { classID } = req.params;
  const token = req.cookies?.access_token;

  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  // 1. Resolve student record
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return res.status(404).json({ error: "Student not found." });

  // 2. Fetch all Topics for the given class
  const { data: topics, error: topicsError } = await supabase
    .from("Topic")
    .select("id, name, description, Order")
    .eq("class_ID", classID)
    .order("Order", { ascending: true });

  if (topicsError) return res.status(500).json({ error: "Error fetching topics." });
  if (!topics?.length) return res.status(200).json({ topics: [], minutes_this_week: 0, resume_target: null });

  const topicIds = topics.map((t) => t.id);

  // 3. Fetch all child Sections belonging to those topics (retrieves difficulty)
  const { data: sections, error: sectionsError } = await supabase
    .from("Section")
    .select("id, name, notes, difficulty, youtube_link, topic_ID")
    .in("topic_ID", topicIds)
    .order("id", { ascending: true });

  if (sectionsError) return res.status(500).json({ error: "Error fetching sections." });

  const sectionIds = (sections || []).map((s) => s.id);

  // 4. Look up student item progress records (video watched & quiz completed status)
  let progressMap = {};
  if (sectionIds.length > 0) {
    const { data: progress } = await supabase
      .from("student_section_progress")
      .select("section_id, completed, video_watched")
      .eq("student_ID", student.id)
      .in("section_id", sectionIds);

    (progress || []).forEach((p) => {
      progressMap[p.section_id] = {
        completed:     p.completed,
        video_watched: p.video_watched,
      };
    });
  }

  // 5. Calculate minutes studied this week (Monday through Sunday tracking)
  const now       = new Date();
  const dayOfWeek = now.getUTCDay();                       
  const daysToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;  
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysToMon);
  weekStart.setUTCHours(0, 0, 0, 0);

  const { data: weekSessions } = await supabase
    .from("student_session")
    .select("duration_minutes, section_id")
    .eq("student_ID", student.id)
    .gte("start_time", weekStart.toISOString());

  // Aggregate total weekly minutes
  const minutesThisWeek = (weekSessions || []).reduce(
    (sum, s) => sum + (Number(s.duration_minutes) || 0),
    0
  );

  // Calculate granular per-section weekly minutes
  const sectionMinutesMap = {};
  (weekSessions || []).forEach((s) => {
    if (s.section_id) {
      sectionMinutesMap[s.section_id] =
        (sectionMinutesMap[s.section_id] || 0) + (Number(s.duration_minutes) || 0);
    }
  });

  // 6. Assemble sections by topic mapping grouping
  const sectionsByTopic = {};
  (sections || []).forEach((s) => {
    if (!sectionsByTopic[s.topic_ID]) sectionsByTopic[s.topic_ID] = [];
    const prog = progressMap[s.id] ?? {};
    
    sectionsByTopic[s.topic_ID].push({
      id:                  s.id,
      name:                s.name,
      notes:               s.notes,
      difficulty:          s.difficulty, // Transferred accurately
      youtube_link:        s.youtube_link,
      quiz_completed:      prog.completed    ?? false,
      video_watched:       prog.video_watched ?? false,
      minutes_this_week:   Math.round(sectionMinutesMap[s.id] || 0),
    });
  });

  // 7. Structure overall enriched topics object tree
  const enrichedTopics = topics.map((t) => ({
    id:          t.id,
    name:        t.name,
    description: t.description,
    order:       t.Order,
    sections:    sectionsByTopic[t.id] ?? [],
  }));

  // 8. Find the next sequential video section the user needs to complete
  let resumeTarget = null;
  for (const topic of enrichedTopics) {
    const nextSection = topic.sections.find(
      (s) => !s.video_watched && s.youtube_link
    );
    if (nextSection) {
      resumeTarget = {
        ...nextSection,
        topic_name: topic.name,
        topic_id:   topic.id,
      };
      break; // Stop immediately at the earliest incomplete item sequence
    }
  }

  // 9. Send response back to the front-end layout structure
  return res.status(200).json({
    topics: enrichedTopics,
    minutes_this_week: Math.round(minutesThisWeek),
    resume_target: resumeTarget,
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /:classID/mark-video-watched
// Body: { section_id }
// Flips video_watched = true on student_section_progress.
// Creates the row if it doesn't exist yet (student opened video before doing
// any questions).
// ─────────────────────────────────────────────────────────────────────────────
const markVideoWatched = asyncHandler(async (req, res) => {
  const { section_id } = req.body;
  const token = req.cookies?.access_token;

  if (!token) return res.status(401).json({ error: "Missing or invalid token." });
  if (!section_id) return res.status(400).json({ error: "section_id is required." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return res.status(404).json({ error: "Student not found." });

  // Check for an existing progress row
  const { data: existing } = await supabase
    .from("student_section_progress")
    .select("id, video_watched")
    .eq("student_ID", student.id)
    .eq("section_id", section_id)
    .maybeSingle();

  if (existing) {
    // Already marked — no-op, return success without hitting DB again
    if (existing.video_watched) {
      return res.status(200).json({ message: "Already marked as watched." });
    }

    const { error: updateError } = await supabase
      .from("student_section_progress")
      .update({
        video_watched:    true,
        video_watched_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) {
      console.error("video_watched update error:", updateError);
      return res.status(500).json({ error: "Failed to mark video as watched." });
    }
  } else {
    // No progress row yet — create a minimal one so we don't lose the signal
    const { error: insertError } = await supabase
      .from("student_section_progress")
      .insert({
        student_ID:       student.id,
        section_id:       section_id,
        video_watched:    true,
        video_watched_at: new Date().toISOString(),
        mastery_score:    0,
        completed:        false,
        status:           "in_progress",
        last_attempted_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error("video_watched insert error:", insertError);
      return res.status(500).json({ error: "Failed to create progress row." });
    }
  }

  return res.status(200).json({ message: "Video marked as watched." });
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /:classID/set-watched-lessons
// ─────────────────────────────────────────────────────────────────────────────
const setLessonWatched = asyncHandler(async (req, res) => {
  const {
    topic_id,
    section_id,
    grade,
    start_time,
    end_time,
    recordedAnswers,
  } = req.body;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  // ── Student ───────────────────────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID")
    .eq("email", user.email)
    .single();

  if (studentError || !student) return res.status(404).json({ error: "Student not found." });

  const studentId = student.id;

  // ── Validate ──────────────────────────────────────────────────────────────
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
    return res.status(400).json({ error: "grade must be a number between 0 and 100." });
  }

  // ── Insert student_session (now includes section_id + topic_id) ───────────
  const { error: sessionError } = await supabase
    .from("student_session")
    .insert({
      student_ID: studentId,
      start_time,
      end_time,
      section_id: section_id ?? null,   // ← NEW: attribute session to section
      topic_id:   topic_id   ?? null,   // ← NEW: attribute session to topic
      timezone:   req.body.timezone ?? null,
    });

  if (sessionError) {
    console.error("session insert error:", sessionError);
    return res.status(500).json({ error: "Failed to save session." });
  }

  // ── Question attempts ─────────────────────────────────────────────────────
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
      return res.status(500).json({ error: "Failed to check existing attempts." });
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
      student_ID:         studentId,
      question_id:        a.question_id,
      section_id:         section_id,
      is_correct:         Boolean(a.is_correct),
      answer_given:       a.answer_given ?? null,
      time_spent_seconds: a.time_spent_seconds ?? null,
      used_ai_video:      Boolean(a.used_ai_video),
      used_ai_chat:       Boolean(a.used_ai_chat),
      corrected_at:       null,
      reviewed:           false,
    };

    const existingId = !a.is_correct ? existingWrongMap[a.question_id] : null;
    existingId ? toUpdate.push({ id: existingId, payload }) : toInsert.push(payload);
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from("student_question_attempt")
      .insert(toInsert);

    if (insertError) {
      console.error("attempts insert error:", insertError);
      return res.status(500).json({ error: "Failed to save question attempts." });
    }
  }

  for (const { id, payload } of toUpdate) {
    const { error: updateError } = await supabase
      .from("student_question_attempt")
      .update(payload)
      .eq("id", id);

    if (updateError) {
      console.error("attempts update error:", updateError);
      return res.status(500).json({ error: "Failed to update question attempt." });
    }
  }

  // ── Section progress ──────────────────────────────────────────────────────
  const sectionStatus = parsedGrade >= 80 ? "completed" : "in_progress";

  const { data: existingProgress } = await supabase
    .from("student_section_progress")
    .select("id, mastery_score, completed, video_watched")
    .eq("student_ID", studentId)
    .eq("section_id", section_id)
    .maybeSingle();

  const newMastery  = parsedGrade / 100;
  const bestMastery = existingProgress
    ? Math.max(existingProgress.mastery_score ?? 0, newMastery)
    : newMastery;

  const bestStatus =
    existingProgress?.completed === true ? "completed" : sectionStatus;

  const progressPayload = {
    student_ID:        studentId,
    section_id:        section_id,
    mastery_score:     bestMastery,
    completed:         bestStatus === "completed",
    status:            bestStatus,
    last_attempted_at: new Date().toISOString(),
    // Preserve video_watched — don't reset it when submitting questions
    ...(existingProgress
      ? {}
      : { video_watched: false, video_watched_at: null }),
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
    return res.status(500).json({ error: "Failed to update section progress." });
  }

  // ── Recompute Student-level cache ─────────────────────────────────────────
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

  const now       = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysToMon);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [
    { data: allSections,    error: allSectionsError },
    { data: allSessions,    error: allSessionsError },
    { count: totalSectionCount, error: totalSectionsError },
    { data: weekSessions,   error: weekSessionsError },
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

    supabase
      .from("student_session")
      .select("duration_minutes")
      .eq("student_ID", studentId)
      .gte("start_time", weekStart.toISOString()),
  ]);

  if (allSectionsError || allSessionsError || totalSectionsError) {
    console.error("cache recalc fetch error:", { allSectionsError, allSessionsError, totalSectionsError });
    return res.status(200).json({
      message: "Progress saved. Cache update skipped due to fetch error.",
    });
  }

  const overallGrade =
    allSections.length > 0
      ? Math.round(
          (allSections.reduce((sum, s) => sum + (Number(s.mastery_score) || 0), 0) /
            allSections.length) * 100
        )
      : 0;

  const totalMinutes = allSessions.reduce(
    (sum, s) => sum + (Number(s.duration_minutes) || 0), 0
  );

  const minutesThisWeek = (weekSessions || []).reduce(
    (sum, s) => sum + (Number(s.duration_minutes) || 0), 0
  );

  const completedSections = allSections.filter((s) => s.completed).length;
  const completionPct =
    totalSectionCount > 0
      ? Math.round((completedSections / totalSectionCount) * 100)
      : 0;

  const { error: cacheError } = await supabase
    .from("Student")
    .update({
      cached_overall_grade:  overallGrade,
      cached_total_minutes:  Math.round(totalMinutes),
      cached_completion_pct: completionPct,
      last_cache_updated_at: new Date().toISOString(),
    })
    .eq("id", studentId);

  if (cacheError) console.error("cache update error:", cacheError);

  return res.status(200).json({
    message: "Progress saved successfully.",
    summary: {
      section_status:    bestStatus,
      grade:             parsedGrade,
      overall_grade:     overallGrade,
      total_minutes:     Math.round(totalMinutes),
      minutes_this_week: Math.round(minutesThisWeek),
      completion_pct:    completionPct,
    },
  });
});


module.exports = {
  getLessons,
  getTopicsWithSections,
  markVideoWatched,
  setLessonWatched,
};
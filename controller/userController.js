const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const dateFunctions = require("./helperFunctions/date");
const { v4: uuidv4 } = require("uuid"); // import uuid
const axios = require("axios");
const jwt = require("jsonwebtoken");



// @ GET
// ROUTE: /:user_email/getprofile
// @ GET
// ROUTE: /:user_email/getprofile
const getProgress = asyncHandler(async (req, res) => {
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

  const email = user.email;

  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select(
      `
      id, name, class, grade, time_commitment, profile_picture,
      AI_Credit, plan_type, isSubscribed, had_trial,
      trial_end, subscription_end, subscription_status, Class_ID,
      cached_overall_grade, cached_completion_pct,
      cached_total_minutes, last_cache_updated_at,
      last_free_video_at, last_free_step_by_step_at
    `
    )
    .eq("email", email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }

  const {
    id: studentId,
    name: studentName,
    class: className,
    time_commitment: timeCommitment,
    profile_picture,
    AI_Credit,
    plan_type,
    isSubscribed,
    had_trial,
    trial_end,
    subscription_end,
    subscription_status,
    Class_ID: classIdFromDb,
    cached_overall_grade,
    cached_completion_pct,
    cached_total_minutes,
    last_cache_updated_at,
    last_free_video_at,
    last_free_step_by_step_at,
  } = studentData;

  let classId = classIdFromDb;

  // ── Subscription fields ──────────────────────────────────────
  const now = new Date();
  const trialEndDate = trial_end ? new Date(trial_end) : null;
  const subEndDate = subscription_end ? new Date(subscription_end) : null;
  const is_on_trial = Boolean(had_trial && trialEndDate && trialEndDate > now);

  let days_remaining = 0;
  if (is_on_trial && trialEndDate) {
    days_remaining = Math.max(
      0,
      Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24))
    );
  } else if (isSubscribed && subEndDate) {
    days_remaining = Math.max(
      0,
      Math.ceil((subEndDate - now) / (1000 * 60 * 60 * 24))
    );
  }

  // ── Daily free-usage boundary (start of today, server local time) ──
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const video_free_available_today =
    !last_free_video_at || new Date(last_free_video_at) < startOfToday;

  const step_by_step_free_available_today =
    !last_free_step_by_step_at ||
    new Date(last_free_step_by_step_at) < startOfToday;

  // ── Run independent queries in parallel ──────────────────────
  const [
    { data: sessions },
    { count: wrong_count },
    { data: lastSection },
    { count: homework_free_uploads_used_today },
  ] = await Promise.all([
    // Sessions for github activity + time tracking
    supabase
      .from("student_session")
      .select("start_time, end_time, duration_minutes, timezone")
      .eq("student_ID", studentId)
      .order("start_time", { ascending: true }),

    // Wrong unreviewed question count for dashboard card
    supabase
      .from("student_question_attempt")
      .select("*", { count: "exact", head: true })
      .eq("student_ID", studentId)
      .eq("is_correct", false)
      .eq("reviewed", false)
      .is("corrected_at", null),

    // Last attempted section for current module
    supabase
      .from("student_section_progress")
      .select(
        `
        section_id,
        mastery_score,
        last_attempted_at,
        Section:section_id (
          name,
          topic_ID,
          Topic:topic_ID (
            id,
            name
          )
        )
      `
      )
      .eq("student_ID", studentId)
      .not("last_attempted_at", "is", null)
      .order("last_attempted_at", { ascending: false })
      .limit(1)
      .single(),

    // Free homework uploads used today
    supabase
      .from("homework_submission")
      .select("*", { count: "exact", head: true })
      .eq("student_ID", studentId)
      .eq("is_free_submission", true)
      .gte("submitted_at", startOfToday.toISOString()),
  ]);

  const homework_free_uploads_remaining_today = Math.max(
    0,
    3 - (homework_free_uploads_used_today ?? 0)
  );

  // ── Sessions ─────────────────────────────────────────────────
  let github_activity = [];
  let time_goal_met = 0;
  let total_minutes_logged = 0;

  const date200DaysAgo = new Date();
  date200DaysAgo.setDate(date200DaysAgo.getDate() - 200);
  github_activity.push({
    date: date200DaysAgo.toISOString().slice(0, 10),
    count: 0,
    level: 0,
  });

  if (!sessions || sessions.length === 0) {
    const today = new Date();
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 20);

    github_activity = [
      { date: twoMonthsAgo.toISOString().slice(0, 10), count: 1, level: 1 },
      { date: today.toISOString().slice(0, 10), count: 1, level: 1 },
    ];

    await supabase.from("student_session").insert({
      student_ID: studentId,
      start_time: today.toISOString(),
      end_time: today.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  } else {
    const groupedByDate = {};
    for (const session of sessions) {
      const date = session.start_time.slice(0, 10);
      if (!groupedByDate[date]) groupedByDate[date] = 0;
      groupedByDate[date] += parseFloat(session.duration_minutes || 0);
    }
    for (const [date, totalMinutes] of Object.entries(groupedByDate)) {
      let level = 1;
      if (totalMinutes >= 120) level = 4;
      else if (totalMinutes >= 60) level = 3;
      else if (totalMinutes >= 30) level = 2;
      github_activity.push({ date, count: 1, level });
    }

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weeklyMinutes = sessions
      .filter((s) => new Date(s.start_time) >= oneWeekAgo)
      .reduce((sum, s) => sum + parseFloat(s.duration_minutes || 0), 0);
    const weeklyGoalMinutes = (timeCommitment || 0) * 60;
    time_goal_met =
      weeklyGoalMinutes > 0
        ? Math.min(100, Math.round((weeklyMinutes / weeklyGoalMinutes) * 100))
        : 0;

    total_minutes_logged = sessions.reduce(
      (sum, s) => sum + parseFloat(s.duration_minutes || 0),
      0
    );
  }

  // ── Class fallback ───────────────────────────────────────────
  if (!classId) {
    const { error: updateError } = await supabase
      .from("Student")
      .update({ Class_ID: 3 })
      .eq("id", studentId);

    if (updateError) {
      return res.status(500).json({ error: "Failed to assign default class." });
    }
    classId = 3;
  }

  // ── Topics & Sections ────────────────────────────────────────
  const { data: topics, error: topicError } = await supabase
    .from("Topic")
    .select("id, name")
    .eq("class_ID", classId);

  if (topicError || !topics || topics.length === 0) {
    return res.status(404).json({ error: "No topics found for this class." });
  }

  const topicIds = topics.map((t) => t.id);

  const { data: sections, error: sectionError } = await supabase
    .from("Section")
    .select("id, name, topic_ID")
    .in("topic_ID", topicIds);

  if (sectionError || !sections || sections.length === 0) {
    return res.status(404).json({ error: "No sections found for topics." });
  }

  const sectionIds = sections.map((s) => s.id);

  // ── Section progress + question-attempt grades ────────────────
  const [{ data: sectionProgress }, { data: questionAttempts }] = await Promise.all([
    supabase
      .from("student_section_progress")
      .select("section_id, mastery_score, completed, last_attempted_at")
      .eq("student_ID", studentId)
      .in("section_id", sectionIds),

    // NOTE: assumes student_question_attempt.section_id is populated directly.
    // If attempts are only linked via question_id (no section_id on the row),
    // this needs to join through `question` instead — flag if that's the case.
    supabase
      .from("student_question_attempt")
      .select("section_id, is_correct")
      .eq("student_ID", studentId)
      .in("section_id", sectionIds),
  ]);

  const progressMap = {};
  for (const p of sectionProgress || []) {
    progressMap[p.section_id] = p;
  }

  // Per-section grade built from actual question attempts: (# correct / # total) * 100
  const sectionGradeMap = {}; // section_id -> { correct, total }
  for (const qa of questionAttempts || []) {
    if (!sectionGradeMap[qa.section_id]) {
      sectionGradeMap[qa.section_id] = { correct: 0, total: 0 };
    }
    sectionGradeMap[qa.section_id].total += 1;
    if (qa.is_correct) sectionGradeMap[qa.section_id].correct += 1;
  }

  // ── Current module ───────────────────────────────────────────
  const current_module = lastSection
    ? {
      topic_name: lastSection.Section?.Topic?.name ?? null,
      topic_id: lastSection.Section?.Topic?.id ?? null,
      section_name: lastSection.Section?.name ?? null,
      section_id: lastSection.section_id,
      mastery_score: parseFloat(lastSection.mastery_score || 0),
      last_attempted_at: lastSection.last_attempted_at,
    }
    : null;

  // ── Build progressArray with topic mastery + section status ──
  let total_sections = 0;
  let attempted_sections = 0;      // sections with at least one graded question attempt
  let attempted_mastery_sum = 0;   // sum of per-section (%correct) grades, only over attempted sections
  let completed_sections = 0;      // sections marked completed
  let isFirstSectionGlobal = true;

  const progressArray = topics.map((topic) => {
    const topicSections = sections.filter((sec) => sec.topic_ID === topic.id);
    let topicMasterySum = 0;
    let topicAttemptedCount = 0;

    const mappedSections = topicSections.map((sec) => {
      const p = progressMap[sec.id];
      const isCompleted = p?.completed ?? false;

      const grades = sectionGradeMap[sec.id];
      const hasGrade = grades && grades.total > 0;
      const sectionGrade = hasGrade ? (grades.correct / grades.total) * 100 : 0;

      total_sections += 1;

      if (hasGrade) {
        attempted_sections += 1;
        attempted_mastery_sum += sectionGrade;
        topicAttemptedCount += 1;
        topicMasterySum += sectionGrade;
      }
      if (isCompleted) {
        completed_sections += 1;
      }

      let status = "todo";
      if (isCompleted) {
        status = "done";
      } else if (current_module && sec.id === current_module.section_id) {
        status = "active";
      } else if (!current_module && isFirstSectionGlobal) {
        status = "active";
      }
      isFirstSectionGlobal = false;

      return {
        section_name: sec.name,
        section_id: sec.id,
        progress: p ? (isCompleted ? 1 : sectionGrade / 100) : 0,
        latest_grade: sectionGrade,
        completed: isCompleted,
        status,
        last_attempted_at: p?.last_attempted_at ?? null,
      };
    });

    // topic_mastery: average per-section question-attempt grade, only over attempted sections in this topic
    const topic_mastery = topicAttemptedCount > 0 ? (topicMasterySum / topicAttemptedCount) : 0;

    return {
      topic_name: topic.name,
      topic_mastery,
      sections: mappedSections,
    };
  });

  // ── Filter for new students ───────────────────────────────────
  let finalProgressArray = progressArray;
  let hasActivityHistory = true;

  if (!current_module && progressArray.length > 0) {
    hasActivityHistory = false;
    const firstTopic = progressArray[0];
    finalProgressArray = [
      {
        ...firstTopic,
        sections: firstTopic.sections.slice(0, 4),
      },
    ];
  }

  // ── Cache check & compute ────────────────────────────────────
  const cacheAgeMinutes = last_cache_updated_at
    ? (Date.now() - new Date(last_cache_updated_at)) / 1000 / 60
    : 999;

  let completion_progress, current_grade, time_logged_pct;

  if (cacheAgeMinutes < 5 && cached_overall_grade != null) {
    current_grade = cached_overall_grade;
    completion_progress = cached_completion_pct;
    time_logged_pct =
      cached_total_minutes > 0 && (timeCommitment || 0) > 0
        ? Math.min(
          100,
          Math.round(
            (cached_total_minutes / ((timeCommitment || 1) * 60)) * 100
          )
        )
        : 0;
  } else {
    // completion_progress: % of ALL sections in the class marked completed
    completion_progress = total_sections > 0
      ? Math.round((completed_sections / total_sections) * 100)
      : 0;

    // current_grade: average of per-section (%correct) grades across sections actually attempted
    current_grade = attempted_sections > 0
      ? Math.round(attempted_mastery_sum / attempted_sections)
      : 0;

    time_logged_pct =
      (timeCommitment || 0) > 0
        ? Math.min(
          100,
          Math.round(
            (total_minutes_logged / ((timeCommitment || 1) * 60)) * 100
          )
        )
        : 0;

    // Fire-and-forget cache update
    supabase
      .from("Student")
      .update({
        cached_overall_grade: current_grade,
        cached_completion_pct: completion_progress,
        cached_total_minutes: total_minutes_logged,
        last_cache_updated_at: new Date().toISOString(),
      })
      .eq("id", studentId)
      .then(({ error }) => {
        if (error) console.error("Cache update failed:", error.message);
      });
  }

  return res.status(200).json({
    name: studentName ?? "",
    github_activity,
    current_grade,
    completion_progress,
    time_logged_pct,
    total_minutes_logged,
    progressArray: finalProgressArray,
    current_module,
    hasActivityHistory,
    wrong_count: wrong_count ?? 0,
    timeCommitment: time_goal_met,
    actual_time_commitment: timeCommitment,
    profile_picture,
    is_on_trial,
    days_remaining,
    plan_type: plan_type ?? "free",
    ai_credits: AI_Credit ?? 0,
    subscription_status: subscription_status ?? "inactive",
    class: className,
    Class_ID: classIdFromDb,

    // daily free-usage tracking (video / homework / step-by-step)
    last_free_video_at: last_free_video_at ?? null,
    video_free_available_today,

    homework_free_uploads_used_today: homework_free_uploads_used_today ?? 0,
    homework_free_uploads_remaining_today,

    last_free_step_by_step_at: last_free_step_by_step_at ?? null,
    step_by_step_free_available_today,
  });
});
// @ PUT
// ROUTE /:topic/:section

const updateGrades = asyncHandler(async (req, res) => {
  // update the grades for the user
});

// @ POST
// ROUTE: /save-session

const saveSession = asyncHandler(async (req, res) => {
  const { email, timeZone, startTime, endTime } = req.body;

  if (!email) {
    return res.status(400).json({ message: "No email detected" });
  }
  if (!startTime || !endTime) {
    return res
      .status(400)
      .json({ message: "Start and end times are required" });
  }
  if (!timeZone) {
    return res.status(400).json({ message: "Time zone is required" });
  }

  // Extract token
  const token = req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // console.log("Everything is validated so far")

  // Get user from token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "User authentication failed" });
  }

  const email_detected = user.email;
  if (email_detected !== email) {
    return res.status(403).json({ error: "Email mismatch" });
  }

  // console.log(email_detected)

  // Fetch current time log for the student
  const { data: studentData, error: fetchError } = await supabase
    .from("Student")
    .select("time_logged")
    .eq("email", email)
    .single();

  if (fetchError) {
    return res.status(500).json({ error: "Error fetching student data" });
  }

  // Convert incoming ISO strings to Date objects
  const start = new Date(startTime);
  const end = new Date(endTime);

  // Ensure we're dealing with UTC
  const startUTC = start.toISOString();
  const endUTC = end.toISOString();

  let updatedLogs = studentData?.time_logged || [];

  // console.log("printing start time and end time")
  // console.log(startUTC, endUTC)

  // Filter logs for today
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todayLogs = updatedLogs.filter((log) => log.slice(0, 10) === today);

  if (todayLogs.length === 0) {
    // No logs today → add new session
    updatedLogs.push(startUTC);
    updatedLogs.push(endUTC);
  } else {
    // Find indices of the two timestamps for today
    // We want to find the first two timestamps in updatedLogs with date === today
    let count = 0;
    for (let i = 0; i < updatedLogs.length; i++) {
      if (updatedLogs[i].slice(0, 10) === today) {
        count++;
        // When count == 2, this is the later timestamp we want to update
        if (count === 2) {
          updatedLogs[i] = endUTC; // Replace the second timestamp with new endUTC
          break; // Stop after updating
        }
      }
    }
  }

  // Save back to Supabase
  const { error: updateError } = await supabase
    .from("Student")
    .update({
      time_logged: updatedLogs,
    })
    .eq("email", email);

  if (updateError) {
    console.log(updateError);
    return res.status(500).json({ error: "Error updating session log" });
  }

  res.status(200).json({ message: "Session saved successfully" });
});

// @ POST
// ROUTE: /update-userprofile
// Body: { answers: [subject, gradeLevel, className, desiredGrade, timeCommitmentLabel], access_token }
const setDataFromSurvey = asyncHandler(async (req, res) => {
  const { answers, access_token } = req.body;

  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // console.log(answers)
  if (!Array.isArray(answers) || answers.length !== 5) {
    return res.status(400).json({ error: "Malformed survey answers." });
  }

  // Validate the token and identify the user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  const email = user.email;

  const [subject, gradeLevel, className, desiredGradeLabel, timeCommitmentLabel] = answers;

  // ── Look up Class_ID from the selected class name ─────────────
  const { data: classRow, error: classLookupError } = await supabase
    .from("Class")
    .select("id")
    .eq("name", className)
    .maybeSingle();

  if (classLookupError) {
    console.error("Class lookup failed:", classLookupError);
    return res.status(500).json({ error: "Failed to resolve selected class." });
  }

  if (!classRow) {
    // The student picked a class name that doesn't exist in the Class table
    // (e.g. the "No classes available for that combination" placeholder,
    // or the CLASS_MAP and Class table have drifted out of sync).
    return res.status(400).json({
      error: `No matching class found for "${className}". Please contact support.`,
    });
  }

  // ── Convert the time-commitment label into a numeric hours/week value ──
  const TIME_COMMITMENT_MAP = {
    "0-3 hours": 2,
    "3-5 hours": 4,
    "Over 5 hours": 6,
  };
  const timeCommitmentHours = TIME_COMMITMENT_MAP[timeCommitmentLabel] ?? null;

  if (timeCommitmentHours === null) {
    return res.status(400).json({ error: "Invalid time commitment selection." });
  }

  // ── Persist everything to the Student row ──────────────────────
  const { data: updatedStudent, error: updateError } = await supabase
    .from("Student")
    .update({
      class: className,
      grade: gradeLevel,
      desired_grade: desiredGradeLabel,
      time_commitment: timeCommitmentHours,
      Class_ID: classRow.id,
    })
    .eq("email", email)
    .select()
    .single();

  if (updateError || !updatedStudent) {
    console.error("Failed to update student profile from survey:", updateError);
    return res.status(500).json({ error: "Failed to save profile details." });
  }

  return res.status(200).json({
    message: "Profile updated successfully.",
    student: updatedStudent,
  });
});

module.exports = {
  setDataFromSurvey,
  getProgress,
  saveSession,
  updateGrades,

};

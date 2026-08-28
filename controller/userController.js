const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const dateFunctions = require("./helperFunctions/date");
const { v4: uuidv4 } = require("uuid"); // import uuid
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { PARALLEL_THRESHOLD,
  updateSectionSkillsSequential,
  updateSectionSkillsParallel,
  computeSectionStatus, } = require("./helperFunctions/knowledgeTreePrompts");
const { chargeCredits } = require("./aiController");

const {
  computeProgress,
  computeGradeBreakdown,
  computePersistence,
  computeIndependence,
  computeConsistency,
  computeFocus,
  computeErrorChecking,
  computeHardSkills,
  computeStepByStepUsage,
  generateRecommendations,
} = require("./helperFunctions/studentReportGenerate");

const {
  checkAndUpdateSubscription,
  getDailyFreeUsage,
  buildActivityStats,
  buildCourseProgress
} = require('./helperFunctions/StudentStatus'); // Adjust path as needed



// @ GET
// ROUTE: /:user_email/getprofile


const getProgress = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  // 1. Authenticate & Fetch User
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select(`
      id, name, class, grade, time_commitment, profile_picture,
      AI_Credit, plan_type, isSubscribed, had_trial,
      trial_end, subscription_end, subscription_status, Class_ID,
      cached_overall_grade, cached_completion_pct,
      cached_total_minutes, last_cache_updated_at,
      last_free_video_at, last_free_step_by_step_at
    `)
    .eq("email", user.email)
    .single();

  if (studentError || !studentData) return res.status(404).json({ error: "Student not found." });

  const studentId = studentData.id;

  // 2. Fallback for Class ID
  let classId = studentData.Class_ID;
  if (!classId) {
    const { error: updateError } = await supabase.from("Student").update({ Class_ID: 3 }).eq("id", studentId);
    if (updateError) return res.status(500).json({ error: "Failed to assign default class." });
    classId = 3;
  }

  // 3. Delegate Subscription & Free Usage Check
  const { is_on_trial, days_remaining, updatedStatus } = await checkAndUpdateSubscription(supabase, studentData);
  const startOfTodayISO = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  // 4. Run Independent Queries in Parallel
  let sessions, wrong_count, lastSection, homework_free_uploads_used_today;
  try {
    const results = await Promise.all([
      supabase.from("student_session").select("start_time, end_time, duration_minutes, timezone").eq("student_ID", studentId).order("start_time", { ascending: true }),
      supabase.from("student_question_attempt").select("*", { count: "exact", head: true }).eq("student_ID", studentId).eq("is_correct", false).eq("reviewed", false).is("corrected_at", null),
      supabase.from("student_section_progress").select(`section_id, mastery_score, last_attempted_at, Section:section_id (name, topic_ID, Topic:topic_ID (id, name))`).eq("student_ID", studentId).not("last_attempted_at", "is", null).order("last_attempted_at", { ascending: false }).limit(1).single(),
      supabase.from("homework_submission").select("*", { count: "exact", head: true }).eq("student_ID", studentId).eq("is_free_submission", true).gte("submitted_at", startOfTodayISO)
    ]);
    sessions = results[0].data;
    wrong_count = results[1].count;
    lastSection = results[2].data;
    homework_free_uploads_used_today = results[3].count;
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch student dashboard data." });
  }

  // 5. Build Activity Stats & Usage Boundaries
  const dailyUsage = getDailyFreeUsage(studentData, homework_free_uploads_used_today);
  const { github_activity, time_goal_met, total_minutes_logged } = await buildActivityStats(supabase, studentId, sessions, studentData.time_commitment);

  // 6. Fetch Topics & Sections
  const { data: topics, error: topicError } = await supabase.from("Topic").select("id, name").eq("class_ID", classId);
  if (topicError || !topics || topics.length === 0) return res.status(404).json({ error: "No topics found for this class." });

  const topicIds = topics.map((t) => t.id);
  const { data: sections, error: sectionError } = await supabase.from("Section").select("id, name, topic_ID").in("topic_ID", topicIds);
  if (sectionError || !sections || sections.length === 0) return res.status(404).json({ error: "No sections found for topics." });

  const sectionIds = sections.map((s) => s.id);

  // 7. Fetch Section Progress in Parallel
  const [{ data: sectionProgress }, { data: questionAttempts }] = await Promise.all([
    supabase.from("student_section_progress").select("section_id, mastery_score, completed, last_attempted_at").eq("student_ID", studentId).in("section_id", sectionIds),
    supabase.from("student_question_attempt").select("section_id, is_correct").eq("student_ID", studentId).in("section_id", sectionIds),
  ]);

  const current_module = lastSection ? {
    topic_name: lastSection.Section?.Topic?.name ?? null,
    topic_id: lastSection.Section?.Topic?.id ?? null,
    section_name: lastSection.Section?.name ?? null,
    section_id: lastSection.section_id,
    mastery_score: parseFloat(lastSection.mastery_score || 0),
    last_attempted_at: lastSection.last_attempted_at,
  } : null;

  // 8. Build Course Progress Array
  const {
    finalProgressArray,
    hasActivityHistory,
    total_sections,
    attempted_sections,
    attempted_mastery_sum,
    completed_sections
  } = buildCourseProgress(topics, sections, sectionProgress, questionAttempts, current_module);

  // 9. Cache Computation & Background Update
  const cacheAgeMinutes = studentData.last_cache_updated_at ? (Date.now() - new Date(studentData.last_cache_updated_at)) / 1000 / 60 : 999;
  let completion_progress, current_grade, time_logged_pct;

  if (cacheAgeMinutes < 5 && studentData.cached_overall_grade != null) {
    current_grade = studentData.cached_overall_grade;
    completion_progress = studentData.cached_completion_pct;
    time_logged_pct = (studentData.cached_total_minutes > 0 && (studentData.time_commitment || 0) > 0)
      ? Math.min(100, Math.round((studentData.cached_total_minutes / ((studentData.time_commitment || 1) * 60)) * 100)) : 0;
  } else {
    completion_progress = total_sections > 0 ? Math.round((completed_sections / total_sections) * 100) : 0;
    current_grade = attempted_sections > 0 ? Math.round(attempted_mastery_sum / attempted_sections) : 0;
    time_logged_pct = (studentData.time_commitment || 0) > 0
      ? Math.min(100, Math.round((total_minutes_logged / ((studentData.time_commitment || 1) * 60)) * 100)) : 0;

    // Fire-and-forget cache update
    supabase.from("Student").update({
      cached_overall_grade: current_grade,
      cached_completion_pct: completion_progress,
      cached_total_minutes: total_minutes_logged,
      last_cache_updated_at: new Date().toISOString(),
    }).eq("id", studentId).then(({ error }) => {
      if (error) console.error("Cache update failed:", error.message);
    });
  }

  // 10. Return Dashboard Payload
  return res.status(200).json({
    name: studentData.name ?? "",
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
    actual_time_commitment: studentData.time_commitment,
    profile_picture: studentData.profile_picture,
    is_on_trial,
    days_remaining,
    plan_type: studentData.plan_type ?? "free",
    ai_credits: studentData.AI_Credit ?? 0,
    subscription_status: updatedStatus ?? "inactive",
    class: studentData.class,
    Class_ID: classId,

    last_free_video_at: studentData.last_free_video_at ?? null,
    video_free_available_today: dailyUsage.video_free_available_today,
    homework_free_uploads_used_today: homework_free_uploads_used_today ?? 0,
    homework_free_uploads_remaining_today: dailyUsage.homework_free_uploads_remaining_today,
    last_free_step_by_step_at: studentData.last_free_step_by_step_at ?? null,
    step_by_step_free_available_today: dailyUsage.step_by_step_free_available_today,
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



// @ GET
// ROUTE: /generate-student-progress-report?months=3
const generateStudentProgressReport = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID, plan_type, AI_Credit, time_commitment")
    .eq("email", user.email)
    .single();
  if (studentError || !studentData) return res.status(404).json({ error: "Student not found." });

  const studentId = studentData.id;
  const classId = studentData.Class_ID;

  const periodMonths = parseInt(req.query.months, 10) || 3;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setMonth(periodStart.getMonth() - periodMonths);

  const periodStartISO = periodStart.toISOString();
  const periodEndISO = periodEnd.toISOString();

  const { data: topics, error: topicError } = await supabase
    .from("Topic")
    .select("id")
    .eq("class_ID", classId);
  if (topicError || !topics || topics.length === 0) {
    return res.status(404).json({ error: "No topics found for this class." });
  }

  const { data: sections, error: sectionError } = await supabase
    .from("Section")
    .select("id, name, topic_ID")
    .in("topic_ID", topics.map((t) => t.id));
  if (sectionError || !sections || sections.length === 0) {
    return res.status(404).json({ error: "No sections found for topics." });
  }
  const sectionIds = sections.map((s) => s.id);

  const [progress, gradeBreakdown, persistence, independence, consistency, focus, errorChecking, hardSkills, stepByStep] =
    await Promise.all([
      computeProgress(studentId, sectionIds, periodStartISO, periodEndISO, studentData.time_commitment),
      computeGradeBreakdown(studentId, sections, periodStartISO, periodEndISO),
      computePersistence(studentId, periodStartISO, periodEndISO),
      computeIndependence(studentId, periodStartISO, periodEndISO),
      computeConsistency(studentId, periodStartISO, periodEndISO),
      computeFocus(studentId, periodStartISO, periodEndISO),
      computeErrorChecking(studentId, periodStartISO, periodEndISO),
      computeHardSkills(studentId, sectionIds),
      computeStepByStepUsage(studentId, periodStartISO, periodEndISO, 10),
    ]);

  const reportDataSoFar = {
    progress,
    grade_breakdown: gradeBreakdown,
    soft_skills: {
      persistence: persistence.score,
      independence: independence.score,
      consistency: consistency.score,
      focus: focus.score,
      error_checking: errorChecking.score,
    },
    hard_skills: hardSkills,
    step_by_step: stepByStep.hasData ? stepByStep.sessions : null,
  };

  const { recommendations, errors_to_fix, tokensUsed, creditsUsed, skippedForCredits } =
    await generateRecommendations(studentData, reportDataSoFar);

  const creditsRemaining = creditsUsed > 0
    ? (await chargeCredits(studentId, creditsUsed)) ?? studentData.AI_Credit
    : studentData.AI_Credit;

  const reportData = {
    ...reportDataSoFar,
    recommendations,
    errors_to_fix,
  };

  const { data: savedReport, error: saveErr } = await supabase
    .from("student_progress_report")
    .upsert({
      student_id: studentId,
      period_months: periodMonths,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      report_data: reportData,
      generated_at: new Date().toISOString(),
    }, { onConflict: "student_id,period_start,period_end" })
    .select()
    .single();
  if (saveErr) throw saveErr;

  res.status(200).json({
    success: true,
    report: reportData,
    tokensUsed,
    creditsUsed,
    creditsRemaining,
    creditsExhausted: skippedForCredits,
  });
});



// @ GET
// ROUTE: /generate-student-knowledge-tree
// @ GET
// ROUTE: /generate-student-knowledge-tree
const generateStudentKnowledgeTree = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });

  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID, plan_type, AI_Credit")
    .eq("email", user.email)
    .single();
  if (studentError || !studentData) return res.status(404).json({ error: "Student not found." });

  const studentId = studentData.id;
  const classId = studentData.Class_ID;
  const startingCredits = studentData.AI_Credit ?? 0;
  const runInParallel = startingCredits > PARALLEL_THRESHOLD;

  const { data: topics, error: topicError } = await supabase
    .from("Topic")
    .select("id, name, Order")
    .eq("class_ID", classId)
    .order("Order", { ascending: true });
  if (topicError || !topics || topics.length === 0) {
    return res.status(404).json({ error: "No topics found for this class." });
  }

  const topicIds = topics.map((t) => t.id);
  const { data: sections, error: sectionError } = await supabase
    .from("Section")
    .select("id, name, topic_ID")
    .in("topic_ID", topicIds)
    .order("id", { ascending: true });
  if (sectionError || !sections || sections.length === 0) {
    return res.status(404).json({ error: "No sections found for topics." });
  }

  const { data: progressRows, error: progressError } = await supabase
    .from("student_section_progress")
    .select("*")
    .eq("student_ID", studentId)
    .in("section_id", sections.map((s) => s.id));
  if (progressError) throw progressError;

  const progressMap = {};
  (progressRows || []).forEach((p) => { progressMap[p.section_id] = p; });

  // Sort sections to match curriculum order: topic order first (topics is
  // already ordered by `Order`), then section order within each topic.
  // This is what firstIncomplete must walk — NOT the raw `sections` array,
  // which is only sorted by id globally and can put a later topic's section
  // ahead of an earlier topic's section if ids don't line up with curriculum
  // order. (If sections within a topic can also be created out of order,
  // swap `a.id - b.id` below for an explicit `Order` column on Section.)
  const sectionsByTopic = new Map();
  sections.forEach((s) => {
    if (!sectionsByTopic.has(s.topic_ID)) sectionsByTopic.set(s.topic_ID, []);
    sectionsByTopic.get(s.topic_ID).push(s);
  });

  const orderedSections = topics.flatMap((topic) =>
    (sectionsByTopic.get(topic.id) || []).sort((a, b) => a.id - b.id)
  );

  let firstIncompleteFound = false;
  const sectionsWithStatus = orderedSections.map((section) => {
    const progressRow = progressMap[section.id];
    const completed = !!progressRow?.completed;
    const isFirstIncomplete = !completed && !firstIncompleteFound;
    if (isFirstIncomplete) firstIncompleteFound = true;
    return { section, progressRow, status: computeSectionStatus(progressRow, isFirstIncomplete) };
  });

  let sectionResultsBySection;
  let totalTokensUsed = 0;
  let totalCreditsUsed = 0;
  let creditsRemaining = startingCredits;
  let creditsExhausted = false;

  if (runInParallel) {
    const creditsAvailable = startingCredits > 0;
    const results = await Promise.all(
      sectionsWithStatus.map(({ section, progressRow }) =>
        updateSectionSkillsParallel(studentData, section, progressRow, creditsAvailable)
      )
    );

    totalTokensUsed = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    totalCreditsUsed = results.reduce((sum, r) => sum + r.creditsUsed, 0);
    creditsExhausted = results.some((r) => r.skippedForCredits);
    creditsRemaining = totalCreditsUsed > 0
      ? await chargeCredits(studentId, totalCreditsUsed)
      : startingCredits;

    sectionResultsBySection = new Map(
      sectionsWithStatus.map(({ section }, i) => [section.id, results[i]])
    );
  } else {
    sectionResultsBySection = new Map();
    for (const { section, progressRow } of sectionsWithStatus) {
      const result = await updateSectionSkillsSequential(studentData, section, progressRow, creditsRemaining);
      creditsRemaining = result.creditsRemaining;
      totalTokensUsed += result.tokensUsed;
      totalCreditsUsed += result.creditsUsed;
      if (result.skippedForCredits) creditsExhausted = true;
      sectionResultsBySection.set(section.id, result);
    }
  }

  const treeTopics = topics.map((topic) => {
    const topicSections = sections.filter((s) => s.topic_ID === topic.id);
    return {
      id: topic.id,
      name: topic.name,
      sections: topicSections.map((section) => {
        const { status, progressRow } = sectionsWithStatus.find((x) => x.section.id === section.id);
        const { obtained, missed } = sectionResultsBySection.get(section.id);
        return {
          id: section.id,
          name: section.name,
          masteryScore: progressRow?.mastery_score || 0,
          status,
          videoWatched: !!progressRow?.video_watched,
          skillsObtained: obtained,
          skillsMissed: missed,
        };
      }),
    };
  });

  const treeData = { topics: treeTopics };

  const { error: treeErr } = await supabase
    .from("student_knowledge_tree")
    .upsert({
      student_id: studentId,
      tree_data: treeData,
      generated_at: new Date().toISOString(),
    }, { onConflict: "student_id" });
  if (treeErr) throw treeErr;

  res.status(200).json({
    success: true,
    tree: treeData,
    tokensUsed: totalTokensUsed,
    creditsUsed: totalCreditsUsed,
    creditsRemaining,
    creditsExhausted,
  });
});


module.exports = {
  generateStudentProgressReport,
  generateStudentKnowledgeTree,
  setDataFromSurvey,
  getProgress,
  saveSession,
  updateGrades,

};

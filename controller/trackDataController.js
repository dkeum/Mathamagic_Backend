// @ GET
// ROUTE: /student/progress
const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// ─── Helper: numeric score → letter grade ─────────────────────────────────────
const getLetterGrade = (score) => {
  if (score >= 90) return "A+";
  if (score >= 80) return "B+";
  if (score >= 70) return "B-";
  if (score >= 60) return "C+";
  return "D";
};

// @ GET
// ROUTE: /student/progress
const getTrackingData = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }


  // console.log(token)
  // ─── 1. Authenticate User ──────────────────────────────────────────────────
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  // ─── 2. Fetch Student Profile ──────────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select("id, Class_ID, time_commitment, cached_total_minutes")
    .eq("email", user.email)
    .single();

  if (studentError || !student) {
    return res.status(404).json({ error: "Student profile record not found." });
  }

  const studentId = student.id;

  // ─── 3. Gather Performance Analytics Concurrently ──────────────────────────
  const [
    { data: attempts, error: attemptsError },
    { data: sessions, error: sessionsError },
    { data: progressRecords, error: progressError },
    { data: topics, error: topicsError },
  ] = await Promise.all([
    // A. All question attempts — corrected_at for weighted grade calculation
    supabase
      .from("student_question_attempt")
      .select("attempted_at, is_correct, corrected_at, section_id")
      .eq("student_ID", studentId)
      .order("attempted_at", { ascending: true }),

    // B. Study sessions for time tracking
    supabase
      .from("student_session")
      .select("start_time, duration_minutes")
      .eq("student_ID", studentId),

    // C. Section-level mastery scores joined to their parent topic
    supabase
      .from("student_section_progress")
      .select("mastery_score, completed, section_id, Section(topic_ID)")
      .eq("student_ID", studentId),

    // D. All topics in the student's class with nested sections for milestone tracking
    supabase
      .from("Topic")
      .select("id, name, Order, Section(id, name)")
      .eq("class_ID", student.Class_ID),
  ]);

  if (attemptsError || sessionsError || progressError || topicsError) {
    console.error("Analytics fetch error:", {
      attemptsError,
      sessionsError,
      progressError,
      topicsError,
    });
    return res.status(500).json({ error: "Failed to compile progress analytics records." });
  }

  // ─── 4. True Cumulative Grade Trend With Corrected Mistake Weighting ───────
  const CORRECTED_WEIGHT = 0.85;

  const gradeGroups = {};
  (attempts || []).forEach((att) => {
    if (!att.attempted_at) return;
    const dateKey = new Date(att.attempted_at).toISOString().split("T")[0] + "T10:00:00Z";

    if (!gradeGroups[dateKey]) {
      // Bucketing daily metrics cleanly
      gradeGroups[dateKey] = { dayTotal: 0, dayEffectiveScore: 0 };
    }

    gradeGroups[dateKey].dayTotal += 1;

    if (att.is_correct) {
      gradeGroups[dateKey].dayEffectiveScore += 1.0;
    } else if (att.corrected_at) {
      gradeGroups[dateKey].dayEffectiveScore += CORRECTED_WEIGHT;
    }
  });

  // Sort dates chronologically to accurately accumulate historical scores
  const sortedDates = Object.entries(gradeGroups).sort((a, b) => new Date(a[0]) - new Date(b[0]));

  let runningTotalQuestions = 0;
  let runningEffectiveScore = 0;

  const gradeTrendData = sortedDates.map(([date, counts]) => {
    // Progressively build the rolling running tally up to this date
    runningTotalQuestions += counts.dayTotal;
    runningEffectiveScore += counts.dayEffectiveScore;

    return {
      date,
      grade: runningTotalQuestions > 0
        ? ((runningEffectiveScore / runningTotalQuestions) * 100).toFixed(2)
        : "0.00",
    };
  });

  // ─── 5. Study Session Time Logs ────────────────────────────────────────────
  const timeLogs = (sessions || []).map((s) => ({
    date: s.start_time,
    durationHours: (Number(s.duration_minutes) || 0) / 60,
  }));

  // ─── 6. Topic-Wise Mastery + Time Spent ───────────────────────────────────
  const topicMetrics = {};
  (topics || []).forEach((t) => {
    topicMetrics[t.id] = {
      id: t.id,
      name: t.name,
      totalScore: 0,
      count: 0,
      timeSpent: 0,
    };
  });

  const attemptedTopicIds = new Set();

  (progressRecords || []).forEach((p) => {
    const topicId = p.Section?.topic_ID;
    if (!topicId || !topicMetrics[topicId]) return;

    const mastery = Number(p.mastery_score) || 0;
    topicMetrics[topicId].totalScore += mastery;
    topicMetrics[topicId].count += 1;
    topicMetrics[topicId].timeSpent += mastery;
    attemptedTopicIds.add(topicId);
  });

  const formattedTopics = Object.values(topicMetrics)
    .filter((t) => attemptedTopicIds.has(t.id))
    .map((t) => {
      const numericGrade = t.count > 0
        ? Math.round((t.totalScore / t.count) * 100)
        : 0;
      const gradeLetter = getLetterGrade(numericGrade);
      const timeSpent = Number(t.timeSpent.toFixed(2));

      let desc = "Needs review";
      let bg = "bg-red-50";
      let text = "text-red-500";
      let color = "#E53E3E";

      if (numericGrade >= 85) {
        desc = "Perfect Score Streak";
        bg = "bg-green-50";
        text = "text-green-600";
        color = "#38A169";
      } else if (numericGrade >= 75) {
        desc = "Improving steadily";
        bg = "bg-purple-50";
        text = "text-purple-600";
        color = "#5d3fd3";
      } else if (numericGrade >= 65) {
        desc = "Needs consistent review";
        bg = "bg-amber-50";
        text = "text-amber-600";
        color = "#fd8b00";
      }

      return {
        title: t.name || "Unnamed Topic",
        desc,
        grade: gradeLetter,
        numericGrade,
        timeSpent,
        bg,
        text,
        color,
      };
    })
    .sort((a, b) => b.numericGrade - a.numericGrade);

  // ─── 7. Overall Effective Grade Across All Attempts ───────────────────────
  const overallEffectiveGrade = (attempts || []).length > 0
    ? Math.round(
      (attempts.reduce((sum, att) => {
        if (att.is_correct) return sum + 1.0;
        if (att.corrected_at) return sum + CORRECTED_WEIGHT;
        return sum;
      }, 0) / attempts.length) * 100
    )
    : 0;

  // ─── 8. Persist Updated Grade Cache to Student Row ────────────────────────
  const { error: cacheError } = await supabase
    .from("Student")
    .update({
      cached_overall_grade: overallEffectiveGrade,
      last_cache_updated_at: new Date().toISOString(),
    })
    .eq("id", studentId);

  if (cacheError) {
    console.error("Student grade cache update error:", cacheError);
  }

  // ─── 9. Live Engine For Next Milestone ────────────────────────────────────
  let nextMilestone = null;

  const completedSectionIds = new Set(
    (progressRecords || [])
      .filter((p) => p.completed === true)
      .map((p) => p.section_id)
  );

  const activeSectionIdsFromAttempts = new Set(
    (attempts || [])
      .filter((att) => att.section_id)
      .map((att) => Number(att.section_id))
  );

  const activeSectionIds = new Set([
    ...(progressRecords || []).map((p) => Number(p.section_id)),
    ...activeSectionIdsFromAttempts
  ]);

  const orderedTopics = [...(topics || [])].sort((a, b) => (Number(a.Order) || 0) - (Number(b.Order) || 0));

  const unstartedTopic = orderedTopics.find((t) => {
    const sections = t.Section || [];
    return !sections.some((s) => activeSectionIds.has(Number(s.id)));
  });

  if (unstartedTopic) {
    const orderedSections = [...(unstartedTopic.Section || [])].sort((a, b) => Number(a.id) - Number(b.id));
    const firstSectionName = orderedSections.length > 0 ? orderedSections[0].name : "Introduction";

    nextMilestone = {
      title: `${unstartedTopic.name || "Unnamed Topic"}`,
      type: firstSectionName,
      isCompletedAll: false,
    };
  } else {
    let nextSection = null;

    for (const t of orderedTopics) {
      const orderedSections = [...(t.Section || [])].sort((a, b) => Number(a.id) - Number(b.id));
      const incomplete = orderedSections.find((s) => !completedSectionIds.has(s.id));

      if (incomplete) {
        nextSection = incomplete;
        break;
      }
    }

    if (nextSection) {
      nextMilestone = {
        title: nextSection.name || "Unnamed Section",
        type: "Section Mastery",
        isCompletedAll: false,
      };
    } else {
      nextMilestone = {
        title: "You're done everything congratulations!",
        type: "All milestones checked 🎉",
        isCompletedAll: true,
      };
    }
  }

  // ─── 10. Dispatch Unified Payload ──────────────────────────────────────────
  return res.status(200).json({
    gradeTrend: gradeTrendData.length ? gradeTrendData : null,
    topics: formattedTopics.length ? formattedTopics : null,
    timeLogs,
    targetHours: Number(student.time_commitment) || 15,
    overallEffectiveGrade,
    nextMilestone,
  });
});


module.exports = { getTrackingData };
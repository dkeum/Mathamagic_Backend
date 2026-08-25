/**
 * Checks subscription and trial status. Updates the DB if the subscription has expired.
 */
export const checkAndUpdateSubscription = async (supabase, studentData) => {
    const { id, had_trial, trial_end, subscription_end, isSubscribed, subscription_status } = studentData;
    const now = new Date();

    const trialEndDate = trial_end ? new Date(trial_end) : null;
    const subEndDate = subscription_end ? new Date(subscription_end) : null;
    const is_on_trial = Boolean(had_trial && trialEndDate && trialEndDate > now);

    let days_remaining = 0;
    let isExpired = false;

    if (is_on_trial && trialEndDate) {
        days_remaining = Math.max(0, Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24)));
        if (days_remaining === 0) isExpired = true;
    } else if (isSubscribed && subEndDate) {
        days_remaining = Math.max(0, Math.ceil((subEndDate - now) / (1000 * 60 * 60 * 24)));
        if (days_remaining === 0) isExpired = true;
    }

    // If the user's time is up but the DB still says they are active/subscribed, update it.
    if (isExpired && (isSubscribed || subscription_status === "active")) {
        const { error } = await supabase
            .from("Student")
            .update({ isSubscribed: false, subscription_status: "inactive" })
            .eq("id", id);

        if (error) console.error("Failed to update expired subscription:", error.message);

        return { is_on_trial, days_remaining, updatedStatus: "inactive" };
    }

    return { is_on_trial, days_remaining, updatedStatus: subscription_status };
};

/**
 * Calculates if daily free boundaries have been crossed.
 */
export const getDailyFreeUsage = (studentData, homework_free_uploads_used_today) => {
    const { last_free_video_at, last_free_step_by_step_at } = studentData;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const video_free_available_today = !last_free_video_at || new Date(last_free_video_at) < startOfToday;
    const step_by_step_free_available_today = !last_free_step_by_step_at || new Date(last_free_step_by_step_at) < startOfToday;
    const homework_free_uploads_remaining_today = Math.max(0, 3 - (homework_free_uploads_used_today ?? 0));

    return {
        video_free_available_today,
        step_by_step_free_available_today,
        homework_free_uploads_remaining_today,
    };
};

/**
 * Formats session data into a GitHub-style activity grid and calculates time goals.
 */
export const buildActivityStats = async (supabase, studentId, sessions, timeCommitment) => {
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

        github_activity.push(
            { date: twoMonthsAgo.toISOString().slice(0, 10), count: 1, level: 1 },
            { date: today.toISOString().slice(0, 10), count: 1, level: 1 }
        );

        // Fire-and-forget insert for new session
        supabase.from("student_session").insert({
            student_ID: studentId,
            start_time: today.toISOString(),
            end_time: today.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }).then();
    } else {
        const groupedByDate = {};
        for (const session of sessions) {
            const date = session.start_time.slice(0, 10);
            groupedByDate[date] = (groupedByDate[date] || 0) + parseFloat(session.duration_minutes || 0);
        }

        for (const [date, totalMinutes] of Object.entries(groupedByDate)) {
            let level = totalMinutes >= 120 ? 4 : totalMinutes >= 60 ? 3 : totalMinutes >= 30 ? 2 : 1;
            github_activity.push({ date, count: 1, level });
        }

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const weeklyMinutes = sessions
            .filter((s) => new Date(s.start_time) >= oneWeekAgo)
            .reduce((sum, s) => sum + parseFloat(s.duration_minutes || 0), 0);

        const weeklyGoalMinutes = (timeCommitment || 0) * 60;
        time_goal_met = weeklyGoalMinutes > 0 ? Math.min(100, Math.round((weeklyMinutes / weeklyGoalMinutes) * 100)) : 0;
        total_minutes_logged = sessions.reduce((sum, s) => sum + parseFloat(s.duration_minutes || 0), 0);
    }

    return { github_activity, time_goal_met, total_minutes_logged };
};

/**
 * Builds the comprehensive progress array for topics and sections.
 */
export const buildCourseProgress = (topics, sections, sectionProgress, questionAttempts, current_module) => {
    const progressMap = {};
    for (const p of sectionProgress || []) {
        progressMap[p.section_id] = p;
    }

    const sectionGradeMap = {};
    for (const qa of questionAttempts || []) {
        if (!sectionGradeMap[qa.section_id]) sectionGradeMap[qa.section_id] = { correct: 0, total: 0 };
        sectionGradeMap[qa.section_id].total += 1;
        if (qa.is_correct) sectionGradeMap[qa.section_id].correct += 1;
    }

    let total_sections = 0;
    let attempted_sections = 0;
    let attempted_mastery_sum = 0;
    let completed_sections = 0;
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

        const topic_mastery = topicAttemptedCount > 0 ? (topicMasterySum / topicAttemptedCount) : 0;

        return {
            topic_name: topic.name,
            topic_mastery,
            sections: mappedSections,
        };
    });

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

    return {
        finalProgressArray,
        hasActivityHistory,
        total_sections,
        attempted_sections,
        attempted_mastery_sum,
        completed_sections
    };
};
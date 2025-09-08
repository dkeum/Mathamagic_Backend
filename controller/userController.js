const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const dateFunctions = require("./helperFunctions/date");
const { v4: uuidv4 } = require("uuid"); // import uuid
const axios = require("axios");

// @ POST
// ROUTE: /update-user

//SEND an send email with with full name and description
const updateUser = asyncHandler(async (req, res) => {
  const { answers } = req.body;
  const token = req.cookies?.access_token;

  // console.log(token)

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Verify token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  const [_, __, course, desiredGrade, timeCommitment] = answers;

  const grade = course.replace(/[^0-9]/g, "");
  //   console.log(answers)
  //   console.log(grade, user.id, timeCommitment)

  let time = 0;

  if (timeCommitment === "0-3 hours") {
    time = 3;
  } else if (timeCommitment === "3-5 hours") {
    time = 5;
  } else {
    time = 6;
  }

  // Update the user's profile in the `profiles` table
  const { error: updateError } = await supabase
    .from("Student")
    .update({
      grade,
      class: course,
      desired_grade: desiredGrade,
      time_commitment: time,
    })
    .eq("email", user.email);

  if (updateError) {
    console.error("Failed to update profile:", updateError.message);
    return res.status(500).json({ error: "Failed to update profile." });
  }

  return res.status(200).json({ message: "Profile updated successfully." });
});

// @ PUT
// ROUTE: /user/setname

const setName = asyncHandler(async (req, res) => {
  const { name } = req.body;

  console.log(name);

  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Name is required." });
  }

  // Extract token from cookie or Authorization header
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  //   console.log(token)

  // Verify user token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  //   console.log(user.email, name)

  // Update name in the profiles table
  const { error: updateError } = await supabase
    .from("Student")
    .update({ name: name.trim() })
    .eq("email", user.email);

  if (updateError) {
    console.error("Error updating name:", updateError.message);
    return res.status(500).json({ error: "Failed to update name." });
  }

  const { data: data1, error1 } = await supabase
    .from("Student")
    .select("name")
    .eq("email", user.email);

  console.log(data1);

  return res.status(200).json({ message: "Name updated successfully." });
});

// @ GET
// ROUTE: /:user_email/getprofile

const getProgress = asyncHandler(async (req, res) => {
  // console.log("getting profile");

  // Extract token from cookie or Authorization header
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Get user from token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  // Get email
  const email = user.email;

  // 1. Get student info by email
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("*")
    .eq("email", email)
    .single(); // assuming one student per email

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }

  const studentId = studentData.id;
  const className = studentData.class;
  const grade = studentData.grade;
  const time_logged = studentData.time_logged;
  let completion_progress = 0;
  const timeCommitment = studentData.time_commitment;
  const profile_picture = studentData?.profile_picture;
  let time_goal_met = 0;

  let github_activity = [];

  const date40DaysAgo = new Date();
  date40DaysAgo.setDate(date40DaysAgo.getDate() - 200);
  const fortyDaysAgoStr = date40DaysAgo.toISOString().slice(0, 10);
  github_activity.push({
    date: fortyDaysAgoStr,
    count: 0,
    level: 0,
  });

  if (time_logged?.length === 0) {
    github_activity = [
      {
        date: "2025-06-23",
        count: 1,
        level: 1,
      },
      {
        date: "2025-08-02",
        count: 1,
        level: 4,
      },
      {
        date: "2025-11-29",
        count: 1,
        level: 3,
      },
    ];
  } else {
    const groupedByDate = time_logged.reduce((acc, timestamp) => {
      const date = timestamp.slice(0, 10);
      if (!acc[date]) acc[date] = [];
      acc[date].push(new Date(timestamp));
      return acc;
    }, {});

    const addedDates = new Set();
    for (const date in groupedByDate) {
      const times = groupedByDate[date].sort((a, b) => a - b);

      for (let i = 0; i < times.length - 1; i++) {
        const diffMs = times[i + 1] - times[i];
        const diffHours = diffMs / (1000 * 60 * 60);

        let level = 1; // default
        if (diffHours < 3) {
          level = 2;
        } else if (diffHours > 3 && diffHours < 5) {
          level = 3;
        } else if (diffHours > 6) {
          level = 4;
        }

        if (!addedDates.has(date)) {
          github_activity.push({
            date: date,
            count: 1,
            level,
          });
          addedDates.add(date);
        }
      }
    }

    // console.log(github_activity)

    // console.log(time_logged, timeCommitment)

    const result = dateFunctions.calculateWeeklyGoal(
      time_logged,
      timeCommitment
    );
    time_goal_met = result.time_goal_met;
  }

  // console.log(studentId, className, grade);

  // 2. Check student progress
  const { data: progressData, error: progressError } = await supabase
    .from("Student Class Progress")
    .select("*")
    .eq("student_ID", studentId)
    .single();

  // console.log("Here's the progress data");
  // console.log(progressData);

  // go through this progressData and if there's a topic with any section missing then iterate through the sections
  // 1. Detect topics with empty sections
  const emptyTopics =
    progressData?.topic_section_progress?.filter(
      (topic) => !topic.sections || topic.sections.length === 0
    ) || [];

  let updatedProgressArray = progressData
    ? [...progressData.topic_section_progress]
    : [];

  let progressArray = [];
  let current_grade = 0;

  // 3. If no progress data, initialize progress
  if (!progressData || progressData.length === 0) {
    // 3a. Get class ID
    const { data: classData, error: classError } = await supabase
      .from("Class")
      .select("*")
      .eq("Name", className)
      .single();

    // console.log(classData, classError)

    if (classError || !classData) {
      return res.status(404).json({ error: "Class not found." });
    }

    const classId = classData.id;

    // console.log("printing the found className");
    // console.log(classData.id);

    // 3b. Get all topics for the class
    const { data: topics, error: topicError } = await supabase
      .from("Topic")
      .select("id, name")
      .eq("class_ID", classId);

    if (topicError || !topics) {
      return res.status(500).json({ error: "Error retrieving topics." });
    }

    const topicIds = topics.map((topic) => topic.id);

    // for each topic_ID I need to get the sections and then build the progressArray
    const { data: sections, error: sectionError } = await supabase
      .from("Section")
      .select("id, name, topic_ID")
      .in("topic_ID", topicIds);

    if (sectionError || !sections) {
      return res.status(500).json({ error: "Error retrieving sections." });
    }

    // console.log("got to this point successfully");
    // console.log(topics)
    // console.log(sections)

    // 4. Build the initial progress JSON

    for (const topic of topics) {
      const topicSections = sections
        .filter((sec) => sec.topic_ID === topic.id)
        .map((sec) => ({
          section_name: sec.name,
          section_id: sec.id,
          progress: 0,
        }));

      // console.log("pushing data");
      // console.log(topic.name);
      // console.log(topicSections);
      progressArray.push({
        topic_name: topic.name,
        sections: topicSections,
      });
    }

    // console.log(progressArray)

    // 5. Insert into Student Class Progress
    const { error: insertError } = await supabase
      .from("Student Class Progress")
      .insert([
        {
          student_ID: studentId,
          class_ID: classId,
          topic_section_progress: progressArray,
        },
      ]);
    // console.log(insertError)
  } else {
    // 2. Only proceed if there are empty topics
    if (emptyTopics.length > 0) {
      // Get all topic names that are empty
      const emptyTopicNames = emptyTopics.map((t) => t.topic_name);

      // Fetch topic IDs from Supabase
      const { data: topics, error: topicError } = await supabase
        .from("Topic")
        .select("id, name, class_ID")
        .in("name", emptyTopicNames);

      if (topicError || !topics) {
        console.error("Error fetching topics:", topicError);
      } else {
        const topicIds = topics.map((t) => t.id);

        // Fetch sections for these topic IDs
        const { data: sections, error: sectionError } = await supabase
          .from("Section")
          .select("id, name, topic_ID")
          .in("topic_ID", topicIds);

        if (sectionError || !sections) {
          console.error("Error fetching sections:", sectionError);
        } else {
          // Replace empty sections with actual sections
          for (const topic of topics) {
            const topicSections = sections
              .filter((sec) => sec.topic_ID === topic.id)
              .map((sec) => ({
                section_name: sec.name,
                section_id: sec.id,
                progress: 0,
              }));

            // Find the topic in updatedProgressArray and replace sections
            const index = updatedProgressArray.findIndex(
              (t) => t.topic_name === topic.name
            );

            if (index !== -1) {
              updatedProgressArray[index].sections = topicSections;
            } else {
              // If topic not found, add it
              updatedProgressArray.push({
                topic_name: topic.name,
                sections: topicSections,
              });
            }
          }

          // 3. Update the Student Class Progress row
          const { error: updateError } = await supabase
            .from("Student Class Progress")
            .update({ topic_section_progress: updatedProgressArray })
            .eq("student_ID", studentId);

          if (updateError) {
            console.error("Error updating progress:", updateError);
          } else {
            console.log("Empty sections filled successfully!");
          }
        }
      }
    }
    progressArray = updatedProgressArray;
    let count = 0;
    let section_progress = 0;
    let temp_score = 0;
    let temp_count = 0;
    for (const section of progressArray) {
      // console.log(section)
      // count += 1;
      // section_progress += section.progress;
      for (const progress_section of section.sections) {
        section_progress += progress_section.progress;
        count += 1;
        if (progress_section?.latest_grade != null) {
          temp_score += parseFloat(progress_section.latest_grade);
          temp_count += 1;
        }
      }
    }

    // console.log(count, section_progress, temp_count, temp_score)
    if (count > 0) {
      completion_progress = Math.round((section_progress / count) * 100);
      if (temp_count === 0) {
        current_grade = 0;
      } else {
        current_grade = Math.round((temp_score / (temp_count * 100)) * 100);
      }

      // console.log(temp_score, temp_count, current_grade);
      // console.log("printing completion_progress")
      // console.log(completion_progress)
    }
  }

  // return the completion progress, current, github login array

  // console.log(github_activity);
  // console.log(completion_progress);
  // console.log(time_goal_met)

  return res.status(200).json({
    github_activity,
    current_grade,
    completion_progress,
    progressArray,
    timeCommitment: time_goal_met,
    actual_time_commitment: timeCommitment,
    profile_picture,
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

// @ PUT
// ROUTE: /update-profile-info
const updateProfileInformation = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  const email = user.email;
  const { name } = req.body; // ✅ now works because Multer parses it
  let picture_url = null;

  if (req.file) {
    const uniqueFilename = `${uuidv4()}.png`;
    const base64Image = req.file.buffer.toString("base64");

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

    picture_url = response.data.content.download_url;
  }

  if (!name && !picture_url) {
    return res.status(400).json({ error: "No updates provided." });
  }

  const { data, error } = await supabase
    .from("Student")
    .update({
      ...(name && { name }),
      ...(picture_url && { profile_picture: picture_url }),
    })
    .eq("email", email)
    .select();

  if (error) {
    console.error("Error updating student:", error);
    return res.status(500).json({ error: "Failed to update student info." });
  }

  return res.status(200).json({
    message: "Profile updated successfully",
    student: data[0],
  });
});

// @ DELETE
// ROUTE: /delete-account
const deleteAccount = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Get user from token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  const email = user.email;

  // 1. Find the student by email
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }

  const student_id = studentData.id;

  // 2. Delete related Student Class Progress rows
  const { error: progressError } = await supabase
    .from("Student Class Progress")
    .delete()
    .eq("student_ID", student_id);

  if (progressError) {
    console.error("Error deleting progress:", progressError);
    return res.status(500).json({ error: "Failed to delete progress data." });
  }

  // 3. Delete the Student row itself
  const { error: deleteError } = await supabase
    .from("Student")
    .delete()
    .eq("id", student_id);

  if (deleteError) {
    console.error("Error deleting student:", deleteError);
    return res.status(500).json({ error: "Failed to delete student." });
  }

  // 4. Optionally: delete user from Supabase Auth too
  // await supabase.auth.admin.deleteUser(user.id);

  return res.status(200).json({
    message: "Account deleted successfully.",
    student_id,
  });
});

module.exports = {
  updateUser,
  setName,
  getProgress,
  saveSession,
  updateGrades,
  updateProfileInformation,
  deleteAccount,
};

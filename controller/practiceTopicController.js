const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const dateFunctions = require("./helperFunctions/date");
const { v4: uuidv4 } = require("uuid"); // import uuid
const axios = require("axios");

// @ GET
// ROUTE: /practice-bank
const getPracticeBank = asyncHandler(async (req, res) => {
  const classId = req.query.class; // Look in query parameters instead of body
  //   console.log("Fetching practice bank for class:", classId);

  if (!classId) {
    return res.status(400).json({ error: "Missing class identifier." });
  }

  // 1. Authenticate user to know WHO is asking for their history
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

  // Get student ID
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }
  const studentId = studentData.id;

  // 2. Query Topics/Sections AND Student History in parallel
  const [curriculumResult, historyResult] = await Promise.all([
    // Query A: All topics and sections for this class, ordered sequentially
    supabase
      .from("Topic")
      .select(
        `
        id, 
        name,
        "Order",
        Section (
          id,
          name,
          difficulty
        )
      `
      )
      .eq("class_ID", classId)
      // Sort topics by your custom structural Order column
      .order("Order", { ascending: true })
      // Bonus: Predictably sort nested sections by their ID so they don't shuffle randomly
      .order("id", { foreignTable: "Section", ascending: true }),

    // Query B: Most recent section this student touched
    supabase
      .from("student_section_progress")
      .select(
        `
      section_id,
      Section:section_id (
        id,
        name,
        Topic:topic_ID (
          name
        )
      )
    `
      )
      .eq("student_ID", studentId)
      .not("last_attempted_at", "is", null)
      .order("last_attempted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Handle core curriculum query errors
  if (curriculumResult.error) {
    console.error("Database error:", curriculumResult.error.message);
    return res.status(500).json({ error: "Failed to retrieve practice bank." });
  }

  const topics = curriculumResult.data || [];
  if (topics.length === 0) {
    return res.status(404).json({ error: "No topics found for this class." });
  }

  // 3. Determine the last section worked on, or fall back to the very first one
  let lastWorkedSection = null;

  if (historyResult.data && historyResult.data.Section) {
    lastWorkedSection = {
      id: historyResult.data.Section.id,
      name: historyResult.data.Section.name,
      topic_name: historyResult.data.Topic?.name || null, // add this
    };
  } else {
    // No history found -> Fallback to the first section of the first topic.
    // Because we added .order("Order"), topics[0] is guaranteed to be the start of your curriculum!
    const firstTopic = topics[0];
    const firstSection = firstTopic?.Section?.[0]; // Accesses the first nested section array item

    if (firstSection) {
      lastWorkedSection = {
        id: firstSection.id,
        name: firstSection.name,
      };
    }
  }

  // 4. Send clean payload back to the client
  return res.status(200).json({
    class_ID: classId,
    last_worked_section: lastWorkedSection,
    topics: topics,
  });
});

module.exports = {
  getPracticeBank,
};

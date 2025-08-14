const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// @ GET
// ROUTE: /questions/:topic/:section

//SEND an send email with with full name and description
const getQuestions = asyncHandler(async (req, res) => {
  // console.log("called get questions");

  const { topic, section } = req.params;
  const token = req.cookies?.access_token;

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

  // Get topic ID
  const { data: topicData, error: topicError } = await supabase
    .from("Topic")
    .select("id")
    .eq("name", topic)
    .single();

  if (topicError || !topicData) {
    return res.status(404).json({ error: "Topic not found." });
  }
  const topic_ID = topicData.id;

  // console.log(topic_ID, section);

  // Get section data
  const { data: sectionData, error: sectionError } = await supabase
    .from("Section")
    .select("*")
    .eq("name", section)
    .single();

  // console.log(sectionData);
  // console.log(sectionError);

  if (sectionError || !sectionData) {
    return res.status(404).json({ error: "Section not found." });
  }

  const question_list = sectionData.questions || [];
  const limitedQuestions = question_list.slice(0, 10);

  // Get questions
  const { data: questionData, error: questionError } = await supabase
    .from("question")
    .select("*")
    .in("id", limitedQuestions);

  if (questionError) {
    return res.status(500).json({ error: "Error fetching questions." });
  }

  // console.log("got questions")

  // Get answers
  const { data: answerData, error: answerError } = await supabase
    .from("answer")
    .select("*")
    .in("question_ID", limitedQuestions);

  // console.log(answerData)

  if (answerError) {
    return res.status(500).json({ error: "Error fetching answers." });
  }

  // Merge questions and answers
  const merged = questionData.map((q) => ({
    ...q,
    answers: answerData.filter((a) => a.question_ID === q.id),
  }));

  return res.status(200).json({
    questions: merged,
  });
});

// @ POST
// ROUTE: /questions/save-marks
const saveQuestionMarks = asyncHandler(async (req, res) => {
  // console.log("saveQuestionMarks is called");
  let { topic, recordedAnswers, grade, section_name } = req.body;

  const token = req.cookies?.access_token;
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

  const email = user.email;
  // console.log(email);

  // Find the student
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("*")
    .eq("email", email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }

  // Get their class progress
  const { data: progressData, error: progressError } = await supabase
    .from("Student Class Progress")
    .select("*")
    .eq("student_ID", studentData.id)
    .single();

  if (progressError || !progressData) {
    return res.status(404).json({ error: "Progress not found." });
  }

  // Update topic_section_progress  //section_name
  let updatedTopicSectionProgress = progressData.topic_section_progress || [];

  updatedTopicSectionProgress = updatedTopicSectionProgress.map((topicItem) => {
    if (topicItem.topic_name === topic) {
      return {
        ...topicItem,
        sections: topicItem.sections.map((section) => {
          if (section.section_name === section_name) {
            return {
              ...section,
              latest_grade: grade,
              best_grade: Math.max(section.best_grade || 0, grade),
              progress: 1,
            };
          }
          return section;
        }),
      };
    }
    return topicItem;
  });

  // Append to existing question_session array (or start a new one)
  let updatedQuestionSession = Array.isArray(progressData.question_session)
    ? [...progressData.question_session]
    : [];

  updatedQuestionSession.push({
    recordedAnswers,
    date: new Date().toISOString(),
    topic,
    grade,
    section_name,
  });

  // Save the update
  const { error: updateError } = await supabase
    .from("Student Class Progress")
    .update({
      topic_section_progress: updatedTopicSectionProgress,
      question_session: updatedQuestionSession,
    })
    .eq("student_ID", studentData.id);

  // console.log(updateError);

  if (updateError) {
    return res.status(500).json({ error: "Failed to update progress." });
  }

  res.status(200).json({ message: "Progress updated successfully" });
});

// @ GET
// /questions/get-questions
const getRecordedAnswers = asyncHandler(async (req, res) => {
  // console.log("Get recorded answers")
  const token = req.cookies?.access_token;

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

  // Get their class progress
  const { data: progressData, error: progressError } = await supabase
    .from("Student Class Progress")
    .select("question_session")
    .eq("student_ID", user.id) // use authenticated user's ID
    .single();

  if (progressError || !progressData) {
    return res.status(404).json({ error: "Progress not found." });
  }

  // Filter only dates within current year
  const currentYear = new Date().getFullYear();
  const filteredArray = (progressData.question_session || []).filter((item) => {
    if (!item.date) return false;
    const sessionYear = new Date(item.date).getFullYear();
    return sessionYear === currentYear;
  });

  // console.log("sending marks seciton")
  // console.log(filteredArray)
  return res.status(200).json({ mark_section: filteredArray });
});

//@ POST
// /questions/fix-questions
const fixRecordedAnswers = asyncHandler(async (req, res) => {
  // console.log("Get recorded answers")

  const { questions_id } = req.body;

  // console.log(questions_id);

  const token = req.cookies?.access_token;

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

  // Get their class progress
  const { data: progressData, error: progressError } = await supabase
    .from("question")
    .select("id ,question")
    .in("id", questions_id)
    .limit(100);

  const questionIds = progressData.map((q) => q.id);

  const { data: answerData, error: answerError } = await supabase
    .from("answer")
    .select("question_ID, answer")
    .in("question_ID", questionIds)
    .limit(100);
  // console.log(progressData)

  // Map answers to their question IDs
  const answerMap = {};
  answerData.forEach((item) => {
    answerMap[item.question_ID] = item.answer;
  });

  // Now you can combine progressData with their answers
  const progressWithAnswers = progressData.map((q) => ({
    ...q,
    answer: answerMap[q.id] || null,
  }));

  return res.status(200).json({ question: progressWithAnswers });
});

// @ POST
// /questions/fixed-mistakes
const fixMistakes = asyncHandler(async (req, res) => {
  const { fixed_questions_id } = req.body;
// 
  console.log(fixed_questions_id)

  if (!Array.isArray(fixed_questions_id) || fixed_questions_id.length === 0) {
    return res.status(400).json({ error: "fixed_questions_id must be a non-empty array" });
  }

  const token = req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Verify user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  // Get student ID
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id")
    .eq("email", user.email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }


  // console.log(studentData)

  // Get their progress
  const { data: progressData, error: progressError } = await supabase
    .from("Student Class Progress")
    .select("id, question_session")
    .eq("student_ID", studentData.id);

    // console.log(progressError)

  if (progressError || !progressData?.length) {
    return res.status(404).json({ error: "Progress not found." });
  }

  let question_session = progressData[0].question_session;

  // Update matching answers
  question_session = question_session.map(session => ({
    ...session,
    recordedAnswers: session.recordedAnswers.map(ans => {
      if (fixed_questions_id.includes(ans.questionId)) {
        return {
          ...ans,
          isCorrect: true,
          // optionally set a correct answer text if you have it
          // answer: ans.answer || "FIXED_ANSWER"
        };
      }
      return ans;
    })
  }));

  // Save updated data
  const { data: updatedData, error: updateError } = await supabase
    .from("Student Class Progress")
    .update({ question_session })
    .eq("student_ID", studentData.id);

    // console.log(updateError)
  if (updateError) {
    return res.status(500).json({ error: "Failed to update progress." });
  }

  return res.status(200).json({ message:"Success" });
});


module.exports = {
  getQuestions,
  saveQuestionMarks,
  getRecordedAnswers,
  fixRecordedAnswers,
  fixMistakes,
};

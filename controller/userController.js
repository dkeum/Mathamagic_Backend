const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

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

  // console.log(studentId, className, grade);

  // 2. Check student progress
  const { data: progressData, error: progressError } = await supabase
    .from("Student Class Progress")
    .select("*")
    .eq("student_ID", studentId)
    .single();

  // console.log("Here's the progress data");
  // console.log(progressData);

  let progressArray = [];

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

    console.log("printing the found className");
    console.log(classData.id);

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

    console.log("got to this point successfully");
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
    progressArray = progressData.topic_section_progress;
  }

  // return the completion progress, current, github login array

  // supabase
  // get the student's class and all the topics and sections for that class.

  return res.status(200).json({
    github_activity: [
      {
        date: "2025-06-23",
        count: 2,
        level: 1,
      },
      {
        date: "2025-08-02",
        count: 16,
        level: 4,
      },
      {
        date: "2025-11-29",
        count: 11,
        level: 3,
      },
    ],
    current_grade: 65,
    completion_progress: 50,
    progressArray,
  });
});


// @ POST
// ROUTE: /save-session

const saveSession = asyncHandler(async(req,res)=> {
  
  const  {email} = req.body

  if( email === none){
    return res.status(400).json({message:"no email detected"})
  }

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

  const email_detected = user.email

  // get the table Students and match email. should be single instance. select time_logged 
  // get all the elements in the array
  // if empty then create an array and paste in the start_time and end_time

})

module.exports = {
  updateUser,
  setName,
  getProgress,
  saveSession,
};

const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const dateFunctions = require("./helperFunctions/date");
const { v4: uuidv4 } = require("uuid"); // import uuid
const axios = require("axios");
const jwt = require("jsonwebtoken");
const STRIPE_API_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY;
const stripe = require("stripe")(STRIPE_API_SECRET_KEY);



// @ POST
// ROUTE: /update-user

//SEND an send email with with full name and description
const updateUser = asyncHandler(async (req, res) => {
  const { answers, access_token } = req.body;

  if (!access_token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(access_token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  const email = user.email;

  const [_, __, course, desiredGrade, timeCommitment] = answers;
  const grade = course.replace(/[^0-9]/g, "");

  let time = 0;
  if (timeCommitment === "0-3 hours") time = 3;
  else if (timeCommitment === "3-5 hours") time = 5;
  else time = 6;

  const { error: updateError } = await supabase
    .from("Student")
    .update({
      grade,
      class: course,
      desired_grade: desiredGrade,
      time_commitment: time,
    })
    .eq("email", email);

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
// Ensure you have initialized stripe at the top of your file, e.g.:
// const stripe = require("stripe")(process.env.STRIPE_API_SECRET_KEY);

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

  // 1. Find the student by email and include stripe_subscription_id
  const { data: studentData, error: studentError } = await supabase
    .from("Student")
    .select("id, stripe_subscription_id")
    .eq("email", email)
    .single();

  if (studentError || !studentData) {
    return res.status(404).json({ error: "Student not found." });
  }

  const student_id = studentData.id;

  // 2. Cancel Stripe subscription if it exists
  if (studentData.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(studentData.stripe_subscription_id);
      console.log(`Canceled Stripe subscription: ${studentData.stripe_subscription_id}`);
    } catch (stripeError) {
      console.error("Error canceling Stripe subscription:", stripeError);
      return res.status(500).json({ error: "Failed to cancel active subscription." });
    }
  }

  // 3. Delete related Student Class Progress rows
  const { error: progressError } = await supabase
    .from("Student Class Progress")
    .delete()
    .eq("student_ID", student_id);

  if (progressError) {
    console.error("Error deleting progress:", progressError);
    return res.status(500).json({ error: "Failed to delete progress data." });
  }

  // 4. Delete the Student row itself
  const { error: deleteError } = await supabase
    .from("Student")
    .delete()
    .eq("id", student_id);

  if (deleteError) {
    console.error("Error deleting student:", deleteError);
    return res.status(500).json({ error: "Failed to delete student." });
  }

  // 5. Optionally: delete user from Supabase Auth too
  // await supabase.auth.admin.deleteUser(user.id);

  return res.status(200).json({
    message: "Account and associated subscriptions deleted successfully.",
    student_id,
  });
});


const getSettingProfile = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(" ")[1] : req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Get user from token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized. Invalid token." });
  }

  // Fetch student data along with guardian link settings and AI_Credit 
  const { data: student, error: studentError } = await supabase
    .from("Student")
    .select(`
      plan_type, 
      subscription_status,
      "AI_Credit",
      guardian_link (
        id,
        guardian_email,
        weekly_report_opt_in,
        status
      )
    `)
    .eq("id", user.id)
    .single();

  if (studentError || !student) {
    console.error("Student lookup failed:", studentError);
    return res.status(404).json({ error: "Student record not found." });
  }

  // Return the Stripe account tier, status, AI credits, and weekly progress email settings
  return res.status(200).json({
    tier: student.plan_type || "free",
    status: student.subscription_status || "inactive",
    credits: student.AI_Credit || 0, // Using your schema's AI_Credit column
    guardian_notifications: student.guardian_link || []
  });
});



module.exports = {
  updateUser,
  setName,
  updateProfileInformation,
  deleteAccount,
  getSettingProfile
};

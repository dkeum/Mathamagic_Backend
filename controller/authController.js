const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// @ POST
// ROUTE: /signup

//SEND an send email with with full name and description
const signUp = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || password.length < 6) {
    return res
      .status(400)
      .json({ error: "Email and password (min 6 chars) are required." });
  }


  try {
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      console.error("Supabase signup error:", error.message);
      return res.status(400).json({ error: error.code });
    }

    return res
      .status(200)
      .json({ message: "Signup successful", user: data.user });
  } catch (err) {
    console.error("Unexpected error during signup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// @ POST
// ROUTE: /logout
const logOut = asyncHandler(async (req, res) => {

  res.clearCookie("access_token");
  return res.status(200);
});

// @ POST
// ROUTE: /login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      return res
        .status(401)
        .json({ error: error?.message || "Invalid credentials" });
    }

    const userEmail = data.user.email;
    const id = data.user.id

    // Step 1: Check if student exists
    const { data: existingStudent, error: selectError } = await supabase
      .from("Student")
      .select("*")
      .eq("email", userEmail)
      .single();

    // console.log(existingStudent)

    let studentData = existingStudent;

    // Step 2: If not found, insert student
    if (existingStudent === null) {
      const { data: newStudent, error: insertError } = await supabase
        .from("Student") // <- corrected table name to "Students"
        .insert([{ email: userEmail , id}])
        .select()
        .single(); // immediately get inserted row

      // console.log(newStudent).

      if (insertError) {
        console.error("Error inserting student:", insertError);
        return res
          .status(500)
          .json({ error: "Failed to create student record." });
      }

      studentData = newStudent;
    }

    // Set access token as HTTP-only cookie
    res.cookie("access_token", data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      maxAge: 60 * 60 * 24 * 1000, // 1 day in ms
    });

    // Final response: include student info from DB
    return res.status(200).json({
      message: "Login successful",
      user: data.user,
      student: studentData,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = {
  signUp,
  login,
  logOut,
};

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

    console.log("New user signed up:", data.user);
    return res
      .status(200)
      .json({ message: "Signup successful", user: data.user });
  } catch (err) {
    console.error("Unexpected error during signup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// @ GET
// ROUTE: /logout
const logOut = asyncHandler(async (req, res) => {
  res.clearCookie("access_token");
  return res.status(200);
});

// @ POST
// ROUTE: /login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Validate input
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

    // Set access token as HTTP-only cookie
    res.cookie("access_token", data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // Use secure cookie in production
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 1, // 1 days
    });

    return res
      .status(200)
      .json({ message: "Login successful", user: data.user });
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

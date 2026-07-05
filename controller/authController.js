const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");



const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NOREPLY_GMAIL,
    pass: process.env.NOREPLY_GMAIL_APP_PASSWORD,
  },
});

// @ POST
// ROUTE: /signup

//SEND an send email with with full name and description
const signUp = asyncHandler(async (req, res) => {


  // console.log("Received signup request:", req.body);
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


    const userId = data.user.id;

    // Create the corresponding Student row — signUp() does NOT do this automatically
    const { error: insertError } = await supabase
      .from("Student")
      .insert({
        id: userId,
        email: email,
        is_verified: false,
      });

    if (insertError) {
      console.error("Error creating Student row:", insertError.message);
      return res.status(500).json({ error: "Failed to create student profile." });
    }

    // your own short-lived signed token — no DB storage needed
    const verifyToken = jwt.sign(
      { userId, email },
      process.env.EMAIL_VERIFY_SECRET,
      { expiresIn: "24h" }
    );

    const buildVerifyEmailHtml = (verifyUrl) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Verify Your Mathamagic Account</title>
</head>
<body style="margin:0; padding:0; background-color:#f7f9fb; font-family: 'Hanken Grotesk', Arial, sans-serif; color:#191c1e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f9fb; padding: 24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius: 12px; overflow:hidden; border: 1px solid #e0e3e5; max-width: 600px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="padding: 24px 24px; border-bottom: 1px solid #e0e3e5;">
              <span style="font-family: 'Space Grotesk', Arial, sans-serif; font-size: 22px; font-weight: 700; color: #0035b9;">
                🧮 Mathamagic
              </span>
            </td>
          </tr>

          <!-- Main content -->
          <tr>
            <td style="padding: 40px 32px; text-align: center;">
              <h1 style="font-family: 'Space Grotesk', Arial, sans-serif; font-size: 28px; font-weight: 600; color: #0035b9; margin: 0 0 16px;">
                Complete Your Sign-Up
              </h1>
              <p style="font-size: 16px; line-height: 1.6; color: #444654; margin: 0 0 32px;">
                Please click the button below to verify your email address and finish setting up your Mathamagic account.
              </p>

              <a href="${verifyUrl}"
                 style="display:inline-block; background-color:#0035b9; color:#ffffff; padding: 14px 40px; border-radius: 8px; font-size: 14px; font-weight: 600; letter-spacing: 0.05em; text-decoration:none;">
                VERIFY ACCOUNT
              </a>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 32px; border-top: 1px solid #e0e3e5;">
                <tr>
                  <td style="padding-top: 16px;">
                    <p style="font-size: 12px; color: #444654; margin: 0 0 8px;">
                      If the button doesn't work, copy and paste this link:
                    </p>
                    <span style="font-size: 13px; color: #4b41e1; word-break: break-all;">
                      ${verifyUrl}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f2f4f6; padding: 32px 24px; text-align:center; border-top: 1px solid #e0e3e5;">
              <div style="font-family: 'Space Grotesk', Arial, sans-serif; font-size: 16px; font-weight: 700; color:#0035b9; opacity:0.8; margin-bottom: 16px;">
                🧮 Mathamagic
              </div>
              <div style="margin-bottom: 12px;">
                <a href="#" style="font-size: 13px; color:#444654; text-decoration:none; margin: 0 12px;">Privacy</a>
                <a href="#" style="font-size: 13px; color:#444654; text-decoration:none; margin: 0 12px;">Support</a>
                <a href="#" style="font-size: 13px; color:#444654; text-decoration:none; margin: 0 12px;">Unsubscribe</a>
              </div>
              <p style="font-size: 10px; color:#747686; text-transform:uppercase; letter-spacing: 0.2em; font-weight: 700; margin:0;">
                © 2026 Mathamagic
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

    const FRONTEND_BASE_URL =
      process.env.NODE_ENV === "DEVELOPMENT"
        ? "http://localhost:5173"
        : process.env.FRONTEND_URL;

    const verifyUrl = `${FRONTEND_BASE_URL}/surveypersonaldetail?token=${verifyToken}`;


    await transporter.sendMail({
      from: `"Mathamagic" <${process.env.NOREPLY_GMAIL}>`,
      to: email,
      subject: "Confirm your Mathamagic account",
      html: buildVerifyEmailHtml(verifyUrl),
    });



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
    const id = data.user.id;

    // Step 1: Check if student exists
    const { data: existingStudent, error: selectError } = await supabase
      .from("Student")
      .select("*")
      .eq("email", userEmail)
      .single();

    let studentData = existingStudent;

    // Step 2: If not found, insert student
    if (existingStudent === null) {
      const { data: newStudent, error: insertError } = await supabase
        .from("Student")
        .insert([{ email: userEmail, id }])
        .select()
        .single();

      if (insertError) {
        console.error("Error inserting student:", insertError);
        return res
          .status(500)
          .json({ error: "Failed to create student record." });
      }

      studentData = newStudent;
    }

    // Step 3: Block login if email hasn't been verified yet
    if (!studentData.is_verified) {
      await supabase.auth.signOut(); // invalidate the session Supabase just created
      return res.status(403).json({
        error: "Please verify your email before logging in.",
        unverified: true,
      });
    }

    // Set access token as HTTP-only cookie
    res.cookie("access_token", data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "PRODUCTION",
      sameSite: process.env.NODE_ENV === "DEVELOPMENT" ? "lax" : "none",
      maxAge: 60 * 60 * 24 * 1000, // 1 day in ms
    });

    // Final response: include student info from DB
    return res.status(200).json({
      message: "Login successful",
      user: data.user,
      student: studentData,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.query;

  try {
    const decoded = jwt.verify(token, process.env.EMAIL_VERIFY_SECRET);

    const { data: updatedStudent, error: updateError } = await supabase
      .from("Student")
      .update({ is_verified: true })
      .eq("id", decoded.userId)
      .select()
      .single();

    if (updateError) {
      console.error("Error verifying student:", updateError.message);
      return res.status(500).json({ error: "Failed to verify account." });
    }

    // Generate a magic-link token server-side, then redeem it immediately
    // to mint a real session — the user never sees this intermediate link
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: decoded.email,
    });

    if (linkError) {
      console.error("Error generating session link:", linkError.message);
      return res.status(200).json({
        message: "Email verified. Please log in.",
        student: updatedStudent,
      });
    }

    const { data: sessionData, error: verifyOtpError } = await supabase.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    });

    if (verifyOtpError || !sessionData.session) {
      console.error("Error creating session:", verifyOtpError?.message);
      return res.status(200).json({
        message: "Email verified. Please log in.",
        student: updatedStudent,
      });
    }

    // Set the same cookie your login flow uses
    res.cookie("access_token", sessionData.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "DEVELOPMENT" ? "lax" : "none",
      maxAge: 60 * 60 * 24 * 1000,
    });

    return res.status(200).json({
      message: "Email verified and logged in.",
      student: updatedStudent,
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    });
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return res.status(400).json({ error: "Invalid or expired verification link." });
  }
});

module.exports = {
  signUp,
  login,
  logOut,
  verifyEmail,
};

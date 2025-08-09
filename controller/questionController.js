const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");

// @ POST
// ROUTE: /section/:section

//SEND an send email with with full name and description
const getQuestions = asyncHandler(async (req, res) => {
  const { section } = req.params;
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Verify token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  



  return res.status(200).json({ message: "Profile updated successfully." });
});




module.exports = {
  getQuestions,
};

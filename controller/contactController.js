const asyncHandler = require("express-async-handler");
const nodemailer = require("nodemailer");


// @ POST
// ROUTE: /email

//SEND an send email with with full name and description
const sendEmail = asyncHandler(async (req, res) => {
  const { email, fullName, message } = req.body;

  res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `${email}`,
      to: process.env.EMAIL_RECEIVER,
      subject: `New Contact Form Submission from ${fullName}`,
      text: `You received a message from ${fullName} (${email}):\n\n${message}`,
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }
});

module.exports = {
  sendEmail,
};

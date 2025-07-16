require("dotenv").config();
const cors = require("cors");

const nodemailer = require("nodemailer");
const express = require("express");
const app = express();

// middleware
const allowedOrigins = [
  "http://localhost:5173",
  "https://mathamagic.vercel.app"
];

app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());
const PORT = 3000;

app.get("/email", (req, res) => {
  res.send("Email Received");
});

app.options("/email", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  return res.status(204).end(); // no content
});

app.post("/email", async (req, res) => {
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

   return  res.status(200).json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});


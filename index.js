require("dotenv").config();
const cors = require("cors");

const nodemailer = require("nodemailer");
const express = require("express");
const app = express();

// middleware
app.use(cors());
app.use(express.json());
const PORT = 3000;

app.get("/email", (req, res) => {
  res.send("Email Received");
});

app.post("/email", async (req, res) => {
  const { email, fullName, message } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

//   console.log("Received email:", email, fullName, message);
//   console.log("EMAIL_USER:", process.env.GMAIL_USER);
//   console.log("EMAIL_PASS:", process.env.GMAIL_APP_PASSWORD);
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

    res.status(200).json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});

const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.NOREPLY_GMAIL,
        pass: process.env.NOREPLY_GMAIL_APP_PASSWORD,
    },
});

module.exports = transporter;
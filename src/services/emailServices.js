const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Create transporter using your SMTP credentials
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const sendEmail = async (to, subject, html) => {
    try {

        await transporter.sendMail({
            from: `IOTFIY-AC-KIT <${process.env.SMTP_USER}>`,
            to,
            subject,
            html,
        });

        console.log("Email sent ✔");
    } catch (err) {
        console.error("SMTP error:", err);
        throw err;
    }
};

module.exports = sendEmail;
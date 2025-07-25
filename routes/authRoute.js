const express = require("express");
const router = express.Router();

const authController = require("../controller/authController");

// Middleware to set CORS headers
const setCorsHeaders = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
};

// Apply CORS headers to all routes including OPTIONS
router.use(setCorsHeaders);

// OPTIONS handlers for preflight requests
router.options("/signup", (req, res) => res.sendStatus(204));
router.options("/login", (req, res) => res.sendStatus(204));
router.options("/logout", (req, res) => res.sendStatus(204));

// Actual route handlers
router.post("/signup", authController.signUp);
router.post("/login", authController.login);
router.get("/logout", authController.logOut);

module.exports = router;

const express = require("express");
const router = express.Router();

const contactController = require("../../controller/contactController");

const setCorsHeaders = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
};


router.options("/email", setCorsHeaders, (req, res) => {
  res.status(204).end(); // Preflight response
});

router.post("/email", setCorsHeaders, contactController.sendEmail);

module.exports = router;

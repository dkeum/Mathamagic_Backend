const express = require("express");
const router = express.Router();

const userController = require("../controller/userController");

// Only apply CORS headers and OPTIONS handlers in non-development environments
if (process.env.NODE_ENV !== "DEVELOPMENT") {

  const setCorsHeaders = (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  };

  router.use(setCorsHeaders);

  // OPTIONS handler for preflight requests
  router.options("/update-user", (req, res) => res.sendStatus(204));
  router.options("/user/setname", (req, res) => res.sendStatus(204));
  router.options("/:user/getprofile", (req, res) => res.sendStatus(204));
  router.options("/save-session", (req, res) => res.sendStatus(204));
}

// Actual route handler
router.post("/update-user", userController.updateUser);
router.put("/user/setname", userController.setName);
router.get("/:user_email/getprofile", userController.getProgress);
router.post("/save-session", userController.saveSession);

module.exports = router;

const express = require("express");
const multer = require("multer");

const router = express.Router();
const upload = multer(); // memory storage (keeps file in req.file.buffer)
const userController = require("../controller/userController");

// Only apply CORS headers and OPTIONS handlers in non-development environments
if (process.env.NODE_ENV !== "DEVELOPMENT") {
  const setCorsHeaders = (req, res, next) => {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "https://mathamagic.vercel.app"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  };

  router.use(setCorsHeaders);

  // OPTIONS handler for preflight requests
  router.options("/update-user", (req, res) => res.sendStatus(204));
  router.options("/user/setname", (req, res) => res.sendStatus(204));
  router.options("/:topic/:section", (req, res) => res.sendStatus(204));
  router.options("/:user/getprofile", (req, res) => res.sendStatus(204));
  router.options("/save-session", (req, res) => res.sendStatus(204));
  router.options("/update-profile-info", (req, res) => res.sendStatus(204));
  router.options("/delete-account", (req, res) => res.sendStatus(204));
}

// Actual route handler
router.post("/update-user", userController.updateUser);
router.put("/user/setname", userController.setName);
router.put("/:topic/:section", userController.updateGrades);
router.get("/:user_email/getprofile", userController.getProgress);
router.post("/save-session", userController.saveSession);
router.put("/update-profile-info", upload.single("profile_picture"), userController.updateProfileInformation);
router.delete("/delete-account", userController.deleteAccount);

module.exports = router;

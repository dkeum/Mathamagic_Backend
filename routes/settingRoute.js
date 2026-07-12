const express = require("express");
const router = express.Router();



const multer = require("multer");
const upload = multer(); // memory storage (keeps file in req.file.buffer)

const settingController = require("../controller/settingController");


// ── Webhook ──────────────────────────────────────────────────
// MUST be before express.json() middleware — Stripe needs the raw body
// Make sure in your server.js you have:
// app.use("/payment/webhook", express.raw({ type: "application/json" }))

// Only apply CORS headers and OPTIONS handlers in non-development environments
if (process.env.NODE_ENV !== "DEVELOPMENT") {

  const setCorsHeaders = (req, res, next) => {
    // res.setHeader("Access-Control-Allow-Origin", "https://mathamagic.vercel.app");
     res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  };

  router.use(setCorsHeaders);

  // OPTIONS handler for preflight requests
  router.options("/payment/create-checkout-session", (req, res) => res.sendStatus(204));
  router.options("/payment/cancel-subscription", (req, res) => res.sendStatus(204));
  router.options("/payment/subscription-status", (req, res) => res.sendStatus(204));

}


// Actual route handler
router.post("/update-userprofile", settingController.updateUser);
router.put("/user/setname", settingController.setName);
router.put("/update-profile-info", upload.single("profile_picture"), settingController.updateProfileInformation);
router.delete("/delete-account", settingController.deleteAccount);
router.get("/setting-info", settingController.getSettingProfile)

module.exports = router;
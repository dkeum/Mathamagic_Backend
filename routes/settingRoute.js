const express = require("express");
const router = express.Router();

const multer = require("multer");
const upload = multer(); // memory storage (keeps file in req.file.buffer)

const settingController = require("../controller/settingController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

// Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {

//   const setCorsHeaders = (req, res, next) => {
//     res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
//     res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
//     res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     next();
//   };

//   router.use(setCorsHeaders);

//   // OPTIONS handlers for preflight requests — was missing entries for
//   // several of this file's own routes (update-userprofile, setname,
//   // update-profile-info, delete-account, setting-info). The three that
//   // existed before (payment/*) don't belong in a settings router at all.
//   router.options("/update-userprofile", (req, res) => res.sendStatus(204));
//   router.options("/user/setname", (req, res) => res.sendStatus(204));
//   router.options("/update-profile-info", (req, res) => res.sendStatus(204));
//   router.options("/delete-account", (req, res) => res.sendStatus(204));
//   router.options("/setting-info", (req, res) => res.sendStatus(204));
// }



applyCustomCors(router)
// ── Settings routes ─────────────────────────────────────────────
router.post("/update-userprofile", settingController.updateUser);

router.put("/user/setname",  settingController.setName);


router.put("/update-profile-info", upload.single("profile_picture"), settingController.updateProfileInformation);
router.delete("/delete-account", settingController.deleteAccount);
router.get("/setting-info", settingController.getSettingProfile);

module.exports = router;
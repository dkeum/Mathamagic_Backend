const express = require("express");
const router = express.Router();

const homeworkHelpController = require("../controller/homeworkHelpController");

// // Only apply CORS headers and OPTIONS handlers in non-development environments
// if (process.env.NODE_ENV !== "DEVELOPMENT") {
//   const setCorsHeaders = (req, res, next) => {
//     res.setHeader(
//       "Access-Control-Allow-Origin",
//       "https://mathamagic.vercel.app"
//     );
//     res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
//     res.setHeader("Access-Control-Allow-Headers", "Content-Type");
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     next();
//   };

//   router.use(setCorsHeaders);

//   // OPTIONS handler for preflight requests
//   router.options("/homework-help/upload-pdf", (req, res) =>
//     res.sendStatus(204)
//   );
//   router.options("/homework-help/upload-image", (req, res) =>
//     res.sendStatus(204)
//   );
// }

// // Actual route handler
// router.post(
//   "/homework-help/upload-pdf",
//   homeworkHelpController.uploadMiddleware,
//   homeworkHelpController.uploadPdf
// );

// router.post(
//   "/homework-help/upload-image",
//   homeworkHelpController.uploadMiddleware,
//   homeworkHelpController.uploadImage
// );

// module.exports = router;

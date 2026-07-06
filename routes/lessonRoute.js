const express = require("express");
const router = express.Router();

const lessonController = require("../controller/lessonController");

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

  router.options("/:classID/lesson/",               (req, res) => res.sendStatus(204));
  router.options("/:classID/topics-with-sections",  (req, res) => res.sendStatus(204));
  router.options("/:classID/mark-video-watched",    (req, res) => res.sendStatus(204));
  router.options("/:classID/set-watched-lessons",   (req, res) => res.sendStatus(204));
}

router.get( "/:classID/lesson/",              lessonController.getLessons);
router.get( "/:classID/topics-with-sections", lessonController.getTopicsWithSections);
router.post("/:classID/mark-video-watched",   lessonController.markVideoWatched);
router.post("/:classID/set-watched-lessons",  lessonController.setLessonWatched);

module.exports = router;
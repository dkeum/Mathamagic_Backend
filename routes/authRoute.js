const express = require("express");
const router = express.Router();

const authController = require("../controller/authController");

router
  .post("/signup", authController.signUp)
  .post("/login", authController.login)
  .get("/logout", authController.logOut);

module.exports = router;

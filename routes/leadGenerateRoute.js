const express = require("express");
const router = express.Router();

const leadGenerateController = require("../controller/leadGenerateController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

applyCustomCors(router)

router.get("/contact-email", leadGenerateController.confirmContactEmail);
router.get("/booking-confirmation", leadGenerateController.confirmBookingEmail);


module.exports = router;
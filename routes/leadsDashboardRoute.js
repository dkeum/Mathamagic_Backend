const express = require("express");
const router = express.Router();

const leadsDashboardController = require("../controller/leadsDashboardController");
const applyCustomCors = require("./customCorsHelper/helperFunctions/customCors");

applyCustomCors(router);

// Owner only: the controller checks the access_token cookie against OWNER_USER_ID
router.get("/leads/dashboard", leadsDashboardController.getLeadsDashboard);

module.exports = router;
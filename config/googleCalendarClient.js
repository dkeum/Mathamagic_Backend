const { google } = require("googleapis");


// C:\Users\danie\Desktop\Personal Projects\Mathamagic\backend\Mathamagic_Backend\project-7fdd81bb-3ecd-4c8a-8dd-da86c97aa40b.json
// Store the whole JSON key as one env var (GOOGLE_SERVICE_ACCOUNT_JSON).
const credentials = JSON.parse(process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
});

module.exports = google.calendar({ version: "v3", auth });
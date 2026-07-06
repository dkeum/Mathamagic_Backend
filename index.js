require("dotenv").config();

const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const express = require("express");
const app = express();

// middleware
const allowedOrigins = [
  "http://localhost:5173",
  "https://mathamagic.vercel.app",
  "https://mathmagick.com*",
];


// 1. Import the router file at the top of your file
const stripeWebhookRouter = require("./routes/stripeWebhook");

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));


// STRIPE WEBHOOKS REQUIRE RAW BODY, so we will apply the raw body parser only to the webhook route in server.js
app.post(
  '/payment/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookRouter
);



app.use(bodyParser.urlencoded({ extended: true }));
// app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.json());
const PORT = 3000;

app.use("/", require("./routes/publicAPI/contactRoute"));
app.use("/", require("./routes/authRoute")); // Good for Serverless function
app.use("/", require("./routes/userRoute"))
app.use("/", require("./routes/questionRoute"))
app.use("/", require("./routes/homeworkHelpRoute"))
app.use("/", require("./routes/stripeRoute"))
app.use("/api/waitlist", require("./routes/waitListRoute")); // Linked to external controller for clean separation of concerns
app.use("/", require("./routes/practiceTopicRoute"))
app.use("/", require("./routes/trackDataRoute"))
app.use("/", require("./routes/finalExamRoute"))
app.use("/", require("./routes/lessonRoute"))
app.use("/", require("./routes/AIVideoGenerateRoute"))



app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});

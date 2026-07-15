require("dotenv").config();

const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const supabase = require("./config/supabaseClient"); // ← add this

const express = require("express");
const app = express();

// middleware
const allowedOrigins = [
  "http://localhost:5173",
  "https://mathamagic.vercel.app",
  "https://mathmagick.com",
];




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
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-AI-Credits-Remaining'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Stripe webhook MUST come BEFORE express.json()
app.use(
  "/payment/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    console.log("🔥 Received request on /payment/webhook");
    console.log("Method:", req.method);
    console.log("Headers:", req.headers);
    next();
  }
);

app.use(
  "/test/stripewebhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    console.log("🔥 Received request on /test/stripewebhook");
    console.log("Method:", req.method);
    console.log("Headers:", req.headers);
    next();
  }
);
// Mount webhook routes
app.use("/", require("./routes/stripeWebhook"));


app.use(bodyParser.urlencoded({ extended: true }));
// app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.json());
const PORT = 3000;

app.get("/", (req, res) => {
  res.json({ message: "hi" });
});

app.use("/", require("./routes/publicAPI/contactRoute"));
app.use("/", require("./routes/authRoute")); // Good for Serverless function
app.use("/", require("./routes/settingRoute"))
app.use("/", require("./routes/questionRoute"))
app.use("/", require("./routes/homeworkHelpRoute"))
app.use("/", require("./routes/stripeRoute"))
app.use("/api/waitlist", require("./routes/waitListRoute")); // Linked to external controller for clean separation of concerns
app.use("/", require("./routes/practiceTopicRoute"))
app.use("/", require("./routes/trackDataRoute"))
app.use("/", require("./routes/finalExamRoute"))
app.use("/", require("./routes/lessonRoute"))
app.use("/", require("./routes/AIVideoGenerateRoute"))
app.use("/", require("./routes/AIRoute"))
app.use("/", require("./routes/cronJobRoute"))
app.use("/", require("./routes/userRoute"))


app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});

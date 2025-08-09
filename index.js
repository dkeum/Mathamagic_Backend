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
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true, // ⬅️ allows sending cookies
  })
);
app.use(bodyParser.urlencoded({ extended: true }));
// app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.json());
const PORT = 3000;

app.use("/", require("./routes/publicAPI/contactRoute"));
app.use("/", require("./routes/authRoute"));
app.use("/", require("./routes/userRoute"))
app.use("/", require("./routes/questionRoute"))




app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});

require("dotenv").config();
const cors = require("cors");

const express = require("express");
const app = express();

// middleware
const allowedOrigins = [
  "http://localhost:5173",
  "https://mathamagic.vercel.app"
];

app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());
const PORT = 3000;



app.use("/",require("./routes/publicAPI/contactRoute"))



app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});


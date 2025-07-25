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
    methods: ["GET", "POST"],
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





  app.get("/private", async(req,res)=>{
    const token = req.cookies.access_token
    if(!token){
      return res.redirect("https://mathamagic.vercel.app")
    }

    const {data, error} = await supabase.auth.getUser(token);


  })



app.listen(PORT, () => {
  console.log(`App is listening on port: ${PORT}`);
});

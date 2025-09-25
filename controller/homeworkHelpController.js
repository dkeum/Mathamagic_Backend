const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const multer = require("multer");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const FormData = require("form-data");

// ✅ Use memory storage for serverless
const storage = multer.memoryStorage();
const upload = multer({ storage });
const uploadMiddleware = upload.single("file");

// @ POST
// ROUTE: /homework-help/upload-pdf
const uploadPdf = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  // Verify user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const githubUrls = [];

    // Prepare multipart/form-data for DynamicPDF
    const form = new FormData();
    form.append("pdf", req.file.buffer, {
      filename: req.file.originalname || "file.pdf",
      contentType: req.file.mimetype || "application/pdf",
    });

    // Call DynamicPDF REST API
    const dynamicPdfResponse = await axios.post(
      "https://api.dpdf.io/v1.0/pdf-image",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.DYNAMICPDF_API_KEY}`,
        },
        responseType: "arraybuffer",
      }
    );

    // Convert returned PNG bytes to base64
    const base64Image = Buffer.from(dynamicPdfResponse.data).toString("base64");

    // Upload to GitHub
    const uniqueFilename = `${uuidv4()}.png`;
    const response = await axios.put(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/uploads/${uniqueFilename}`,
      {
        message: `Upload PDF page`,
        content: base64Image,
        branch: process.env.GITHUB_BRANCH || "main",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    githubUrls.push(response.data.content.download_url);

    return res.status(200).json({
      message: "PDF uploaded and converted successfully",
      githubUrls,
    });
  } catch (error) {
    console.error("PDF upload error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to upload PDF." });
  }
});

// @ POST
// ROUTE: /homework-help/upload-image
const uploadImage = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Missing or invalid token." });

  // Verify user
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) return res.status(401).json({ error: "Unauthorized user." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const uniqueFilename = `${uuidv4()}.png`;

    // Convert buffer -> base64
    const base64Image = req.file.buffer.toString("base64");

    // Upload to GitHub
    const response = await axios.put(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/uploads/${uniqueFilename}`,
      {
        message: `Upload image ${uniqueFilename}`,
        content: base64Image,
        branch: process.env.GITHUB_BRANCH || "main",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    return res.status(200).json({
      message: "Image uploaded successfully",
      githubUrls: [response.data.content.download_url],
    });
  } catch (error) {
    console.error("Image upload error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to upload image." });
  }
});

module.exports = {
  uploadPdf,
  uploadMiddleware,
  uploadImage,
};

const asyncHandler = require("express-async-handler");
const supabase = require("../config/supabaseClient");
const multer = require("multer");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid"); // import uuid
const { PdfImage, PdfResource, PngImageFormat } = require("@dynamicpdf/api");
const path = require("path");
const os = require("os");


// Disk storage in /tmp
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(os.tmpdir(), "uploads")); // temp folder
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });
const uploadMiddleware = upload.single("file");

// @ POST
// ROUTE: /homework-help/upload-pdf
const uploadPdf = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Verify token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  try {
    const githubUrls = [];

    // Use DynamicPDF to convert uploaded PDF buffer into images
    const pdfResource = new PdfResource(req.file.buffer);
    const pdfImage = new PdfImage(pdfResource);
    pdfImage.apiKey = process.env.DYNAMICPDF_API_KEY;

    const pngImageFormat = new PngImageFormat();
    pdfImage.imageFormat = pngImageFormat;

    const result = await pdfImage.process();

    if (!result.isSuccessful) {
      console.error("DynamicPDF error:", result.errorJson);
      return res.status(500).json({ error: "Failed to convert PDF." });
    }

    // Iterate through all pages/images
    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];

      const uniqueFilename = `${uuidv4()}.png`;

      // Upload each PNG page to GitHub
      const response = await axios.put(
        `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/uploads/${uniqueFilename}`,
        {
          message: `Upload PDF page ${i + 1}`,
          content: image.data, // already base64 from DynamicPDF
          branch: process.env.GITHUB_BRANCH || "main",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      // console.log(response.data.content.download_url)

      githubUrls.push(response.data.content.download_url);
    }

    return res.status(200).json({
      message: "PDF pages uploaded successfully",
      githubUrls,
    });
  } catch (error) {
    console.error("PDF upload error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to upload PDF pages." });
  }
});

// @ POST
// ROUTE: /homework-help/upload-image
const uploadImage = asyncHandler(async (req, res) => {
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  // Verify token
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return res.status(401).json({ error: "Unauthorized user." });
  }
  // console.log("upload image is called")
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  try {
    const uniqueFilename = `${uuidv4()}.png`;

    // Convert buffer -> base64
    const base64Image = req.file.buffer.toString("base64");

    // Upload image to GitHub
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

    // console.log(response.data.content.download_url);
    return res.status(200).json({
      message: "Image uploaded successfully",
      githubUrls: [response.data.content.download_url], // ✅ only one image
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

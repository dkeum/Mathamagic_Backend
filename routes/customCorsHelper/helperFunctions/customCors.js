// middleware/customCors.js

const applyCustomCors = (router) => {
  // Only apply CORS headers and OPTIONS handlers in non-development environments
  if (process.env.NODE_ENV !== "DEVELOPMENT") {
    
    // Define the exact origins you want to allow
    const allowedOrigins = [
      "https://mathmagick.com",
      "https://mathamagic.vercel.app"
    ];
    
    const setCorsHeaders = (req, res, next) => {
      const origin = req.headers.origin;
      
      // If the incoming request is from an allowed origin, set it as the header
      if (allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }

      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
      
      // Combine multiple headers into one comma-separated string
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      
      next();
    };

    router.use(setCorsHeaders);

    // This wildcard catches ALL preflight OPTIONS requests for this router
    router.options("*", (req, res) => res.sendStatus(204));
  }
};

module.exports = applyCustomCors;
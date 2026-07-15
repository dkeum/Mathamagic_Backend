// middleware/customCors.js

const applyCustomCors = (router) => {
  // Only apply CORS headers and OPTIONS handlers in non-development environments
  if (process.env.NODE_ENV !== "DEVELOPMENT") {
    
    const setCorsHeaders = (req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "https://mathmagick.com");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      next();
    };

    router.use(setCorsHeaders);

    // This wildcard catches ALL preflight OPTIONS requests for this router
    // so you don't have to write them out one by one!
    router.options("*", (req, res) => res.sendStatus(204));
  }
};

module.exports = applyCustomCors;
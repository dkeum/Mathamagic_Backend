const supabase = require("../../config/supabaseClient");

async function cleanUpOldVideos(req, res) {
  // 1. Vercel Cron Security Check
  // Vercel will send your CRON_SECRET in the Authorization header.
  console/log(req?.headers?.authorization)
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  const BUCKET_NAME = "generated-videos";
  const THIRTY_MINUTES_MS = 30 * 60 * 1000;
  
  console.log(`Starting cleanup for bucket: ${BUCKET_NAME}`);

  try {
    const { data: files, error: listError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .list('', {
        limit: 1000,
        sortBy: { column: 'created_at', order: 'asc' }
      });

    if (listError) throw new Error(`Failed to list files: ${listError.message}`);

    if (!files || files.length === 0) {
      console.log("Bucket is empty. Nothing to clean up.");
      return res.status(200).json({ message: "Bucket empty" });
    }

    const now = new Date();

    const filesToDelete = files
      .filter((file) => {
        if (!file.id) return false; 
        const fileCreatedAt = new Date(file.created_at);
        return (now.getTime() - fileCreatedAt.getTime()) > THIRTY_MINUTES_MS;
      })
      .map((file) => file.name);

    if (filesToDelete.length === 0) {
      console.log("No videos older than 30 minutes found.");
      return res.status(200).json({ message: "No old videos found" });
    }

    console.log(`Found ${filesToDelete.length} video(s) older than 30 minutes. Deleting...`);

    const { error: deleteError } = await supabase
      .storage
      .from(BUCKET_NAME)
      .remove(filesToDelete);

    if (deleteError) throw new Error(`Failed to delete files: ${deleteError.message}`);

    console.log("Cleanup successful! Deleted files:", filesToDelete);
    
    // Return success to Vercel
    return res.status(200).json({ success: true, deletedFiles: filesToDelete });

  } catch (error) {
    console.error("Error during cleanup process:", error);
    return res.status(500).json({ error: "Internal Server Error during cleanup" });
  }
}

module.exports = { cleanUpOldVideos };
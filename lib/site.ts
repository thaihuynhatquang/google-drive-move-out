// Public URL of the deployment (Netlify sets URL at build time; SITE_URL overrides it).
export const SITE_URL = (process.env.SITE_URL || process.env.URL || "http://localhost:3000").replace(/\/$/, "");

export const SITE_TITLE = "Drive Move-Out: transfer Google Drive folder ownership to another account";
export const SITE_DESCRIPTION =
  "Bulk-transfer ownership of a Google Drive folder, with every file and subfolder in it, from one Gmail account " +
  "to another. No downloading or re-uploading: only the owner changes. Free, open source, runs in your browser.";

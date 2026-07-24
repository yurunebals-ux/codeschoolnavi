import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import rehypeExternalLinks from "rehype-external-links";

// Set `site` to your real domain before deploying (used for sitemap & canonical URLs).
export default defineConfig({
  site: process.env.SITE_URL || "https://example.com",
  integrations: [sitemap()],
  build: { format: "directory" },
  markdown: {
    rehypePlugins: [
      // Compliance: outbound (affiliate) links get rel="sponsored nofollow noopener".
      [rehypeExternalLinks, { target: "_blank", rel: ["sponsored", "nofollow", "noopener"] }],
    ],
  },
});

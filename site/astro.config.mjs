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
      // Compliance: アフィリエイト（ASP経由）の外部リンクだけ rel="sponsored"。
      // ニュースの出典リンクまで sponsored にすると、検索エンジンに「広告」と伝わり、
      // 本文中の sponsored リンク用のボタン装飾（Base.astro）も当たってしまう（2026-09-11 本番で確認）。
      [rehypeExternalLinks, {
        target: "_blank",
        rel: (el) => {
          const href = String(el.properties?.href ?? "");
          const ad = /moshimo\.com|a8\.net|afi-b\.com|accesstrade|valuecommerce|rentracks|felmat|link-a\.net/i.test(href);
          return ad ? ["sponsored", "nofollow", "noopener"] : ["nofollow", "noopener"];
        },
      }],
    ],
  },
});

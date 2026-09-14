// Google ニュース用サイトマップ（直近2日のニュース記事だけ）。Search Console で通常のサイトマップと別に送信する。
import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export async function GET({ site }: APIContext) {
  const posts = (await getCollection("blog", ({ data }) => !data.draft && data.news))
    .filter((p) => Date.now() - +new Date(p.data.pubDate) < 2 * 86400000)
    .sort((a, b) => +new Date(b.data.pubDate) - +new Date(a.data.pubDate));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const urls = posts.map((p) => `  <url>
    <loc>${new URL(`/blog/${p.slug}/`, site).toString()}</loc>
    <news:news>
      <news:publication><news:name>コードスクールナビ</news:name><news:language>ja</news:language></news:publication>
      <news:publication_date>${new Date(p.data.pubDate).toISOString()}</news:publication_date>
      <news:title>${esc(p.data.title)}</news:title>
    </news:news>
  </url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

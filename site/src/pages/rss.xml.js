import rss from "@astrojs/rss";
import { getCollection } from "astro:content";

export async function GET(context) {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return rss({
    title: import.meta.env.SITE_NAME || "プログラミングスクール比較ナビ",
    description: "プログラミングスクールの比較・評判・料金の最新記事",
    site: context.site,
    items: posts
      .sort((a, b) => +new Date(b.data.pubDate) - +new Date(a.data.pubDate))
      .map((p) => ({
        title: p.data.title,
        description: p.data.description,
        pubDate: new Date(p.data.pubDate),
        link: `/blog/${p.slug}/`,
      })),
  });
}

import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    author: z.string().default("Editorial Team"),
        pubDate: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)),
        updatedDate: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)).optional(),
    tools: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    // ニュース解説／トピック記事のフラグ（src/pipeline/generate.ts が付ける）
    news: z.boolean().default(false),
    topic: z.boolean().default(false),
    // ニュース記事: ネットの反応の件数（はてブ等の合計）。トップ・一覧で「反応◯件」と出す
    reactions: z.number().optional(),
  }),
});

export const collections = { blog };

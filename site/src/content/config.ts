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
  }),
});

export const collections = { blog };

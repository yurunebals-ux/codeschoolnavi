// Tiny JSON-file state store (no native deps, safe in CI).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.js";

export type KeywordStatus = "queued" | "drafted" | "approved" | "published" | "rejected";

export type ArticleKind = "money" | "info" | "pillar";

export interface KeywordItem {
  slug: string;
  keyword: string;
  template: string;
  tools: string[];
  audience?: string;
  kind: ArticleKind; // money = commercial, info = top-funnel, pillar = hub
  cluster: string; // topic cluster this article belongs to (for internal linking)
  score: number;
  status: KeywordStatus;
  rejectReason?: string;
  createdAt: string;
  publishedAt?: string;
  // analytics feedback
  impressions?: number;
  clicks?: number;
  position?: number;
}

export interface State {
  keywords: KeywordItem[];
  publishedCount: number;
  lastRun?: string;
  // rough estimated MRR based on published comparison articles (very approximate)
  estimatedMrrUsd: number;
  history: { date: string; published: number; estimatedMrrUsd: number }[];
}

const empty: State = {
  keywords: [],
  publishedCount: 0,
  estimatedMrrUsd: 0,
  history: [],
};

export function loadState(): State {
  if (!existsSync(paths.state)) return structuredClone(empty);
  try {
    return { ...structuredClone(empty), ...JSON.parse(readFileSync(paths.state, "utf8")) };
  } catch {
    return structuredClone(empty);
  }
}

export function saveState(s: State): void {
  mkdirSync(dirname(paths.state), { recursive: true });
  writeFileSync(paths.state, JSON.stringify(s, null, 2));
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

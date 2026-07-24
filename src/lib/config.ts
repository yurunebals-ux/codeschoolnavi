// Central configuration loaded from environment variables.
// Loads a .env file manually (no dependency) if present.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotenv();

const env = (k: string, d = "") => process.env[k] ?? d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const config = {
  llm: {
    provider: env("LLM_PROVIDER", "openai"),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "gpt-4o-mini"),
    baseUrl: env("LLM_BASE_URL"),
  },
  site: {
    url: env("SITE_URL", "https://example.com").replace(/\/$/, ""),
    name: env("SITE_NAME", "プログラミングスクール比較ナビ"),
    author: env("SITE_AUTHOR", "編集部"),
    niche: env("SITE_NICHE", "programming-schools"),
  },
  pipeline: {
    perCycle: num("ARTICLES_PER_CYCLE", 3),
    qualityMin: num("QUALITY_MIN_SCORE", 70),
    minWords: num("MIN_WORDS", 1200),
  },
  indexNowKey: env("INDEXNOW_KEY"),
  gsc: {
    keyJson: env("GSC_SERVICE_ACCOUNT_JSON"),
    siteUrl: env("GSC_SITE_URL"),
  },
} as const;

export const paths = {
  root: process.cwd(),
  data: resolve(process.cwd(), "data"),
  state: resolve(process.cwd(), "data/state.json"),
  affiliates: resolve(process.cwd(), "data/affiliates.json"),
  blog: resolve(process.cwd(), "site/src/content/blog"),
  drafts: resolve(process.cwd(), "data/drafts"),
};

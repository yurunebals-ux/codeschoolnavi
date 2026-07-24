// ROLE: Publishing & Ops
// Moves approved drafts into the Astro content dir, updates state + MRR estimate,
// commits (if in a git repo & PUBLISH_COMMIT=1), and pings IndexNow.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { config, paths } from "../lib/config.js";
import { loadState, saveState } from "../lib/store.js";

// Rough recurring-revenue model: each published buyer-intent article is assumed
// to eventually convert a small trickle of recurring signups. Very approximate,
// intentionally conservative; real numbers come from analytics later.
// 日本の高単価・単発報酬モデル：公開記事1本あたりの推定月間収益（円）。
// 平均報酬 約2万円 × 早期の低い月間成約率を見込んだ保守値。
const REV_PER_ARTICLE_YEN = 300;

export async function publishRun(): Promise<number> {
  const state = loadState();
  const approved = state.keywords.filter((k) => k.status === "approved");
  if (!approved.length) { console.log("[ops] nothing approved to publish."); return 0; }

  mkdirSync(paths.blog, { recursive: true });
  const publishedUrls: string[] = [];

  for (const item of approved) {
    const src = resolve(paths.drafts, `${item.slug}.md`);
    if (!existsSync(src)) continue;
    let md = readFileSync(src, "utf8");

    // Internal linking: connect this page to its cluster (pillar first, then peers).
    const related = state.keywords
      .filter((k) => k.status === "published" && k.cluster === item.cluster && k.slug !== item.slug)
      .sort((a, b) => (a.kind === "pillar" ? -1 : 0) - (b.kind === "pillar" ? -1 : 0))
      .slice(0, 5);
    if (related.length) {
      const links = related.map((r) => `- [${r.keyword}](/blog/${r.slug}/)`).join("\n");
      md += `\n\n## 関連記事\n\n${links}\n`;
    }

    const dest = resolve(paths.blog, `${item.slug}.md`);
    writeFileSync(dest, md);
    item.status = "published";
    item.publishedAt = new Date().toISOString();
    state.publishedCount++;
    publishedUrls.push(`${config.site.url}/blog/${item.slug}/`);
    console.log(`[ops] published ${item.slug}`);
  }

  state.estimatedMrrUsd = Math.round(state.publishedCount * REV_PER_ARTICLE_YEN);
  const today = new Date().toISOString().slice(0, 10);
  const hist = state.history.find((h) => h.date === today);
  if (hist) { hist.published = state.publishedCount; hist.estimatedMrrUsd = state.estimatedMrrUsd; }
  else state.history.push({ date: today, published: state.publishedCount, estimatedMrrUsd: state.estimatedMrrUsd });
  state.lastRun = new Date().toISOString();
  saveState(state);

  writeSiteMeta();
  if (process.env.PUBLISH_COMMIT === "1") tryCommit(publishedUrls.length);
  if (config.indexNowKey && publishedUrls.length) await pingIndexNow(publishedUrls);

  console.log(`[ops] +${publishedUrls.length}本 公開. 累計=${state.publishedCount}, 推定月収≒¥${state.estimatedMrrUsd.toLocaleString()}`);
  return publishedUrls.length;
}

// robots.txt（sitemap誘導）と IndexNow キーファイルを site/public に出力。
function writeSiteMeta() {
  const pub = resolve(paths.root, "site/public");
  mkdirSync(pub, { recursive: true });
  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${config.site.url}/sitemap-index.xml\n`;
  writeFileSync(resolve(pub, "robots.txt"), robots);
  if (config.indexNowKey && /^[a-zA-Z0-9-]{8,}$/.test(config.indexNowKey)) {
    writeFileSync(resolve(pub, `${config.indexNowKey}.txt`), config.indexNowKey);
  }
}

function tryCommit(n: number) {
  try {
    execSync("git add -A", { cwd: paths.root, stdio: "ignore" });
    execSync(`git commit -m "content: publish ${n} article(s)"`, { cwd: paths.root, stdio: "ignore" });
    if (process.env.PUBLISH_PUSH === "1") execSync("git push", { cwd: paths.root, stdio: "ignore" });
    console.log("[ops] committed to git.");
  } catch { console.log("[ops] git commit skipped (no repo or nothing to commit)."); }
}

async function pingIndexNow(urls: string[]) {
  try {
    const host = new URL(config.site.url).host;
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host, key: config.indexNowKey, keyLocation: `${config.site.url}/${config.indexNowKey}.txt`, urlList: urls }),
    });
    console.log(`[ops] IndexNow notified (${res.status}).`);
  } catch (e) { console.log("[ops] IndexNow ping failed:", (e as Error).message); }
}

if (import.meta.url === `file://${process.argv[1]}`) publishRun();

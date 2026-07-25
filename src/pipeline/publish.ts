// ROLE: Publishing & Ops
// Moves approved drafts into the Astro content dir, updates state + MRR estimate,
// commits (if in a git repo & PUBLISH_COMMIT=1), and pings IndexNow.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";

// Rough recurring-revenue model: each published buyer-intent article is assumed
// to eventually convert a small trickle of recurring signups. Very approximate,
// intentionally conservative; real numbers come from analytics later.
// 日本の高単価・単発報酬モデル：公開記事1本あたりの推定月間収益（円）。
// 平均報酬 約2万円 × 早期の低い月間成約率を見込んだ保守値。
const REV_PER_ARTICLE_YEN = 300;

// ---- 内部リンク（競合評価②: 記事間リンクほぼゼロの解消） ----
// 給付金ハブを常に優先し、同クラスタ→新着の順で最大4本。既存の関連ブロックは張り替える。
const HUB_SLUGS = ["kyufukin-osusume"];

function relatedFor(item: KeywordItem, published: KeywordItem[]): KeywordItem[] {
  const peers = published.filter((k) => k.slug !== item.slug);
  const rel: KeywordItem[] = [];
  for (const hs of HUB_SLUGS) {
    const hub = peers.find((k) => k.slug === hs);
    if (hub) rel.push(hub);
  }
  for (const k of peers) {
    if (k.cluster === item.cluster && !rel.includes(k)) rel.push(k);
  }
  const latest = [...peers].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  for (const k of latest) if (!rel.includes(k)) rel.push(k);
  return rel.slice(0, 4);
}

function upsertRelatedLinks(md: string, rel: KeywordItem[]): string {
  // 既存の関連ブロック（末尾）を除去してから付け直す。
  const stripped = md.replace(/\n## (関連記事|あわせて読みたい)\n[\s\S]*$/, "").trimEnd();
  if (!rel.length) return stripped + "\n";
  const links = rel.map((r) => `- [${r.keyword}](/blog/${r.slug}/)`).join("\n");
  return `${stripped}\n\n## あわせて読みたい\n\n${links}\n`;
}

// 状態ファイルと実ファイルの食い違いを直す。
// 実害の例（実際に発生していた）: 公開済み8本のうち6本が status="queued" のままで、
//   (1) generateNext がそれを未執筆と見なして書き直し、公開中の記事を上書きする
//   (2) refreshInternalLinks が published だけを見るため、内部リンクが更新されない
// 放置運用では誰も気づけないので、サイクルの先頭で毎回突き合わせる。
// 真実の情報源は「site/src/content/blog に .md があるか」。
export function reconcilePublished(): number {
  const state = loadState();
  let fixed = 0;
  for (const k of state.keywords) {
    if (k.status === "published") continue;
    const p = resolve(paths.blog, `${k.slug}.md`);
    if (!existsSync(p)) continue;
    k.status = "published";
    if (!k.publishedAt) {
      // 記事のfrontmatterのpubDateを公開日として拾う（無ければ今日）。
      const m = readFileSync(p, "utf8").match(/^pubDate:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m);
      k.publishedAt = m ? new Date(`${m[1]}T00:00:00Z`).toISOString() : new Date().toISOString();
    }
    fixed++;
  }
  const realCount = state.keywords.filter((k) => k.status === "published").length;
  const countFixed = state.publishedCount !== realCount;
  state.publishedCount = realCount;
  if (fixed || countFixed) {
    saveState(state);
    console.log(`[ops] 状態を実ファイルに合わせて修復: ${fixed}件をpublishedに、累計=${realCount}`);
  }
  return fixed;
}

// 公開済み全記事の内部リンクを最新状態に張り替える（過去記事のレトロフィット含む）。
export function refreshInternalLinks(): number {
  const state = loadState();
  const published = state.keywords.filter((k) => k.status === "published");
  let changed = 0;
  for (const k of published) {
    const p = resolve(paths.blog, `${k.slug}.md`);
    if (!existsSync(p)) continue;
    const md = readFileSync(p, "utf8");
    const out = upsertRelatedLinks(md, relatedFor(k, published));
    if (out !== md) { writeFileSync(p, out); changed++; }
  }
  if (changed) console.log(`[ops] 内部リンクを更新: ${changed}本`);
  return changed;
}

// 料金定点観測データをサイト側へ同期（記事ページの「料金表示の監視ログ」用）。
function syncPricewatch(): boolean {
  const src = resolve(paths.data, "pricewatch.json");
  const dest = resolve(paths.root, "site/src/data/pricewatch.json");
  if (!existsSync(src)) return false;
  const before = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  if (before === readFileSync(src, "utf8")) return false;
  copyFileSync(src, dest);
  console.log("[ops] pricewatch.json をサイトへ同期");
  return true;
}

export async function publishRun(): Promise<number> {
  const state = loadState();
  const approved = state.keywords.filter((k) => k.status === "approved");

  mkdirSync(paths.blog, { recursive: true });
  const publishedUrls: string[] = [];

  for (const item of approved) {
    const src = resolve(paths.drafts, `${item.slug}.md`);
    if (!existsSync(src)) continue;
    const md = readFileSync(src, "utf8");
    const dest = resolve(paths.blog, `${item.slug}.md`);
    writeFileSync(dest, md);
    item.status = "published";
    item.publishedAt = new Date().toISOString();
    state.publishedCount++;
    publishedUrls.push(`${config.site.url}/blog/${item.slug}/`);
    console.log(`[ops] published ${item.slug}`);
  }
  saveState(state);

  // 新規公開の有無に関わらず、内部リンクと観測データを毎日メンテナンスする。
  const linkChanges = refreshInternalLinks();
  const pwChanged = syncPricewatch();

  const state2 = loadState();
  state2.estimatedMrrUsd = Math.round(state2.publishedCount * REV_PER_ARTICLE_YEN);
  const today = new Date().toISOString().slice(0, 10);
  const hist = state2.history.find((h) => h.date === today);
  if (hist) { hist.published = state2.publishedCount; hist.estimatedMrrUsd = state2.estimatedMrrUsd; }
  else state2.history.push({ date: today, published: state2.publishedCount, estimatedMrrUsd: state2.estimatedMrrUsd });
  state2.lastRun = new Date().toISOString();
  saveState(state2);

  writeSiteMeta();
  // 何を変更したかを個別に数え上げる方式だと、新しい工程（文体改稿など）を
  // 足したときに commit 条件を直し忘れて変更が失われる。作業ツリーが汚れて
  // いるかどうかで判断する。
  if (process.env.PUBLISH_COMMIT === "1" && (publishedUrls.length || linkChanges || pwChanged || isDirty())) {
    tryCommit(publishedUrls.length);
  }
  if (config.indexNowKey && publishedUrls.length) await pingIndexNow(publishedUrls);

  console.log(`[ops] +${publishedUrls.length}本 公開. 累計=${state2.publishedCount}, 内部リンク更新=${linkChanges}本`);
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

// 未コミットの変更があるか。git が無い環境では false（＝従来どおりの判定に任せる）。
function isDirty(): boolean {
  try {
    return execSync("git status --porcelain", { cwd: paths.root }).toString().trim().length > 0;
  } catch { return false; }
}

function tryCommit(n: number) {
  try {
    execSync("git add -A", { cwd: paths.root, stdio: "ignore" });
    const msg = n > 0 ? `content: publish ${n} article(s)` : "chore: refresh internal links / pricewatch";
    execSync(`git commit -m "${msg}"`, { cwd: paths.root, stdio: "ignore" });
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

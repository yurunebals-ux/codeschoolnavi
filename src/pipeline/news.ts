// ROLE: ニュースデスク
//
// 週1本、AI・プログラミング学習・リスキリングに関するニュースを拾って
// 「ニュース解説」記事の種をキューに入れる。本文は generate.ts の news:commentary が書く。
//
// 設計:
//  - 情報源は Google ニュースの検索RSS（無料・鍵不要・GitHub Actions から到達可能）。
//  - LLMには「見出し・媒体・抜粋」しか渡さない。抜粋にない事実を書かせない（捏造防止）。
//  - 記事本文の引用はしない（著作権）。出典へリンクして詳細はそちらに誘導する。
//  - 使ったニュースは data/news.json に記録し、同じ話題を二度書かない。
//  - 失敗しても日次サイクルは止めない（呼び出し側で catch）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";
import { loadState, saveState } from "../lib/store.js";

const LOG = resolve(paths.data, "news.json");
const QUERIES = [
  "生成AI 学習 未経験",
  "プログラミングスクール",
  "リスキリング 教育訓練給付",
  "エンジニア 転職 AI 求人",
  "プログラミング教育 AI",
];
// 見出しにこの語が含まれるものを優先（読者との関連が強い順）
const BOOST = ["プログラミング", "スクール", "リスキリング", "給付", "エンジニア", "生成AI", "学習", "転職", "未経験", "Python", "資格"];
const BLOCK = /株価|決算|逮捕|訴訟|炎上|芸能|選挙/;

interface Item { title: string; link: string; source: string; published: string; snippet: string }
interface Log { used: { link: string; slug: string; date: string }[]; lastRun?: string }

function loadLog(): Log {
  if (!existsSync(LOG)) return { used: [] };
  try { return JSON.parse(readFileSync(LOG, "utf8")); } catch { return { used: [] }; }
}

function decode(s: string): string {
  // Google ニュースの description は HTML がエスケープされて入っている（&lt;a href=…&gt;）。
  // 実体参照を戻してからタグを剥がさないと、タグが文字列として残る（2026-09-11 実測）。
  const un = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return un.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchRss(q: string): Promise<Item[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 codeschoolnavi-newsdesk" } });
  if (!res.ok) throw new Error(`rss ${res.status}`);
  const xml = await res.text();
  const items: Item[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const pick = (tag: string) => decode((x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] ?? "");
    const title = pick("title").replace(/\s*-\s*[^-]+$/, ""); // 末尾の「 - 媒体名」を落とす
    const link = pick("link");
    const source = pick("source");
    const published = pick("pubDate");
    const snippet = pick("description").slice(0, 300);
    if (title && link) items.push({ title, link, source, published, snippet });
  }
  return items;
}

function relevance(it: Item): number {
  let s = 0;
  for (const b of BOOST) if (it.title.includes(b)) s += 2;
  if (BLOCK.test(it.title)) s -= 10;
  const age = (Date.now() - new Date(it.published).getTime()) / 86400000;
  if (!Number.isNaN(age)) s -= Math.min(age, 14) * 0.3; // 新しいほど上
  return s;
}

/** 週1回だけ実行。キューに未処理のニュースがある間は何もしない。 */
export async function newsRun(): Promise<string | null> {
  const log = loadLog();
  const state = loadState();
  if (state.keywords.some((k) => k.template.startsWith("news:") && (k.status === "queued" || k.status === "drafted"))) {
    console.log("[news] 未処理のニュース記事があるためスキップ");
    return null;
  }
  const lastNews = state.keywords.filter((k) => k.template.startsWith("news:") && k.publishedAt).map((k) => k.publishedAt!).sort().pop();
  if (lastNews && Date.now() - new Date(lastNews).getTime() < 6 * 86400000) {
    console.log("[news] 前回のニュース記事から6日未満。スキップ");
    return null;
  }

  const seen = new Set(log.used.map((u) => u.link));
  const all: Item[] = [];
  for (const q of QUERIES) {
    try { all.push(...(await fetchRss(q))); } catch (e) { console.log(`[news] RSS取得失敗 "${q}": ${(e as Error).message}`); }
  }
  const fresh = all
    .filter((it) => !seen.has(it.link))
    .filter((it) => { const age = (Date.now() - new Date(it.published).getTime()) / 86400000; return Number.isNaN(age) || age <= 10; })
    .filter((it, i, a) => a.findIndex((x) => x.title === it.title) === i)
    .sort((a, b) => relevance(b) - relevance(a));
  const top = fresh[0];
  if (!top || relevance(top) < 2) { console.log(`[news] 適したニュースなし（候補${fresh.length}件）`); return null; }

  const date = new Date().toISOString().slice(0, 10);
  let h = 2166136261; for (const ch of top.link) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const slug = `news-${date.replace(/-/g, "")}-${(h >>> 0).toString(36).slice(0, 5)}`;
  state.keywords.push({
    slug, keyword: `${top.title}｜ニュース解説`, template: "news:commentary", tools: [], kind: "news",
    cluster: "ニュース", score: 95, status: "queued", createdAt: new Date().toISOString(),
    news: top,
  });
  saveState(state);
  log.used.push({ link: top.link, slug, date });
  log.lastRun = date;
  writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
  console.log(`[news] キュー投入: "${top.title}"（${top.source}）`);
  return slug;
}

if (import.meta.url === `file://${process.argv[1]}`) newsRun();

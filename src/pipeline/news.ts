// ROLE: ニュースデスク
//
// 週1本、AI・プログラミング学習・リスキリング業界のニュースを3本選び、
// 「今週のニュースと編集部の見方」というコラム記事の材料を作る。本文は generate.ts の news:weekly が書く。
//
// 【2026-09-11 の作り直し】最初の1本（見出し＋抜粋だけを渡して書かせた）はオーナー評「中身が無さすぎる」。
// 見出しと300字の抜粋から2,000字の解説は書けない。そこで:
//   - 出典サイトの記事本文を取得して（各2,500字まで）、要約と論評の材料として渡す
//   - 1本ではなく3本を束ね、共通する論点をコラムにする
//   - 本文が取れたニュースが2本未満の週は書かない（薄い記事を出すくらいなら休む）
//   - 記事本文の引用は15字まで（著作権）。要約と論評は自分の言葉で書かせる
//   - スクール（アフィリエイト）は関係がある場合だけ触れる。無理に結びつけない
//
// 情報源: 直リンクの RSS（ITmedia AI+ / Ledge.ai / AINOW / Publickey / CodeZine / PR TIMES）と
// Google ニュース検索 RSS（リンクは Google の中継URLなので解決を試みる）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";
import { loadState, saveState } from "../lib/store.js";

const LOG = resolve(paths.data, "news.json");
const UA = "Mozilla/5.0 (compatible; codeschoolnavi-newsdesk/1.0; +https://codeschoolnavi.com/about/)";

const FEEDS = [
  "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",
  "https://ledge.ai/feed/",
  "https://ainow.ai/feed/",
  "https://www.publickey1.jp/atom.xml",
  "https://codezine.jp/rss/new/20/index.xml",
  "https://prtimes.jp/index.rdf",
  // 海外（英語）。AIの一次ニュースは海外発が多く、日本語で「学ぶ人にとっての意味」を書く記事は少ない（2026-09-14 オーナー方針）
  "https://openai.com/news/rss.xml",
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://www.technologyreview.com/topic/artificial-intelligence/feed",
];
const GOOGLE_QUERIES = ["プログラミングスクール", "リスキリング 教育訓練給付", "生成AI 人材育成", "エンジニア 未経験 転職", "生成AI 発表", "AIエージェント 開発者"];
const GOOGLE_QUERIES_EN = ["OpenAI", "Anthropic Claude", "AI coding agents developers", "Google Gemini AI"];

// 見出しにこの語が含まれるものを優先（読者との関連が強い順に重み）
const BOOST: [RegExp, number][] = [
  [/プログラミングスクール|プログラミング教育|コーディング/, 4],
  [/リスキリング|教育訓練給付|学び直し|給付金/, 4],
  [/未経験|転職|求人|採用|人材育成|エンジニア不足/, 3],
  [/生成AI|ChatGPT|Claude|Gemini|Copilot|LLM|AIエージェント/, 2],
  [/Python|AI人材|データサイエン|E資格|G検定/, 2],
  [/エンジニア|開発者|IT人材/, 1],
  // 英語（海外ニュース）
  [/OpenAI|Anthropic|Claude|GPT|Gemini|Copilot|Cursor|DeepSeek|Llama|Mistral|ChatGPT/i, 3],
  [/developer|coding|programmer|engineer|software|jobs|hiring|layoff|junior/i, 2],
  [/agent|model|launch|release|open.?source|benchmark/i, 1],
];
const BLOCK = /株価|決算|逮捕|訴訟|炎上|芸能|選挙|セール|クーポン|割引キャンペーン|IPO|earnings|stock|lawsuit|shares|valuation/i;
export const isEnglish = (s: string) => !/[\u3040-\u30ff\u4e00-\u9faf]/.test(s);

export interface NewsItem { title: string; link: string; source: string; published: string; snippet: string; text?: string }
interface Log { used: { link: string; slug: string; date: string }[]; lastRun?: string }

function loadLog(): Log {
  if (!existsSync(LOG)) return { used: [] };
  try { return JSON.parse(readFileSync(LOG, "utf8")); } catch { return { used: [] }; }
}

function unescapeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}
function decode(s: string): string {
  // RSS の description は HTML がエスケープされて入っていることがある。実体参照を戻してからタグを剥がす。
  const un = unescapeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  return un.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function get(url: string, ms = 15000): Promise<{ url: string; body: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xml,application/rss+xml,*/*" }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return { url: res.url, body: await res.text() };
  } catch { return null; }
}

/** RSS 2.0 / RDF / Atom を雑に読む（依存を増やさない） */
function parseFeed(xml: string, fallbackSource: string): NewsItem[] {
  const out: NewsItem[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);
  const feedTitle = decode((xml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] ?? fallbackSource);
  for (const x of blocks) {
    const pick = (tag: string) => decode((x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] ?? "");
    let link = pick("link");
    if (!link) link = (x.match(/<link[^>]*href="([^"]+)"/) || [])[1] ?? "";
    const title = pick("title").replace(/\s*-\s*[^-]+$/, "");
    const source = pick("source") || feedTitle;
    const published = pick("pubDate") || pick("dc:date") || pick("published") || pick("updated");
    const snippet = (pick("description") || pick("summary") || pick("content")).slice(0, 400);
    if (title && link) out.push({ title, link, source, published, snippet });
  }
  return out;
}

/** Google ニュースの中継URL → 元記事URL。取れなければそのまま返す */
async function resolveLink(link: string): Promise<string> {
  if (!/news\.google\.com/.test(link)) return link;
  // (1) 旧形式: /articles/<base64> の中に元URLがそのまま入っている
  const idm = link.match(/\/(?:articles|rss\/articles)\/([^?/]+)/);
  const id = idm?.[1] ?? "";
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const m = raw.match(/https?:\/\/[^\x00-\x20"'<>]+/);
    if (m && !/google\.com/.test(m[0])) return m[0];
  } catch { /* 新形式 */ }
  // (2) 新形式: 記事ページの署名とタイムスタンプで batchexecute を叩くと元URLが返る
  const r = await get(link);
  if (!r) return link;
  if (!/news\.google\.com/.test(r.url)) return r.url;
  const sg = r.body.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = r.body.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const aid = r.body.match(/data-n-a-id="([^"]+)"/)?.[1] ?? id;
  if (sg && ts) {
    try {
      const req = JSON.stringify([[["Fbv4je", JSON.stringify(["garturlreq", [["X", "X", ["ja-JP", "JP"], null, null, 1, 1, "JP:ja", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]], "ja-JP", "JP", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0], aid, Number(ts), sg]), null, "generic"]]]);
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": UA },
        body: "f.req=" + encodeURIComponent(req),
      });
      clearTimeout(t);
      const txt = await res.text();
      const m = txt.match(/"garturlres","(https?:[^"]+)"/) || txt.match(/https?:\\?\/\\?\/(?!news\.google)[^"\\]+/);
      if (m) return (m[1] ?? m[0]).replace(/\\\//g, "/");
    } catch { /* 失敗したら下へ */ }
  }
  // (3) 最後の手段: ページ内の外部リンク（Google のドメインと画像は除く）
  const m2 = r.body.match(/data-n-au="([^"]+)"/) || r.body.match(/href="(https?:\/\/(?![^"]*google)[^"]+)"/);
  return m2 && !/googleusercontent|gstatic/.test(m2[1]) ? unescapeEntities(m2[1]) : link;
}

/** 記事ページから本文らしいテキストを抜く（<article> があればそこ、無ければ本文の <p> をつなぐ） */
export function extractText(html: string, cap = 2500): string {
  let h = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, "");
  const art = h.match(/<article\b[\s\S]*?<\/article>/i);
  if (art) h = art[0];
  const paras = [...h.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decode(m[1])).filter((t) => t.length >= 30);
  let text = paras.join("\n");
  if (text.length < 300) text = decode(h).slice(0, cap); // <p> の無いサイト向け
  return text.slice(0, cap);
}

/** "Sun, 06 Sep 2026 18:38:44 GMT" → "2026年9月6日" */
function fmtDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function relevance(it: NewsItem): number {
  let s = 0;
  const hay = it.title + " " + it.snippet.slice(0, 120);
  for (const [re, w] of BOOST) if (re.test(hay)) s += w;
  if (BLOCK.test(it.title)) s -= 10;
  const age = (Date.now() - new Date(it.published).getTime()) / 86400000;
  if (!Number.isNaN(age)) s -= Math.min(age, 14) * 0.25;
  return s;
}

/** 本文が無いニュースに本文を足す（generate.ts からも呼ぶ。古い形式の1本ニュースの再生成用） */
export async function enrichItems(items: NewsItem[]): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  for (const it of items) {
    // 本文があっても、リンクが Google の中継や画像のままなら取り直す（2026-09-11 の事故: 画像URLに解決して本文が Google のページになった）
    if (it.text && it.text.length > 300 && !/google/.test(it.link)) { out.push(it); continue; }
    const link = await resolveLink(it.link);
    const page = await get(link);
    const text = page ? extractText(page.body, 4000) : "";
    out.push({ ...it, link, text: text.length >= 300 ? text : "" });
  }
  return out;
}

/**
 * 毎日呼ばれる。ニュース記事（週間コラム news:weekly ／ 1本のニュースへの見解 news:hot）の材料をキューに入れる。
 *
 * 【割合】オーナー方針（2026-09-14）「コラムやホットニュースへの見解の割合をむしろ多い方に」。
 *   直近2本がどちらもニュース記事のときだけ休む → ニュース : それ以外 = 2 : 1 が上限。
 *   材料（本文の取れた記事）が無い日は自然に減る。
 * 【種類】前回の週間コラムから5日以上あいていれば週間コラム（3本束ね）、それ以外は news:hot（1本に見解）。
 */
export async function newsRun(opts: { force?: boolean; mode?: "weekly" | "hot"; minHours?: number } = {}): Promise<string | null> {
  const log = loadLog();
  const state = loadState();
  if (opts.force) console.log("[news] --force: 割合と間隔のチェックを飛ばす");
  if (state.keywords.some((k) => k.template.startsWith("news:") && (k.status === "queued" || k.status === "drafted"))) {
    console.log("[news] 未処理のニュース記事があるためスキップ");
    return null;
  }
  const published = state.keywords.filter((k) => k.status === "published" && k.publishedAt).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  if (opts.minHours) {
    // 速報用 cron（news-hot.yml）: 前回の news:hot から minHours 未満なら休む。割合の門は日次サイクル側で見る
    const lastHot = published.find((k) => k.template === "news:hot")?.publishedAt;
    if (lastHot && Date.now() - new Date(lastHot).getTime() < opts.minHours * 3600000) {
      console.log(`[news] 前回の見解記事から${opts.minHours}時間未満。スキップ`);
      return null;
    }
  } else if (!opts.force && published.length >= 2 && published.slice(0, 2).every((k) => k.template.startsWith("news:"))) {
    console.log("[news] 直近2本がニュース記事。今日は比較・トピック記事に譲る");
    return null;
  }
  const lastWeekly = state.keywords.filter((k) => k.template === "news:weekly" && k.publishedAt).map((k) => k.publishedAt!).sort().pop();
  const weeklyDue = !lastWeekly || Date.now() - new Date(lastWeekly).getTime() >= 5 * 86400000;
  const mode: "weekly" | "hot" = opts.mode ?? (weeklyDue ? "weekly" : "hot");
  console.log(`[news] 種類: ${mode}${lastWeekly ? `（前回の週間コラム ${lastWeekly.slice(0, 10)}）` : ""}`);

  const seen = new Set(log.used.map((u) => u.link));
  const all: NewsItem[] = [];
  for (const f of FEEDS) {
    const r = await get(f);
    if (r) all.push(...parseFeed(r.body, new URL(f).host)); else console.log(`[news] 取得失敗 ${f}`);
  }
  for (const q of GOOGLE_QUERIES) {
    const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`);
    if (r) all.push(...parseFeed(r.body, "Google ニュース"));
  }
  for (const q of GOOGLE_QUERIES_EN) {
    const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}%20when%3A2d&hl=en-US&gl=US&ceid=US:en`);
    if (r) all.push(...parseFeed(r.body, "Google News"));
  }
  const fresh = all
    .filter((it) => !seen.has(it.link))
    .filter((it) => { const age = (Date.now() - new Date(it.published).getTime()) / 86400000; return Number.isNaN(age) || age <= 8; })
    .filter((it, i, a) => a.findIndex((x) => x.title === it.title) === i)
    .filter((it) => relevance(it) >= 3)
    .sort((a, b) => relevance(b) - relevance(a));
  console.log(`[news] 候補 ${fresh.length}件（全${all.length}件）`);

  const grams = (t: string) => { const x = t.replace(/[\s「」『』【】（）()、。・:：\-｜|]/g, ""); const g = new Set<string>(); for (let i = 0; i < x.length - 1; i++) g.add(x.slice(i, i + 2)); return g; };
  const similar = (a: string, b: string) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };
  const isPR = (it: NewsItem) => /prtimes|newscast|atpress|pr\.|プレスリリース/i.test(it.link + " " + it.source);
  // 企業のオウンドメディアの「おすすめ転職エージェント」型（SEO記事）はニュースではない。2026-09-11 に混入
  const isSeo = (it: NewsItem) => /おすすめ|ランキング|徹底比較|転職エージェント|選び方|完全ガイド|まとめ$/.test(it.title) || /\/(career-)?column\/|\/media\/|\/magazine\/|\/lab\//.test(it.link);
  const date = new Date().toISOString().slice(0, 10);
  const slugFor = (key: string) => {
    let h = 2166136261; for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    let slug = `news-${date.replace(/-/g, "")}-${(h >>> 0).toString(36).slice(0, 5)}`;
    if (state.keywords.some((k) => k.slug === slug)) slug += "-" + Date.now().toString(36).slice(-3);
    return slug;
  };

  if (mode === "hot") {
    // 1本に見解を書く。プレスリリースやSEO記事は避け、本文が800字以上取れた最上位のニュースを使う
    const order = [...fresh.filter((it) => !isPR(it) && !isSeo(it)), ...fresh.filter((it) => isPR(it) && !isSeo(it))].slice(0, 12);
    for (const it of order) {
      const [en] = await enrichItems([it]);
      if (!en.text || en.text.length < 800) { console.log(`[news] 本文不足: ${it.title.slice(0, 40)}`); continue; }
      if (seen.has(en.link)) continue;
      const slug = slugFor(en.link);
      state.keywords.push({
        slug, keyword: `ニュースの見方: ${en.title.slice(0, 40)}`,
        template: "news:hot", tools: [], kind: "news", cluster: "ニュース", score: 96, status: "queued", createdAt: new Date().toISOString(),
        news: { title: en.title, link: en.link, source: en.source, published: fmtDate(en.published), snippet: en.snippet, text: en.text } as any,
      });
      saveState(state);
      log.used.push({ link: en.link, slug, date }); if (it.link !== en.link) log.used.push({ link: it.link, slug, date });
      log.lastRun = date;
      writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
      console.log(`[news] キュー投入(hot): 「${en.title.slice(0, 40)}」(${en.source}) 本文${en.text.length}字`);
      return slug;
    }
    console.log("[news] 見解を書けるニュース（本文800字以上）が無い。今日は書かない");
    return null;
  }

  // 上位から本文を取りに行き、本文が取れた3本（媒体は重複させない）を採用
  const picked: (NewsItem & { rssLink: string })[] = [];
  const hosts = new Set<string>();
  let prCount = 0;
  for (const it of fresh.slice(0, 20)) {
    if (picked.length >= 3) break;
    // 同じ話題（同じプレスリリースを複数媒体が載せる）は1本だけ
    if (picked.some((p) => similar(p.title, it.title) > 0.35)) { console.log(`[news] 同じ話題: ${it.title.slice(0, 40)}`); continue; }
    if (isSeo(it)) { console.log(`[news] SEO記事なので除外: ${it.title.slice(0, 40)}`); continue; }
    if (isPR(it) && prCount >= 1) continue; // プレスリリース由来は1本まで（宣伝ばかりにしない）
    const [en] = await enrichItems([it]);
    if (!en.text) { console.log(`[news] 本文なし: ${it.title.slice(0, 40)}`); continue; }
    const host = (() => { try { return new URL(en.link).host; } catch { return en.source; } })();
    if (hosts.has(host)) continue;
    hosts.add(host);
    if (isPR(it)) prCount++;
    picked.push({ ...en, rssLink: it.link, published: fmtDate(en.published) });
  }
  if (picked.length < 2) { console.log(`[news] 本文が取れたニュースが${picked.length}本。今週は書かない`); return null; }

  const slug = slugFor(picked.map((p) => p.link).join("|"));
  state.keywords.push({
    slug, keyword: `今週のAI・プログラミング学習ニュースと編集部の見方（${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}）`,
    template: "news:weekly", tools: [], kind: "news", cluster: "ニュース", score: 95, status: "queued", createdAt: new Date().toISOString(),
    news: { items: picked.map(({ rssLink, ...rest }) => rest) } as any,
  });
  saveState(state);
  for (const p of picked) { log.used.push({ link: p.link, slug, date }); if (p.rssLink !== p.link) log.used.push({ link: p.rssLink, slug, date }); }
  log.lastRun = date;
  writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
  console.log(`[news] キュー投入: ${picked.map((p) => `「${p.title.slice(0, 30)}」(${p.source})`).join(" / ")}`);
  return slug;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = process.argv.find((a) => a === "--hot" || a === "--weekly");
  const mh = process.argv.find((a) => a.startsWith("--min-hours="));
  newsRun({ force: process.argv.includes("--force"), mode: m === "--hot" ? "hot" : m === "--weekly" ? "weekly" : undefined, minHours: mh ? Number(mh.split("=")[1]) : undefined });
}

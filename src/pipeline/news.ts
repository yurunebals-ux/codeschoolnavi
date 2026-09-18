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
import { chat, isOffline } from "../lib/llm.js";

const LOG = resolve(paths.data, "news.json");
const UA = "Mozilla/5.0 (compatible; codeschoolnavi-newsdesk/1.0; +https://codeschoolnavi.com/about/)";

const FEEDS = [
  "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",
  "https://ledge.ai/feed/",
  "https://ainow.ai/feed/",
  "https://www.publickey1.jp/atom.xml",
  "https://codezine.jp/rss/new/20/index.xml",
  "https://prtimes.jp/index.rdf",
  // はてなブックマークの人気エントリー（IT）。ブックマークが多い＝反応（コメント）が取れる記事が並ぶ（まとめサイト向き）
  "https://b.hatena.ne.jp/hotentry/it.rss",
  // 一般向け（オーナー 2026-09-18「専門的すぎる。もっとライトな内容を」）: 総合の人気エントリー、Yahoo!ニュースIT、ITmedia NEWS
  "https://b.hatena.ne.jp/hotentry.rss",
  "https://news.yahoo.co.jp/rss/categories/it.xml",
  "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml",
  "https://b.hatena.ne.jp/q/%E7%94%9F%E6%88%90AI?mode=rss&sort=recent",
  "https://b.hatena.ne.jp/q/%E3%83%97%E3%83%AD%E3%82%B0%E3%83%A9%E3%83%9F%E3%83%B3%E3%82%B0%E3%82%B9%E3%82%AF%E3%83%BC%E3%83%AB?mode=rss&sort=recent",
  // 海外（英語）。AIの一次ニュースは海外発が多く、日本語で「学ぶ人にとっての意味」を書く記事は少ない（2026-09-14 オーナー方針）
  "https://openai.com/news/rss.xml",
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://www.technologyreview.com/topic/artificial-intelligence/feed",
];
const GOOGLE_QUERIES = ["プログラミングスクール", "リスキリング 教育訓練給付", "生成AI 人材育成", "エンジニア 未経験 転職", "ChatGPT 使い方 仕事", "AI 仕事 なくなる", "AI 副業", "AI 資格", "生成AI 新入社員", "AI 学校 授業"];
const GOOGLE_QUERIES_EN = ["OpenAI", "Anthropic Claude", "AI coding agents developers", "Google Gemini AI"];

// 見出しにこの語が含まれるものを優先（読者との関連が強い順に重み）
const BOOST: [RegExp, number][] = [
  // 一般の社会人・学生に近い話題を最優先（2026-09-18）
  [/仕事|働き方|転職|採用|求人|給料|年収|副業|学び直し|勉強|資格|教育|学生|新卒|授業|使い方|値上げ|料金|無料|規制|法律|禁止|話題|人気|初心者|未経験|できる人|できない人/, 4],
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
const BLOCK = /株価|決算|逮捕|訴訟|炎上|芸能|選挙|セール|クーポン|割引キャンペーン|IPO|earnings|stock|lawsuit|shares|valuation|軍事|兵器|ミサイル|戦争|武装|テロ|missile|weapon|military|warfare|terror|drone strike|deepfake|porn|sexual|suicide|self-harm|election|政治|政党/i;
// 読者（これから学ぶ人）から遠い、深い技術ネタは減点（はてブ人気エントリーは GPU 自作や量子化の話が多い。2026-09-14 に DeepSeek×A100 の記事を書いた）
const TOO_DEEP = /GPU|CUDA|FP\d|tok\/s|\d+ms|カーネル|量子化|VRAM|自作PC|ベンチマーク|Rust|C\+\+|Kubernetes|k8s|アーキテクチャ|コンパイラ|推論サーバ|Linux|メモリ帯域|TFLOPS|API|SDK|MCP|CLI|ターミナル|ライブラリ|フレームワーク|プロトコル|トークン|レイテンシ|型付け|TypeScript|リポジトリ|OSS|プルリク|ハーネス|エージェント設計|RAG|ファインチューニング|LLMの|モデル評価/i;
// 英語ニュースは媒体を絞る（Google News 英語検索は無名サイトも拾う。2026-09-14 に quasa.io の兵器ネタが混入）
const TRUSTED_EN = /(^|\.)(techcrunch\.com|openai\.com|anthropic\.com|technologyreview\.com|theverge\.com|arstechnica\.com|wired\.com|reuters\.com|bloomberg\.com|nytimes\.com|ft\.com|venturebeat\.com|zdnet\.com|github\.blog|blog\.google|deepmind\.google|microsoft\.com|theinformation\.com|axios\.com|cnbc\.com|bbc\.com|theguardian\.com|stackoverflow\.blog|infoq\.com|thenewstack\.io)$/i;
// 英語ニュースは「学ぶ人・働く人」に関係する語が無ければ扱わない（モデル発表だけの記事は多すぎる）
const EN_RELEVANT = /developer|coding|code|programmer|engineer|software|jobs?|hiring|layoff|junior|learn|student|education|skills?|career|workforce|entry.level|bootcamp|copilot|agent/i;
export const isEnglish = (s: string) => !/[\u3040-\u30ff\u4e00-\u9faf]/.test(s);

export interface NewsItem { title: string; link: string; source: string; published: string; snippet: string; text?: string; bookmarks?: number }
interface Log { used: { link: string; slug: string; date: string }[]; lastRun?: string }

function loadLog(): Log {
  if (!existsSync(LOG)) return { used: [] };
  try { return JSON.parse(readFileSync(LOG, "utf8")); } catch { return { used: [] }; }
}

function unescapeEntities(s: string): string {
  // はてなブックマークのフィードは日本語を &#x4E07; のような16進の実体参照で書く（2026-09-14 実測）
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}
function decode(s: string): string {
  // RSS の description は HTML がエスケープされて入っていることがある。実体参照を戻してからタグを剥がす。
  const un = unescapeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  return un.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

let lastErr = "";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
async function get(url: string, ms = 15000, accept = "text/html,application/xml,application/rss+xml,*/*", ua = UA): Promise<{ url: string; body: string } | null> {
  lastErr = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { headers: { "user-agent": ua, accept, "accept-language": "ja,en;q=0.8" }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) { lastErr = `HTTP ${res.status}`; return null; }
    return { url: res.url, body: await res.text() };
  } catch (e) { lastErr = String((e as Error).message ?? e).slice(0, 60); return null; }
}

/** 媒体名の後始末。「ITmedia AI＋ 最新記事一覧」のようなフィード題名が出典に出ていた（2026-09-14） */
function cleanSource(s: string): string {
  return s.replace(/\s*[-－–|｜:：]?\s*(最新記事一覧|新着記事一覧|新着記事|記事一覧|RSS.*|フィード.*|Feed.*|News Feed.*)$/i, "").replace(/\s+/g, " ").trim().slice(0, 30) || s;
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
    const source = cleanSource(pick("source") || feedTitle);
    const published = pick("pubDate") || pick("dc:date") || pick("published") || pick("updated");
    const snippet = (pick("description") || pick("summary") || pick("content")).slice(0, 400);
    // はてなブックマークのフィードは元記事のURLが link で、ブクマ数が hatena:bookmarkcount に入る（反応の多さの目安）
    const bm = Number(pick("hatena:bookmarkcount") || 0) || undefined;
    const src = /はてなブックマーク/.test(source) ? hostOf(link) || source : source;
    if (title && link) out.push({ title, link, source: src, published, snippet, bookmarks: bm });
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

// ---- ネットの反応（コメント）を拾う。「ニュースに対するコメントも拾ってまとめサイトのように」（オーナー 2026-09-14）----
// 使うのは公開APIだけ: はてなブックマーク（エントリー情報API）、Hacker News（Algolia API）、Bluesky（公開API）、Reddit（JSON）。
// X（旧Twitter）とYahoo!コメントは API が有料／規約上不可なので使わない。
// 掲載は「要約＋40字以内の短い引用（出所明示）」に限り、ユーザー名は出さない（引用の要件と、個人を晒さないため）。
export interface Reactions { threads: { platform: string; url: string; count: number }[]; comments: { platform: string; text: string; likes?: number }[] }

async function getJson(url: string, ms = 12000, ua = UA): Promise<any | null> {
  const r = await get(url, ms, "application/json", ua);
  if (!r) return null;
  try { return JSON.parse(r.body); } catch { lastErr = "JSONではない"; return null; }
}
const cleanComment = (t: string) => decode(t).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
// 中傷・罵倒を含むコメントは材料に入れない（1本目で「何やってんだこいつ」が引用された。2026-09-14）
const ABUSE = /こいつ|バカ|馬鹿|アホ|クズ|クソ|糞|死ね|キモ|気持ち悪|頭悪|無能|ゴミ|カス|老害|情弱|信者|工作員|写真|顔|容姿|見た目|太っ|ハゲ|ブス|ブサ|idiot|stupid|moron|dumb|scam|garbage|trash|ugly/i; // 容姿・写真への言及も外す（2026-09-17 に登壇者の写真を揶揄するコメントが載った）
const okComment = (t: string) => t.length >= 8 && !ABUSE.test(t);

export async function fetchReactions(link: string, title: string): Promise<Reactions> {
  const out: Reactions = { threads: [], comments: [] };
  // はてなブックマーク
  const hb = await getJson(`https://b.hatena.ne.jp/entry/jsonlite/?url=${encodeURIComponent(link)}`);
  // ブックマークが無いエントリーは API が literal null を返す（失敗ではない）
  console.log(`[news]   はてブ: ${hb ? `${hb.count ?? 0}件（コメント付き${(hb.bookmarks ?? []).filter((b: any) => (b.comment ?? "").length >= 8).length}）` : lastErr ? `取得失敗(${lastErr})` : "0件"}`);
  if (hb && Array.isArray(hb.bookmarks)) {
    const cs = hb.bookmarks.map((b: any) => cleanComment(b.comment ?? "")).filter(okComment);
    if (cs.length) {
      out.threads.push({ platform: "はてなブックマーク", url: hb.entry_url ?? `https://b.hatena.ne.jp/entry/s/${link.replace(/^https?:\/\//, "")}`, count: Number(hb.count ?? cs.length) });
      out.comments.push(...cs.slice(0, 15).map((text: string) => ({ platform: "はてなブックマーク", text })));
    }
  }
  // Hacker News
  const hn = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(link)}&restrictSearchableAttributes=url&tags=story&hitsPerPage=3`);
  const hit = hn?.hits?.sort((a: any, b: any) => (b.num_comments ?? 0) - (a.num_comments ?? 0))[0];
  console.log(`[news]   HN: ${hn ? (hit ? `${hit.num_comments ?? 0}件` : "該当なし") : `取得失敗(${lastErr})`}`);
  if (hit && (hit.num_comments ?? 0) > 0) {
    const item = await getJson(`https://hn.algolia.com/api/v1/items/${hit.objectID}`);
    const cs = (item?.children ?? []).map((c: any) => cleanComment(c.text ?? "")).filter((c: string) => c.length >= 20 && okComment(c));
    if (cs.length) {
      out.threads.push({ platform: "Hacker News", url: `https://news.ycombinator.com/item?id=${hit.objectID}`, count: hit.num_comments });
      out.comments.push(...cs.slice(0, 12).map((text: string) => ({ platform: "Hacker News", text })));
    }
  }
  // Bluesky（URL と見出しの両方で検索）。GitHub Actions からは HTTP 403（2026-09-14 実測）なので既定では呼ばない
  for (const q of process.env.NEWS_BLUESKY ? [link, title.slice(0, 40)] : []) {
    const bs = await getJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25`, 12000, BROWSER_UA);
    const posts = (bs?.posts ?? []).filter((p: any) => (p.record?.text ?? "").length >= 20);
    console.log(`[news]   Bluesky(${q.slice(0, 20)}…): ${bs ? `${posts.length}件` : `取得失敗(${lastErr})`}`);
    if (!posts.length) continue;
    const seenT = new Set(out.comments.map((c) => c.text));
    const cs = posts
      .map((p: any) => ({ platform: "Bluesky", text: cleanComment(p.record.text), likes: Number(p.likeCount ?? 0) }))
      .filter((c: any) => c.text.length >= 12 && okComment(c.text) && !seenT.has(c.text))
      .sort((a: any, b: any) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 10);
    if (cs.length) {
      if (!out.threads.some((t) => t.platform === "Bluesky")) out.threads.push({ platform: "Bluesky", url: `https://bsky.app/search?q=${encodeURIComponent(q)}`, count: posts.length });
      out.comments.push(...cs);
    }
    if (out.comments.filter((c) => c.platform === "Bluesky").length >= 5) break;
  }
  // Reddit（GitHub Actions からは HTTP 403。既定では呼ばない）
  const rd = process.env.NEWS_REDDIT ? await getJson(`https://www.reddit.com/search.json?q=url%3A${encodeURIComponent(link)}&sort=comments&limit=3`) : null;
  const post = rd?.data?.children?.map((c: any) => c.data).sort((a: any, b: any) => (b.num_comments ?? 0) - (a.num_comments ?? 0))[0];
  if (process.env.NEWS_REDDIT) console.log(`[news]   Reddit: ${rd ? (post ? `${post.num_comments ?? 0}件` : "該当なし") : `取得失敗(${lastErr})`}`);
  if (post && (post.num_comments ?? 0) > 0 && post.permalink) {
    const th = await getJson(`https://www.reddit.com${post.permalink}.json?limit=20`);
    const cs = (th?.[1]?.data?.children ?? []).map((c: any) => c.data).filter((d: any) => d.body && d.body.length >= 20 && okComment(d.body))
      .map((d: any) => ({ platform: "Reddit", text: cleanComment(d.body), likes: Number(d.score ?? 0) }))
      .sort((a: any, b: any) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 10);
    if (cs.length) {
      out.threads.push({ platform: "Reddit", url: `https://www.reddit.com${post.permalink}`, count: post.num_comments });
      out.comments.push(...cs);
    }
  }
  return out;
}

/** 見出しを「プログラミングを学ぼうか迷っている一般の社会人・学生が読んで、内容が想像でき、自分に関係あると思えるか」で採点し、7点以上だけ残す */
async function keepLight(items: NewsItem[]): Promise<NewsItem[]> {
  if (isOffline() || items.length < 3) return items;
  try {
    const r = await chat(
      `次のニュース見出しを、「プログラミングやAIを学ぼうか迷っている一般の社会人・学生」が読んで (a) 何の話かすぐ想像できる (b) 自分の仕事・学び・お金・暮らしに関係あると感じて人に話したくなる、の2点で10点満点で採点する。「AIを使ってみたらこうなった」という体験談、職場や学校でのAIの出来事、AIで仕事や給料がどう変わるかの話は高得点。専門用語（API、ハーネス、量子化、ベンチマーク、GPU等）が中心の見出し、開発者だけに向いた見出し、製品の機能一覧やハウツー記事は3点以下。出力は「番号: 点数」を1行ずつ、他は書かない。\n\n${items.map((it, i) => `${i + 1}: ${it.title.slice(0, 80)}`).join("\n")}`,
      { maxTokens: 400, temperature: 0 });
    const score = new Map<number, number>();
    for (const m of r.matchAll(/(\d+)\s*[:：]\s*(\d+(?:\.\d+)?)/g)) score.set(Number(m[1]) - 1, Number(m[2]));
    // 7点以上を残し、点が高い順（同点は元の関連度順）に並べ替える。0反応のPR記事で候補枠を使い切らないため
    const kept = items.map((it, i) => ({ it, i, sc: score.get(i) ?? 0 })).filter((x) => x.sc >= 7).sort((a, b) => b.sc - a.sc || a.i - b.i).map((x) => x.it);
    console.log(`[news] ライト判定: ${kept.length}/${items.length} 本が一般向け（7点以上）`);
    for (const [i, sc] of [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`[news]   ${sc}点 「${items[i]?.title.slice(0, 40)}」`);
    return kept.length ? kept : items.slice(0, 5);
  } catch (e) { console.log("[news] ライト判定に失敗。全候補を使う:", (e as Error).message); return items; }
}

const hostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

function relevance(it: NewsItem): number {
  let s = 0;
  const hay = it.title + " " + it.snippet.slice(0, 120);
  for (const [re, w] of BOOST) if (re.test(hay)) s += w;
  if (BLOCK.test(it.title) || BLOCK.test(it.snippet.slice(0, 200))) s -= 10;
  if (isEnglish(it.title) && !EN_RELEVANT.test(hay)) s -= 10;
  if (it.bookmarks) s += Math.min(it.bookmarks / 25, 4); // 反応が多い記事を優先（100ブクマで+4）
  if (TOO_DEEP.test(it.title)) s -= 6; // 専門的すぎる話題は強く下げる（2026-09-18）
  // 総合の人気エントリーや Yahoo!ニュースを入れたので、AI・IT・学びの軸が無い話題（転職一般、社会ニュース）は落とす
  if (!/AI|人工知能|生成|ChatGPT|Claude|Gemini|Copilot|プログラミング|エンジニア|コード|IT|デジタル|DX|スクール|リスキリング|データ|ロボット|自動化/i.test(hay)) s -= 10;
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
    let page = await get(link);
    if (!page) page = await get(link, 15000, undefined, BROWSER_UA); // ボット UA を弾くサイト向け
    let text = page ? extractText(page.body, 4000) : "";
    if (text.length < 300) {
      // JS描画・Cloudflare で本文が取れないサイトは、レンダリング代行（r.jina.ai、無料・キー不要）を経由して読む
      const jr = await get(`https://r.jina.ai/${link}`, 25000, "text/plain");
      if (jr && jr.body.length >= 300) text = jr.body.replace(/^Title:.*\n|^URL Source:.*\n|^Markdown Content:\n/gm, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
    }
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
export async function newsRun(opts: { force?: boolean; mode?: "weekly" | "hot"; minHours?: number; dry?: boolean } = {}): Promise<string | null> {
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
  for (const it of fresh.slice(0, 12)) console.log(`[news]   ${relevance(it).toFixed(1)} ${it.bookmarks ? `☆${it.bookmarks} ` : ""}${hostOf(it.link) || it.source} 「${it.title.slice(0, 40)}」`);
  // 既に記事にしたニュースと同じ話題（別媒体の同じプレスリリース等）は使わない
  const usedTitles = state.keywords.filter((k) => k.template.startsWith("news:")).flatMap((k) => [k.news?.title, ...(k.news?.items ?? []).map((i) => i.title)]).filter((t): t is string => !!t);

  const grams = (t: string) => { const x = t.replace(/[\s「」『』【】（）()、。・:：\-｜|]/g, ""); const g = new Set<string>(); for (let i = 0; i < x.length - 1; i++) g.add(x.slice(i, i + 2)); return g; };
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const similar = (a: string, b: string) => {
    // 英語同士は単語で比べる（2-gram だと「Claude」「developers」だけで似ていると判定した）
    if (isEnglish(a) && isEnglish(b)) { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)) * 0.6; }
    if (isEnglish(a) !== isEnglish(b)) return 0;
    const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / Math.max(1, Math.min(A.size, B.size));
  };
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
    let order = [...fresh.filter((it) => !isPR(it) && !isSeo(it)), ...fresh.filter((it) => isPR(it) && !isSeo(it))].slice(0, 30);
    // 見出しの「一般の社会人が読んで分かるか」をLLMに採点させ、専門的すぎるものを落とす（オーナー 2026-09-18）
    order = await keepLight(order);
    // 本文が取れた候補を最大8本まで集め、ネットの反応が多いものを優先する（「まとめサイトのように」）。
    const cands: { it: NewsItem; en: NewsItem; rx: Reactions; rank: number }[] = [];
    for (const it of order) {
      if (cands.length >= 8) break;
      const [en] = await enrichItems([it]);
      if (usedTitles.some((t) => similar(t, it.title) > 0.35)) { console.log(`[news] 既出の話題: ${it.title.slice(0, 40)}`); continue; }
      if (!en.text || en.text.length < 800) { console.log(`[news] 本文不足(${en.text?.length ?? 0}字 ${hostOf(en.link)}${lastErr ? " " + lastErr : ""}): ${it.title.slice(0, 40)}`); continue; }
      if (seen.has(en.link)) continue;
      // 英語かどうかは見出しではなく本文で判定（Qiita や GIGAZINE の英字だけの見出しを海外扱いしていた）
      if (isEnglish(en.text.slice(0, 300)) && !TRUSTED_EN.test(hostOf(en.link))) { console.log(`[news] 英語の無名媒体は使わない: ${hostOf(en.link)}`); continue; }
      if (BLOCK.test(en.text.slice(0, 1500))) { console.log(`[news] 本文に扱わない話題: ${it.title.slice(0, 40)}`); continue; }
      const rx = await fetchReactions(en.link, en.title).catch(() => ({ threads: [], comments: [] } as Reactions));
      console.log(`[news] 候補: 「${it.title.slice(0, 36)}」 反応${rx.comments.length}件（${rx.threads.map((t) => `${t.platform}${t.count}`).join("・") || "なし"}）`);
      cands.push({ it, en, rx, rank: cands.length });
    }
    // まとめ風の記事にするので、反応が5件以上ある候補だけ（最多のもの）。無ければ今日は書かない（オーナー 2026-09-17）
    const withRx = cands.filter((c) => c.rx.comments.length >= 5).sort((a, b) => b.rx.comments.length - a.rx.comments.length || a.rank - b.rank);
    const best = withRx[0];
    if (!best && cands.length) console.log(`[news] 反応が5件以上あるニュースが無い（候補${cands.length}本）。今日は書かない`);
    if (opts.dry) { console.log(`[news] --dry: 候補${cands.length}本を評価しただけで終了（キューに入れない）`); return null; }
    if (best) {
      const { it, en, rx } = best;
      const slug = slugFor(en.link);
      state.keywords.push({
        slug, keyword: `ニュースの見方: ${en.title.slice(0, 40)}`,
        template: "news:hot", tools: [], kind: "news", cluster: "ニュース", score: 96, status: "queued", createdAt: new Date().toISOString(),
        news: { title: en.title, link: en.link, source: en.source, published: fmtDate(en.published), snippet: en.snippet, text: en.text, reactions: rx.comments.length ? rx : undefined },
      });
      saveState(state);
      log.used.push({ link: en.link, slug, date }); if (it.link !== en.link) log.used.push({ link: it.link, slug, date });
      log.lastRun = date;
      writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
      console.log(`[news] キュー投入(hot): 「${en.title.slice(0, 40)}」(${en.source}) 本文${en.text?.length ?? 0}字 反応${rx.comments.length}件`);
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
    const host = hostOf(en.link) || en.source;
    if (hosts.has(host)) continue;
    if (isEnglish((en.text ?? "").slice(0, 300)) && !TRUSTED_EN.test(host)) { console.log(`[news] 英語の無名媒体は使わない: ${host}`); continue; }
    if (usedTitles.some((t) => similar(t, it.title) > 0.35)) { console.log(`[news] 既出の話題: ${it.title.slice(0, 40)}`); continue; }
    if (BLOCK.test(en.text.slice(0, 1500))) continue;
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
  newsRun({ force: process.argv.includes("--force"), mode: m === "--hot" ? "hot" : m === "--weekly" ? "weekly" : undefined, minHours: mh ? Number(mh.split("=")[1]) : undefined, dry: process.argv.includes("--dry") });
}

// 新着記事を X に自動投稿する（2026-09-26 オーナー決定: リンク付きを1日3本）
// X API は 2026年2月から従量課金。リンク付きの投稿は1件約0.20ドル。費用を抑えるため:
//   - 1回の実行で最大1本（x-post.yml が1日3回動く → 1日最大3本）
//   - 月の上限（X_MONTHLY_MAX、既定90本）を data/x-posted.json の記録で数えて超えない
//   - 自分のタイムラインは読まない（読み取りも課金されるため）。重複防止は data/x-posted.json で行う
// 選ぶ記事: 公開2日以内・未投稿のうち、読み物（topic）→ 反応の多いニュース → 新しい順。広告記事（スクール比較）は後回し
// 必要な環境変数: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET（GitHub Secrets）。無ければ何もしない
// --dry: 投稿せず、選んだ記事と本文を表示する
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const K = process.env.X_API_KEY, KS = process.env.X_API_SECRET, T = process.env.X_ACCESS_TOKEN, TS = process.env.X_ACCESS_SECRET;
const SITE = (process.env.SITE_URL || "https://codeschoolnavi.com").replace(/\/$/, "");
const DAYS = Number(process.env.X_DAYS || 2);
const MONTHLY_MAX = Number(process.env.X_MONTHLY_MAX || 90);
const DRY = process.argv.includes("--dry");
const root = new URL("../../", import.meta.url).pathname;
const blogDir = join(root, "site/src/content/blog");
const logFile = join(root, "data/x-posted.json");

if (!DRY && !(K && KS && T && TS)) { console.log("[x] X_API_KEY などが未設定。スキップ"); process.exit(0); }

const log = existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : { posts: [] };
const posted = new Set(log.posts.map((p) => p.slug));
const month = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
const thisMonth = log.posts.filter((p) => (p.at || "").startsWith(month)).length;
if (thisMonth >= MONTHLY_MAX) { console.log(`[x] 今月は ${thisMonth} 本投稿済み（上限 ${MONTHLY_MAX}）。スキップ`); process.exit(0); }

const fm = (src, key) => { const m = src.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m")); return m ? m[1].replace(/\\"/g, '"') : ""; };
const now = Date.now();
const cands = readdirSync(blogDir).filter((f) => f.endsWith(".md")).map((f) => {
  const src = readFileSync(join(blogDir, f), "utf8");
  return { slug: f.replace(/\.md$/, ""), title: fm(src, "title"), description: fm(src, "description"), pubDate: fm(src, "pubDate"), draft: fm(src, "draft") === "true", news: fm(src, "news") === "true", topic: fm(src, "topic") === "true", reactions: Number(fm(src, "reactions") || 0) };
}).filter((p) => !p.draft && p.title && p.pubDate && !posted.has(p.slug) && now - new Date(p.pubDate + "T00:00:00+09:00").getTime() < DAYS * 86400000);
if (!cands.length) { console.log("[x] 未投稿の新着なし"); process.exit(0); }
const rank = (p) => (p.topic ? 3 : p.news ? 2 : 0) * 1000 + Math.min(p.reactions, 999);
cands.sort((a, b) => rank(b) - rank(a) || b.pubDate.localeCompare(a.pubDate));
const p = cands[0];
const url = `${SITE}/blog/${p.slug}/`;

// X の文字数: 日本語などは2、ASCII等は1、URL は一律23。上限280
const weight = (s) => [...s].reduce((n, ch) => { const c = ch.codePointAt(0); return n + ((c <= 0x10ff) || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037) ? 1 : 2); }, 0);
const cut = (s, max) => { let out = ""; for (const ch of s) { if (weight(out + ch + "…") > max) return out + "…"; out += ch; } return out; };
const label = p.news ? "【AIニュースまとめ】" : p.topic ? "【学び・キャリア】" : "【スクール比較】";
const tags = p.news ? "#AIニュース #生成AI" : "#プログラミング学習 #リスキリング";
const head = `${label}${p.title}`;
const fixed = weight(head) + 2 + 2 + 23 + 2 + weight(tags); // 改行ぶんを含む
const room = 278 - fixed;
const text = `${head}\n\n${room > 30 ? cut(p.description, room) + "\n\n" : ""}${url}\n\n${tags}`;
console.log(`[x] 選んだ記事: ${p.slug}（今月 ${thisMonth} 本目の次）\n${text}\n（${weight(text) - weight(url) + 23} / 280）`);
if (DRY) process.exit(0);

// 公開されているか確認（デプロイ前の記事を投稿しない）
const live = await fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
if (!live) { console.log(`[x] まだ公開されていない: ${url}。次の回に回す`); process.exit(0); }

// OAuth 1.0a（ユーザー文脈）で POST /2/tweets
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export function oauthHeader(method, endpoint, extra, keys, nonce = crypto.randomBytes(16).toString("hex"), ts = Math.floor(Date.now() / 1000).toString()) {
  const o = { oauth_consumer_key: keys.K, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: ts, oauth_token: keys.T, oauth_version: "1.0" };
  const all = { ...extra, ...o };
  const params = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join("&");
  const base = `${method.toUpperCase()}&${enc(endpoint)}&${enc(params)}`;
  o.oauth_signature = crypto.createHmac("sha1", `${enc(keys.KS)}&${enc(keys.TS)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(", ");
}
const endpoint = "https://api.x.com/2/tweets";
const res = await fetch(endpoint, { method: "POST", headers: { Authorization: oauthHeader("POST", endpoint, {}, { K, KS, T, TS }), "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
const body = await res.text();
if (!res.ok) {
  console.log(`[x] 投稿失敗 ${res.status}: ${body.slice(0, 300)}`);
  // 402（残高不足）や 403（権限）でもワークフロー全体は止めない。記録はしない（次回また試す）
  process.exit(0);
}
const id = JSON.parse(body)?.data?.id;
log.posts.push({ slug: p.slug, id, at: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") });
log.posts = log.posts.slice(-400);
writeFileSync(logFile, JSON.stringify(log, null, 2) + "\n");
console.log(`[x] 投稿 ${p.slug} → https://x.com/i/status/${id}`);

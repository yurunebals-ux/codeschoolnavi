// X のワンタップ投稿（/x-today/）に添える「1〜2行の自然なひとこと」を作る（2026-09-26 オーナー依頼）
// - 対象: 公開3日以内でまだひとことが無い記事（1回最大8本）
// - 保存先: site/src/data/x-comments.json（{ slug: { comment, at } }）。記事ファイルは触らない
// - 書き手は gpt-4.1-mini（LLM_API_KEY）。サイト運営者の目線で、記事の中身だけを根拠に書く。
//   体験の捏造（「使ってみたら」など）・本文にない数字・煽り・ハッシュタグ・URL・絵文字の多用はさせず、機械的にも弾く
// 必要な環境変数: LLM_API_KEY（無ければ何もしない）。--dry で保存せず表示だけ
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL || "gpt-4.1-mini";
const BASE = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DAYS = Number(process.env.XC_DAYS || 3);
const MAX = Number(process.env.XC_MAX || 8);
const DRY = process.argv.includes("--dry");
const root = new URL("../", import.meta.url).pathname; // site/
const blogDir = join(root, "src/content/blog");
const outFile = join(root, "src/data/x-comments.json");
if (!KEY) { console.log("[xc] LLM_API_KEY が未設定。スキップ"); process.exit(0); }

const store = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const fm = (src, key) => { const m = src.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m")); return m ? m[1].replace(/\\"/g, '"') : ""; };
const now = Date.now();
const todo = readdirSync(blogDir).filter((f) => f.endsWith(".md")).map((f) => {
  const src = readFileSync(join(blogDir, f), "utf8");
  const body = src.replace(/^---[\s\S]*?---/, "").replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`|-]+/g, " ").replace(/\s+/g, " ").trim();
  return { slug: f.replace(/\.md$/, ""), title: fm(src, "title"), description: fm(src, "description"), pubDate: fm(src, "pubDate"), draft: fm(src, "draft") === "true", news: fm(src, "news") === "true", topic: fm(src, "topic") === "true", body: body.slice(0, 1500) };
}).filter((p) => !p.draft && p.title && p.pubDate && !store[p.slug] && now - new Date(p.pubDate + "T00:00:00+09:00").getTime() < DAYS * 86400000)
  .sort((a, b) => b.pubDate.localeCompare(a.pubDate)).slice(0, MAX);
if (!todo.length) { console.log("[xc] 新しく作る記事なし"); process.exit(0); }

const SYSTEM = `あなたは、AIニュースのまとめとプログラミングスクール比較のサイト「コードスクールナビ」の運営者として、Xに記事を紹介するときに添える「ひとこと」を書きます。
条件:
- 日本語で1〜2文、全体で60文字以内。友人に話すような自然な口調（です・ます調でも、くだけすぎない話し言葉でもよい）
- 記事の中でいちばん気になる点・意外な点・読む人に関係する点を、自分の感想として短く言う。問いかけで終わってもよい
- 与えられた記事の内容だけを根拠にする。記事にない数字・固有名詞・事実を足さない
- 自分が使った・受講した・体験した、といった体験談を作らない（運営者は記事を読んだ立場で話す）
- 誇張・煽り（「ヤバい」「衝撃」「絶対」「必見」など）、断定的な悪口、宣伝文句は使わない
- ハッシュタグ・URL・「記事はこちら」などの誘導文は書かない。絵文字は使わない
出力は JSON で {"comment":"..."} のみ。`;

const bad = /https?:|www\.|#|＃|記事はこちら|詳しくは|リンク|衝撃|ヤバ|やば|必見|絶対|使ってみ|受講して|試してみたら|私も使|僕も使/;
async function ask(p) {
  const user = `記事の種類: ${p.news ? "AIニュースのまとめ（ネットの反応つき）" : p.topic ? "学び・キャリアの読み物" : "プログラミングスクールの比較記事"}\nタイトル: ${p.title}\n説明: ${p.description}\n本文の冒頭: ${p.body}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0.8, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    });
    if (!r.ok) { console.log(`[xc] API ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
    const j = await r.json();
    let c = "";
    try { c = String(JSON.parse(j.choices[0].message.content).comment || ""); } catch { continue; }
    c = c.replace(/^["「『]|["」』]$/g, "").replace(/\s*\n\s*/g, "\n").trim();
    const len = [...c.replace(/\n/g, "")].length;
    if (len >= 8 && len <= 70 && !bad.test(c) && !/\p{Extended_Pictographic}/u.test(c)) return c;
    console.log(`[xc] 条件外のため作り直し（${len}字）: ${c}`);
  }
  return null;
}

let made = 0;
for (const p of todo) {
  const c = await ask(p);
  if (!c) continue;
  console.log(`[xc] ${p.slug}: ${c}`);
  store[p.slug] = { comment: c, at: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") };
  made++;
}
// 古いもの（60日より前）は掃除して、ファイルを小さく保つ
const cutoff = new Date(Date.now() - 60 * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
for (const [k, v] of Object.entries(store)) if ((v.at || "").slice(0, 10) < cutoff) delete store[k];
if (!DRY && made) writeFileSync(outFile, JSON.stringify(store, null, 2) + "\n");
console.log(`[xc] 作成 ${made} 本${DRY ? "（--dry のため保存せず）" : ""}`);

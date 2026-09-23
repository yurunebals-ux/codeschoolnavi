// 新着記事を Bluesky に自動投稿する（デプロイ後に実行。2026-09-23 アクセス特化）
// - 対象: 公開日が直近2日以内の記事（ニュース・読み物・スクール記事すべて）
// - 重複防止: 自分の直近100投稿のリンクカード（embed.external.uri）と突き合わせ、未投稿の記事だけ出す。状態ファイルは持たない
// - 1回のデプロイで最大3本（古い順）。デプロイは1日に何度も走るので、自然に分散される
// - 画像: 本番ページの og:image（記事ごとの OGP 画像）をリンクカードのサムネイルにする
// 必要な環境変数: BSKY_HANDLE（例 codeschoolnavi.bsky.social）, BSKY_APP_PASSWORD（GitHub Secrets）。無ければ何もしない
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HANDLE = process.env.BSKY_HANDLE;
const PASS = process.env.BSKY_APP_PASSWORD;
const PDS = process.env.BSKY_PDS || "https://bsky.social";
const SITE = (process.env.SITE_URL || "https://codeschoolnavi.com").replace(/\/$/, "");
const MAX = Number(process.env.BSKY_MAX || 3);
const DAYS = Number(process.env.BSKY_DAYS || 2);
const DRY = process.argv.includes("--dry");

if (!HANDLE || !PASS) { console.log("[bsky] BSKY_HANDLE / BSKY_APP_PASSWORD が未設定。スキップ"); process.exit(0); }

const blogDir = new URL("../src/content/blog/", import.meta.url).pathname;
const fm = (src, key) => { const m = src.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m")); return m ? m[1].replace(/\\"/g, '"') : ""; };
const now = Date.now();
const posts = readdirSync(blogDir).filter((f) => f.endsWith(".md")).map((f) => {
  const src = readFileSync(join(blogDir, f), "utf8");
  return { slug: f.replace(/\.md$/, ""), title: fm(src, "title"), description: fm(src, "description"), pubDate: fm(src, "pubDate"), draft: fm(src, "draft") === "true", news: fm(src, "news") === "true", topic: fm(src, "topic") === "true" };
}).filter((p) => !p.draft && p.title && p.pubDate && now - new Date(p.pubDate + "T00:00:00+09:00").getTime() < DAYS * 86400000)
  .sort((a, b) => a.pubDate.localeCompare(b.pubDate));
if (!posts.length) { console.log("[bsky] 直近の新着なし"); process.exit(0); }

const api = async (method, body, token, ctype = "application/json") => {
  const r = await fetch(`${PDS}/xrpc/${method}`, { method: "POST", headers: { "Content-Type": ctype, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: ctype === "application/json" ? JSON.stringify(body) : body });
  if (!r.ok) throw new Error(`${method} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const session = await api("com.atproto.server.createSession", { identifier: HANDLE, password: PASS });
const token = session.accessJwt, did = session.did;

// 既に投稿済みのリンク
const lr = await fetch(`${PDS}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=100`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
const posted = new Set((lr.records ?? []).map((x) => x.value?.embed?.external?.uri).filter(Boolean).map((u) => u.replace(/\/?(\?.*)?$/, "/")));
const todo = posts.filter((p) => !posted.has(`${SITE}/blog/${p.slug}/`)).slice(0, MAX);
console.log(`[bsky] 新着 ${posts.length} 本 ／ 未投稿 ${todo.length} 本を投稿`);

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

for (const p of todo) {
  const url = `${SITE}/blog/${p.slug}/`;
  const label = p.news ? "【AIニュースまとめ】" : p.topic ? "【学び・キャリア】" : "【スクール比較】";
  const tags = p.news ? ["AIニュース", "生成AI"] : ["プログラミング学習", "リスキリング"];
  const head = `${label}${p.title}`;
  const tagLine = tags.map((t) => `#${t}`).join(" ");
  // 本文は300文字（書記素）まで。説明文は残りに収める
  const room = 290 - [...head].length - [...tagLine].length - 4;
  const text = `${head}\n\n${room > 20 ? cut(p.description, room) + "\n\n" : ""}${tagLine}`;
  // ハッシュタグの facet（バイト位置）
  const facets = [];
  let from = 0;
  for (const t of tags) {
    const needle = `#${t}`;
    const i = text.indexOf(needle, from);
    if (i < 0) continue;
    const start = bytes(text.slice(0, i));
    facets.push({ index: { byteStart: start, byteEnd: start + bytes(needle) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: t }] });
    from = i + needle.length;
  }
  // サムネイル（本番の og:image）
  let thumb;
  try {
    const html = await fetch(url).then((r) => r.text());
    const og = html.match(/property="og:image" content="([^"]+)"/)?.[1];
    if (og) {
      const img = await fetch(og);
      if (img.ok) {
        const buf = Buffer.from(await img.arrayBuffer());
        if (buf.length < 950000 && !DRY) thumb = (await api("com.atproto.repo.uploadBlob", buf, token, img.headers.get("content-type") || "image/png")).blob;
      }
    }
  } catch (e) { console.log(`[bsky] サムネイル取得失敗 ${p.slug}: ${e.message}`); }
  const record = {
    $type: "app.bsky.feed.post", text, facets, langs: ["ja"], createdAt: new Date().toISOString(),
    embed: { $type: "app.bsky.embed.external", external: { uri: url, title: p.title, description: cut(p.description, 280), ...(thumb ? { thumb } : {}) } },
  };
  if (DRY) { console.log(`[bsky] --dry ${url}\n${text}`); continue; }
  try {
    await api("com.atproto.repo.createRecord", { repo: did, collection: "app.bsky.feed.post", record }, token);
    console.log(`[bsky] 投稿 ${p.slug}`);
  } catch (e) { console.log(`[bsky] 投稿失敗 ${p.slug}: ${e.message}`); }
}

// コードスクールナビのコメント掲示板 API（Cloudflare Workers + D1、2026-09-26）
// オーナー方針: 登録なしの匿名で書ける 2ちゃんねる風。荒らし・中傷対策をサーバー側で行う。
//   GET  /comments?page=<slug>        そのページの表示中コメント（古い順、最大500）
//   GET  /recent?limit=10             サイト全体の最新コメント（トップ用）
//   GET  /counts?pages=a,b,c          ページごとの件数
//   POST /comments  {page,name,body,website,t}   書き込み
//   POST /report    {id}              通報（3件で自動非表示）
//   GET  /stats                       日次点検用の件数（本文なし）
// 管理（非表示・削除）は GitHub Actions の comments-admin から D1 を直接操作する。管理用のAPIは持たない。

const ORIGINS = ["https://codeschoolnavi.com", "https://www.codeschoolnavi.com"];
const PAGE_RE = /^[a-z0-9-]{3,80}$/;
// 中傷・差別・性的・暴力の語。ニュースの反応の除外語（news.ts の ABUSE）より広め
const K = "(?![ァ-ヴー])";  // カタカナ語の一部（カスタム・バカンスなど）に反応しないため
const NG = new RegExp([
  "死ね", "殺す", "殺して", "ころす", "氏ね", "自殺しろ", "消えろ", "キチガイ", "基地外", "ガイジ", "池沼", "害児", "チョン", "支那", "土人",
  `(?<![ァ-ヴー])バカ${K}`, "馬鹿", "アホ", "クズ", "クソ", "糞", `(?<![ァ-ヴー])カス${K}`, "ゴミ", `(?<![ァ-ヴー])キモ${K}`, "気持ち悪",
  `(?<![ァ-ヴー])ブス${K}`, "ブサイク", `(?<![ァ-ヴー])デブ${K}`, `(?<![ァ-ヴー])ハゲ${K}`,
  "まんこ", "ちんこ", "セックス", "レイプ", "援交", "パパ活", "LINE追加", "ライン追加",
  "https?:", "www\\.", "[a-z0-9-]+\\.(com|jp|net|xyz|info|biz|me|io)\\b",
].join("|"), "i");
// 個人情報らしきもの（電話・メール）
const PII = /\d{2,4}-\d{2,4}-\d{3,4}|0[789]0\d{8}|[\w.+-]+@[\w-]+\.[\w.]+/;

const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": status === 200 ? "public, max-age=15" : "no-store", Vary: "Origin" },
});

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/[^A-Za-z0-9]/g, "");
}
const jstDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const allow = ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin) && env.ALLOW_LOCAL === "1" ? origin : ORIGINS[0];
    // プリフライト。204 は本文を持てないので null で返す（本文つきだと例外になり CORS が通らない）
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" } });
    try {
      if (req.method === "GET" && url.pathname === "/comments") {
        const page = url.searchParams.get("page") || "";
        if (!PAGE_RE.test(page)) return json({ error: "page" }, 400);
        const { results } = await env.DB.prepare("SELECT id, no, name, body, uid, created_at FROM comments WHERE page = ? AND status = 'visible' ORDER BY id LIMIT 500").bind(page).all();
        return json({ items: results, count: results.length });
      }
      if (req.method === "GET" && url.pathname === "/recent") {
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
        const { results } = await env.DB.prepare("SELECT page, no, body, created_at FROM comments WHERE status = 'visible' ORDER BY id DESC LIMIT ?").bind(limit).all();
        return json({ items: results.map((r) => ({ ...r, body: r.body.slice(0, 80) })) });
      }
      if (req.method === "GET" && url.pathname === "/counts") {
        const pages = (url.searchParams.get("pages") || "").split(",").filter((p) => PAGE_RE.test(p)).slice(0, 60);
        if (!pages.length) return json({ counts: {} });
        const { results } = await env.DB.prepare(`SELECT page, COUNT(*) AS n FROM comments WHERE status = 'visible' AND page IN (${pages.map(() => "?").join(",")}) GROUP BY page`).bind(...pages).all();
        return json({ counts: Object.fromEntries(results.map((r) => [r.page, r.n])) });
      }

      // 日次点検用の集計（2026-09-26）。本文・IP は返さない。件数と、通報を受けて表示中の書き込みの位置だけ
      if (req.method === "GET" && url.pathname === "/stats") {
        const since24 = new Date(Date.now() - 86400000).toISOString();
        const s = await env.DB.prepare("SELECT SUM(status = 'visible') AS visible, SUM(status = 'visible' AND created_at > ?) AS visible24h, SUM(status = 'hidden') AS hidden, SUM(status = 'hidden' AND created_at > ?) AS hidden24h, SUM(created_at > ?) AS posts24h FROM comments").bind(since24, since24, since24).first();
        const rep = await env.DB.prepare("SELECT id, page, no, reports, created_at FROM comments WHERE status = 'visible' AND reports > 0 ORDER BY reports DESC, id DESC LIMIT 20").all();
        const pages = await env.DB.prepare("SELECT page, COUNT(*) AS n FROM comments WHERE status = 'visible' AND created_at > ? GROUP BY page ORDER BY n DESC LIMIT 10").bind(since24).all();
        const n = (v) => Number(v || 0);
        return new Response(JSON.stringify({
          generated_at: new Date().toISOString(),
          visible: n(s?.visible), hidden: n(s?.hidden),
          last24h: { posts: n(s?.posts24h), visible: n(s?.visible24h), hidden: n(s?.hidden24h) },
          reported_visible: rep.results, top_pages_24h: pages.results,
        }), { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
      }

      if (req.method === "POST") {
        // 書き込み・通報はサイトからのみ受け付ける
        if (!(ORIGINS.includes(origin) || (env.ALLOW_LOCAL === "1" && /^http:\/\/localhost:\d+$/.test(origin)))) return json({ error: "origin" }, 403, allow);
        const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const salt = env.IP_SALT || "csn";
        const ipHash = await sha(`${ip}|${salt}`);
        const now = new Date().toISOString();
        let body;
        try { body = await req.json(); } catch { return json({ error: "送信内容を読み取れませんでした" }, 400, allow); }

        if (url.pathname === "/report") {
          const id = Number(body.id);
          if (!Number.isInteger(id) || id < 1) return json({ error: "id" }, 400, allow);
          const r = await env.DB.prepare("INSERT OR IGNORE INTO reports (comment_id, ip_hash, created_at) VALUES (?, ?, ?)").bind(id, ipHash, now).run();
          if (r.meta.changes) {
            await env.DB.prepare("UPDATE comments SET reports = reports + 1, status = CASE WHEN reports + 1 >= 3 THEN 'hidden' ELSE status END WHERE id = ?").bind(id).run();
          }
          return json({ ok: true }, 200, allow);
        }

        if (url.pathname === "/comments") {
          const page = String(body.page || "");
          if (!PAGE_RE.test(page)) return json({ error: "書き込み先が正しくありません" }, 400, allow);
          // ボット対策: 見えない入力欄（website）に何か入っていたら、成功したふりをして捨てる
          if (body.website) return json({ ok: true, ignored: true }, 200, allow);
          // フォームを開いてから3秒未満の送信はボットとみなす
          if (!body.t || Date.now() - Number(body.t) < 3000) return json({ error: "少し待ってから送信してください" }, 400, allow);
          const text = String(body.body || "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          const name = (String(body.name || "").trim().slice(0, 20)) || "名無しさん";
          if ([...text].length < 2) return json({ error: "本文が短すぎます" }, 400, allow);
          if ([...text].length > 500) return json({ error: "本文は500文字までです" }, 400, allow);
          if (text.split("\n").length > 15) return json({ error: "改行は15行までです" }, 400, allow);
          if (NG.test(text) || NG.test(name)) return json({ error: "書き込めない言葉（中傷・差別・宣伝・URLなど）が含まれています" }, 400, allow);
          if (PII.test(text) || PII.test(name)) return json({ error: "電話番号やメールアドレスは書き込めません" }, 400, allow);

          // 連投制限: 30秒に1回、1日20回まで。同じ文面の繰り返しは1時間拒否
          const since30 = new Date(Date.now() - 30000).toISOString();
          const since24 = new Date(Date.now() - 86400000).toISOString();
          const since1h = new Date(Date.now() - 3600000).toISOString();
          const lim = await env.DB.prepare("SELECT SUM(created_at > ?) AS s30, COUNT(*) AS d, SUM(created_at > ? AND body = ?) AS dup FROM comments WHERE ip_hash = ? AND created_at > ?").bind(since30, since1h, text, ipHash, since24).first();
          if (lim && lim.s30 > 0) return json({ error: "連続投稿はできません。30秒ほど待ってください" }, 429, allow);
          if (lim && lim.d >= 20) return json({ error: "今日の書き込み上限（20回）に達しました" }, 429, allow);
          if (lim && lim.dup > 0) return json({ error: "同じ内容はすでに書き込まれています" }, 400, allow);

          const uid = (await sha(`${ip}|${jstDate()}|${salt}|uid`)).slice(0, 8);
          const next = await env.DB.prepare("SELECT COALESCE(MAX(no), 0) + 1 AS n FROM comments WHERE page = ?").bind(page).first();
          const no = next.n;
          const r = await env.DB.prepare("INSERT INTO comments (page, no, name, body, uid, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(page, no, name, text, uid, ipHash, now).run();
          return json({ ok: true, item: { id: r.meta.last_row_id, no, name, body: text, uid, created_at: now } }, 200, allow);
        }
      }
      return json({ error: "not found" }, 404, allow);
    } catch (e) {
      return json({ error: "サーバーでエラーが起きました。時間をおいて試してください" }, 500, allow);
    }
  },
};

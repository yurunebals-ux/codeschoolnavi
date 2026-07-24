// Generates a self-contained dashboard.html: KPIs, monetization deadlines with
// on/off-track status + contingency triggers, revenue projection, pipeline funnel,
// and the AI project team roster. Reads data/state.json and data/team.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState } from "../lib/store.js";
import { team } from "../lib/team.js";

// Launch date = MONETIZATION_START env, else first history date, else today.
function launchDate(state: ReturnType<typeof loadState>): Date {
  if (process.env.MONETIZATION_START) return new Date(process.env.MONETIZATION_START);
  if (state.history[0]?.date) return new Date(state.history[0].date);
  return new Date();
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmt(d: Date): string { return d.toISOString().slice(0, 10); }

interface Milestone { label: string; day: number; targetPublished?: number; targetMrr?: number; hard?: boolean; }
const MILESTONES: Milestone[] = [
  { label: "システム稼働・初回10記事", day: 3, targetPublished: 10 },
  { label: "30記事・Search Console登録", day: 14, targetPublished: 30 },
  { label: "60記事・検索表示が開始", day: 30, targetPublished: 60 },
  { label: "初成約（収益化デッドライン①）", day: 90, targetMrr: 10000, hard: true },
  { label: "月5万円（必達目標）", day: 180, targetMrr: 50000, hard: true },
  { label: "月20万円（拡大目標）", day: 365, targetMrr: 200000 },
];

export function buildDashboard(outPath?: string): string {
  const state = loadState();
  const start = launchDate(state);
  const today = new Date();
  const daysElapsed = Math.floor((+today - +start) / 86400000);

  const funnel = { queued: 0, drafted: 0, approved: 0, published: 0, rejected: 0 } as Record<string, number>;
  for (const k of state.keywords) funnel[k.status] = (funnel[k.status] || 0) + 1;

  const rows = MILESTONES.map((m) => {
    const due = addDays(start, m.day);
    const daysLeft = Math.ceil((+due - +today) / 86400000);
    let status: "done" | "ontrack" | "risk" | "late" = "ontrack";
    const metPub = m.targetPublished ? state.publishedCount >= m.targetPublished : true;
    const metMrr = m.targetMrr ? state.estimatedMrrUsd >= m.targetMrr : true;
    if (metPub && metMrr) status = "done";
    else if (daysLeft < 0) status = "late";
    else if (daysLeft <= 7) status = "risk";
    return { m, due, daysLeft, status, metPub, metMrr };
  });

  // Contingency triggers if a hard deadline is late or at risk.
  const alerts: string[] = [];
  for (const r of rows) {
    if (r.m.hard && (r.status === "late" || r.status === "risk") && !(r.metPub && r.metMrr)) {
      alerts.push(`「${r.m.label}」が${r.status === "late" ? "期限超過" : "期限間近"}。対策: 生成本数を1.5倍に増産／新しいツール軸を追加／上位化しかけの記事を強化。`);
    }
  }

  // 収益予測カーブ（保守シナリオ・円/月）。
  const proj = [0, 3000, 9000, 20000, 40000, 80000, 130000, 170000, 200000, 240000];

  const t = team();
  const html = render({ config, state, start, today, daysElapsed, funnel, rows, alerts, proj, team: t, fmt });
  const out = outPath || resolve(paths.root, "dashboard.html");
  writeFileSync(out, html);
  console.log(`[dashboard] wrote ${out}`);
  return out;
}

function render(x: any): string {
  const { config, state, start, daysElapsed, funnel, rows, alerts, proj, team, fmt } = x;
  const statusColor: Record<string, string> = { done: "#3fb950", ontrack: "#58a6ff", risk: "#d29922", late: "#f85149" };
  const statusLabel: Record<string, string> = { done: "達成", ontrack: "順調", risk: "要注意", late: "遅延" };

  const milestoneRows = rows.map((r: any) => `
    <tr>
      <td><span class="dot" style="background:${statusColor[r.status]}"></span>${statusLabel[r.status]}</td>
      <td>${r.m.label}${r.m.hard ? ' <span class="hard">必達</span>' : ""}</td>
      <td>${fmt(r.due)}</td>
      <td>${r.daysLeft >= 0 ? `あと${r.daysLeft}日` : `${-r.daysLeft}日超過`}</td>
      <td>${r.m.targetPublished ? `${state.publishedCount}/${r.m.targetPublished}記事` : ""}${r.m.targetMrr ? `¥${state.estimatedMrrUsd.toLocaleString()}/¥${r.m.targetMrr.toLocaleString()}` : ""}</td>
    </tr>`).join("");

  const teamRows = team.roles.map((role: any) => `
    <tr><td><b>${role.title}</b></td><td>${role.mission}</td><td><code>${role.owns}</code></td></tr>`).join("");

  const maxProj = Math.max(...proj);
  const points = proj.map((v: number, i: number) => `${40 + (i * 620) / (proj.length - 1)},${220 - (v / maxProj) * 180}`).join(" ");

  const alertBox = alerts.length
    ? `<div class="alerts"><b>⚠ 遅延対策トリガー</b><ul>${alerts.map((a: string) => `<li>${a}</li>`).join("")}</ul></div>`
    : `<div class="ok">✓ 現在、必達デッドラインに対する遅延アラートはありません。</div>`;

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.site.name} — 収益化ダッシュボード</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans",sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px}
.kpi .v{font-size:26px;font-weight:700}.kpi .l{color:var(--mut);font-size:12px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:20px}
.card h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--bd)}th{color:var(--mut);font-weight:500}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.hard{background:#f8514922;color:#f85149;border:1px solid #f8514955;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px}
.alerts{background:#d2992218;border:1px solid #d2992255;border-radius:10px;padding:14px;margin-bottom:20px}
.alerts ul{margin:8px 0 0;padding-left:18px}.alerts li{margin:4px 0;font-size:13px}
.ok{background:#3fb95018;border:1px solid #3fb95055;border-radius:10px;padding:12px;margin-bottom:20px;font-size:13px}
code{background:#0d1117;border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-size:11px;color:var(--acc)}
.funnel{display:flex;gap:8px;flex-wrap:wrap}.fitem{flex:1;min-width:90px;text-align:center;background:#0d1117;border:1px solid var(--bd);border-radius:8px;padding:10px}
.fitem .n{font-size:20px;font-weight:700}.fitem .k{font-size:11px;color:var(--mut)}
svg{width:100%;height:auto}.foot{color:var(--mut);font-size:11px;margin-top:8px}
</style></head><body><div class="wrap">
<h1>${config.site.name} — 収益化ダッシュボード</h1>
<div class="sub">ニッチ: ${config.site.niche} ・ 稼働開始: ${fmt(start)} ・ 経過 ${daysElapsed}日 ・ 最終更新: ${state.lastRun ? state.lastRun.slice(0, 16).replace("T", " ") : "未稼働"}</div>

${alertBox}

<div class="grid">
  <div class="kpi"><div class="v">${state.publishedCount}</div><div class="l">公開記事数</div></div>
  <div class="kpi"><div class="v">¥${state.estimatedMrrUsd.toLocaleString()}</div><div class="l">推定月間収益</div></div>
  <div class="kpi"><div class="v">${funnel.queued || 0}</div><div class="l">生成待ちキーワード</div></div>
  <div class="kpi"><div class="v">${funnel.rejected || 0}</div><div class="l">品質ゲート却下</div></div>
</div>

<div class="card"><h2>収益化マイルストーン（期限と進捗）</h2>
<table><thead><tr><th>状態</th><th>マイルストーン</th><th>期限</th><th>残り</th><th>進捗</th></tr></thead>
<tbody>${milestoneRows}</tbody></table>
<div class="foot">「必達」= 遅延時に自動で対策トリガーが発火するデッドライン。</div></div>

<div class="card"><h2>収益予測（保守シナリオ・高単価単発モデル）</h2>
<svg viewBox="0 0 680 240"><polyline fill="none" stroke="#58a6ff" stroke-width="2" points="${points}"/>
<line x1="40" y1="220" x2="660" y2="220" stroke="#30363d"/></svg>
<div class="foot">横軸=月（0→12ヶ月）、縦軸=推定月収(円)。標準シナリオで12ヶ月目 約20万円/月。</div></div>

<div class="card"><h2>パイプライン状況（品質ゲート付き）</h2>
<div class="funnel">
  <div class="fitem"><div class="n">${funnel.queued || 0}</div><div class="k">キーワード</div></div>
  <div class="fitem"><div class="n">${funnel.drafted || 0}</div><div class="k">下書き生成</div></div>
  <div class="fitem"><div class="n">${funnel.approved || 0}</div><div class="k">品質合格</div></div>
  <div class="fitem"><div class="n">${funnel.published || 0}</div><div class="k">公開済み</div></div>
  <div class="fitem"><div class="n">${funnel.rejected || 0}</div><div class="k">却下（品質保護）</div></div>
</div></div>

<div class="card"><h2>プロジェクトチーム（自律AIロール）</h2>
<table><thead><tr><th>役職</th><th>ミッション</th><th>担当工程</th></tr></thead>
<tbody>${teamRows}</tbody></table>
<div class="foot">オーナー（あなた）の稼働: 立ち上げ後は月30分程度（ダッシュボード確認と承認のみ）。</div></div>

</div></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) buildDashboard(process.argv[2]);

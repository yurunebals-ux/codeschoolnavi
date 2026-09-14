// Project Director: runs the whole team in order for one daily cycle.
import { config } from "./lib/config.js";
import { buildKeywords } from "./pipeline/keyword.js";
import { priceWatchRun } from "./pipeline/pricewatch.js";
import { generateNext } from "./pipeline/generate.js";
import { checkAll } from "./pipeline/quality.js";
import { polishRun } from "./pipeline/polish.js";
import { newsRun } from "./pipeline/news.js";
import { regenRun } from "./pipeline/regen.js";
import { publishRun, reconcilePublished } from "./pipeline/publish.js";
import { analyticsLoop } from "./pipeline/analytics.js";
import { buildDashboard } from "./pipeline/dashboard.js";
import { loadState } from "./lib/store.js";

async function cycle() {
  console.log("=== DAILY CYCLE START ===");
  // 生成の前に状態を実ファイルへ突き合わせる。ここを飛ばすと、状態が壊れたときに
  // 公開中の記事を書き直して上書きしてしまう。
  reconcilePublished();
  const state = loadState();
  const queued = state.keywords.filter((k) => k.status === "queued").length;
  const queuedTopics = state.keywords.filter((k) => k.status === "queued" && k.template.startsWith("topic:")).length;
  // トピック記事は比較記事のキューが尽きるまで追加されず、9/11〜9/13 は一度も出なかった。トピックが切れたら補充する
  if (queued < config.pipeline.perCycle || queuedTopics === 0) buildKeywords(40);

  // 独自データ：公式サイト表示料金の定点観測（失敗してもサイクルは止めない）
  await priceWatchRun().catch((e) => console.log("[pricewatch] skip:", (e as Error).message));

  // 週1本のニュース解説の種を拾う（失敗しても止めない）
  await newsRun().catch((e) => console.log("[news] skip:", (e as Error).message));

  for (let i = 0; i < config.pipeline.perCycle; i++) {
    const made = await generateNext();
    if (!made) break;
  }
  checkAll();

  // 公開済み記事の文体改稿を1本。新規生成より後・公開より前に置くことで、
  // 改稿した記事も同じコミットに乗る。失敗してもサイクルは止めない。
  await polishRun().catch((e) => console.log("[polish] skip:", (e as Error).message));
  // 旧い型の公開記事を1日2本ずつ新しい型で作り直す（全記事が終われば何もしない）
  await regenRun({ count: Number(process.env.REGEN_PER_CYCLE ?? 2) }).catch((e) => console.log("[regen] skip:", (e as Error).message));

  await publishRun();
  await analyticsLoop();
  buildDashboard();
  console.log("=== DAILY CYCLE DONE ===");
}

function status() {
  const s = loadState();
  const by: Record<string, number> = {};
  for (const k of s.keywords) by[k.status] = (by[k.status] || 0) + 1;
  console.log(JSON.stringify({ published: s.publishedCount, estimatedMrrUsd: s.estimatedMrrUsd, pipeline: by, lastRun: s.lastRun }, null, 2));
}

const cmd = process.argv[2] || "cycle";
if (cmd === "cycle") cycle();
else if (cmd === "status") status();
else if (cmd === "dashboard") buildDashboard();
else console.log("usage: tsx src/index.ts [cycle|status|dashboard]");

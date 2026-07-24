// Project Director: runs the whole team in order for one daily cycle.
import { config } from "./lib/config.js";
import { buildKeywords } from "./pipeline/keyword.js";
import { generateNext } from "./pipeline/generate.js";
import { checkAll } from "./pipeline/quality.js";
import { publishRun } from "./pipeline/publish.js";
import { analyticsLoop } from "./pipeline/analytics.js";
import { buildDashboard } from "./pipeline/dashboard.js";
import { loadState } from "./lib/store.js";

async function cycle() {
  console.log("=== DAILY CYCLE START ===");
  const state = loadState();
  const queued = state.keywords.filter((k) => k.status === "queued").length;
  if (queued < config.pipeline.perCycle) buildKeywords(40);

  for (let i = 0; i < config.pipeline.perCycle; i++) {
    const made = await generateNext();
    if (!made) break;
  }
  checkAll();
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

// ROLE: SEO Analyst
// Pulls Search Console data (if a service account is configured) and flags
// "near-miss" pages (positions 11-20) for reinforcement by re-queuing an
// improved brief. Without GSC credentials it runs a no-op summary so the
// pipeline never breaks.
import { config } from "../lib/config.js";
import { loadState, saveState } from "../lib/store.js";

export async function analyticsLoop(): Promise<void> {
  const state = loadState();

  if (!config.gsc.keyJson || !config.gsc.siteUrl) {
    console.log("[analyst] GSC not configured — skipping (set GSC_SERVICE_ACCOUNT_JSON & GSC_SITE_URL to enable).");
    summary(state);
    return;
  }

  // NOTE: When enabled, fetch GSC Search Analytics via the service account here.
  // The structure below shows exactly what to do with the rows once fetched.
  // rows: { page, query, impressions, clicks, position }
  const rows = await fetchGscRows().catch((e) => {
    console.log("[analyst] GSC fetch failed:", (e as Error).message);
    return [] as GscRow[];
  });

  let reinforced = 0;
  for (const r of rows) {
    const slug = r.page.replace(/\/$/, "").split("/").pop() || "";
    const item = state.keywords.find((k) => k.slug === slug);
    if (!item) continue;
    item.impressions = r.impressions;
    item.clicks = r.clicks;
    item.position = r.position;
    // Near-miss: has impressions and sits on page 2 -> worth one more push.
    if (r.impressions > 20 && r.position >= 11 && r.position <= 20 && item.status === "published") {
      item.status = "queued"; // re-enters generation with fresh, expanded brief
      item.rejectReason = undefined;
      reinforced++;
    }
  }
  saveState(state);
  console.log(`[analyst] reinforced ${reinforced} near-miss page(s).`);
  summary(state);
}

interface GscRow { page: string; query: string; impressions: number; clicks: number; position: number; }
async function fetchGscRows(): Promise<GscRow[]> {
  // Placeholder for the authenticated GSC call. Implement with the service
  // account JSON when ready; returns [] until then so the loop is safe.
  return [];
}

function summary(state: ReturnType<typeof loadState>) {
  const byStatus: Record<string, number> = {};
  for (const k of state.keywords) byStatus[k.status] = (byStatus[k.status] || 0) + 1;
  console.log(`[analyst] pipeline: ${JSON.stringify(byStatus)} | published=${state.publishedCount} | 推定月収≒¥${state.estimatedMrrUsd.toLocaleString()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) analyticsLoop();

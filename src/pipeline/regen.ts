// ROLE: 編集長（既存記事の作り直し）
//
// 2026-09-11 に記事の型を作り直した（generate.ts）。新しい型は「これから書く記事」にしか
// 効かないので、公開済みの記事も順に作り直す。polish.ts（文体だけ直す）とは別物で、
// こちらは本文を新しい構成で書き直し、旧本文は捨てる。
//
// 安全装置:
//  - quality.ts と同じ採点（evaluateDraft）に通らなければ旧本文を残す
//  - pubDate（公開日）は変えず updatedDate だけ今日にする（URL・公開日は SEO 上の資産）
//  - 1回の実行本数は引数で制限（コスト管理）。data/regen.json に記録し、同じ記事を二度やらない
//
// 使い方: tsx src/pipeline/regen.ts --count=3 | --slugs=a,b,c [--force]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";
import { loadState, saveState, STRUCTURE_VERSION, type KeywordItem } from "../lib/store.js";
import { isOffline } from "../lib/llm.js";
import { writeArticle, frontmatter, type Affiliates } from "./generate.js";
import { evaluateDraft, shingles } from "./quality.js";
import { syncOffers } from "./offers.js";

const LOG = resolve(paths.data, "regen.json");
interface Log { done: Record<string, { date: string; version: number; ok: boolean; reason?: string }> }
function loadLog(): Log { if (!existsSync(LOG)) return { done: {} }; try { return JSON.parse(readFileSync(LOG, "utf8")); } catch { return { done: {} }; } }
function saveLog(l: Log) { writeFileSync(LOG, JSON.stringify(l, null, 2) + "\n"); }

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

export async function regenRun(opts: { count?: number; slugs?: string[]; force?: boolean } = {}): Promise<number> {
  if (isOffline()) { console.log("[regen] APIキーなし。スキップ"); return 0; }
  const aff: Affiliates = JSON.parse(readFileSync(paths.affiliates, "utf8"));
  const state = loadState();
  const log = loadLog();

  const published = state.keywords.filter((k) => k.status === "published");
  let targets: KeywordItem[];
  if (opts.slugs?.length) {
    targets = published.filter((k) => opts.slugs!.includes(k.slug));
  } else {
    // 古い順（読者に長く見られている記事から直す）。すでに新しい型のものは除く。
    // data/priority.json（Search Console で表示が出ている記事）を先に、残りは古い順
    const prio: string[] = (() => { try { return JSON.parse(readFileSync(resolve(paths.data, "priority.json"), "utf8")).slugs ?? []; } catch { return []; } })();
    const rank = (k: KeywordItem) => { const i = prio.indexOf(k.slug); return i < 0 ? 999 : i; };
    targets = published
      .filter((k) => (k.structure ?? 1) < STRUCTURE_VERSION)
      .filter((k) => opts.force || !log.done[k.slug] || log.done[k.slug].version < STRUCTURE_VERSION)
      .sort((a, b) => rank(a) - rank(b) || (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))
      .slice(0, opts.count ?? 3);
  }
  if (!targets.length) { console.log("[regen] 対象なし（全記事が新しい型）"); return 0; }

  // 重複判定の比較対象は「自分以外」の公開記事。
  const bodies = new Map<string, Set<string>>();
  for (const k of published) {
    const p = resolve(paths.blog, `${k.slug}.md`);
    if (existsSync(p)) bodies.set(k.slug, shingles(readFileSync(p, "utf8")));
  }

  let ok = 0;
  for (const item of targets) {
    const dest = resolve(paths.blog, `${item.slug}.md`);
    if (!existsSync(dest)) continue;
    const old = readFileSync(dest, "utf8");
    const pub = old.match(/^pubDate:\s*([0-9-]+)/m)?.[1] ?? new Date().toISOString().slice(0, 10);
    // タイトルは公開中のファイルのものを正とする（state.json の keyword は古い型のタイトルを
    // 持っていることがある。2026-09-11 に「やめとけ」型のタイトルを手で改題した）。
    const curTitle = (() => { const m = old.match(/^title:\s*(.+)$/m); if (!m) return null; try { return JSON.parse(m[1]); } catch { return m[1].replace(/^["']|["']$/g, ""); } })();
    const today = new Date().toISOString().slice(0, 10);
    console.log(`[regen] 作り直し開始 "${item.keyword}"`);
    try {
      const { body, description, title, tools } = await writeArticle(item, aff);
      const md = `${frontmatter(item, tools, description, { pub, upd: today }, title ?? curTitle)}\n\n> 【広告】${aff.disclosure}\n\n${body.trim()}\n`;
      const prior = [...bodies.entries()].filter(([s]) => s !== item.slug).map(([, v]) => v);
      const v = evaluateDraft(md, item, aff, prior);
      if (v.hardBlock || v.pts < 70) {
        log.done[item.slug] = { date: today, version: STRUCTURE_VERSION, ok: false, reason: `score=${v.pts}; ${v.reasons.join("; ")}` };
        console.log(`[regen] 不採用 "${item.slug}": score=${v.pts}; ${v.reasons.join("; ")}`);
        continue;
      }
      writeFileSync(dest, md);
      const draft = resolve(paths.drafts, `${item.slug}.md`);
      writeFileSync(draft, md);
      item.structure = STRUCTURE_VERSION;
      if (title ?? curTitle) item.keyword = (title ?? curTitle)!;
      log.done[item.slug] = { date: today, version: STRUCTURE_VERSION, ok: true };
      ok++;
      console.log(`[regen] 採用 "${item.slug}" score=${v.pts} 文体=${v.aiScore}`);
    } catch (e) {
      log.done[item.slug] = { date: today, version: STRUCTURE_VERSION, ok: false, reason: (e as Error).message };
      console.log(`[regen] 失敗 "${item.slug}": ${(e as Error).message}`);
    }
    saveLog(log);
    saveState(state);
  }
  syncOffers();
  console.log(`[regen] ${ok}/${targets.length} 本を新しい型に置き換え`);
  return ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slugs = arg("slugs")?.split(",").map((s) => s.trim()).filter(Boolean);
  const count = Number(arg("count")) || 3;
  regenRun({ slugs, count, force: process.argv.includes("--force") }).catch((e) => { console.error(e); process.exit(1); });
}

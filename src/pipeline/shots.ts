// ROLE: デザイン + 運用
//
// 各スクールの公式サイトのファーストビューを撮り、サイトの「見た目の写真要素」にする。
//
// なぜ公式サイトのスクショなのか（2026-09-11 の競合分析より）:
//   上位の比較サイト6つを調べたところ、ヒーローに人物のストック写真を置くサイトは
//   ひとつも無く、共通していたのは「各校ブロックの冒頭に公式サイトのスクショ1枚」だった。
//   スクショは「本物のスクールを扱っている」感を出す唯一の写真要素で、
//   しかも人物写真のような肖像権・ステマ規制の問題を持ち込まない。
//   出典表記（「出典：〇〇公式サイト」）を添える運用はコエテコ・マナビタイム型。
//
// 運用:
//   - 作業コンテナからは外部HTTPが通らないので、実行は GitHub Actions（.github/workflows/shots.yml）。
//   - 30日以上古いか、無いものだけ撮り直す（毎回撮るとリポジトリが画像差分で太る）。
//   - 失敗した校は前回の画像を残す。1校も撮れなくても例外で落とさない（サイトの公開を止めない）。
//   - 出力: site/public/img/shots/<id>.webp（幅960px）と site/src/data/shots.json（撮影日など）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";

interface Tool { id: string; name: string; official_url?: string; }
interface Shot { file: string; takenAt: string; w: number; h: number; source: string; }
type ShotsFile = { _note: string; shots: Record<string, Shot> };

const OUT_DIR = resolve(paths.root, "site/public/img/shots");
const META = resolve(paths.root, "site/src/data/shots.json");
const MAX_AGE_DAYS = Number(process.env.SHOTS_MAX_AGE_DAYS || 30);
const FORCE = process.argv.includes("--force");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const WIDTH = 960;

function loadMeta(): ShotsFile {
  if (!existsSync(META)) return { _note: "", shots: {} };
  try { return JSON.parse(readFileSync(META, "utf8")); } catch { return { _note: "", shots: {} }; }
}

function isFresh(s: Shot | undefined): boolean {
  if (!s) return false;
  if (!existsSync(resolve(paths.root, "site/public", s.file.replace(/^\//, "")))) return false;
  const age = (Date.now() - new Date(s.takenAt).getTime()) / 86400000;
  return age < MAX_AGE_DAYS;
}

export async function takeShots(): Promise<{ taken: number; skipped: number; failed: string[] }> {
  const aff = JSON.parse(readFileSync(resolve(paths.data, "affiliates.json"), "utf8")) as { tools: Tool[] };
  const meta = loadMeta();
  const targets = aff.tools.filter((t) => /^https?:\/\//.test(t.official_url ?? ""))
    .filter((t) => !ONLY.length || ONLY.includes(t.id));

  const todo = targets.filter((t) => FORCE || !isFresh(meta.shots[t.id]));
  const skipped = targets.length - todo.length;
  const failed: string[] = [];
  if (!todo.length) {
    console.log(`[shots] 撮り直し対象なし（${targets.length}校すべて${MAX_AGE_DAYS}日以内）`);
    return { taken: 0, skipped, failed };
  }

  // playwright と sharp はここで初めて読む（撮る必要が無い日はネイティブモジュールを触らない）
  const { chromium } = await import("playwright");
  const sharp = (await import("sharp")).default;
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.PW_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });

  let taken = 0;
  for (const t of todo) {
    const page = await ctx.newPage();
    try {
      try {
        await page.goto(t.official_url!, { waitUntil: "networkidle", timeout: 30000 });
      } catch {
        // SPAや広告タグでnetworkidleにならないサイトがある。loadまで待てていれば十分
        await page.goto(t.official_url!, { waitUntil: "load", timeout: 30000 });
      }
      await page.waitForTimeout(1800); // ヒーローのフェードインや遅延画像を待つ
      // 画面下に張り付くCookie同意・追従CTAだけを隠す（ヘッダーは残す）
      await page.addStyleTag({ content: `
        [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i] { display: none !important; }
      ` }).catch(() => {});
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 800 } });
      const out = resolve(OUT_DIR, `${t.id}.webp`);
      const img = sharp(png).resize({ width: WIDTH }).webp({ quality: 78 });
      const info = await img.toFile(out);
      meta.shots[t.id] = {
        file: `/img/shots/${t.id}.webp`,
        takenAt: new Date().toISOString(),
        w: info.width, h: info.height,
        source: t.official_url!,
      };
      taken++;
      console.log(`[shots] ${t.id.padEnd(18)} OK ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)}KB`);
    } catch (e: any) {
      failed.push(t.id);
      console.log(`[shots] ${t.id.padEnd(18)} NG ${String(e?.message || e).split("\n")[0].slice(0, 90)}${meta.shots[t.id] ? "（前回の画像を維持）" : ""}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  await browser.close();

  meta._note = "自動生成（src/pipeline/shots.ts）。手で編集しない。各校の公式サイトのファーストビュー。出典表記はテンプレート側で付ける。";
  writeFileSync(META, JSON.stringify(meta, null, 2) + "\n");
  console.log(`[shots] 撮影 ${taken} / スキップ ${skipped} / 失敗 ${failed.length}`);
  return { taken, skipped, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  takeShots().catch((e) => { console.error("[shots] fatal:", e); process.exit(0); /* 公開を止めない */ });
}

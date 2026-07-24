// ROLE: SEO Analyst + Monetization（独自データ蓄積）
// 競合評価③への対策：各スクール公式サイトの「表示料金」を毎日自動確認し、
// 変化があった日だけ記録する。無人運用のまま貯まる当サイト独自の一次データ
// （＝E-E-A-T・記事の鮮度の根拠）になる。断定的な価格主張には使わず、
// 「料金表示の変更監視ログ」としてサイトに表示する。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";

// 公式トップ（or 料金掲載ページ）。ID は data/affiliates.json の tools[].id と一致させる。
const OFFICIALS: { id: string; name: string; url: string }[] = [
  { id: "techacademy", name: "TechAcademy", url: "https://techacademy.jp/" },
  { id: "dmmwebcamp", name: "SHIFT TERAS CAMPUS（旧DMM WEBCAMP）", url: "https://web-camp.io/" },
  { id: "techcamp", name: "テックキャンプ", url: "https://tech-camp.in/" },
  { id: "codecamp", name: "CodeCamp", url: "https://codecamp.jp/" },
  { id: "runteq", name: "RUNTEQ", url: "https://runteq.jp/" },
  { id: "kikagaku", name: "キカガク", url: "https://www.kikagaku.ai/" },
  { id: "aidemy", name: "Aidemy", url: "https://aidemy.net/" },
  { id: "techis", name: "テックアイエス", url: "https://techis.jp/" },
];

interface Observation { date: string; prices: number[]; min: number }
interface SchoolWatch { name: string; url: string; observations: Observation[]; lastChecked?: string; lastError?: string }
interface Db { note: string; schools: Record<string, SchoolWatch> }

const FILE = resolve(paths.data, "pricewatch.json");

function loadDb(): Db {
  if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  return { note: "公式サイト表示料金の自動観測ログ。価格の断定に使わず、変更検知と確認日の根拠として使う。", schools: {} };
}

// HTMLから「円」表記の金額を抽出（1万〜200万円のみ。分割払い等のノイズは範囲で軽減）。
export function extractPrices(html: string): number[] {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const out = new Set<number>();
  for (const m of text.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{5,7})\s*円/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 10000 && n <= 2000000) out.add(n);
  }
  return [...out].sort((a, b) => a - b).slice(0, 20);
}

async function fetchHtml(url: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; CodeSchoolNaviBot/1.0; +https://codeschoolnavi.com/about/)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

export async function priceWatchRun(): Promise<void> {
  const db = loadDb();
  const today = new Date().toISOString().slice(0, 10);
  let changes = 0;

  for (const o of OFFICIALS) {
    const sch: SchoolWatch = db.schools[o.id] ?? { name: o.name, url: o.url, observations: [] };
    sch.name = o.name; sch.url = o.url;
    try {
      const html = await fetchHtml(o.url);
      const prices = extractPrices(html);
      const last = sch.observations[sch.observations.length - 1];
      if (prices.length && (!last || JSON.stringify(last.prices) !== JSON.stringify(prices))) {
        sch.observations.push({ date: today, prices, min: prices[0] });
        if (sch.observations.length > 60) sch.observations = sch.observations.slice(-60);
        changes++;
        console.log(`[pricewatch] ${o.name}: 表示価格の変化を記録（${prices.length}件検出）`);
      }
      sch.lastChecked = today;
      delete sch.lastError;
    } catch (e) {
      sch.lastError = `${today}: ${(e as Error).message}`;
      console.log(`[pricewatch] ${o.name}: 取得失敗 ${(e as Error).message}`);
    }
    db.schools[o.id] = sch;
    // 行儀よく1秒空ける
    await new Promise((r) => setTimeout(r, 1000));
  }

  mkdirSync(paths.data, { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2) + "\n");
  console.log(`[pricewatch] 完了: ${OFFICIALS.length}校確認 / 変化 ${changes}件`);
}

if (import.meta.url === `file://${process.argv[1]}`) priceWatchRun();


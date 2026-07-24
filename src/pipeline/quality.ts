// ROLES: QA・ファクトチェック + コンプライアンス（日本語 / ステマ規制対応）
// 下書きを検査し、薄い/重複/誇大/広告表記なしを自動却下。0-100で採点。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";

// 日本語は空白で分かち書きしないため、文字数（記号・空白除外）で長さを測る。
function charCount(md: string): number {
  return md.replace(/[#>*`|\-\s]/g, "").length;
}
function headingCount(md: string): number {
  return (md.match(/^##\s+/gm) || []).length;
}
// 文字3-gramのJaccard類似度（日英どちらでも動作、APIコスト0）。
function shingles(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[#>*`|\-\s]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export function checkAll(): { approved: number; rejected: number } {
  const state = loadState();
  const drafted = state.keywords.filter((k) => k.status === "drafted");
  let approved = 0, rejected = 0;

  const priorBodies: Set<string>[] = [];
  state.keywords.filter((k) => k.status === "approved" || k.status === "published").forEach((k) => {
    const p = resolve(paths.drafts, `${k.slug}.md`);
    if (existsSync(p)) priorBodies.push(shingles(readFileSync(p, "utf8")));
  });

  for (const item of drafted) {
    const p = resolve(paths.drafts, `${item.slug}.md`);
    if (!existsSync(p)) { reject(item, "下書きファイルなし"); rejected++; continue; }
    const md = readFileSync(p, "utf8");
    const reasons: string[] = [];
    let pts = 0;

    const cc = charCount(md);
    if (cc >= config.pipeline.minWords) pts += 30; else reasons.push(`薄い: ${cc}字`);

    const hc = headingCount(md);
    if (hc >= 3) pts += 20; else reasons.push(`見出し不足: ${hc}`);

    if (/よくある質問|FAQ/i.test(md)) pts += 10; else reasons.push("FAQなし");
    if (md.includes("|")) pts += 10; // 比較表

    // コンプライアンス：ステマ規制の広告表記が必須。
    const hasAd = /【?広告】?|プロモーション|ＰＲ|PR|アフィリエイト/.test(md);
    if (hasAd) pts += 15; else reasons.push("広告表記なし（ステマ規制ブロック）");

    if (/\]\(https?:\/\//.test(md)) pts += 10; else reasons.push("アフィリンクなし");
    if (/OFFLINE PLACEHOLDER|オフライン/.test(md)) reasons.push("オフラインのダミー本文");
    if (/絶対|必ず稼げる|確実に稼|日本一|100%|No\.?1|誰でも稼/i.test(md)) reasons.push("誇大・断定表現");

    const sh = shingles(md);
    const maxSim = priorBodies.reduce((m, b) => Math.max(m, jaccard(sh, b)), 0);
    if (maxSim > 0.55) reasons.push(`重複疑い(sim ${maxSim.toFixed(2)})`); else pts += 5;

    const hardBlock =
      !hasAd ||
      /OFFLINE PLACEHOLDER|オフライン/.test(md) ||
      /絶対|必ず稼げる|確実に稼|日本一|100%|No\.?1|誰でも稼/i.test(md) ||
      maxSim > 0.55;

    if (!hardBlock && pts >= config.pipeline.qualityMin) {
      item.status = "approved";
      priorBodies.push(sh);
      approved++;
      console.log(`[qa] 承認 "${item.keyword}" score=${pts}`);
    } else {
      reject(item, `score=${pts}; ${reasons.join("; ")}`);
      rejected++;
    }
  }
  saveState(state);
  console.log(`[qa/compliance] 承認 ${approved} / 却下 ${rejected}`);
  return { approved, rejected };
}

function reject(item: KeywordItem, reason: string) {
  item.status = "rejected";
  item.rejectReason = reason;
  console.log(`[qa] 却下 "${item.keyword}": ${reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) checkAll();

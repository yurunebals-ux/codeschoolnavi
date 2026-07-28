// ROLES: QA・ファクトチェック + コンプライアンス（日本語 / ステマ規制対応）
// 下書きを検査し、薄い/重複/誇大/広告表記なしを自動却下。0-100で採点。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";
import { scanAiese } from "../lib/aiese.js";

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
    if (cc >= config.pipeline.minWords) pts += 30; else reasons.push(`薄い: ${cc}字（基準${config.pipeline.minWords}字）`);

    // 深度基準（競合評価に基づく）: 長編はセクション数も伴う。
    const hc = headingCount(md);
    if (hc >= 8) pts += 20; else if (hc >= 5) { pts += 10; reasons.push(`見出しやや不足: ${hc}`); } else reasons.push(`見出し不足: ${hc}`);

    if (/よくある質問|FAQ/i.test(md)) pts += 10; else reasons.push("FAQなし");
    if (md.includes("|")) pts += 10; // 比較表
    if (/実質負担|給付金|還元/.test(md)) pts += 5; // 負担額の具体性（日本市場の成約要因）

    // コンプライアンス：ステマ規制の広告表記が必須。
    const hasAd = /【?広告】?|プロモーション|ＰＲ|PR|アフィリエイト/.test(md);
    if (hasAd) pts += 15; else reasons.push("広告表記なし（ステマ規制ブロック）");

    // 収益導線は本文ではなくテンプレート側（site/src/components/Cta.astro が
    // offers.json を読む）が持つ。本文にリンクを焼き込むと、提携が承認された日に
    // 全記事を書き直すことになるうえ、未承認のうちは下のプレースホルダ検査に
    // 引っかかって1本も公開できない。だからここで見るのは本文の外部リンクではなく
    // 「記事間を回遊させる内部リンクがあるか」にする。
    if (/\]\(\/blog\//.test(md)) pts += 10; else reasons.push("内部リンクなし");
    // 注意: 「オフライン」は通常の日本語として本文に登場するため、
    // ダミー検出は英語マーカー（llm.tsのオフラインモード出力）のみで判定する。
    if (/OFFLINE PLACEHOLDER/.test(md)) reasons.push("オフラインのダミー本文");
    // 提携が未承認のスクールは data/affiliates.json の affiliate_url が
    // プレースホルダ（px.a8.net/REPLACE-... など）のままになっている。
    // generate.ts の比較表フォールバックはその値をそのままMarkdownリンクにするので、
    // 放っておくと rel="sponsored" 付きの死んだ外部リンクが公開記事に載る。
    // 読者を空振りさせるうえSEO上も損なので、公開前にここで確実に止める。
    const hasDeadLink = /REPLACE-WITH-YOUR|PENDING-A8-APPROVAL/.test(md);
    if (hasDeadLink) reasons.push("提携未承認のプレースホルダURLが本文に残っている");
    if (/絶対|必ず稼げる|確実に稼|日本一|100%|No\.?1|誰でも稼/i.test(md)) reasons.push("誇大・断定表現");

    const sh = shingles(md);
    const maxSim = priorBodies.reduce((m, b) => Math.max(m, jaccard(sh, b)), 0);
    if (maxSim > 0.72) reasons.push(`重複疑い(sim ${maxSim.toFixed(2)})`); else pts += 5;

    // 文体（AIっぽさ）。生成側の推敲で30以下まで落とす設計なので、
    // ここは「推敲が機能しなかった原稿」を止めるための後段の網。
    // 閾値を厳しくしすぎると1本も公開されず収益が止まるため、
    // 減点は細かく、ブロックは明確に酷いものだけに限る。
    const ai = scanAiese(md);
    if (ai.score <= 30) pts += 10;
    else if (ai.score <= 45) pts += 5;
    else reasons.push(`AI文体(score ${ai.score}: ${[...ai.top(4), ...ai.structure, ...ai.rhythm].join("、")})`);

    const hardBlock =
      !hasAd ||
      hasDeadLink ||
      /OFFLINE PLACEHOLDER/.test(md) ||
      /絶対|必ず稼げる|確実に稼|日本一|100%|No\.?1|誰でも稼/i.test(md) ||
      maxSim > 0.72 ||
      ai.score > config.pipeline.aieseMax;

    if (!hardBlock && pts >= config.pipeline.qualityMin) {
      item.status = "approved";
      priorBodies.push(sh);
      approved++;
      console.log(`[qa] 承認 "${item.keyword}" score=${pts} 文体=${ai.score}`);
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

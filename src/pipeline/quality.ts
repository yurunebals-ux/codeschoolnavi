// ROLES: QA・ファクトチェック + コンプライアンス（日本語 / ステマ規制対応）
// 下書きを検査し、薄い/重複/誇大/広告表記なし/構造崩れを自動却下。0-100で採点。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";
import { scanAiese } from "../lib/aiese.js";
import { findStructureProblems } from "../lib/structure.js";
import { minWordsFor } from "./generate.js";

// 日本語は空白で分かち書きしないため、文字数（記号・空白除外）で長さを測る。
function charCount(md: string): number {
  return md.replace(/[#>*`|\-\s]/g, "").length;
}
function headingCount(md: string): number {
  return (md.match(/^##\s+/gm) || []).length;
}
// 文字3-gramのJaccard類似度（日英どちらでも動作、APIコスト0）。
export function shingles(text: string): Set<string> {
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

export interface Verdict { pts: number; reasons: string[]; hardBlock: boolean; aiScore: number; shingle: Set<string> }

interface AffMeta { subsidy_ids?: string[]; tools: { id: string; name: string }[] }

/**
 * 1本の原稿を採点する。生成サイクル（checkAll）と再生成（regen.ts）の両方から使う。
 * priorBodies は重複判定の比較対象（公開済み・承認済みの本文）。
 */
export function evaluateDraft(md: string, item: KeywordItem, aff: AffMeta, priorBodies: Set<string>[]): Verdict {
  const reasons: string[] = [];
  let pts = 0;
  const subsidyIds = new Set(aff.subsidy_ids ?? []);
  const isNews = item.template.startsWith("news:");
  const isTopic = item.template.startsWith("topic:");

  const need = minWordsFor(item);
  const cc = charCount(md);
  if (cc >= need) pts += 30; else reasons.push(`薄い: ${cc}字（基準${need}字）`);

  // 深度基準: 長編はセクション数も伴う。ニュースは短いので緩める。
  const hc = headingCount(md);
  const hNeed = isNews ? 2 : isTopic ? 5 : 6;
  if (hc >= hNeed + 2) pts += 20; else if (hc >= hNeed) { pts += 10; reasons.push(`見出しやや不足: ${hc}`); } else reasons.push(`見出し不足: ${hc}`);

  if (isNews) pts += 10; else if (/よくある質問|FAQ/i.test(md)) pts += 10; else reasons.push("FAQなし");
  if (md.includes("|") || isNews || isTopic) pts += 10; // 比較表（ニュース・トピックは不要）

  // 給付金の扱い。対象校の記事だけ具体性を加点し、対象外校は「対象外」と正直に書けば同じだけ加点。
  const eligible = item.tools.some((id) => subsidyIds.has(id));
  if (eligible) {
    if (/実質負担|給付金|還元/.test(md)) pts += 5;
  } else if (/対象ではない|対象外|対象講座はありません/.test(md)) {
    pts += 5;
  } else if (isNews || isTopic) pts += 5;

  // 【景表法】対象講座を持たないスクールの記事に、給付額を差し引く計算を載せない。
  const discountMath =
    /[\d,]{3,}円\s*[-−–ー]\s*[\d,]{3,}円/.test(md) ||
    /[\d,]{3,}円(?:が|の)?割引/.test(md) ||
    /実質負担額[はがも：:]\s*[\d,]{3,}円/.test(md) ||
    /実質[\d,]{3,}円/.test(md);
  const subsidyContext = /給付金|教育訓練給付/.test(md);
  const badSubsidyMath = !eligible && !isTopic && !isNews && subsidyContext && discountMath;
  if (badSubsidyMath) reasons.push("給付金の対象講座がないスクールなのに割引後の実質負担額を計算している（景表法）");

  // 【逆の誤り】対象校なのに「対象の案内がない／対象ではない／不明」と書く。
  // 2026-09-09 のスキルアップAI記事がこれ。読者は使える給付金を使わずに申し込む。
  // 「◯◯プランは対象外」のような正しい但し書きまで止めないよう、スクール名を含む文だけ見る。
  let subsidyDenied = false;
  if (eligible) {
    const names = aff.tools.filter((t) => item.tools.includes(t.id) && subsidyIds.has(t.id)).map((t) => t.name);
    const sentences = md.split(/[。\n]/);
    for (const s of sentences) {
      if (!names.some((n) => s.includes(n))) continue;
      if (/(プラン|コース|講座)は(給付金の)?対象外/.test(s) && !/全(コース|講座)/.test(s)) continue;
      if (/給付金.{0,30}(対象(講座|コース)?(は|が|として)?(ありません|ない|なし|不明|確認できない|確認が取れていない)|対象では(ありません|ない)|明記(が|は|されて)(ありません|ない|いません)|案内(が|は|されて)(ありません|ない|いません)|扱いません)/.test(s)) {
        subsidyDenied = true; reasons.push(`給付金の対象校なのに対象外・不明と書いている: 「${s.trim().slice(0, 40)}」`); break;
      }
    }
  }

  // コンプライアンス：ステマ規制の広告表記が必須。
  const hasAd = /【?広告】?|プロモーション|ＰＲ|PR|アフィリエイト/.test(md);
  if (hasAd) pts += 15; else reasons.push("広告表記なし（ステマ規制ブロック）");

  // 内部リンク（回遊）。
  if (/\]\(\/(blog|kyufukin)\//.test(md)) pts += 10; else reasons.push("内部リンクなし");
  if (/OFFLINE PLACEHOLDER/.test(md)) reasons.push("オフラインのダミー本文");
  const hasDeadLink = /REPLACE-WITH-YOUR|PENDING-A8-APPROVAL/.test(md);
  if (hasDeadLink) reasons.push("提携未承認のプレースホルダURLが本文に残っている");
  const hype = /絶対|必ず稼げる|確実に稼|日本一|100%|No\.?1|誰でも稼/i.test(md);
  if (hype) reasons.push("誇大・断定表現");

  // 口コミの捏造（出典を示せない「声」）。データ規約で禁じているが、出たら止める。
  const fakeVoice = /という声(が|も)|との口コミ|口コミ(が|も)多い|口コミでは|と評判です|受講生の声/.test(md);
  if (fakeVoice) reasons.push("出典のない口コミ・評判の記述");

  // 構造（重複見出し・表崩れ・生成の残骸・空の節）。
  const structure = findStructureProblems(md);
  if (structure.length) reasons.push(`構造: ${structure.map((p) => `${p.kind}(${p.detail})`).join(", ")}`);

  const sh = shingles(md);
  const maxSim = priorBodies.reduce((m, b) => Math.max(m, jaccard(sh, b)), 0);
  if (maxSim > 0.72) reasons.push(`重複疑い(sim ${maxSim.toFixed(2)})`); else pts += 5;

  const ai = scanAiese(md);
  if (ai.score <= 30) pts += 10;
  else if (ai.score <= 45) pts += 5;
  else reasons.push(`AI文体(score ${ai.score}: ${[...ai.top(4), ...ai.structure, ...ai.rhythm].join("、")})`);

  const hardBlock =
    !hasAd || hasDeadLink || /OFFLINE PLACEHOLDER/.test(md) || hype ||
    maxSim > 0.72 || badSubsidyMath || subsidyDenied || fakeVoice || structure.length > 0 ||
    ai.score > config.pipeline.aieseMax;

  return { pts, reasons, hardBlock, aiScore: ai.score, shingle: sh };
}

export function checkAll(): { approved: number; rejected: number } {
  const state = loadState();
  const drafted = state.keywords.filter((k) => k.status === "drafted");
  let approved = 0, rejected = 0;

  const aff = JSON.parse(readFileSync(paths.affiliates, "utf8")) as AffMeta;

  const priorBodies: Set<string>[] = [];
  state.keywords.filter((k) => k.status === "approved" || k.status === "published").forEach((k) => {
    const p = resolve(paths.drafts, `${k.slug}.md`);
    if (existsSync(p)) priorBodies.push(shingles(readFileSync(p, "utf8")));
  });

  for (const item of drafted) {
    const p = resolve(paths.drafts, `${item.slug}.md`);
    if (!existsSync(p)) { reject(item, "下書きファイルなし"); rejected++; continue; }
    const md = readFileSync(p, "utf8");
    const v = evaluateDraft(md, item, aff, priorBodies);
    if (!v.hardBlock && v.pts >= config.pipeline.qualityMin) {
      item.status = "approved";
      priorBodies.push(v.shingle);
      approved++;
      console.log(`[qa] 承認 "${item.keyword}" score=${v.pts} 文体=${v.aiScore}`);
    } else {
      reject(item, `score=${v.pts}; ${v.reasons.join("; ")}`);
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

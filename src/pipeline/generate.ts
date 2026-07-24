// ROLES: シニアライター + 編集長 + 収益責任者（日本語）
// キューから1件取り、直接的な結論→評価軸→各サービス解説→比較表→FAQ→まとめの
// 日本語記事を生成。アフィリンク挿入、ステマ規制対応の広告表記を先頭に付与。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";
import { chat, isOffline } from "../lib/llm.js";
import { persona } from "../lib/team.js";

interface Tool {
  id: string; name: string; category: string; categoryId: string;
  reward_yen: number; affiliate_url: string; one_liner: string; price_from_yen: number;
  period?: string; langs?: string; job_support?: string; refund?: string; portfolio?: string; format?: string;
}
interface Affiliates { disclosure: string; tools: Tool[]; review_axes?: string[]; subsidy_ids?: string[]; }

function toolsFor(item: KeywordItem, all: Tool[]): Tool[] {
  if (item.kind === "pillar" || item.template.startsWith("money:best-for") || (item.kind === "info" && item.tools.length > 1)) {
    const inCluster = all.filter((t) => item.tools.includes(t.id));
    return inCluster.length ? inCluster : all.slice(0, 4);
  }
  const named = all.filter((t) => item.tools.includes(t.id));
  return named.length ? named : all.slice(0, 3);
}

// 私の設計判断：モバイルでも見やすい6列（価格だけでなく「意思決定に効く」軸を選定）。
function comparisonTable(tools: Tool[]): string {
  const head = "| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) |\n|---|---|---|---|---|---|";
  const rows = tools.map((t) =>
    `| [${t.name}](${t.affiliate_url}) | ${t.format ?? "―"} | ${t.period ?? "―"} | ${t.job_support ?? "―"} | ${t.refund ?? "―"} | ${t.price_from_yen === 0 ? "無料" : t.price_from_yen.toLocaleString() + "円〜"} |`);
  return [head, ...rows].join("\n");
}

// 日本語の実質文字数（記号・空白除外）。quality.ts と同一基準。
function charCount(md: string): number {
  return md.replace(/[#>*`|\-\s]/g, "").length;
}

// 競合評価で判明した最重要課題「深度1/10」への対策：
// 上位サイト並みの長編（目標6,000字超）を、小型モデルでも安定して出せるよう
// 前半・中盤・後半の3回に分けて生成し、不足時は補筆する。
async function writeBody(item: KeywordItem, tools: Tool[], axes: string[], subsidyIds: string[]): Promise<string> {
  const list = tools.map((t) => `${t.name}（${t.category}／${t.format ?? ""}／${t.period ?? ""}／転職支援:${t.job_support ?? "?"}／返金:${t.refund ?? "?"}／${t.price_from_yen === 0 ? "無料" : t.price_from_yen.toLocaleString() + "円〜"}／${t.one_liner}）`).join("\n");
  const axesText = axes.length ? axes.join("・") : "教育の質・サポート・料金";
  const subsidyNames = tools.filter((t) => subsidyIds.includes(t.id)).map((t) => t.name);
  const subsidyLine = subsidyNames.length
    ? `教育訓練給付（最大70%還元）の対象コースがあるのは: ${subsidyNames.join("・")}。それ以外は対象外と明記する。`
    : `今回のスクールに給付金対象の明確な情報はないため、給付金の一般的な仕組みのみ説明し対象と断定しない。`;
  const system = `${persona("writer")}\n${persona("editor")}\nあなたは日本語ネイティブのプロ編集者です。読者がこの1本で意思決定を完了できる、深く正直で中立的な記事を書きます。H1（# タイトル）は付けません。誇大・断定（絶対/必ず/日本一 等）は使いません。事実（価格・実績）を捏造せず、与えられたデータの範囲で書きます。同じ内容の言い換えによる水増しは禁止。具体例・判断基準・数字で深くします。`;
  const ctx = [
    `TOPIC: ${item.keyword}`,
    `想定読者: プログラミングスクールを比較検討中で、申込直前の人。`,
    `扱ってよいサービス（この中だけ。長所も短所も正直に）:\n${list}`,
    `本記事の検証軸: ${axesText}。`,
  ].join("\n");

  const p1 = await chat(
    `${ctx}\n\nこれは全体で6,000字以上になる長編記事の【前半】です。次のセクションだけを ## 見出しで書いてください（この部分だけで1,800字以上）:\n1. 冒頭: 読者の悩みに具体的に共感し、結論（目的別のおすすめ1〜3校）を先に明示\n2. この記事の比較・検証方法（検証軸を明記）\n3. 失敗しない選び方（目的・形式・期間・料金・転職支援それぞれの判断基準を具体的に）\n4. 比較一覧表（| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) | の6列）`,
    { system, maxTokens: 4000, temperature: 0.7 });

  const p2 = await chat(
    `${ctx}\n\n長編記事の【中盤】です。前半には結論・検証方法・選び方・比較表が既にあります。重複せず、次のセクションだけを ## 見出しで書いてください（この部分だけで2,500字以上）:\n5. 各スクールの詳細（1校ずつ ### 小見出しで: 特徴・カリキュラム・向いている人・向かない人・注意点。デメリット必須）\n6. 料金の詳細と給付金でいくら安くなるか: ${subsidyLine} 対象校は「受講料 − 給付金＝実質負担額」の計算例を示す`,
    { system, maxTokens: 6000, temperature: 0.7 });

  const p3 = await chat(
    `${ctx}\n\n長編記事の【後半】です。前半・中盤には結論、選び方、比較表、各校詳細、料金・給付金の解説が既にあります。重複せず、次のセクションだけを ## 見出しで書いてください（この部分だけで1,800字以上）:\n7. 目的別の使い分け（「◯◯な人は△△」を全スクール分、明確に）\n8. 「やめとけ」と言われる理由への中立的な見解（事実ベースで）\n9. 卒業後のキャリア・年収の一般的な実態（断定しない）\n10. よくある質問（5問。### で質問文を見出しに）\n11. まとめ（迷ったら無料カウンセリング/無料相談を勧める自然なCTA）`,
    { system, maxTokens: 4000, temperature: 0.7 });

  let body = [p1, p2, p3].map((s) => s.trim()).join("\n\n");

  // 見出しの整形: プロンプトの節番号や「冒頭：」が見出しにそのまま残ると機械生成感が出るため除去。
  body = body
    .replace(/^(#{2,3})\s*\d+[\.．、]?\s*/gm, "$1 ")
    .replace(/^(#{2,3})\s*(冒頭|前半|中盤|後半)[:：]\s*/gm, "$1 ");

  // 目標に届かない場合は、まだ書かれていない読者の疑問を1回だけ補筆。
  if (charCount(body) < config.pipeline.minWords + 300 && !isOffline()) {
    const p4 = await chat(
      `${ctx}\n\n以下は執筆済みの記事です。この記事でまだ答えられていない、申込直前の読者が抱く疑問を3つ選び、それぞれ ### の見出しで具体的に解説してください（合計1,200字以上。既出内容の繰り返し禁止。見出しは「## さらに詳しく知りたい人へ」の配下に置く想定で ### のみ）:\n\n---\n${body.slice(0, 6000)}`,
      { system, maxTokens: 3000, temperature: 0.7 });
    body += `\n\n## さらに詳しく知りたい人へ\n\n${p4.trim()}`;
  }
  return body;
}

export async function generateNext(): Promise<KeywordItem | null> {
  const aff: Affiliates = JSON.parse(readFileSync(paths.affiliates, "utf8"));
  const state = loadState();
  const item = state.keywords.find((k) => k.status === "queued");
  if (!item) { console.log("[writer] キュー待ちなし。"); return null; }

  const tools = toolsFor(item, aff.tools);
  let body = await writeBody(item, tools, aff.review_axes ?? [], aff.subsidy_ids ?? []);

  if (/pillar|money:vs|money:best-for/.test(item.template) && !body.includes("|")) {
    body += `\n\n## 比較一覧\n\n${comparisonTable(tools)}\n`;
  }

  const now = new Date();
  const fm = [
    "---",
    `title: ${JSON.stringify(item.keyword)}`,
    `description: ${JSON.stringify(`${item.keyword}。料金・評判・特徴を比較して、あなたに合うスクールを解説します。`)}`,
    `author: ${JSON.stringify(config.site.author)}`,
    `pubDate: ${now.toISOString().slice(0, 10)}`,
    `updatedDate: ${now.toISOString().slice(0, 10)}`,
    `tools: [${tools.map((t) => JSON.stringify(t.name)).join(", ")}]`,
    `draft: false`,
    "---",
  ].join("\n");

  // ステマ規制対応：本文冒頭に明瞭な広告表記。
  const disclosure = `> 【広告】${aff.disclosure}`;
  const md = `${fm}\n\n${disclosure}\n\n${body.trim()}\n`;

  mkdirSync(paths.drafts, { recursive: true });
  writeFileSync(resolve(paths.drafts, `${item.slug}.md`), md);
  item.status = "drafted";
  saveState(state);
  console.log(`[writer/editor] 下書き生成 "${item.keyword}" ${isOffline() ? "(オフライン)" : ""}`);
  return item;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2]) || 1;
  (async () => { for (let i = 0; i < n; i++) if (!(await generateNext())) break; })();
}

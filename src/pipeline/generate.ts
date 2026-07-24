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
interface Affiliates { disclosure: string; tools: Tool[]; review_axes?: string[]; }

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

async function writeBody(item: KeywordItem, tools: Tool[], axes: string[]): Promise<string> {
  const list = tools.map((t) => `${t.name}（${t.category}／${t.format ?? ""}／${t.period ?? ""}／転職支援:${t.job_support ?? "?"}／${t.price_from_yen === 0 ? "無料" : t.price_from_yen.toLocaleString() + "円〜"}／${t.one_liner}）`).join("\n");
  const axesText = axes.length ? axes.join("・") : "教育の質・サポート・料金";
  const system = `${persona("writer")}\n${persona("editor")}\nあなたは日本語ネイティブのプロ編集者です。読者の意思決定に役立つ、正直で中立的な記事を書きます。H1（# タイトル）は付けません。誇大・断定（絶対/必ず/日本一 等）は使いません。事実（価格・実績）を捏造しません。水増しせず具体的に書きます。`;
  // 構成は事例の丸写しではなく、検索意図（比較検討→意思決定）から私が設計した順序。
  const prompt = [
    `TOPIC: ${item.keyword}`,
    `想定読者: プログラミングスクールを比較検討中で、申込直前の人。`,
    `扱ってよいサービス（この中だけ。長所も短所も正直に）:\n${list}`,
    `本記事の検証軸（信頼性のため冒頭近くで明示する）: ${axesText}。`,
    `以下の順で ## 見出しを付けて構成する:`,
    `1. 冒頭: 読者の悩みに一文で共感し、結論（おすすめを1〜3校）を先に明示。`,
    `2. この記事の比較・検証方法（上記の検証軸で公平に比較したと明記）。`,
    `3. 失敗しない選び方（目的・形式・期間・料金・転職支援の観点で判断基準を提示）。`,
    `4. 各スクールの特徴・向いている人・注意点（デメリットも正直に併記）。`,
    `5. 「やめとけ」と言われる理由への中立的な見解（過度に煽らず事実ベース）。`,
    `6. 料金と、卒業後のキャリア・年収の一般的な実態（断定しない）。`,
    `7. よくある質問（3つ）。`,
    `8. まとめ（迷ったらまず無料カウンセリング/無料相談を勧める自然なCTA）。`,
    `文字数の目安: 1800〜2600字。広告表記は自動付与するので本文には書かない。`,
  ].join("\n");
  return chat(prompt, { system, maxTokens: 3200, temperature: 0.7 });
}

export async function generateNext(): Promise<KeywordItem | null> {
  const aff: Affiliates = JSON.parse(readFileSync(paths.affiliates, "utf8"));
  const state = loadState();
  const item = state.keywords.find((k) => k.status === "queued");
  if (!item) { console.log("[writer] キュー待ちなし。"); return null; }

  const tools = toolsFor(item, aff.tools);
  let body = await writeBody(item, tools, aff.review_axes ?? []);

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

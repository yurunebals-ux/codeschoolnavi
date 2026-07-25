// ROLES: シニアライター + 編集長 + 収益責任者（日本語）
// キューから1件取り、直接的な結論→評価軸→各サービス解説→比較表→FAQ→まとめの
// 日本語記事を生成。アフィリンク挿入、ステマ規制対応の広告表記を先頭に付与。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem } from "../lib/store.js";
import { chat, isOffline } from "../lib/llm.js";
import { persona } from "../lib/team.js";
import { scanAiese, deaiMechanical } from "../lib/aiese.js";

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

// ── 文体規約 ────────────────────────────────────────────────
// 「AIっぽく書かないで」は指示として機能しない。何がダメで何に置き換えるのかを
// 具体的に示さないと、モデルは同じ型を出し続ける。そこで禁止語を列挙し、
// 置き換え後の言い方まで指定する。判定は src/lib/aiese.ts で機械的に行い、
// 基準を超えたら書き直させる（＝指示が効いたかを測れるようにする）。
const STYLE = `【文体規約：厳守】
この規約に反した原稿は差し戻される。読者は「人が書いたかどうか」を無意識に判定しており、以下の型が出た瞬間に信用しなくなる。

1. 次の語句は使用禁止。
禁止: 結論として / これらを踏まえ / まとめると / 以下の通り / 〜が重要です / 重要なポイント / 〜が求められます / 〜と言えます / 〜と言えるでしょう / ではないでしょうか / いかがでしょうか / 充実 / 充実度 / 費用対効果 / 総合的に / 多角的 / さまざまな / 様々な / 非常に / しっかり / ぜひ / 〜しましょう / 〜してみてください / 自分に合った / 理想的な / 〜な方も多いのではないでしょうか
2. 言い換えの指定。
「サポートが充実している」→「質問すると平均◯分で返ってくる」のように、何がどれだけあるのかを書く。
「費用対効果が高い」→「◯◯万円払って△△が手に入る」と金額と中身で書く。
「〜が重要です」→ なぜ重要かを1文で書く。重要だと言うだけの文は削る。
「〜と言えます」→ 言い切るか、言い切れないなら「公式サイトには◯◯と書かれている」と出典を示す。
3. 文のリズム。
・「です・ます」で終わる文が続いたら、途中に15字以下の短い文を混ぜる。例:「ここが分かれ目だ。」「理由は単純です。」
・体言止めを1記事に3〜5回使う。例:「実質負担は約9万円。」
・1文は原則60字以内。3行以上続く文を書かない。
4. 段落の作り方。
・箇条書きは1つの節に1回まで。残りは文章で説明する。太字ラベル＋説明を並べた箇条書き（**目的の明確化** のような形）は禁止。
・「AやB、Cなど」の三点並列は1記事に2回まで。
・抽象語で始めない。段落の1文目に必ず数字・固有名詞・具体的な行動のいずれかを入れる。
5. 書き出し。
共感から入らない。「迷う人が多い」「悩ましいところです」で始めるのは禁止。読者がいま知りたい事実（金額・期間・条件のどれか）を1文目に置く。`;

// 競合評価で判明した最重要課題「深度1/10」への対策：
// 上位サイト並みの長編（目標6,000字超）を、小型モデルでも安定して出せるよう
// 前半・中盤・後半の3回に分けて生成し、不足時は補筆する。
async function writeBody(item: KeywordItem, tools: Tool[], axes: string[], subsidyIds: string[]): Promise<string> {
  const list = tools.map((t) => `${t.name}（${t.category}／${t.format ?? ""}／${t.period ?? ""}／転職支援:${t.job_support ?? "?"}／返金:${t.refund ?? "?"}／${t.price_from_yen === 0 ? "無料" : t.price_from_yen.toLocaleString() + "円〜"}／${t.one_liner}）`).join("\n");
  const axesText = axes.length ? axes.join("・") : "教育の質・サポート・料金";
  const subsidyNames = tools.filter((t) => subsidyIds.includes(t.id)).map((t) => t.name);
  // 給付金の数字は /kyufukin/ の解説ページと同一の一次情報に合わせる。
  // （旧実装は「最大70%還元」で固定していたが、専門実践は上乗せ込みで最大80%。
  //   区分ごとに率と上限が違うため、一括して「最大◯%」と書かせない。）
  const KYUFU_FACTS =
    `教育訓練給付は3区分で率と上限が違う。一般=受講費用の20%（上限10万円）、` +
    `特定一般=40%（上限20万円）、専門実践=受講中50%（年間上限40万円）＋資格取得や就職で20%（年間上限16万円）` +
    `＋賃金が5%以上上がった場合さらに10%（年間上限8万円）で最大80%。` +
    `特定一般と専門実践は受講開始日の2週間前までにハローワークでの事前手続きが必須（遅れると対象外）。` +
    `区分をまとめて「最大◯%」と書かない。金額を書くときは必ず区分名を添える。` +
    `詳しい対象条件と申請手順は自サイトの /kyufukin/ に集約しているので、そこへ内部リンクする。`;
  const subsidyLine = subsidyNames.length
    ? `${KYUFU_FACTS} 給付金の対象コースがあるのは: ${subsidyNames.join("・")}。それ以外は対象外と明記する。対象校は「受講料 − 給付額 ＝ 実質負担額」を具体的な数字で計算して示す（どの区分で計算したかを書く）。`
    : `${KYUFU_FACTS} ただし今回のスクールが対象講座かどうかの確実な情報はないため、仕組みの説明にとどめ、対象だと断定しない。`;
  const system = `${persona("writer")}\n${persona("editor")}\nあなたは日本語ネイティブのプロ編集者です。読者がこの1本で意思決定を完了できる、深く正直で中立的な記事を書きます。H1（# タイトル）は付けません。誇大・断定（絶対/必ず/日本一 等）は使いません。事実（価格・実績）を捏造せず、与えられたデータの範囲で書きます。同じ内容の言い換えによる水増しは禁止。具体例・判断基準・数字で深くします。\n\n${STYLE}`;
  const ctx = [
    `TOPIC: ${item.keyword}`,
    `想定読者: プログラミングスクールを比較検討中で、申込直前の人。`,
    `扱ってよいサービス（この中だけ。長所も短所も正直に）:\n${list}`,
    `本記事の検証軸: ${axesText}。`,
  ].join("\n");

  const p1 = await chat(
    `${ctx}\n\nこれは全体で6,000字以上になる長編記事の【前半】です。次のセクションだけを ## 見出しで書いてください（この部分だけで1,800字以上）:\n1. 冒頭: 共感や前置きを書かずに、1文目から金額か期間か条件の事実を出す。そのうえで目的別の結論（どの目的ならどの1〜3校か）を先に示す\n2. この記事の比較・検証方法（検証軸を明記。軸を「N個」と数で書く場合は列挙した数と必ず一致させる）\n3. 失敗しない選び方（目的・形式・期間・料金・転職支援それぞれの判断基準。「◯◯なら△△を選ぶ」の形で、判断できる基準値を数字で書く）\n4. 比較一覧表（| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) | の6列）`,
    { system, maxTokens: 4000, temperature: 0.7 });

  const p2 = await chat(
    `${ctx}\n\n長編記事の【中盤】です。前半には結論・検証方法・選び方・比較表が既にあります。重複せず、次のセクションだけを ## 見出しで書いてください（この部分だけで2,500字以上）:\n5. 各スクールの詳細（1校ずつ ### 小見出しで: 特徴・カリキュラム・向いている人・向かない人・注意点。デメリット必須）\n6. 料金の詳細と給付金でいくら安くなるか: ${subsidyLine} 対象校は「受講料 − 給付金＝実質負担額」の計算例を示す`,
    { system, maxTokens: 6000, temperature: 0.7 });

  const p3 = await chat(
    `${ctx}\n\n長編記事の【後半】です。前半・中盤には結論、選び方、比較表、各校詳細、料金・給付金の解説が既にあります。重複せず、次のセクションだけを ## 見出しで書いてください（この部分だけで1,800字以上）:\n7. 目的別の使い分け（「◯◯な人は△△」を全スクール分、明確に）\n8. 「やめとけ」と言われる理由への中立的な見解（事実ベースで）\n9. 卒業後のキャリア・年収の一般的な実態（断定しない）\n10. よくある質問（5問。### で質問文を見出しに）\n11. 最後の節。見出しを「まとめ」「最後に」「総括」にしてはいけない。ここまでに書いた内容を要約し直すことも禁止（読者は同じ話を2回読まされることを最も嫌う）。代わりに「今日やること」を手順で書く: (a) 申込前に必ず自分で確認すべき項目を3つ、確認方法つきで（例: 給付金の指定講座かどうかは講座番号で検索して確認する）、(b) 無料カウンセリングで聞くべき質問を3つ、そのまま口に出せる文で、(c) 迷いが残る場合の判断の分かれ目を1つ。この節の見出しは内容に即した具体的なもの（例「申し込む前に確認する3つのこと」）にする`,
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

  body = await depersonalizeAi(body, system);
  return body;
}

// ── 推敲パス ──────────────────────────────────────────────────
// 生成直後の原稿は、文体規約を渡してあっても必ずAI特有の型が残る。
// そこで「機械置換 → 検査 → 残っている型を名指しして書き直させる」を繰り返す。
// 検査器が具体的な指摘を返すので、モデルは何を直せばよいか分かる状態で書き直せる。
const AIESE_TARGET = 30;   // ここを下回れば合格
const MAX_ROUNDS = 2;      // 1記事あたりの書き直し上限（コスト管理）

async function depersonalizeAi(body: string, system: string): Promise<string> {
  let out = deaiMechanical(body);
  if (isOffline()) return out;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const s = scanAiese(out);
    if (s.score <= AIESE_TARGET) {
      console.log(`[editor] 文体OK score=${s.score}（${round - 1}回書き直し）`);
      return out;
    }
    const orders = [
      s.hits.length ? `残っている禁止語句: ${s.top(12).join("、")}。すべて具体的な記述に置き換える（語を消すだけでなく、何がどれだけあるのかを書く）。` : "",
      s.structure.length ? `構造の問題: ${s.structure.join(" / ")}。太字ラベルの箇条書きは文章に開き、要約だけの節は「読者が次にやること」に書き換える。` : "",
      s.rhythm.length ? `リズムの問題: ${s.rhythm.join(" / ")}。15字以下の短い文と体言止めを混ぜて、文末の型を崩す。` : "",
    ].filter(Boolean).join("\n");

    console.log(`[editor] 文体書き直し ${round}回目 score=${s.score} → ${s.structure.length + s.rhythm.length}件の構造/リズム指摘`);

    const revised = await chat(
      `以下の記事を、意味・事実・数字・見出し構成・マークダウン記法・リンクを一切変えずに、文体だけ書き直してください。\n\n${orders}\n\n守ること:\n・見出し（## と ###）の個数と順序は変えない。表とリンクはそのまま残す。\n・価格・期間・パーセント・スクール名は1文字も変えない。新しい事実を足さない。\n・文字数は減らさない（同じ長さか少し長く）。\n・記事全体を最初から最後まで出力する。省略や「（以下省略）」は禁止。\n\n---\n${out}`,
      { system, maxTokens: 12000, temperature: 0.4 });

    const cand = deaiMechanical(revised.trim());
    // 書き直しが失敗（途中で切れた・短くなった）した場合は元を残す。
    // 文体より情報量のほうが大事なので、ここは保守的に判定する。
    const ok =
      charCount(cand) >= charCount(out) * 0.9 &&
      (cand.match(/^##\s+/gm) || []).length >= (out.match(/^##\s+/gm) || []).length - 1 &&
      !/以下省略|（省略）/.test(cand);
    if (!ok) {
      console.log(`[editor] 書き直しを破棄（本文が欠けた: ${charCount(cand)}字 vs ${charCount(out)}字）`);
      return out;
    }
    if (scanAiese(cand).score >= scanAiese(out).score) {
      console.log(`[editor] 書き直しで改善せず、元の原稿を採用`);
      return out;
    }
    out = cand;
  }
  console.log(`[editor] 文体スコア最終 ${scanAiese(out).score}（上限${MAX_ROUNDS}回に到達）`);
  return out;
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

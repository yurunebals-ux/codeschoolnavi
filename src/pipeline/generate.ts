// ROLES: シニアライター + 編集長 + 収益責任者（日本語）
//
// キューから1件取り、記事の「種類」に応じた構成で日本語記事を生成する。
//
// 【2026-09-11 の作り直しの理由】
// それまでは全記事が「特徴→カリキュラム→向いている人→注意点→料金→目的別→やめとけ→
// キャリア→FAQ→まとめ」の同じ型で、データにない数字は書けないためAIが一般論と
// 「公式サイトで確認してください」で埋めていた。オーナーの評価は「つまらないものが多い」。
// 直したこと:
//   1. 種類ごとに別の構成（評判／料金／向き不向き／2校比較／おすすめ／とは／トピック／ニュース）
//   2. 事実は機械で入れる（基本データ表）。LLMには「データにない固有名詞・数字を書かない」を課す
//   3. 単校記事は「角度」を slug から決めて1節を変える（全記事が同じ顔にならない）
//   4. 同カテゴリの参考校を渡し、数字で位置づけさせる
//   5. 口コミの捏造を禁止し、「公式の主張→編集部の読み」の形で書かせる
//   6. 3回生成→2回生成。重複除去と構造検査は書き直しの「後」にも掛ける
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../lib/config.js";
import { loadState, saveState, STRUCTURE_VERSION, type KeywordItem } from "../lib/store.js";
import { chat, isOffline } from "../lib/llm.js";
import { persona } from "../lib/team.js";
import { scanAiese, deaiMechanical } from "../lib/aiese.js";
import { findStructureProblems, headingList } from "../lib/structure.js";
import { enrichItems, isEnglish, type NewsItem } from "./news.js";

export interface Tool {
  id: string; name: string; category: string; categoryId: string;
  reward_yen: number; affiliate_url: string; official_url?: string; one_liner: string; price_from_yen: number;
  price_note?: string;
  period?: string; langs?: string; job_support?: string; refund?: string; portfolio?: string; format?: string;
  /**
   * 給付金の但し書き。「対象コースがある」と「読者が見ている最安プランが対象」は別物なので、
   * どのコースがどの区分で対象か（対象外ならその理由）を1行で持つ。プロンプトへそのまま渡す。
   */
  subsidy_note?: string;
}
export interface Affiliates { disclosure: string; tools: Tool[]; review_axes?: string[]; subsidy_ids?: string[]; }

/** 記事の種類ごとの下限字数。単校記事に6,000字を課すと一般論で水増しされる。 */
export function minWordsFor(item: KeywordItem): number {
  const base = config.pipeline.minWords; // ワークフローの MIN_WORDS（4200）
  if (item.template === "news:weekly") return 1800;
  if (item.template === "news:hot") return 1400;
  if (item.template.startsWith("news:")) return 900;
  if (item.template.startsWith("topic:")) return Math.round(base * 0.7);
  if (/^money:(review|pricing|doubt)$|^info:what$/.test(item.template)) return Math.round(base * 0.75);
  return base;
}

function toolsFor(item: KeywordItem, all: Tool[]): Tool[] {
  if (item.kind === "pillar" || item.template.startsWith("money:best-for") || (item.kind === "info" && item.tools.length > 1)) {
    const inCluster = all.filter((t) => item.tools.includes(t.id));
    return inCluster.length ? inCluster : all.slice(0, 4);
  }
  const named = all.filter((t) => item.tools.includes(t.id));
  if (named.length) return named;
  if (item.template.startsWith("topic:")) return [];
  if (item.template.startsWith("news:")) {
    // ニュース記事はスクールに無理に結びつけない（オーナー方針 2026-09-11「全ての記事をアフィリエイトに
    // 結びつけなくてもよい」）。参考としてAI系／転職系から2校だけ渡す。数字はここにあるものしか書けない。
    const n = JSON.stringify(item.news ?? {});
    const cat = /AI|人工知能|生成|機械学習|データ/.test(n) ? "ai" : "tenshoku";
    return all.filter((t) => t.categoryId === cat).slice(0, 2);
  }
  return all.slice(0, 3);
}

function yen(t: Tool): string {
  return t.price_from_yen === 0 ? "無料" : `${t.price_from_yen.toLocaleString()}円〜`;
}

// 私の設計判断：モバイルでも見やすい6列（価格だけでなく「意思決定に効く」軸を選定）。
function comparisonTable(tools: Tool[]): string {
  const head = "| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) |\n|---|---|---|---|---|---|";
  const rows = tools.map((t) =>
    `| ${t.name} | ${t.format ?? "―"} | ${t.period ?? "―"} | ${t.job_support ?? "―"} | ${t.refund ?? "―"} | ${yen(t)} |`);
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
・体言止めを1記事に3〜5回使う。例:「分かれ目は返金条件。」
・1文は原則60字以内。3行以上続く文を書かない。
4. 段落の作り方。
・箇条書きは1つの節に1回まで。残りは文章で説明する。太字ラベル＋説明を並べた箇条書き（**目的の明確化** のような形）は禁止。
・「AやB、Cなど」の三点並列は1記事に2回まで。
・抽象語で始めない。段落の1文目に必ず数字・固有名詞・具体的な行動のいずれかを入れる。
5. 書き出し。
共感から入らない。「迷う人が多い」「悩ましいところです」で始めるのは禁止。読者がいま知りたい事実（金額・期間・条件のどれか）を1文目に置く。`;

// ── データ規約 ──────────────────────────────────────────────
// 「つまらない」の正体は、書ける事実が少ないのに長さを求められて一般論で埋めること。
// 一般論を禁じ、事実と編集部の解釈を分けさせる。
const DATA_RULES = `【データ規約：厳守】
・コース名・金額・期間・人数・割合などの固有情報は、下の「データ」にあるものだけを書く。データにない数字や固有名詞（架空のコース名など）を作らない。
・データにない項目（例: 返金保証の条件）は「公式サイトに記載がない」と記事内で1回だけ書き、以後は触れない。「公式サイトで確認してください」の類は記事全体で2回まで。
・口コミ・受講生の声・「〜という声がある」「〜と評判」「〜と言われている」は書かない（出典を示せないため）。代わりに「公式サイトには◯◯とある。編集部はこれを△△と読む」のように、事実と編集部の解釈を分けて書く。
・統計値（転職成功率・平均年収など）はデータにあるものだけ。無ければ書かない。
・見出しは読者の疑問文か、答えを含む具体的な文にする（例「3ヶ月で転職できるのか」「月3万円の分割は現実的か」）。「特徴」「カリキュラム」「注意点」「メリット」のような一語の見出しは禁止。
・同じ内容を別の節で繰り返さない。前置き・共感・要約の節を作らない。`;

// ── 単校記事の「角度」 ────────────────────────────────────────
// 同じ学校の評判記事でも、どの視点で1節を書くかを slug から決めて散らす。
// 決定的（同じ slug なら同じ角度）なので、再生成しても記事の顔が変わらない。
const ANGLES = [
  { title: "働きながら期間内に終わるか", brief: "平日夜2時間＋土日で受講した場合に間に合うかを、データにある期間から逆算して書く。どこで詰まりやすいかも具体的に。学習時間の目安がデータに無ければ、期間と形式（自習中心かライブか）から編集部の見方として書く。" },
  { title: "受講料のほかに何にいくらかかるか", brief: "入学金・分割手数料・期間延長・教材・PCなど、データにある範囲で総額の見立てを書く。データにない費目は「公式サイトに記載がない」と1回だけ書き、読者が確認すべき項目として列挙する。" },
  { title: "30代未経験でも現実的か", brief: "年齢条件（転職保証の上限など）・未経験からの到達点・転職支援の中身を、データにある条件で書く。条件がデータに無い場合は、無料カウンセリングで確認すべき質問文をそのまま書く。" },
  { title: "途中で挫折しないための仕組みがあるか", brief: "質問対応・メンタリング頻度・課題の量・期限など、続けやすさに関わる条件をデータの範囲で書き、挫折しやすい人の条件を具体的に書く。" },
  { title: "修了後に何ができるようになるか", brief: "ポートフォリオ・到達レベル・扱う言語や技術をデータの範囲で書き、それが転職市場でどう見られるかを編集部の見方として書く（断定しない）。" },
];
function angleFor(slug: string) {
  let h = 2166136261;
  for (const ch of slug) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; }
  return ANGLES[(h >>> 7) % ANGLES.length];
}

/** 同カテゴリの参考校を2つ。無ければ他カテゴリから。 */
function peersFor(main: Tool, all: Tool[]): Tool[] {
  const same = all.filter((t) => t.id !== main.id && t.categoryId === main.categoryId);
  const other = all.filter((t) => t.id !== main.id && t.categoryId !== main.categoryId);
  return [...same, ...other].slice(0, 2);
}

function toolLine(t: Tool): string {
  const parts = [
    `${t.name}（${t.category}）`,
    `形式:${t.format ?? "不明"}`, `期間:${t.period ?? "不明"}`, `受講料:${yen(t)}`,
    t.price_note ? `コース別料金:${t.price_note}` : "",
    `学べる内容:${t.langs ?? "不明"}`, `転職支援:${t.job_support ?? "不明"}`, `返金保証:${t.refund ?? "不明"}`,
    `ポートフォリオ制作:${t.portfolio ?? "不明"}`, `一言:${t.one_liner}`,
  ].filter(Boolean);
  return parts.join("／");
}

function firstSentence(s: string): string {
  return s.split("。")[0].replace(/\d{4}-\d{2}-\d{2}.*$/, "").trim();
}

/** 機械で入れる基本データ表。LLMに事実を書かせないための安全装置。 */
function factBox(t: Tool, eligible: boolean): string {
  const now = new Date();
  const cell = (s?: string) => (s && s !== "―" ? s : "公式サイトに記載なし").replace(/\|/g, "／");
  const price = `${yen(t)}${t.price_note ? `。コース別: ${t.price_note}` : ""}`;
  const subsidy = eligible
    ? `対象講座あり（${t.subsidy_note ? firstSentence(t.subsidy_note) : "区分は本文参照"}）`
    : `対象講座なし${t.subsidy_note ? `（${firstSentence(t.subsidy_note)}）` : ""}`;
  return [
    `## 基本データ（${now.getFullYear()}年${now.getMonth() + 1}月時点）`,
    "",
    "| 項目 | 内容 |",
    "|---|---|",
    `| 形式 | ${cell(t.format)} |`,
    `| 期間 | ${cell(t.period)} |`,
    `| 受講料（税込） | ${cell(price)} |`,
    `| 学べる内容 | ${cell(t.langs)} |`,
    `| 転職支援 | ${cell(t.job_support)} |`,
    `| 返金保証 | ${cell(t.refund)} |`,
    `| ポートフォリオ制作 | ${cell(t.portfolio)} |`,
    `| 教育訓練給付金 | ${cell(subsidy)} |`,
  ].join("\n");
}

/** 冒頭段落の直後（最初の ## の前）に節を差し込む */
function insertAfterIntro(body: string, block: string): string {
  const i = body.search(/^##\s+/m);
  if (i < 0) return `${body.trimEnd()}\n\n${block}\n`;
  return `${body.slice(0, i).trimEnd()}\n\n${block}\n\n${body.slice(i)}`;
}

/**
 * 同じ ## 見出しが2回出てくる原稿を1つにまとめる。
 * 各LLM呼び出しには「前半には◯◯が既にあります。重複せず」と伝えているが、モデルは前の
 * 出力を見ていないので、指示だけでは重複を防ぎきれない。残すのは長いほう（文字数）。
 */
export function normalizeHeadings(md: string): string {
  // 節番号は「## 5. 」「## 5）」のように区切りがある場合だけ落とす。区切りなしで数字を消すと
  // 「## 50代からの…」が「## 代からの…」になる（2026-09-11 実測）。
  let out = md.replace(/^(#{2,3})\s+\d{1,2}[.．、)）]\s*/gm, "$1 ");
  out = out.replace(/^##\s+(?:まとめ|最後に|総括)\s*$/gm, "## 迷ったときの決め方");
  return out;
}

// 表の区切り行（|---|---|）が抜けた表を直す。LLMがときどき落とし、検査で却下されて1日分が空振りする
// （2026-09-11 AVILEN 記事）。ヘッダ行の列数に合わせて区切り行を挿入する。
export function repairTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!/^\s*\|/.test(lines[i]) || (i > 0 && /^\s*\|/.test(lines[i - 1]))) continue; // 表の1行目だけ見る
    const next = lines[i + 1] ?? "";
    if (/^\s*\|\s*:?-{2,}/.test(next)) continue;
    const n = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
    out.push("|" + " --- |".repeat(n));
  }
  return out.join("\n");
}

/** 自サイトへのリンクの後始末（全記事共通） */
export function fixInternalLinks(body: string): string {
  // 自サイトへのリンクを絶対URLで書いてくる（https://example.com/kyufukin/ など。本番で4記事が
  // example.com へ飛んでいた、2026-09-11 実測）。自サイト・example.com の絶対URLは相対パスに直す。
  body = body.replace(/\]\(https?:\/\/(?:www\.)?(?:example\.com|codeschoolnavi\.com)(\/[^)\s]*)?\)/g, (_m, path) => `](${path || "/"})`);
  // 「/kyufukin/」とパスを地の文に書くだけでリンクにしないことがある（実測: ryokin-runteq、news-hot 1本目）。
  // Markdown リンクの中は触らず、裸のパスだけリンクに置き換える。
  body = body.replace(/「?(?<!\]\()(?<![\w/])(\/kyufukin\/)」?/g, (m, path, off, str) => {
    const before = str.slice(Math.max(0, off - 2), off);
    return /\]\($/.test(before) || /\($/.test(before) ? m : "[給付金の使い方](/kyufukin/)";
  });
  body = body.replace(/(?<!\]\()(?<![\w/])\/shindan\/(?![\w/])/g, "[6問診断](/shindan/)");
  return body;
}

export function dedupeSections(md: string): string {
  const lines = md.split("\n");
  const heads: { title: string; start: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m && !/^###/.test(l)) heads.push({ title: m[1], start: i });
  });
  if (heads.length < 2) return md;

  const blocks = heads.map((h, i) => ({
    title: h.title,
    start: h.start,
    end: i + 1 < heads.length ? heads[i + 1].start : lines.length,
  }));
  // 残すのは情報量が多いほう。行数ではなく文字数で比べる。
  const weight = (b: { start: number; end: number }) =>
    lines.slice(b.start, b.end).join("").length;
  const keep = new Map<string, number>();
  blocks.forEach((b, i) => {
    const cur = keep.get(b.title);
    if (cur === undefined || weight(b) > weight(blocks[cur])) keep.set(b.title, i);
  });
  if (keep.size === blocks.length) return md;

  const drop = new Set<number>();
  blocks.forEach((_, i) => { if (keep.get(blocks[i].title) !== i) drop.add(i); });
  const out: string[] = lines.slice(0, blocks[0].start);
  blocks.forEach((b, i) => { if (!drop.has(i)) out.push(...lines.slice(b.start, b.end)); });
  console.log(`[writer] 重複した見出しを${drop.size}節ぶん削除: ${[...drop].map((i) => blocks[i].title).join(" / ")}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 先頭の DESCRIPTION: 行を取り出す（無ければ null） */
function takeDescription(md: string): { body: string; description: string | null } {
  const m = md.match(/^\s*DESCRIPTION[:：]\s*(.+)\s*\n/);
  if (!m) return { body: md, description: null };
  return { body: md.slice(m[0].length), description: m[1].replace(/^["「]|["」]$/g, "").trim() };
}
function takeTitle(md: string): { body: string; title: string | null } {
  const m = md.match(/^\s*TITLE[:：]\s*(.+)\s*\n/);
  if (!m) return { body: md, title: null };
  return { body: md.slice(m[0].length), title: m[1].replace(/^["「]|["」]$/g, "").trim() };
}

function subsidyLineFor(tools: Tool[], subsidyIds: string[]): string {
  const subsidyNames = tools.filter((t) => subsidyIds.includes(t.id)).map((t) => t.name);
  // 給付金の数字は /kyufukin/ の解説ページと同一の一次情報に合わせる。
  const KYUFU_FACTS =
    `教育訓練給付は3区分で率と上限が違う。一般=受講費用の20%（上限10万円）、` +
    `特定一般=40%（上限20万円）、専門実践=受講中50%（年間上限40万円）＋資格取得や就職で20%（年間上限16万円）` +
    `＋賃金が5%以上上がった場合さらに10%（年間上限8万円）で最大80%。` +
    `特定一般と専門実践は受講開始日の2週間前までにハローワークでの事前手続きが必須（遅れると対象外）。` +
    `区分をまとめて「最大◯%」と書かない。金額を書くときは必ず区分名を添える。` +
    `詳しい対象条件と申請手順は自サイトの /kyufukin/ に集約しているので、そこへ内部リンクする。`;
  const subsidyNotes = tools
    .filter((t) => subsidyIds.includes(t.id) && t.subsidy_note)
    .map((t) => `${t.name}: ${t.subsidy_note}`);
  const outNotes = tools
    .filter((t) => !subsidyIds.includes(t.id) && t.subsidy_note)
    .map((t) => `${t.name}: ${t.subsidy_note}`);

  return subsidyNames.length
    ? `${KYUFU_FACTS} 給付金の対象コースがあるのは: ${subsidyNames.join("・")}。それ以外は対象外と明記する。` +
      `対象校の但し書き（これに反する記述をしてはいけない。「対象の案内がない」「対象か不明」と書くのも禁止）:\n${subsidyNotes.join("\n")}\n` +
      `対象校について「受講料 − 給付額 ＝ 実質負担額」を計算して示す場合は、` +
      `**必ず但し書きにある対象コースの受講料で計算し、そのコース名と区分を明記する**。対象コースの受講料がデータに無ければ計算しない。` +
      `比較表に出ている最安プランが対象外なら、その金額で給付額を計算してはいけない。` +
      (outNotes.length ? `\n対象外のスクール（割引計算をしてはいけない）:\n${outNotes.join("\n")}` : "")
    : `${KYUFU_FACTS} 今回のスクールは教育訓練給付金の対象講座を持たない。理由:\n${outNotes.join("\n") || "公式に対象である旨の記載がないため。"}\n` +
      `**実質負担額の割引計算を書いてはいけない。** 受講料は全額自己負担である前提で書き、` +
      `制度の仕組みに触れる場合も「このスクールは対象ではない」と明記する。` +
      `経済産業省のリスキリング事業は教育訓練給付金とは別制度なので、混同して「給付金」と呼ばない。`;
}

interface Plan { a: string; b: string; factBoxFor?: Tool; needTable: boolean }

/** 記事の種類ごとの構成。A（前半）と B（後半）の2回で書く。 */
function planFor(item: KeywordItem, tools: Tool[], all: Tool[], subsidyIds: string[]): Plan {
  const t = tools[0];
  const eligible = (x: Tool) => subsidyIds.includes(x.id);
  const subsidy = subsidyLineFor(tools, subsidyIds);
  const kyufuHead = tools.some(eligible) ? "給付金でいくら安くなるか" : "給付金は使えるか";
  const faq = `## よくある質問（### で質問文を4つ。答えは各120字以内。既出の内容の繰り返しは禁止）`;
  const last = `最後の節。見出しを「まとめ」「最後に」「総括」にしてはいけない。要約も禁止。「今日やること」を手順で書く: (a) 申込前に自分で確認する項目を3つ、確認方法つきで、(b) 無料カウンセリングでそのまま口に出せる質問を3つ、(c) 迷いが残る場合の判断の分かれ目を1つ。見出しは内容に即した具体的なもの（例「申し込む前に確認する3つのこと」）にする`;

  if (item.template === "money:review" && t) {
    const angle = angleFor(item.slug);
    const peers = peersFor(t, all).map((p) => p.name).join("・");
    return {
      factBoxFor: t, needTable: false,
      a: `1. 冒頭（見出しなし・200字以内）: 1文目に金額か期間。3文目までに編集部の判定（合う人／合わない人）を一言で。\n2. ## 編集部の判定：「◯◯な人には合う、△△な人には合わない」の形の見出し。判定理由を3つ、それぞれ数字か条件つきで。参考校（${peers}）との違いを最低1つ数字で示す。\n3. ## ${angle.title}（${t.name}に即した具体的な見出しに言い換えてよい）: ${angle.brief}\n4. ## 公式サイトの売り文句を読み解く: 公式の主張を3つ取り上げ（データの一言・学べる内容・転職支援・返金などから）、それぞれ「公式はこう書いている→条件・裏側→読者にとって何を意味するか」の順で書く。`,
      b: `5. ## 向いていない人と、その人に合う代替校: 条件を具体的に3つ。それぞれ参考校（${peers}）のどれが代わりになるかを、料金・期間・保証の数字つきで。\n6. ## ${kyufuHead}: ${subsidy}\n7. ${faq}\n8. ${last}`,
    };
  }
  if (item.template === "money:pricing" && t) {
    const peers = peersFor(t, all);
    const angle = angleFor(item.slug);
    return {
      factBoxFor: t, needTable: true,
      a: `1. 冒頭（見出しなし・200字以内）: 受講料の事実と、「高いか安いか」の判定を1文で。\n2. ## 同カテゴリ${peers.length}校と並べると高いのか: 比較表（| スクール | 受講料(税込) | 期間 | 1ヶ月あたりの目安 | 転職支援 | 返金保証 | の6列。${t.name}と参考校 ${peers.map((p) => p.name).join("・")} を載せる。1ヶ月あたりは受講料÷期間の月数で計算し「約◯万円」と書く）。表の下で、どこが高くてどこが安いのかを数字で読み解く。\n3. ## 料金の中身：どのコースがいくらか: コース別料金データからコースごとの金額と期間を書き、週あたり・月あたりに割った数字を示す。データにないコースは書かない。\n4. ## ${angle.title}: ${angle.brief}`,
      b: `5. ## ${kyufuHead}: ${subsidy}\n6. ## 支払い方法と返金：契約前に知っておくこと: 分割・返金・途中解約について、データにある範囲で。無いものは「公式サイトに記載がない」と1回だけ書き、確認する質問文を示す。\n7. ${faq}\n8. ${last}`,
    };
  }
  if (item.template === "money:doubt" && t) {
    const peers = peersFor(t, all).map((p) => p.name).join("・");
    return {
      factBoxFor: t, needTable: false,
      a: `1. 冒頭（見出しなし・200字以内）: 申し込む前に不安材料になりうる事実を3つ、先に列挙する（料金・期間・保証条件・転職支援など、データにある事実だけ）。\n2. その3つについて、それぞれ ## 本当に◯◯なのか の形の見出しで1節ずつ検証する（合計3節）。各節は「事実（データ）→編集部の見方→どんな人なら問題にならないか」の順。`,
      b: `5. ## 合わない条件と、その場合に見るべき学校: 条件を3つ、それぞれ参考校（${peers}）のどれが代わりになるかを数字つきで。\n6. ## ${kyufuHead}: ${subsidy}\n7. ## 申し込む前に潰しておく不安: 無料カウンセリングでそのまま口に出せる質問を5つ、「」で書く。それぞれ何を確かめる質問かを1文添える。\n8. ${faq}\n9. 最後の節（見出しは「まとめ」以外の具体的なもの）: 判断の分かれ目を1つだけ書き、その先の行動を2通り示す。要約は禁止。`,
    };
  }
  if (item.template === "money:vs" && tools.length >= 2) {
    const [x, y] = tools;
    return {
      needTable: true,
      a: `1. 冒頭（見出しなし・200字以内）: 結論「◯◯なら${x.name}、△△なら${y.name}」を1文目に。理由を数字で2つ。\n2. 比較一覧表（| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) | の6列）\n3. ## 受講料の総額で比べる ／ ## 期間と学習時間で比べる ／ ## 転職支援と保証で比べる の3節。各節に必ず両校の数字を入れ、どちらがどんな人に向くかで締める。`,
      b: `4. ## 学べる内容とサポートの違い: データの範囲で。\n5. ## ${kyufuHead}: ${subsidy}\n6. ## ${x.name}を選んで後悔するケース／${y.name}を選んで後悔するケース: それぞれ2つずつ、条件を具体的に。\n7. ${faq}\n8. ${last}`,
    };
  }
  if (item.template === "info:what" && t) {
    return {
      factBoxFor: t, needTable: false,
      a: `1. 冒頭（見出しなし・200字以内）: 何のスクールか・受講料・期間を事実で。\n2. ## コースと料金の全体像: コース別料金データから、どのコースが誰向けでいくらかを書く。\n3. ## 申し込みから修了までの流れ: データにある形式・期間・サポートから、学習がどう進むかを書く。不明な点は1回だけ「公式サイトに記載がない」。`,
      b: `4. ## 向いている人・向いていない人: それぞれ3条件、数字か具体的な状況つきで。\n5. ## ${kyufuHead}: ${subsidy}\n6. ${faq}\n7. ${last}`,
    };
  }
  if (item.template.startsWith("topic:")) {
    const brief = (item as any).brief ?? "";
    const hubs = (item as any).hubs ?? ["/kyufukin/"];
    return {
      needTable: false,
      a: `1. 冒頭（見出しなし・200字以内）: 読者がいま知りたい事実か判断を1文目に。\n2. 本文の前半として、テーマに即した ## 見出し（読者の疑問文）を3つ。各節は具体的な行動・判断基準・数字（自サイトのデータにあるスクール料金や給付金率のみ）で書く。一般的な統計値は書かない。\n【テーマの要点】${brief}\n【内部リンク】本文中の自然な位置で次のページに1回ずつリンクする（Markdown リンク）: ${hubs.join(" 、 ")}`,
      b: `3. 本文の後半として ## 見出し（読者の疑問文）を2つ。前半と重ならない論点を選ぶ（前半は「入口の判断」「学習の順番」「費用」あたりを扱う想定なので、後半は「つまずきどころ」「次の一歩」「スクールを使うべき人・使わなくていい人」を扱う）。\n4. ## よくある質問（### で質問文を3つ。答えは各120字以内）\n5. 最後の節（見出しは「まとめ」以外の具体的なもの）: 今日やることを手順で3つ。要約は禁止。`,
    };
  }
  if (item.template === "news:weekly") {
    const items: NewsItem[] = (item.news?.items ?? []) as NewsItem[];
    const src = items.map((n, i) => `【ニュース${i + 1}】見出し: ${n.title}\n媒体: ${n.source}\n公開日: ${n.published}\nURL: ${n.link}\n本文（要約と論評の材料。15字を超えてそのまま写さない）:\n${(n.text || n.snippet).slice(0, 2500)}`).join("\n\n");
    return {
      needTable: false,
      a: `これは週1本の「業界ニュースと編集部の見方」コラム（全体で2,200字以上）。読者はプログラミングやAIを学ぼうとしている社会人・学生。スクールの宣伝ではなく、読み物として面白いことが目的。\n最初の行に「TITLE: 」で記事タイトル（40字以内。3本に共通する論点を一言で言い切る。「今週のニュース」のような定型は禁止。例「AI人材の求人が増えても未経験の入口は広がらない、と読める3つの動き」）。\n次の行に「DESCRIPTION: 」で80字以内の説明。\nそのあと本文:\n1. 冒頭（見出しなし・200字以内）: 今週の3本が指している「ひとつの変化」を1文目に言い切る。\n2. ニュースごとに ## 見出し（そのニュースの意味を言い切る文。媒体名や「〜について」は使わない）を1つずつ、計${items.length}節。各節は「何が起きたか（媒体の本文から、自分の言葉で3〜5文。固有名詞・数字は本文にあるものだけ）→ 背景（なぜ今か）→ 学ぶ人にとっての意味（誰が・何を・いつまでに変えるべきか）」の順。各節400字以上。1文目で出典に Markdown リンク: [媒体名](URL)。\n【材料】\n${src}`,
      b: `続きとして次を書く:\n3. ## 編集部の見方（見出しは論点を言い切る文に変える）: 3本を貫く論点をひとつ立て、賛成する立場と反対する立場の両方を書いたうえで、編集部の結論を書く。600字以上。一般論で逃げず、「◯◯な人は今年中に△△、そうでない人は様子見」のように行動まで落とす。\n4. ## 今週の読者への宿題: 具体的な行動を3つ（それぞれ「なぜ今か」を1文添える）。スクールに関係するものは自サイトの記事へ内部リンク（/blog/osusume-hikaku-ai/ や /kyufukin/ など）してよいが、関係が薄ければ無理に入れない。\n5. ## 出典: 3本を「- [見出し](URL)（媒体名、公開日）」の箇条書きで。\n【禁止】材料にない固有名詞・数字・発言。15字を超える引用。「当サイトの調査によると」「平均◯万円」のような根拠のない数字。スクールの宣伝口調。`,
    };
  }
  if (item.template.startsWith("news:")) {
    const n = (item.news ?? {}) as any;
    return {
      needTable: false,
      a: `これはニュース解説記事（全体で1,200〜2,000字）。最初の行に「TITLE: 」で記事タイトル（40字以内。ニュースの見出しをそのまま使わず、読者への意味を示す）を書く。\n次の行に「DESCRIPTION: 」で80字以内の説明。\nそのあと本文:\n1. 冒頭（見出しなし・150字以内）: 何が報じられたかを事実だけで。1文目で出典に Markdown リンクする: [${n.source ?? "出典"}](${n.link ?? ""})\n2. ## このニュースが学ぶ人にどう関係するか: 報じられた事実（下の材料の範囲のみ）と背景を、自分の言葉で。\n3. ## 読者が今やること: 具体的な行動を3つ。\n【材料】見出し: ${n.title ?? ""}\n媒体: ${n.source ?? ""}\n公開日: ${n.published ?? ""}\n本文: ${(n.text || n.snippet || "").slice(0, 2500)}\n【禁止】材料にない固有名詞・数字・発言。15字を超える引用。根拠のない数字や調査の言及。`,
      b: ``,
    };
  }
  // pillar:* / money:best-for / info:choose（複数校）
  const names = tools.map((x) => x.name).join("・");
  return {
    needTable: true,
    a: `1. 冒頭（見出しなし・250字以内）: 目的別の結論（どの目的ならどの1〜3校か）を1文目から。\n2. ## 選ぶ基準：数字で線を引く: 料金・期間・形式・転職支援・返金保証それぞれについて「◯◯なら△△を選ぶ」の形で、判断できる基準値を数字で書く。\n3. 比較一覧表（| スクール | 形式 | 期間 | 転職支援 | 返金保証 | 受講料(税込) | の6列。${names} を全校載せる）`,
    b: `4. ## 各スクールの一言判定: 1校ずつ ### 見出し（スクール名）で、判定（誰に合うか）・向かない人・注意点を各300字以内で。全校（${names}）を必ず書く。\n5. ## ${kyufuHead}: ${subsidy}\n6. ${faq}\n7. ${last}`,
  };
}

export async function writeArticle(item: KeywordItem, aff: Affiliates): Promise<{ body: string; description: string | null; title: string | null; tools: Tool[] }> {
  const all = aff.tools;
  const tools = toolsFor(item, all);
  const subsidyIds = aff.subsidy_ids ?? [];
  const plan = planFor(item, tools, all, subsidyIds);

  const system = `${persona("writer")}\n${persona("editor")}\nあなたは日本語ネイティブのプロ編集者です。読者がこの1本で意思決定を完了できる、深く正直で中立的な記事を書きます。H1（# タイトル）は付けません。誇大・断定（絶対/必ず/日本一 等）は使いません。事実（価格・実績）を捏造せず、与えられたデータの範囲で書きます。同じ内容の言い換えによる水増しは禁止。具体例・判断基準・数字で深くします。\n\n${DATA_RULES}\n\n${STYLE}`;

  const main = plan.factBoxFor ?? tools[0];
  const peers = main ? peersFor(main, all) : [];
  const dataLines = [
    ...(tools.length ? [`【データ：扱うスクール（この中だけ。長所も短所も正直に）】\n${tools.map(toolLine).join("\n")}`] : []),
    ...(peers.length && tools.length === 1 ? [`【データ：参考校（比較のために数字を出してよい。主役は${main!.name}）】\n${peers.map(toolLine).join("\n")}`] : []),
  ].join("\n\n");
  const axes = aff.review_axes?.length ? aff.review_axes.join("・") : "教育の質・サポート・料金";
  const ctx = [
    `TOPIC: ${item.keyword}`,
    `想定読者: ${item.template.startsWith("topic:") || item.template.startsWith("news:") ? "プログラミングやAIを学ぼうとしている社会人・学生。" : "プログラミングスクールを比較検討中で、申込直前の人。"}`,
    dataLines,
    `本記事の検証軸: ${axes}。`,
  ].filter(Boolean).join("\n");

  const total = minWordsFor(item);
  const descLine = `最初の行に「DESCRIPTION: 」で、この記事の説明文（80字以内。検索結果と一覧カードに出る。数字か固有名詞を1つ入れ、「解説します」で終わらない）を書き、そのあと本文を続ける。`;

  let p1: string, p2 = "";
  if (item.template === "news:weekly") {
    // 【2026-09-11 実測】材料を1回のプロンプトにまとめて渡すと、後半の呼び出しが材料を持たず
    // 出典を捏造（example.com）し、参考校のデータに引きずられてスクール比較にすり替わった。
    // なので (1) ニュース1本ごとに小さく書かせ、(2) コラムは3本の要約だけを見せて書かせ、
    // (3) 出典一覧と骨組みは機械で組む。スクールのデータは渡さない。
    const items = await enrichItems((item.news?.items ?? []) as NewsItem[]).catch(() => (item.news?.items ?? []) as NewsItem[]);
    item.news = { ...(item.news ?? {}), items };
    const usable = items.filter((n) => n.text);
    if (usable.length < 2) throw new Error("ニュースの本文が2本未満のため書かない");
    const newsSystem = `${persona("editor")}\nあなたは日本語ネイティブの編集者です。プログラミングやAIを学ぼうとしている社会人・学生に向けて、業界ニュースを自分の言葉で解説します。宣伝口調は使いません。${DATA_RULES.replace("下の「データ」", "下の「材料」")}\n\n${STYLE}`;
    const sections: string[] = [];
    const summaries: string[] = [];
    for (const n of usable) {
      const r = await chat(
        `次のニュース1本について、読者（プログラミングやAIを学ぼうとしている人）向けの解説を書く。\n出力形式（この形式以外は書かない）:\n1行目: 「H: 」に続けて見出し（そのニュースの意味を言い切る文。25字以内。媒体名・「〜について」・番号は使わない）\n2行目以降: 段落を3つ。(1) 何が起きたか（材料の本文から自分の言葉で3〜5文。固有名詞・数字は本文にあるものだけ。15字を超えて写さない）(2) 背景（なぜ今この動きか）(3) 学ぶ人にとっての意味（誰が・何を・どう変えるべきか。言い切る）。合計400〜600字。箇条書きは使わない。${isEnglish((n.text || n.snippet || "").slice(0, 300)) ? "材料は英語だが本文は日本語で書く。社名・製品名は原語のまま。日本の学ぶ人にとっての意味を(3)に含める。" : ""}\n\n【材料】\n見出し: ${n.title}\n媒体: ${n.source}\n公開日: ${n.published}\n本文:\n${(n.text || n.snippet).slice(0, 2500)}`,
        { system: newsSystem, maxTokens: 1500, temperature: 0.6 });
      const lines = r.trim().split("\n");
      const hm = lines[0].match(/^H[:：]\s*(.+)$/);
      const heading = (hm ? hm[1] : n.title).replace(/^#+\s*/, "").trim();
      const paras = (hm ? lines.slice(1) : lines).join("\n").trim().replace(/^#+.*$/gm, "").trim();
      sections.push(`## ${heading}\n\n出典：[${n.source}](${n.link})（${n.published}）\n\n${paras}`);
      summaries.push(`・${heading}（${n.source}）: ${paras.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    const col = await chat(
      `今週のニュース${usable.length}本の要約を読んで、コラムを書く。\n出力形式（この順で。この形式以外は書かない）:\nTITLE: 記事タイトル（40字以内。${usable.length}本に共通する論点を、読者の損得が伝わる言い方で言い切る。例「『AIの使い方』を教える講座は、もう選ぶ理由がない」「求人は増えたのに未経験の入口は狭い、その理由」。「〜の現状」「〜の動向」「今週のニュース」のような定型は禁止）\nDESCRIPTION: 80字以内の説明\nLEAD: 冒頭の1段落（120字以内。${usable.length}本が指している「ひとつの変化」を1文目で言い切る）\n## （論点を言い切る見出し）\n本文600字以上: ${usable.length}本を貫く論点をひとつ立て、賛成する立場と反対する立場の両方を書いたうえで、編集部の結論を書く。一般論で逃げず、「◯◯な人は今年中に△△、そうでない人は様子見」のように行動まで落とす。ニュースにない固有名詞・数字は出さない。\n## 今週の読者への宿題\n具体的な行動を3つ、文章で（各行動に「なぜ今か」を1文添える）。スクール名や商品名は出さない。\n\n【要約】\n${summaries.join("\n")}`,
      { system: newsSystem, maxTokens: 2500, temperature: 0.7 });
    const ct = takeTitle(col.trim());
    const cd = takeDescription(ct.body);
    const lm = cd.body.match(/^\s*LEAD[:：]\s*(.+)\n/);
    const lead = lm ? lm[1].trim() : "";
    // 行末の空白2つ（Markdownの改行）と見出し末尾の空白を落とす。表示が崩れる
    const colBody = (lm ? cd.body.slice(lm[0].length) : cd.body).trim().replace(/[ \t]+$/gm, "");
    const sources = usable.map((n) => `- [${n.title}](${n.link})（${n.source}、${n.published}）`).join("\n");
    let body2 = [lead, ...sections, colBody, `## 出典\n\n${sources}`].filter(Boolean).join("\n\n");
    body2 = dedupeSections(normalizeHeadings(body2));
    body2 = dedupeSections(await depersonalizeAi(body2, newsSystem));
    return { body: body2, description: cd.description, title: ct.title, tools: [] };
  }
  if (item.template.startsWith("news:")) {
    // 1本のニュースへの見解（news:hot。旧 news:commentary も同じ型で書く）。
    // 【設計】材料＝媒体の本文（800字以上ないと書かない）。事実→背景→歓迎する見方→慎重な見方→編集部の結論、
    // の順で賛否を必ず両方書く（オーナー方針: 評価には賛否の両方）。出典は機械で入れる。スクールのデータは渡さない。
    if (item.news?.link && !item.news.text) {
      const [en] = await enrichItems([item.news as NewsItem]).catch(() => [item.news as NewsItem]);
      item.news = { ...item.news, ...en };
    }
    const n = (item.news ?? {}) as NewsItem;
    if (!n.text || n.text.length < 800) throw new Error("ニュースの本文が800字未満のため書かない");
    const newsSystem = `${persona("editor")}\nあなたは日本語ネイティブの編集者です。プログラミングやAIを学ぼうとしている社会人・学生に向けて、業界ニュース1本を取り上げ、自分の言葉で見解を書きます。宣伝口調は使いません。${DATA_RULES.replace("下の「データ」", "下の「材料」")}\n\n${STYLE}`;
    const r = await chat(
      `次のニュース1本について、見解記事を書く（全体で1,600〜2,200字）。\n出力形式（この順で。この形式以外は書かない）:\nTITLE: 記事タイトル（45字以内。検索で探される固有名詞（社名・製品名・制度名。例: OpenAI、Claude、教育訓練給付金）を必ず前半に入れ、後半で編集部の見方を言い切る。ニュースの見出しの写しは禁止。例「OpenAI の新モデル発表で、未経験がいま学ぶべきなのはプロンプトではなく設計だ」「AI研修のROIを3分で出せる、は半分正しい」）\nDESCRIPTION: 80字以内の説明\nLEAD: 冒頭の1段落（120字以内。何が起きたかを1文、編集部の見方を1文）\n## （何が起きたかを言い切る見出し）\n材料の本文から、自分の言葉で4〜6文。固有名詞・数字・日付は本文にあるものだけ。15字を超えて写さない。\n## （なぜ今この動きなのかを言い切る見出し）\n背景を3〜5文。材料に書かれていない事実は書かず、「〜と読める」「〜の流れの中にある」の形で推測と事実を分ける。\n## この動きを歓迎する見方\n賛成する立場の論拠を3〜4文。誰にとって何が良いか。\n## 慎重に見る見方\n反対・懸念の立場の論拠を3〜4文。誰が損をしうるか、見落とされている条件は何か。\n## 編集部の結論：学ぶ人はどう動くか\n賛否${item.news?.reactions?.comments?.length ? "（ネットの反応の傾向も踏まえる）" : ""}を踏まえた編集部の判断を言い切り、「◯◯な人は今月中に△△、そうでない人は様子見」のように行動まで落とす。5〜7文。自サイトの記事へ内部リンクを1つだけ入れてよい（必ず Markdown リンクの形: [給付金の使い方](/kyufukin/)、[6問診断](/shindan/)、[AIスクールの比較](/blog/osusume-hikaku-ai/)）。関係が薄ければ入れない。\n\n【禁止】材料にない固有名詞・数字・発言・調査。「当サイトの調査によると」「平均◯万円」。箇条書き。スクール名の宣伝。\n${isEnglish((n.text ?? "").slice(0, 300)) ? "【海外ニュース】材料は英語。本文は日本語で書く。社名・製品名は原語のまま（初出でカタカナや短い説明を添える）。「日本の学ぶ人・転職市場にとっての意味」を結論の節で必ず1〜2文書く。\n" : ""}\n【材料】\n見出し: ${n.title}\n媒体: ${n.source}\n公開日: ${n.published}\nURL: ${n.link}\n本文:\n${n.text.slice(0, 4000)}${item.news?.reactions?.comments?.length ? `\n\n【ネットの反応の傾向（参考。本文に引用しない）】\n${item.news.reactions.comments.slice(0, 10).map((c) => `- ${c.text.slice(0, 80)}`).join("\n")}` : ""}`,
      { system: newsSystem, maxTokens: 3500, temperature: 0.7 });
    const ht = takeTitle(r.trim());
    const hd = takeDescription(ht.body);
    const lm = hd.body.match(/^\s*LEAD[:：]\s*(.+)\n/);
    const lead = lm ? lm[1].trim() : "";
    let hotBody = (lm ? hd.body.slice(lm[0].length) : hd.body).trim().replace(/[ \t]+$/gm, "");

    // ネットの反応（まとめサイト風）。反応が5件以上あるときだけ「なぜ今か」の節の後に挟む。
    // 掲載は要約＋40字以内の短い引用（出所は節末に機械で明示）。ユーザー名は出さない。
    const rx = item.news?.reactions;
    if (rx && rx.comments.length >= 5) {
      const list = rx.comments.slice(0, 30).map((c, i) => `${i + 1}. [${c.platform}${c.likes ? ` ♥${c.likes}` : ""}] ${c.text}`).join("\n");
      const rxText = await chat(
        `次のニュースに対するネット上のコメント（${rx.comments.length}件）を読み、「ネットの反応」の節を書く。\n出力形式（この形式以外は書かない。見出し「## ネットの反応」から始める）:\n## ネットの反応\n導入1文（どの立場の声が多いか）。\n### 歓迎・期待の声\n要約2〜3文＋短い引用を1つ（原文から40字以内をそのまま「」で。英語なら日本語に訳して「」）。\n### 懸念・批判の声\n同じ形。\n### 別の視点\n同じ形（該当する声が無ければこの小見出しは書かない）。\n【禁止】コメントにない意見の創作。ユーザー名・ハンドル名。40字を超える引用。個人や企業への中傷の引用。\n\n【ニュースの見出し】${n.title}\n【コメント】\n${list}`,
        { system: newsSystem, maxTokens: 1500, temperature: 0.5 });
      const rxSection = rxText.trim().replace(/[ \t]+$/gm, "");
      if (/^## ネットの反応/m.test(rxSection)) {
        const srcLine = `反応の出典：${rx.threads.map((t) => `[${t.platform}](${t.url})（${t.count}件）`).join("・")}`;
        // 2つ目の ## 見出し（なぜ今か）の直後の段落末に挿入。見出しが2つ未満なら末尾へ
        const heads = [...hotBody.matchAll(/^## .+$/gm)];
        const at = heads[2]?.index;
        hotBody = at != null
          ? `${hotBody.slice(0, at).trimEnd()}\n\n${rxSection}\n\n${srcLine}\n\n${hotBody.slice(at)}`
          : `${hotBody}\n\n${rxSection}\n\n${srcLine}`;
      }
    }
    let body3 = [lead, `出典：[${n.source}](${n.link})（${n.published}）`, hotBody, `## 出典\n\n- [${n.title}](${n.link})（${n.source}、${n.published}）`].filter(Boolean).join("\n\n");
    body3 = fixInternalLinks(dedupeSections(normalizeHeadings(body3)));
    body3 = dedupeSections(await depersonalizeAi(body3, newsSystem));
    return { body: body3, description: hd.description, title: ht.title, tools: [] };
  } else {
    p1 = await chat(
      `${ctx}\n\nこれは全体で${total.toLocaleString()}字以上になる記事の【前半】です。${descLine}\n本文は次の構成だけを書く（この部分だけで${Math.round(total * 0.5).toLocaleString()}字以上）:\n${plan.a}`,
      { system, maxTokens: 5000, temperature: 0.7 });
    p2 = await chat(
      `${ctx}\n\n記事の【後半】です。前半には冒頭の結論と次の内容が既にある: ${plan.a.replace(/\n/g, " ").slice(0, 400)}…。重複せず、次の構成だけを ## 見出しで書く（この部分だけで${Math.round(total * 0.5).toLocaleString()}字以上）:\n${plan.b}`,
      { system, maxTokens: 6000, temperature: 0.7 });
  }

  const t1 = takeTitle(p1.trim());
  const d1 = takeDescription(t1.body);
  let body = [d1.body, p2].map((s) => s.trim()).filter(Boolean).join("\n\n");
  body = dedupeSections(normalizeHeadings(repairTables(body)));
  body = body
    .replace(/^(#{2,3})\s*\d{1,2}[\.．、)）]\s*/gm, "$1 ")
    .replace(/^(#{2,3})\s*(冒頭|前半|中盤|後半)[:：]\s*/gm, "$1 ");

  body = fixInternalLinks(body);
  if (plan.factBoxFor) body = insertAfterIntro(body, factBox(plan.factBoxFor, subsidyIds.includes(plan.factBoxFor.id)));
  if (plan.needTable && !body.includes("|") && tools.length) body += `\n\n## 比較一覧\n\n${comparisonTable(tools)}\n`;

  // 目標に届かない場合は、まだ書かれていない読者の疑問を1回だけ補筆。
  if (!item.template.startsWith("news:") && charCount(body) < total + 200 && !isOffline()) {
    const p4 = await chat(
      `${ctx}\n\n以下は執筆済みの記事です。この記事でまだ答えられていない、申込直前の読者が抱く疑問を2つ選び、それぞれ ### の見出し（疑問文）で具体的に解説してください（合計800字以上。既出内容の繰り返し禁止。データにない数字は書かない。見出しは「## さらに詳しく知りたい人へ」の配下に置く想定で ### のみ）:\n\n---\n${body.slice(0, 6000)}`,
      { system, maxTokens: 2500, temperature: 0.7 });
    body += `\n\n## さらに詳しく知りたい人へ\n\n${p4.trim()}`;
  }

  body = await depersonalizeAi(body, system);
  // 書き直しの後にも重複除去を掛ける（2026-09-09 の事故: 書き直しで節が二重化して公開された）
  body = dedupeSections(body);
  return { body, description: d1.description, title: t1.title, tools };
}

// ── 推敲パス ──────────────────────────────────────────────────
// 生成直後の原稿は、文体規約を渡してあっても必ずAI特有の型が残る。
// 「機械置換 → 検査 → 残っている型を名指しして書き直させる」を繰り返す。
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
      `以下の記事を、意味・事実・数字・見出し構成・マークダウン記法・表・リンクを一切変えずに、文体だけ書き直してください。\n\n${orders}\n\n守ること:\n・見出し（## と ###）の文言・個数・順序は変えない。表（| で始まる行）は1文字も変えずにそのまま残す。\n・価格・期間・パーセント・スクール名は1文字も変えない。新しい事実を足さない。「」で囲まれた引用と「出典：」「反応の出典：」で始まる行は1文字も変えない。\n・文字数は減らさない（同じ長さか少し長く）。\n・記事全体を最初から最後まで出力する。省略や「（以下省略）」は禁止。\n\n---\n${out}`,
      { system, maxTokens: 12000, temperature: 0.4 });

    const cand = deaiMechanical(revised.trim());
    // 書き直しが失敗（途中で切れた・短くなった・構造が変わった）した場合は元を残す。
    // 文体より情報量と構造のほうが大事なので、ここは保守的に判定する。
    const before = headingList(out), after = headingList(cand);
    const sameHeads = before.length === after.length && before.every((h, i) => h === after[i]);
    const problems = findStructureProblems(cand);
    const ok =
      charCount(cand) >= charCount(out) * 0.9 &&
      sameHeads &&
      problems.length === 0 &&
      !/以下省略|（省略）/.test(cand);
    if (!ok) {
      console.log(`[editor] 書き直しを破棄（${!sameHeads ? "見出しが変わった" : problems.length ? problems.map((p) => p.kind).join("/") : "本文が欠けた"}: ${charCount(cand)}字 vs ${charCount(out)}字）`);
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

/**
 * 次に書く記事を選ぶ。
 * キューは収益記事（score 90前後）が先頭に並ぶので、そのままだとトピック記事
 * （score 60）が何十日も後回しになる。読者にとっては比較記事ばかりのサイトより、
 * 学習の話題が混ざっているほうが戻ってくる理由になる。ニュースは最優先、
 * 直近2本が比較・評判系ならトピックを1本挟む。
 */
export function pickNext(state: ReturnType<typeof loadState>): KeywordItem | undefined {
  const queued = state.keywords.filter((k) => k.status === "queued");
  if (!queued.length) return undefined;
  const news = queued.find((k) => k.template.startsWith("news:"));
  if (news) return news;
  // ニュース以外は、トピック記事（学習・キャリアの読み物）と比較・評判記事を交互に出す。
  // オーナー方針（2026-09-11）「全ての記事をアフィリエイトに結びつけなくてもよい。読みに来るだけでも面白いサイトに」。
  // ニュースは間に挟まるので、「直近のニュース以外の1本」を見て交互にする（2026-09-14: 直近1本だけ見ていたので
  // ニュースの翌日は必ず比較記事になり、トピックがほぼ出なかった）。
  const lastNonNews = [...state.keywords.filter((k) => k.status === "published" && !k.template.startsWith("news:"))]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0];
  const topic = queued.find((k) => k.template.startsWith("topic:"));
  if (topic && lastNonNews && !lastNonNews.template.startsWith("topic:")) return topic;
  return queued.find((k) => !k.template.startsWith("topic:")) ?? queued[0];
}

export function frontmatter(item: KeywordItem, tools: Tool[], description: string | null, dates: { pub: string; upd: string }, title?: string | null): string {
  const desc = description && description.length >= 20
    ? description
    : `${item.keyword}。料金・条件・向き不向きを公式情報と編集部の基準で整理します。`;
  return [
    "---",
    `title: ${JSON.stringify(title ?? item.keyword)}`,
    `description: ${JSON.stringify(desc)}`,
    `author: ${JSON.stringify(config.site.author)}`,
    `pubDate: ${dates.pub}`,
    `updatedDate: ${dates.upd}`,
    `tools: [${tools.map((t) => JSON.stringify(t.name)).join(", ")}]`,
    ...(item.template.startsWith("news:") ? [`news: true`] : []),
    ...(item.template.startsWith("topic:") ? [`topic: true`] : []),
    `draft: false`,
    "---",
  ].join("\n");
}

export async function generateNext(): Promise<KeywordItem | null> {
  const aff: Affiliates = JSON.parse(readFileSync(paths.affiliates, "utf8"));
  const state = loadState();
  const item = pickNext(state);
  if (!item) { console.log("[writer] キュー待ちなし。"); return null; }

  // キューに残っている旧型タイトル（「◯◯はやめとけ？…」）を新しい型に揃える。
  // state.json は手でコミットしないので、ここで直すのが確実。
  if (item.template === "money:doubt") item.keyword = item.keyword.replace(/はやめとけ？評判と後悔しない判断基準$/, "は自分に合う？向いていない人の条件と後悔しない判断基準");
  const { body, description, title, tools } = await writeArticle(item, aff);
  if (title) item.keyword = title;

  const today = new Date().toISOString().slice(0, 10);
  const fm = frontmatter(item, tools, description, { pub: today, upd: today }, title);

  // ステマ規制対応：本文冒頭に明瞭な広告表記。
  const disclosure = `> 【広告】${aff.disclosure}`;
  const md = `${fm}\n\n${disclosure}\n\n${body.trim()}\n`;

  mkdirSync(paths.drafts, { recursive: true });
  writeFileSync(resolve(paths.drafts, `${item.slug}.md`), md);
  item.status = "drafted";
  item.structure = STRUCTURE_VERSION;
  saveState(state);
  console.log(`[writer/editor] 下書き生成 "${item.keyword}" ${isOffline() ? "(オフライン)" : ""}`);
  return item;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2]) || 1;
  (async () => { for (let i = 0; i < n; i++) if (!(await generateNext())) break; })();
}

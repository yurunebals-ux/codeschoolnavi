// ROLES: 編集長（既存記事の文体改稿）
//
// 生成側の文体規約と推敲は「これから書く記事」にしか効かない。すでに公開済みの
// 記事はAI特有の型を残したままなので、毎日のサイクルで1本ずつ直していく。
// 人の手を入れずに古い在庫が入れ替わるようにするのが目的。
//
// 選び方: 公開済み記事のうちAI文体スコアが最も高い（＝最もAIっぽい）1本。
// 直したらスコアを記録し、改善しなかった記事は再挑戦の対象から外す（無限ループ防止）。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../lib/config.js";
import { chat, isOffline } from "../lib/llm.js";
import { persona } from "../lib/team.js";
import { scanAiese, deaiMechanical } from "../lib/aiese.js";

const LOG = resolve(paths.data, "polish.json");
const TARGET = 30;        // これ以下なら手を入れない
const ATTEMPT_LIMIT = 2;  // 同じ記事に何回まで挑むか

interface PolishLog { [slug: string]: { attempts: number; score: number; last: string } }

function loadLog(): PolishLog {
  if (!existsSync(LOG)) return {};
  try { return JSON.parse(readFileSync(LOG, "utf8")); } catch { return {}; }
}
function saveLog(l: PolishLog) { writeFileSync(LOG, JSON.stringify(l, null, 2) + "\n"); }

function charCount(md: string): number {
  return md.replace(/[#>*`|\-\s]/g, "").length;
}

// frontmatter は文体改稿の対象外（title・日付・toolsを触らせない）
function splitFm(md: string): [string, string] {
  const m = md.match(/^(---[\s\S]*?^---\n)/m);
  return m ? [m[1], md.slice(m[1].length)] : ["", md];
}

export async function polishRun(): Promise<string | null> {
  const dir = paths.blog;
  if (!existsSync(dir)) { console.log("[polish] 記事ディレクトリなし。"); return null; }

  const log = loadLog();
  const cands = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const md = readFileSync(resolve(dir, f), "utf8");
      return { file: f, slug: f.replace(/\.md$/, ""), md, score: scanAiese(md).score };
    })
    .filter((c) => c.score > TARGET)
    .filter((c) => (log[c.slug]?.attempts ?? 0) < ATTEMPT_LIMIT)
    .sort((a, b) => b.score - a.score);

  if (!cands.length) { console.log("[polish] 改稿対象なし（全記事が基準内）。"); return null; }
  const t = cands[0];
  const [fm, bodyIn] = splitFm(t.md);

  // まず機械置換。APIが使えない環境でもここまでは必ず効く。
  let body = deaiMechanical(bodyIn);
  const mech = scanAiese(fm + body).score;
  if (mech < t.score) console.log(`[polish] "${t.slug}" 機械置換 ${t.score} → ${mech}`);

  if (!isOffline()) {
    const s = scanAiese(fm + body);
    const orders = [
      s.hits.length ? `残っている禁止語句: ${s.top(12).join("、")}。語を消すだけで済ませず、何がどれだけあるのかを具体的に書き直す。` : "",
      s.structure.length ? `構造の問題: ${s.structure.join(" / ")}。太字ラベル＋説明の箇条書きは文章に開く。要約だけの「まとめ」節は、読者が次にやること（申込前に確認する項目・無料相談で聞く質問）に書き換え、見出しも内容に即した具体的なものにする。` : "",
      s.rhythm.length ? `リズムの問題: ${s.rhythm.join(" / ")}。15字以下の短い文と体言止めを混ぜ、文末の型を崩す。` : "",
    ].filter(Boolean).join("\n");

    const system = `${persona("writer")}\n${persona("editor")}\nあなたは日本語ネイティブのプロ編集者です。公開済み記事の文体だけを直す改稿を担当します。事実の追加・変更は職務違反です。`;
    const revised = await chat(
      `以下は公開済みの記事です。意味・事実・数字・見出し構成・マークダウン記法・リンクを一切変えずに、文体だけを書き直してください。\n\n${orders}\n\n絶対に守ること:\n・見出し（## と ###）の文言・個数・順序は、書き換えを指示された「まとめ」節を除いて変えない。\n・表とリンク（[文字](URL)）はURLも表記もそのまま残す。\n・価格・期間・パーセント・スクール名・日付は1文字も変えない。新しい事実や数字を足さない。\n・冒頭の「> 【広告】」で始まる行は一字一句そのまま残す（法令上の表記のため）。\n・文字数は減らさない。記事全体を最初から最後まで出力する。省略は禁止。\n\n---\n${body}`,
      { system, maxTokens: 12000, temperature: 0.4 });

    const cand = deaiMechanical(revised.trim());
    const h2Before = (body.match(/^##\s+/gm) || []).length;
    const h2After = (cand.match(/^##\s+/gm) || []).length;
    // 改稿の受け入れ判定。文体より情報量とコンプライアンスが優先。
    const problems: string[] = [];
    if (charCount(cand) < charCount(body) * 0.9) problems.push(`本文が短くなった(${charCount(cand)}字 vs ${charCount(body)}字)`);
    if (h2After < h2Before - 1) problems.push(`見出しが減った(${h2After} vs ${h2Before})`);
    if (!/【広告】/.test(cand)) problems.push("広告表記が消えた");
    if (/以下省略|（省略）|\.\.\.$/.test(cand)) problems.push("出力が途中で切れた");
    const after = scanAiese(fm + cand).score;
    if (after >= scanAiese(fm + body).score) problems.push(`文体が改善せず(${after})`);

    if (problems.length) {
      console.log(`[polish] "${t.slug}" LLM改稿を破棄: ${problems.join("; ")}`);
    } else {
      body = cand;
      console.log(`[polish] "${t.slug}" LLM改稿 ${mech} → ${after}`);
    }
  }

  const out = fm + body;
  const final = scanAiese(out).score;
  if (out === t.md) {
    // 何も変わらなかった記事に毎日挑み続けないよう、試行回数を進める。
    // ただしオフライン（APIキーなし）のときは数えない。機械置換だけでは
    // 直せない記事なのは当たり前で、ここで回数を使い切ると、鍵のある環境で
    // 一度も推敲されないまま対象から外れてしまう。
    if (isOffline()) {
      console.log(`[polish] "${t.slug}" 機械置換では変化なし（score ${t.score}）。APIキーのある環境で再挑戦。`);
      return null;
    }
    log[t.slug] = { attempts: (log[t.slug]?.attempts ?? 0) + 1, score: t.score, last: new Date().toISOString().slice(0, 10) };
    saveLog(log);
    console.log(`[polish] "${t.slug}" 変化なし（score ${t.score}）。`);
    return null;
  }

  writeFileSync(resolve(dir, t.file), out);
  // 下書き側も揃えておく（quality.ts の重複判定が下書きを読むため）
  const draft = resolve(paths.drafts, t.file);
  if (existsSync(draft)) writeFileSync(draft, out);

  log[t.slug] = { attempts: (log[t.slug]?.attempts ?? 0) + 1, score: final, last: new Date().toISOString().slice(0, 10) };
  saveLog(log);
  console.log(`[polish] 改稿完了 "${t.slug}" 文体 ${t.score} → ${final}（残り${cands.length - 1}本）`);
  return t.slug;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2]) || 1;
  (async () => { for (let i = 0; i < n; i++) if (!(await polishRun())) break; })();
}

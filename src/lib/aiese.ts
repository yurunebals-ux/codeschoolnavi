// ROLES: 編集長（文体管理）
// 「AIが書いた感じ」を数値で捕まえるための検査器。
//
// なぜ機械判定にするのか：
// 生成プロンプトに「AIっぽく書かないで」と書くだけでは効かない。効いたかどうかを
// 測れないからだ。そこで(1)語句、(2)構造、(3)リズムの3系統で減点し、生成側は
// この検査を通るまで書き直す、QA側は基準を超えた下書きを落とす、という運用にする。
//
// 判定は文字列処理だけで完結する（APIコスト0・実行時間ミリ秒）。

// ── (1) 語句：日本語のAI記事に不釣り合いな頻度で現れる言い回し ──────────
// weight は「読者がAIっぽさを感じる強さ」。実記事8本の実測頻度をもとに置いた。
export interface Pat { re: RegExp; label: string; weight: number; }

export const PHRASES: Pat[] = [
  // 接続の型。人はここまで律儀に前置きしない。
  { re: /結論として[、,]?/g, label: "結論として", weight: 3 },
  { re: /これらを踏まえ[てた]?[、,]?/g, label: "これらを踏まえ", weight: 3 },
  { re: /まとめると[、,]?/g, label: "まとめると", weight: 3 },
  { re: /上記のように|前述のとおり|前述の通り/g, label: "上記のように", weight: 2 },
  { re: /そのため[、,]/g, label: "そのため、", weight: 1 },
  // 中身のない総括。断定を避けた結果、何も言っていない文になる型。
  { re: /以下の(?:通り|とおり)/g, label: "以下の通り", weight: 3 },
  { re: /が(?:重要|大切)です/g, label: "が重要です", weight: 3 },
  { re: /(?:重要|大切)な(?:ポイント|点)/g, label: "重要なポイント", weight: 3 },
  { re: /が求められます/g, label: "が求められます", weight: 3 },
  { re: /と言え(?:ます|るでしょう)/g, label: "と言えます", weight: 3 },
  { re: /(?:でしょう|かもしれません)。/g, label: "でしょう。", weight: 2 },
  { re: /ではないでしょうか/g, label: "ではないでしょうか", weight: 3 },
  { re: /いかがでしょうか/g, label: "いかがでしょうか", weight: 3 },
  { re: /可能性があります/g, label: "可能性があります", weight: 2 },
  { re: /傾向があります/g, label: "傾向があります", weight: 2 },
  { re: /と言われています/g, label: "と言われています", weight: 2 },
  // カタログ語。抽象名詞で埋めると具体性が消える。
  { re: /充実/g, label: "充実", weight: 3 },
  { re: /費用対効果/g, label: "費用対効果", weight: 3 },
  { re: /総合的に/g, label: "総合的に", weight: 2 },
  { re: /多角的|包括的/g, label: "多角的", weight: 2 },
  { re: /自分に合った/g, label: "自分に合った", weight: 2 },
  { re: /自分にぴったり/g, label: "自分にぴったり", weight: 2 },
  { re: /理想的な/g, label: "理想的な", weight: 2 },
  { re: /最適な/g, label: "最適な", weight: 1 },
  // 誇張の水増し語。消しても意味が変わらない＝不要語。
  { re: /さまざまな|様々な/g, label: "さまざまな", weight: 2 },
  { re: /非常に/g, label: "非常に", weight: 2 },
  { re: /しっかりと?/g, label: "しっかり", weight: 2 },
  { re: /きちんと/g, label: "きちんと", weight: 1 },
  { re: /ぜひ/g, label: "ぜひ", weight: 2 },
  { re: /まさに/g, label: "まさに", weight: 1 },
  // 呼びかけの型。読者を子ども扱いしているように読める。
  // 「ましょう」は動詞を限定せず全部拾う（機械置換で消しきれない形を検査で残すため）
  { re: /ましょう/g, label: "〜ましょう", weight: 3 },
  { re: /してみてください/g, label: "してみてください", weight: 2 },
  { re: /おすすめします/g, label: "おすすめします", weight: 1 },
  // 中身の薄い共感の型。冒頭に来ると一発でAIだと分かる。
  { re: /悩んでいる方も多い|迷っている方も多い|方も多いのではないでしょうか/g, label: "〜方も多い", weight: 3 },
  { re: /絡み合[うい]|複雑に絡/g, label: "絡み合う", weight: 2 },
];

export interface Hit { label: string; count: number; weight: number; }
export interface Scan {
  hits: Hit[];          // 出現した語句（多い順）
  phraseHits: number;   // 語句の総ヒット数
  per1000: number;      // 1,000字あたりの重み付きヒット
  structure: string[];  // 構造上の指摘
  rhythm: string[];     // リズム上の指摘
  score: number;        // 0-100。低いほど人間らしい。
  top(n?: number): string[]; // 書き直し指示に埋める用
}

// 本文だけを対象にする（表・引用・リンク・見出し記号はノイズになる）。
function proseOf(md: string): string {
  return md
    .replace(/^---[\s\S]*?^---/m, "")            // frontmatter
    .split("\n")
    .filter((l) => !/^\s*(\||>|#{1,6}\s)/.test(l))
    .join("\n")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // リンクはテキストだけ残す
    .replace(/[*`]/g, "");
}

function sentences(prose: string): string[] {
  return prose
    .split(/(?<=[。！？])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

// 「まとめが冒頭の言い換えか」を測る。
// Jaccard は長さの違いに引っぱられて低く出るので、包含率（短い側のうち何割が
// 相手にもあるか）で見る。まとめは冒頭より短いのが普通で、知りたいのは
// 「まとめに、冒頭になかった情報がどれだけあるか」だからだ。
function overlap(a: string, b: string): number {
  const g = (t: string) => {
    const s = t.replace(/[\s、。「」（）]/g, "");
    const o = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) o.add(s.slice(i, i + 3));
    return o;
  };
  const A = g(a), B = g(b);
  if (A.size < 20 || B.size < 20) return 0;
  const [S, L] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const s of S) if (L.has(s)) inter++;
  return inter / S.size;
}

export function scanAiese(md: string): Scan {
  const prose = proseOf(md);
  const len = Math.max(1, prose.replace(/\s/g, "").length);

  // (1) 語句
  const hits: Hit[] = [];
  let weighted = 0;
  for (const p of PHRASES) {
    const m = prose.match(p.re);
    if (m && m.length) {
      hits.push({ label: p.label, count: m.length, weight: p.weight });
      weighted += m.length * p.weight;
    }
  }
  hits.sort((a, b) => b.count * b.weight - a.count * a.weight);
  const phraseHits = hits.reduce((s, h) => s + h.count, 0);
  const per1000 = Math.round((weighted / len) * 1000 * 10) / 10;

  // (2) 構造
  const structure: string[] = [];
  const secs = md.split(/^##\s+/m).slice(1);
  const body = (s: string) => s.split("\n").slice(1).join("\n");

  // まとめが冒頭の言い換えになっていないか（読者が「同じ話を2回された」と感じる型）
  const closing = secs.find((s) => /^(まとめ|最後に|総括|おわりに)/.test(s));
  if (closing && secs.length > 2) {
    const rest = secs.filter((s) => s !== closing).map((s) => proseOf(body(s))).join("\n");
    const ov = overlap(proseOf(body(closing)), rest);
    // 実測: 言い換えだけのまとめは既出率 0.40〜0.47。新情報のある結びは 0.3 前後。
    if (ov > 0.42) structure.push(`まとめが本文の言い換え(既出率 ${Math.round(ov * 100)}%)`);
  }
  // 見出しが「まとめ」で終わる構成そのものが定型。人が書く記事は最後に
  // 「次にすること」や判断の分岐が来る。
  if (/^##\s*(まとめ|最後に|総括)\s*$/m.test(md)) structure.push("見出し「まとめ」（定型）");
  // 太字ラベル＋説明の箇条書きは、資料のスライドであって読み物ではない
  const boldItems = (md.match(/^\s*(?:[0-9]+\.|[-*])\s*\*\*[^*]+\*\*/gm) || []).length;
  if (boldItems >= 5) structure.push(`太字ラベル箇条書き ${boldItems}個`);
  // 「AやB、Cなど」の三点並列を多用すると、どの段落も同じ形に見える
  const triads = (prose.match(/[^\s、。]{2,10}や[^\s、。]{2,10}、[^\s、。]{2,10}など/g) || []).length;
  if (triads >= 3) structure.push(`三点並列「AやB、Cなど」${triads}回`);
  // 箇条書きだけで段落がない節（説明を放棄している）
  const listOnly = secs.filter((s) => {
    const b = body(s);
    const lines = b.split("\n").filter((l) => l.trim());
    if (lines.length < 3) return false;
    return lines.filter((l) => /^\s*(?:[-*]|[0-9]+\.)\s/.test(l)).length / lines.length > 0.7;
  }).length;
  if (listOnly >= 2) structure.push(`箇条書きだけの節 ${listOnly}個`);

  // (3) リズム
  const rhythm: string[] = [];
  const ss = sentences(prose);
  if (ss.length >= 12) {
    // 文末が「です・ます」一色だと、機械の読み上げのように聞こえる
    const desumasu = ss.filter((s) => /(?:です|ます|ました|ません)[。！？]?$/.test(s)).length;
    const ratio = desumasu / ss.length;
    if (ratio > 0.88) rhythm.push(`文末が「です・ます」一色 ${Math.round(ratio * 100)}%`);
    // 長さが揃いすぎ＝人が書いたリズムではない
    const lens = ss.map((s) => s.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length);
    const cv = sd / Math.max(1, avg);
    if (cv < 0.42) rhythm.push(`文の長さが均一(変動係数 ${cv.toFixed(2)}、平均${Math.round(avg)}字)`);
    // 短文がまったくない＝息継ぎがない
    const shorts = lens.filter((l) => l <= 22).length / lens.length;
    if (shorts < 0.10) rhythm.push(`短い文がない(22字以下 ${Math.round(shorts * 100)}%)`);
  }

  // 合成スコア。実記事8本で 43〜72 に散るよう係数を合わせた（0が理想）。
  // 語句densityが主因、構造とリズムは上乗せ。60を超えると読者は明確に
  // 「機械が書いた」と感じる、という前提で運用する。
  const score = Math.min(
    100,
    Math.round(per1000 * 2.2 + structure.length * 7 + rhythm.length * 6)
  );

  return {
    hits, phraseHits, per1000, structure, rhythm, score,
    top(n = 8) {
      return hits.slice(0, n).map((h) => `「${h.label}」×${h.count}`);
    },
  };
}

// ── 機械的に安全な書き換えだけを行う ────────────────────────────
// 方針：文法を壊さない置換に限る。判断が必要な言い換え（「重要です」を何に
// 変えるか等）はLLMの推敲に任せる。ここでやるのは「消しても意味が変わらない語」
// の削除と、スロットが完全に一致する差し替えだけ。
const SAFE: [RegExp, string][] = [
  // 削除しても文が成立する前置き・水増し語
  [/結論として[、,]\s*/g, ""],
  [/これらを踏まえ[てた]?[、,]\s*/g, ""],
  [/まとめると[、,]\s*/g, ""],
  [/(?<![ぁ-んァ-ヶ一-龠])ぜひ/g, ""],
  [/しっかりと?/g, ""],
  [/(?<![ぁ-んァ-ヶ一-龠])非常に/g, ""],
  [/(?:さまざま|様々)な/g, ""],
  [/いかがでしょうか[。？]\s*/g, ""],
  // スロットが完全一致する差し替え
  [/と言え(?:ます|るでしょう)。/g, "。"],
  [/が求められます/g, "が必要です"],
];

// 「充実」「費用対効果」は係り方で置換先が変わる。活用形を長い順に列挙し、
// どの形にも当てはまらない裸の語はここでは触らない（検査で拾ってLLM推敲に回す）。
// 一括置換で「そろっているしており」のような崩れを作るほうが、AIっぽさより有害。
const CONTEXT: [RegExp, string][] = [
  // 費用対効果：どの格助詞にも付けられる名詞句に替える。長い名詞句は繰り返すと
  // それ自体が悪文になるので、よく出る言い回しは個別に短く言い換える。
  [/費用対効果(?:が|は|も)(?:高い|良い|よい)/g, "払った額の割に得るものが大きい"],
  [/費用対効果(?:が|は|も)(?:低い|悪い)/g, "払った額の割に得るものが小さい"],
  [/費用対効果を感じにくい/g, "払った額の割に得るものが小さいと感じる"],
  [/料金と費用対効果/g, "料金と、その額で何が手に入るか"],
  [/費用対効果を考え/g, "その額で何が手に入るかを考え"],
  // 最後の受け皿。以前は "払った額に対する見返り" にしていたが、
  // 「事前に確認し払った額に対する見返りを計算してください」のように
  // 動詞に続くと読点が無いぶん係り受けが取りづらく、かえって読みにくかった。
  // 短く、そのまま文に埋め込める言い回しにする。
  [/費用対効果を計算/g, "支払い額に見合うかを計算"],
  [/費用対効果/g, "支払い額に見合うか"],
  // 充実：係る名詞で置換先が変わる。人が手をかける対象（サポート・支援・体制）は
  // 「そろっている」だと在庫のように読めるので「手厚い」に寄せ、教材やカリキュラム
  // など数えられる対象は「そろっている」にする。活用形は長い順（順序が命）。
  // ── サポート系
  [/充実した(サポート|支援|フォロー|体制|指導|相談|対応)/g, "手厚い$1"],
  [/充実している(サポート|支援|フォロー|体制|指導|相談|対応)/g, "手厚い$1"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実していれば/g, "$1$2手厚ければ"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実していない/g, "$1$2手薄い"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実しており/g, "$1$2手厚く"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実しています/g, "$1$2手厚いです"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実している/g, "$1$2手厚い"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実し、/g, "$1$2手厚く、"],
  [/(サポート|支援|フォロー|体制|指導|相談|対応)(が|は|も)充実(?=[。、])/g, "$1$2手厚い"],
  [/(サポート|支援|指導|相談)(内容|体制)?の充実度/g, "$1$2の手厚さ"],
  // ── モノ系
  [/(教材|カリキュラム|コース|講座|教育|コンテンツ|機能|設備)(内容)?の充実度/g, "$1$2の幅と深さ"],
  [/内容の充実度/g, "内容の幅と深さ"],
  [/充実度/g, "手厚さ"],
  [/充実しておらず/g, "そろっておらず"],
  [/充実していない/g, "そろっていない"],
  [/充実していれば/g, "そろっていれば"],
  [/充実しており/g, "そろっており"],
  [/充実しています/g, "そろっています"],
  [/充実している/g, "そろっている"],
  [/充実させ/g, "そろえ"],
  [/充実した/g, "そろった"],
  [/充実し、/g, "そろっており、"],
  [/(が|は|も)充実(?=[。、])/g, "$1そろっている"],
  [/の充実(?=[。、])/g, "の手厚さ"],
  // 呼びかけの型。「〜ましょう」は動詞ごとに活用が違うので一括置換せず、
  // 「〜てください」の形が確実に成立する組だけを列挙する。
  [/確認しましょう/g, "確認してください"],
  [/比較しましょう/g, "比べてください"],
  [/検討しましょう/g, "検討してください"],
  [/見てみましょう/g, "見ていきます"],
  [/考えてみましょう/g, "考えてみてください"],
  [/にしましょう/g, "にしてください"],
  [/選びましょう/g, "選んでください"],
  [/決めましょう/g, "決めてください"],
  [/避けましょう/g, "避けてください"],
  [/押さえましょう/g, "押さえてください"],
  [/把握しましょう/g, "把握してください"],
  [/活用しましょう/g, "活用してください"],
  [/利用しましょう/g, "利用してください"],
  [/意識しましょう/g, "意識してください"],
  [/注意しましょう/g, "注意してください"],
  [/準備しましょう/g, "準備してください"],
  [/相談しましょう/g, "相談してください"],
  [/確保しましょう/g, "確保してください"],
  [/計算しましょう/g, "計算してください"],
  [/整理しましょう/g, "整理してください"],
  [/おきましょう/g, "おいてください"],
  [/申し込みましょう/g, "申し込んでください"],
  [/立てましょう/g, "立ててください"],
];

export function deaiMechanical(md: string): string {
  // frontmatter・表・引用は触らない
  const fmMatch = md.match(/^(---[\s\S]*?^---\n)/m);
  const fm = fmMatch ? fmMatch[1] : "";
  let rest = fm ? md.slice(fm.length) : md;

  rest = rest
    .split("\n")
    .map((line) => {
      if (/^\s*(\||>)/.test(line)) return line; // 表・広告表記はそのまま
      // 行頭・行末の空白はマークダウンの意味を持つ（箇条書きの継続行のインデント、
      // 行末2スペースの改行）。置換は必ず中身だけに当てる。
      const m = line.match(/^([ \t]*)([\s\S]*?)([ \t]*)$/);
      if (!m) return line;
      const [, lead, mid, trail] = m;
      let l = mid;
      for (const [re, to] of CONTEXT) l = l.replace(re, to as string);
      for (const [re, to] of SAFE) l = l.replace(re, to as string);
      // 置換で生じた読点の乱れだけを整える（空白の詰め直しはしない）
      l = l.replace(/、\s*、/g, "、").replace(/^、\s*/, "");
      return lead + l + trail;
    })
    .join("\n");

  return fm + rest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 使い方: tsx src/lib/aiese.ts <file.md> [--fix]
  const { readFileSync, writeFileSync } = await import("node:fs");
  const file = process.argv[2];
  if (!file) { console.log("usage: tsx src/lib/aiese.ts <file.md> [--fix]"); process.exit(1); }
  const src = readFileSync(file, "utf8");
  const before = scanAiese(src);
  console.log(`score=${before.score} per1000=${before.per1000} 語句${before.phraseHits}件`);
  console.log("  語句:", before.top(10).join(" ") || "なし");
  console.log("  構造:", before.structure.join(" / ") || "なし");
  console.log("  リズム:", before.rhythm.join(" / ") || "なし");
  if (process.argv.includes("--fix")) {
    const out = deaiMechanical(src);
    writeFileSync(file, out);
    const after = scanAiese(out);
    console.log(`→ 機械置換後 score=${after.score} per1000=${after.per1000}`);
  }
}

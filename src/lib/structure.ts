// 原稿の「構造」の検査。生成・改稿・公開前の3か所で同じ物差しを使う。
//
// 【なぜ必要か】2026-09-09 公開の「スキルアップAIの評判」は、同じ節が丸ごと2回入り、
// 比較表の先頭セルが欠け（「ル | 形式 | …」で始まる行）、「次の詳細分析は後半で扱います」
// という生成過程の残骸まで載った状態でトップページの「最新」枠に出た。
// 原因は、文体の書き直し（LLM）が構造を崩したのに、重複除去は書き直しの前にしか
// 走らず、公開前検査（quality.ts）にも構造の項目が無かったこと。
// 文体より構造のほうが先に読者の信用を失う。ここで機械的に止める。

export interface StructureProblem { kind: string; detail: string }

const LEFTOVER = /(前半|中盤|後半)(で|に)(扱|述べ|解説|書)|次の詳細分析|以下省略|（省略）|\(以下略\)/;

/** 見出し文字列の正規化。番号・空白・句読点の差で「別の見出し」と判定しないため */
function normHeading(s: string): string {
  return s.replace(/^\d+[.．、]\s*/, "").replace(/[\s　。．、:：]/g, "").toLowerCase();
}

export function findStructureProblems(md: string): StructureProblem[] {
  const out: StructureProblem[] = [];
  const lines = md.split("\n");

  // 1. 見出しの重複（## も ### も）。目次に同じ行が2回並び、読者は同じ話を2回読まされる。
  const seen = new Map<string, number>();
  for (const l of lines) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    const key = m[1] + normHeading(m[2]);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 2) out.push({ kind: "重複見出し", detail: m[2] });
  }

  // 2. 表の崩れ。表の行は必ず「|」で始まる。途中で切れた行（「ル | 形式 |」）や、
  //    区切り行と列数が合わない行は、レンダリングすると表ではなく文字の羅列になる。
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i])) {
      // 表の外にある「| を3つ以上含む行」は、先頭が欠けた表の行とみなす
      if ((lines[i].match(/\|/g) || []).length >= 3 && !/^\s*>/.test(lines[i])) {
        out.push({ kind: "表崩れ", detail: `先頭が欠けた行: ${lines[i].slice(0, 30)}` });
      }
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
    const block = lines.slice(start, i);
    if (block.length < 2 || !/^\s*\|\s*:?-{2,}/.test(block[1])) {
      out.push({ kind: "表崩れ", detail: `区切り行がない: ${block[0].slice(0, 30)}` });
      continue;
    }
    const cols = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
    const n = cols(block[0]);
    for (const row of block.slice(2)) {
      if (cols(row) !== n) { out.push({ kind: "表崩れ", detail: `列数不一致(${cols(row)}≠${n}): ${row.slice(0, 30)}` }); break; }
    }
  }

  // 3. 生成過程の残骸。
  for (const l of lines) {
    if (LEFTOVER.test(l)) { out.push({ kind: "生成の残骸", detail: l.trim().slice(0, 40) }); break; }
  }

  // 4. 中身のない節（見出しの直後に次の見出し、または40字未満）。
  const heads: number[] = [];
  lines.forEach((l, idx) => { if (/^##\s+/.test(l)) heads.push(idx); });
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const body = lines.slice(h + 1, end).join("").replace(/[#>*`|\-\s]/g, "");
    if (body.length < 40) out.push({ kind: "空の節", detail: lines[h].replace(/^##\s+/, "") });
  });

  return out;
}

/** 見出し（## / ###）の並びを配列で返す。書き直し前後で同一かを比べる用 */
export function headingList(md: string): string[] {
  return (md.match(/^#{2,3}\s+.+$/gm) || []).map((l) => l.replace(/^(#{2,3})\s+/, "$1 ").trim());
}

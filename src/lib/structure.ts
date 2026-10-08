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

/**
 * 「当サイトの調査によると」「当サイトの独自調査では」を本文から削る（2026-10-08）。
 * 当サイトは調査をしていないので書けない言い回しだが、生成がこの前置きを付ける癖があり、
 * 検査で3回（9/15・9/25・10/7）本題の記事が丸ごと却下された。前置きだけ消せば文は成り立つ。
 * 「平均◯万円」のような中身の数字は残るので、quality.ts の金額検査がそのまま見る。
 */
export function stripSurveyClaims(body: string): string {
  return body
    .replace(/当サイト(の|が行った|が実施した)?(独自)?(調査|アンケート)(結果)?(によると|によれば|では|で(は)?分かった(のは|ことは)?)[、,]?\s*/g, "")
    .replace(/(編集部|当編集部)の(独自)?調査(によると|では)[、,]?\s*/g, "");
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

  // 3b. 生成の残骸（別の記事の定型）と壊れたリンク（2026-09-29）。
  //  - news-20260929-c4f4s: 元記事の「【FAQ】」「【著者】」「【公開日】」「【参考】」をそのまま写した
  //  - topic-saisho-no-gengo: `[文言]( [6問診断](/shindan/) )` のようにリンクが入れ子になった
  //  - 9/26 の news: `]( )` のように空のリンク
  for (const l of lines) {
    if (/^\s*【(FAQ|著者|公開日|参考|執筆者|監修)】/.test(l)) { out.push({ kind: "生成の残骸", detail: l.trim().slice(0, 30) }); break; }
    // 伏せ字のまま（kyufukin-uzuzcollege・kyufukin-techacademy の「最大◯◯%還元」。プロンプトの例文がそのまま出た）
    if (/◯◯|○○|△△|××/.test(l)) { out.push({ kind: "伏せ字", detail: l.trim().slice(0, 30) }); break; }
  }
  for (const l of lines) {
    if (/\]\(\s*\[|\]\(\s*\)|\]\(\.\[/.test(l)) { out.push({ kind: "リンク崩れ", detail: l.trim().slice(0, 40) }); break; }
  }

  // 3c. 同じ段落の重複（40字以上の段落が2回）。kyufukin-runteq（9/29）は同じ締めの段落が冒頭と末尾に2回入った。
  //     見出しの重複検査は見出しの無いブロックの重複を拾えない。
  const paras = new Map<string, number>();
  for (const para of md.split(/\n\s*\n/)) {
    const key = para.replace(/[\s　>*#\-]/g, "");
    if (key.length < 40 || /^\|/.test(para.trim())) continue;
    const n = (paras.get(key) ?? 0) + 1;
    paras.set(key, n);
    if (n === 2) { out.push({ kind: "段落の重複", detail: para.trim().slice(0, 30) }); break; }
  }

  // 3d. 途中から始まる番号リスト（「3.」から始まる）。書き直しで前半が切れたときの痕跡。
  //     kyufukin-runteq（9/29）は「保険者期間が3年以上必要です。」という文の途中から始まり、3〜5番だけのリストが残った。
  //     番号の間に字下げしない段落が挟まる書き方（「1. **見出し**」の次の行が本文）は正常なので、
  //     「同じ節の中に1つ前の番号が無い」ときだけ止める。
  const seenNums = new Set<number>();
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) { seenNums.clear(); continue; }
    const li = /^\s{0,3}(\d+)[.)．]\s+/.exec(l);
    if (!li) continue;
    const n = Number(li[1]);
    if (n > 1 && !seenNums.has(n - 1)) { out.push({ kind: "途中から始まるリスト", detail: l.trim().slice(0, 30) }); break; }
    seenNums.add(n);
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

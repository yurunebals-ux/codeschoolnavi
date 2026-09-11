// 記事のカテゴリ判定（一覧のチップ・サムネの配色・記事ページのアイキャッチで共用）。
// ニュース解説とトピック記事はタイトルではなく frontmatter のフラグで判定する。
export type Cat = "給付金" | "比較" | "評判・口コミ" | "注意点" | "料金" | "ニュース" | "学習・キャリア" | "解説";
export function catOf(title: string, data?: { news?: boolean; topic?: boolean }): Cat {
  if (data?.news || /｜ニュース解説$/.test(title)) return "ニュース";
  if (data?.topic) return "学習・キャリア";
  if (title.includes("給付金")) return "給付金";
  // 「やめとけ」は検索語としては強いが、タグに出すとマイナス印象が先に立つ（オーナー指摘 2026-09-11）。
  // タイトルは検索需要に合わせて残し、カテゴリ表示は「注意点」にする。
  if (title.includes("やめとけ") || title.includes("後悔しない判断基準")) return "注意点";
  if (/料金は高い|の料金/.test(title)) return "料金";
  if (title.includes("比較") || title.includes("おすすめ")) return "比較";
  if (title.includes("評判")) return "評判・口コミ";
  return "解説";
}

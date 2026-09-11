// 記事のカテゴリ判定（一覧のチップ・サムネの配色・記事ページのアイキャッチで共用）。
// ニュース解説とトピック記事はタイトルではなく frontmatter のフラグで判定する。
export type Cat = "給付金" | "比較" | "評判・口コミ" | "やめとけ" | "料金" | "ニュース" | "学習・キャリア" | "解説";
export function catOf(title: string, data?: { news?: boolean; topic?: boolean }): Cat {
  if (data?.news || /｜ニュース解説$/.test(title)) return "ニュース";
  if (data?.topic) return "学習・キャリア";
  if (title.includes("給付金")) return "給付金";
  if (title.includes("やめとけ")) return "やめとけ";
  if (/料金は高い|の料金/.test(title)) return "料金";
  if (title.includes("比較") || title.includes("おすすめ")) return "比較";
  if (title.includes("評判")) return "評判・口コミ";
  return "解説";
}

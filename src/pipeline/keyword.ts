// ROLE: SEO Strategy Lead（日本市場）
// 日本語の買い手直前キーワードをクラスター構造で生成。日本語はURLに使えないため、
// slug は英字ID（tool.id / categoryId / audience.id）から生成し、表示キーワードは日本語。
import { readFileSync } from "node:fs";
import { paths } from "../lib/config.js";
import { loadState, saveState, type KeywordItem, type ArticleKind } from "../lib/store.js";

interface Tool { id: string; name: string; category: string; categoryId: string; }
interface Audience { id: string; label: string; }
interface Affiliates { audiences: Audience[]; tools: Tool[]; comparison_pairs: [string, string][]; subsidy_ids?: string[]; }

function score(intent: number, kind: ArticleKind): number {
  let s = intent * 9;
  if (kind === "money") s += 10;
  if (kind === "pillar") s += 8;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function buildKeywords(limit = 40): number {
  const aff: Affiliates = JSON.parse(readFileSync(paths.affiliates, "utf8"));
  const byId = new Map(aff.tools.map((t) => [t.id, t] as const));
  const state = loadState();
  const existing = new Set(state.keywords.map((k) => k.slug));
  const out: KeywordItem[] = [];
  const now = new Date().toISOString();

  const add = (slug: string, keyword: string, template: string, toolIds: string[], intent: number, kind: ArticleKind, cluster: string, audience?: string) => {
    if (existing.has(slug) || out.some((c) => c.slug === slug)) return;
    out.push({ slug, keyword, template, tools: toolIds, audience, kind, cluster, score: score(intent, kind), status: "queued", createdAt: now });
  };

  const categories = [...new Map(aff.tools.map((t) => [t.categoryId, t.category])).entries()]; // [id,label]

  // 1) PILLAR — カテゴリごとの比較ハブ
  for (const [cid, clabel] of categories) {
    const ids = aff.tools.filter((t) => t.categoryId === cid).map((t) => t.id);
    add(`osusume-hikaku-${cid}`, `${clabel}のプログラミングスクールおすすめ比較`, "pillar:osusume", ids, 9, "pillar", clabel);
  }

  // 特別ハブ：給付金対象（最大70%還元）— 需要が大きく成約に強い高収益ページ（自作の分析による設計）
  if (aff.subsidy_ids && aff.subsidy_ids.length) {
    add(`kyufukin-osusume`, `給付金対象のプログラミングスクールおすすめ｜最大70%還元の条件も解説`, "pillar:subsidy", aff.subsidy_ids, 10, "pillar", "給付金対象");
  }
  // 特別ハブ：「意味ない/やめとけ」への中立的回答（検索需要が非常に多い）
  add(`imiaru-erabikata`, `プログラミングスクールは意味ない？やめとけと言われる理由と後悔しない選び方`, "pillar:doubt", aff.tools.slice(0, 6).map((t) => t.id), 9, "pillar", "選び方");

  // 2) MONEY — 評判/料金/やめとけ/比較/おすすめ(対象者別)
  for (const t of aff.tools) {
    add(`hyoban-${t.id}`, `${t.name}の評判・口コミは？特徴を解説`, "money:review", [t.id], 9, "money", t.category);
    add(`ryokin-${t.id}`, `${t.name}の料金は高い？他社と比較`, "money:pricing", [t.id], 8, "money", t.category);
    add(`yametoke-${t.id}`, `${t.name}はやめとけ？評判と後悔しない判断基準`, "money:doubt", [t.id], 8, "money", t.category);
  }
  for (const [a, b] of aff.comparison_pairs) {
    const ta = byId.get(a), tb = byId.get(b);
    if (!ta || !tb) continue;
    add(`hikaku-${a}-${b}`, `${ta.name}と${tb.name}を徹底比較｜どっちがおすすめ？`, "money:vs", [a, b], 8, "money", ta.category);
  }
  for (const [cid, clabel] of categories) {
    const ids = aff.tools.filter((t) => t.categoryId === cid).map((t) => t.id);
    for (const au of aff.audiences) {
      add(`osusume-${cid}-${au.id}`, `${au.label}におすすめの${clabel}プログラミングスクール`, "money:best-for", ids, 8, "money", clabel, au.id);
    }
  }

  // 3) INFO — 選び方/とは（クラスターを支える情報記事）
  for (const [cid, clabel] of categories) {
    const ids = aff.tools.filter((t) => t.categoryId === cid).map((t) => t.id);
    add(`erabikata-${cid}`, `${clabel}のプログラミングスクールの選び方`, "info:choose", ids, 6, "info", clabel);
  }
  for (const t of aff.tools) {
    add(`towa-${t.id}`, `${t.name}とは？特徴・コース・向いている人`, "info:what", [t.id], 5, "info", t.category);
  }

  out.sort((a, b) => b.score - a.score);
  const chosen = out.slice(0, limit);
  state.keywords.push(...chosen);
  saveState(state);
  console.log(`[strategist] queued ${chosen.length} 件（${categories.length}クラスター、最上位: "${chosen[0]?.keyword}" @${chosen[0]?.score}）`);
  return chosen.length;
}

if (import.meta.url === `file://${process.argv[1]}`) buildKeywords(Number(process.argv[2]) || 40);

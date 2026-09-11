// slug → 主題スクール → 公式サイトのスクショ。
// 記事ページ（CTA・料金監視・出典付きスクショ）と一覧（アイキャッチ）で共用する。
// slug 規約: <template>-<toolId> ／ hikaku-<a>-<b>（比較は提携済み側を主題にする）。
import offersFile from "../data/offers.json";
import shotsFile from "../data/shots.json";

const offers = (offersFile as any).offers ?? {};
const shots = (shotsFile as any).shots ?? {};

/** 記事に関係するスクール id（0〜2件。2校比較は [主題, 相手]） */
export function schoolsFromSlug(slug: string): string[] {
  const ids = new Set(Object.keys(offers));
  const m = slug.match(/^(hyoban|ryokin|yametoke|towa)-(.+)$/);
  if (m && ids.has(m[2])) return [m[2]];
  const h = slug.match(/^hikaku-(.+)$/);
  if (h) {
    // id にハイフンは無いので、先頭から最長一致で2つに割る
    const parts = h[1].split("-");
    for (let i = 1; i < parts.length; i++) {
      const a = parts.slice(0, i).join("-"), b = parts.slice(i).join("-");
      if (ids.has(a) && ids.has(b)) return offers[a]?.sponsored ? [a, b] : offers[b]?.sponsored ? [b, a] : [a, b];
    }
  }
  return [];
}

export function schoolFromSlug(slug: string): string | null {
  return schoolsFromSlug(slug)[0] ?? null;
}

export interface ShotRef { id: string; name: string; file: string; small: string; official?: string; takenAt: string }

/** 記事のアイキャッチに使える公式サイトのスクショ（無ければ空） */
export function shotsFor(slug: string): ShotRef[] {
  return schoolsFromSlug(slug)
    .filter((id) => shots[id]?.file)
    .map((id) => ({
      id,
      name: offers[id]?.name ?? id,
      file: shots[id].file,
      small: shots[id].file.replace(/\.webp$/, "-s.webp"),
      official: offers[id]?.official,
      takenAt: shots[id].takenAt ?? "",
    }));
}

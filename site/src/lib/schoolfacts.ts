// スクールの要点データ（結論カード・比較ボックスで共用、2026-09-28）。
// 元データは data/affiliates.json（記事生成と同じ一次データ）。表示用に短く整える。
import aff from "../../../data/affiliates.json";
import offersFile from "../data/offers.json";

const tools: any[] = (aff as any).tools ?? [];
const offers: Record<string, any> = (offersFile as any).offers ?? {};
const yen = (n: number) => n.toLocaleString("ja-JP");
const none = (v: any) => !v || /^(―|-|記載なし|不明)$/.test(String(v).trim());
const norm = (s: string) => s.replace(/[\s（）()・]/g, "").toLowerCase();

export interface Facts {
  id: string; name: string; price: string; period: string; format: string;
  job: string; refund: string; subsidy: "あり" | "なし" | "要確認"; oneLiner: string;
  offer: any | null; review: string | null; kyufukin: string | null;
}

export function factsOf(id: string, slugs: Set<string>): Facts | null {
  const t = tools.find((x) => x.id === id);
  if (!t) return null;
  const monthly = /月額/.test(t.period ?? "") || /^月額/.test(t.price_note ?? "");
  const price = t.price_from_yen > 0
    ? (monthly ? `月額${yen(t.price_from_yen)}円` : `${yen(t.price_from_yen)}円〜`)
    : (/無料/.test(t.price_note ?? "") && /円/.test(t.price_note ?? "") ? "無料（条件あり）" : "無料");
  const sn = String(t.subsidy_note ?? "");
  const subsidy = /対象講座なし|対象外|なり得ない|前提としない/.test(sn.slice(0, 40)) || /対象として扱わない|指定講座なし/.test(sn) ? "なし"
    : /専門実践|一般教育訓練|特定一般/.test(sn) && /対象/.test(sn) ? "あり" : "要確認";
  return {
    id, name: offers[id]?.name ?? t.name,
    price, period: t.period ?? "", format: t.format ?? "",
    job: none(t.job_support) ? "記載なし" : String(t.job_support),
    refund: none(t.refund) ? "記載なし" : String(t.refund),
    subsidy, oneLiner: t.one_liner ?? "",
    offer: offers[id] ?? null,
    review: slugs.has(`hyoban-${id}`) ? `/blog/hyoban-${id}/` : null,
    kyufukin: slugs.has(`kyufukin-${id}`) ? `/blog/kyufukin-${id}/` : null,
  };
}

/** 記事の tools（スクール名の配列）→ id。offers と affiliates の名前で照合する */
export function idsFromNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const k = norm(n);
    const hit = Object.entries(offers).find(([, o]) => norm(o.name) === k)?.[0]
      ?? tools.find((t) => norm(t.name) === k || norm(t.name).startsWith(k) || k.startsWith(norm(t.name)))?.id;
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** 評判記事の「編集部の判定：「A には合う、B には合わない」」から、向く人・向かない人を取り出す */
export function verdictOf(body: string): { fit: string; unfit: string } | null {
  const m = body.match(/^## 編集部の判定：「(.+?)」\s*$/m);
  if (!m) return null;
  const v = m[1];
  const r = v.match(/^(.+?)(?:には|に)合う(?:が)?、?(.+?)(?:には|に)(?:は)?合わない/);
  if (!r) return null;
  return { fit: r[1].trim(), unfit: r[2].trim() };
}

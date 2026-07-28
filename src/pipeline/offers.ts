// ROLES: 収益責任者 + シニアエンジニア
//
// 記事とトップページに出す「申し込み導線（CTA）」の唯一の生成元。
//
// なぜ Markdown ではなくここで作るのか（設計の核心）:
//   1. 記事本文はLLMが1回書いたら凍結される。本文にアフィリンクを焼き込むと、
//      提携が承認された日に全記事を書き直すことになる（＝LLMコストと品質リスク）。
//   2. quality.ts はプレースホルダURL（REPLACE-.../PENDING-...）を含む原稿を
//      ハードブロックする。つまり未承認のうちは本文にリンクを入れられない。
//      結果として公開10本の外部リンクは0本、CTAはゼロになっていた。
//   3. データ駆動にしておけば、承認日にやることは affiliates.json の
//      affiliate_url を1行差し替えるだけ。全ページのCTAが一斉に収益リンクへ変わる。
//
// 出力: site/src/data/offers.json （Astro側が読む）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { paths } from "../lib/config.js";

const PLACEHOLDER = /REPLACE-WITH-YOUR|PENDING-A8-APPROVAL/;

export interface Offer {
  /** 表示名 */
  name: string;
  /** 遷移先。提携済みならアフィリンク、未承認なら公式サイト。 */
  href: string;
  /** true のときだけ rel="sponsored" と広告表記を出す（ステマ規制）。 */
  sponsored: boolean;
  /** ボタンの文言（記事内の大きいCTA用） */
  label: string;
  /**
   * 狭い場所用の短い文言。トップのカード内や表の中はスクール名が
   * すぐ隣に出ているので、名前を繰り返すと3行に折れて読みにくい。
   */
  short: string;
  /** ボタン下の一言（無料である旨など） */
  note: string;
}

export interface OffersFile {
  _note: string;
  /** slug からスクールを引けないページ用（給付金ハブなど）の指名 */
  picks: Record<string, string>;
  offers: Record<string, Offer>;
}

interface Tool {
  id: string; name: string; affiliate_url?: string; official_url?: string;
  reward_note?: string; moshimo_status?: string; a8_status?: string;
}

/**
 * 「無料カウンセリング」が成果地点の案件は、そう書いたほうが押される。
 * もしものSHIFT TERAS CAMPUSは無料カウンセリング申込が1,000円（ほぼ全承認）なので、
 * 文言を公式サイト送客ではなく相談予約に寄せる。
 */
function labelFor(t: Tool, sponsored: boolean): { label: string; short: string; note: string } {
  const priceNote = "料金・開講日は変わることがあります。申し込み前に公式サイトでご確認ください。";
  if (!sponsored) {
    return { label: "公式サイトで最新の料金を見る", short: "公式サイトを見る", note: priceNote };
  }
  const counseling = /カウンセリング|無料相談|説明会|面談/.test(t.reward_note ?? "");
  if (counseling) {
    return {
      label: `${t.name}の無料カウンセリングを見る`,
      short: "無料カウンセリングを見る",
      note: "相談は無料。その場で申し込む必要はありません。",
    };
  }
  return { label: `${t.name}の公式サイトを見る`, short: "公式サイトを見る", note: priceNote };
}

export function buildOffers(): OffersFile {
  const affPath = resolve(paths.data, "affiliates.json");
  const aff = JSON.parse(readFileSync(affPath, "utf8")) as {
    tools: Tool[]; subsidy_ids?: string[];
  };

  const offers: Record<string, Offer> = {};
  for (const t of aff.tools) {
    const a = (t.affiliate_url ?? "").trim();
    const o = (t.official_url ?? "").trim();
    const usable = (u: string) => /^https?:\/\//.test(u) && !PLACEHOLDER.test(u);

    let href = "";
    let sponsored = false;
    if (usable(a)) { href = a; sponsored = true; }
    else if (usable(o)) { href = o; sponsored = false; }
    else continue; // 出せるURLが無いスクールはCTA自体を出さない（空振りリンクを作らない）

    const { label, short, note } = labelFor(t, sponsored);
    offers[t.id] = { name: t.name, href, sponsored, label, short, note };
  }

  // 給付金ハブのように「1校に紐づかない」ページ用の指名。
  // 給付金対象（subsidy_ids）のうち、提携済みのものを優先する。
  // ハードコードしないのは、承認が増えたときに自動でよりよい案件へ移るため。
  const subsidy = aff.subsidy_ids ?? [];
  const kyufukin =
    subsidy.find((id) => offers[id]?.sponsored) ??
    subsidy.find((id) => offers[id]) ??
    "";

  const out: OffersFile = {
    _note:
      "自動生成（src/pipeline/offers.ts）。手で編集しない。" +
      "提携が承認されたら data/affiliates.json の affiliate_url を差し替えれば、ここも全ページのCTAも自動で切り替わる。",
    picks: kyufukin ? { kyufukin } : {},
    offers,
  };

  // 事故防止: プレースホルダが1つでも混ざったら書き出さずに落とす。
  // 死んだ外部リンクを本番に出すくらいなら、ビルドを止めたほうがいい。
  const dump = JSON.stringify(out);
  if (PLACEHOLDER.test(dump)) {
    throw new Error("[offers] プレースホルダURLが混入している。affiliates.json を確認すること。");
  }
  return out;
}

/** site/src/data/offers.json を更新。変化があったら true。 */
export function syncOffers(): boolean {
  const out = buildOffers();
  const dest = resolve(paths.root, "site/src/data/offers.json");
  const body = JSON.stringify(out, null, 2) + "\n";
  const before = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  if (before === body) return false;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  const n = Object.keys(out.offers).length;
  const paid = Object.values(out.offers).filter((o) => o.sponsored).length;
  console.log(`[ops] offers.json を更新: ${n}件（うち提携済み ${paid}件）`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = buildOffers();
  for (const [id, v] of Object.entries(o.offers)) {
    console.log(`${v.sponsored ? "💰" : "  "} ${id.padEnd(20)} ${v.label}`);
  }
  console.log("picks:", o.picks);
  syncOffers();
}

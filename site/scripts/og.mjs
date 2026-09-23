// 記事ごとの OGP 画像（1200x675 PNG）をビルド後に作る。
// 2026-09-23 アクセス特化: これまでニュース・トピック記事は og-default.png の共通画像で、
// X・LINE・はてなで共有されても全部同じカードだった。記事ページのアイキャッチ（Thumb.astro のインラインSVG）を
// そのまま PNG にして、og:image / twitter:image / JSON-LD の image を差し替える。
// 公式スクショがある記事は既に個別の og 画像があるので触らない（og-default.png の記事だけが対象）。
// 日本語の描画には Noto Sans CJK が要る（pages.yml で fonts-noto-cjk を入れる）。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const dist = new URL("../dist/", import.meta.url).pathname;
const blog = join(dist, "blog");
const outDir = join(dist, "og");
mkdirSync(outDir, { recursive: true });
const site = (process.env.SITE_URL || "https://codeschoolnavi.com").replace(/\/$/, "");
const DEFAULT = `${site}/og-default.png`;

let made = 0, skipped = 0;
for (const slug of readdirSync(blog)) {
  const file = join(blog, slug, "index.html");
  if (!existsSync(file)) continue;
  let html = readFileSync(file, "utf8");
  if (!html.includes(DEFAULT)) { skipped++; continue; }
  const i = html.indexOf('class="eyecatch"');
  if (i < 0) { skipped++; continue; }
  const s = html.indexOf("<svg", i);
  const e = html.indexOf("</svg>", s);
  if (s < 0 || e < 0 || s - i > 400) { skipped++; continue; }
  let svg = html.slice(s, e + 6);
  // 幅・高さを明示し、名前空間を保証する（インラインSVGには無いことがある）
  svg = svg.replace(/^<svg/, '<svg width="1200" height="675"');
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  // librsvg は system-ui 系の名前を知らないので、日本語フォントを先頭に足す
  svg = svg.replace(/font-family="([^"]*)"/g, (_m, f) => `font-family="Noto Sans CJK JP,${f.replace(/"/g, "'")}"`);
  try {
    await sharp(Buffer.from(svg), { density: 180 }).resize(1200, 675, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(join(outDir, `${slug}.png`));
    html = html.split(DEFAULT).join(`${site}/og/${slug}.png`);
    writeFileSync(file, html);
    made++;
  } catch (err) {
    console.log(`[og] 失敗 ${slug}: ${err.message}`);
  }
}
console.log(`[og] 生成 ${made} 枚 ／ 対象外 ${skipped} 本`);

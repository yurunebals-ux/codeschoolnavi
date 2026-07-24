# Affiliate Autopilot（日本市場版）

日本のアフィリエイト（既定: プログラミングスクール比較）のSEOサイトを、AIで記事量産→品質ゲート
→自動公開→自動最適化する自律システム。日本市場向けの設計は `日本市場版_設計ポイント.md`、
成功事例の反映は `PLAYBOOK.md`、フレームワーク全体は `設計書.md`。
ニッチは `data/affiliates.json` を差し替えるだけで他ジャンルに変更できます。

## これは何を自動化するか
毎日、GitHub Actions が以下を無人で回します:
1. `keyword` 買い手直前キーワードをクラスター構造で発掘
2. `generate` AIロール(ライター/編集長)が比較表・FAQ付きの記事を生成、アフィリリンク挿入
3. `quality` QA+コンプライアンスが薄い/重複/開示なしを自動却下(スパム防止=放置の生命線)
4. `publish` 合格記事を公開、内部リンク付与、IndexNow通知
5. `analytics` 2ページ目の記事を検出し強化キューへ
6. `dashboard` 進捗・期限・推定MRRを `dashboard.html` に出力

## セットアップ(所要 約30分・以降は無人)
```bash
npm install
cp .env.example .env   # 値を埋める(下記「あなたが用意するもの」)
npm run cycle          # 1サイクル手動実行(動作確認)
```
GitHub に push し、リポジトリの Secrets に .env の値を登録すれば、`.github/workflows/daily.yml`
が毎日自動実行します。サイトは `site/` を Cloudflare Pages に接続すれば自動デプロイ。

## コマンド
| コマンド | 役割 |
|---|---|
| `npm run cycle` | 1日分の全工程を実行 |
| `npm run status` | 現在のパイプライン状況をJSON表示 |
| `npm run dashboard:build` | ダッシュボード再生成 |
| 各 `npm run keyword:build` 等 | 工程を個別実行 |

## オフラインモード
`LLM_API_KEY` 未設定でも全工程が動作(ダミー記事を生成し品質ゲートで却下)。
配線確認用。実記事の生成にはキーが必要。

## ⚠ あなた(オーナー)が用意するもの ＝ 唯一の必須作業
コードと自動化はすべて構築済み。以下だけは本人の身元/支払いが必要で代行不可です。
`.env` に貼るだけで完了します。

1. **ASP登録＋案件提携**(無料): A8.net / afb / アクセストレード / もしも。スクール案件と提携し、
   発行された広告リンクを `data/affiliates.json` の `affiliate_url` に貼る（詳細は申込ガイド_日本.html）。
2. **ドメイン**(約1,500円/年): 取得して `SITE_URL` に設定。
3. **LLM APIキー**(従量): `LLM_API_KEY` に設定。目安 月3,000〜8,000円。
4. **GitHub / Cloudflare アカウント**(無料枠): リポジトリ配置とデプロイ用。
5. (任意) **Search Console** サービスアカウント: `analytics:loop` を有効化。

## ディレクトリ
```
src/lib        設定・ストア・LLM・チーム定義
src/pipeline   keyword/generate/quality/publish/analytics/dashboard
data           affiliates.json / team.json / state.json(実行時生成)
site           Astro 静的サイト(記事は content/blog)
.github/workflows/daily.yml  毎日の自動実行
```

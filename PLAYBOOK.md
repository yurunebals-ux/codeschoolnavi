# 成功アフィリエイト分析 → 本システムへの反映(プレイブック)

実際に成果を出しているアフィリエイトサイト/SEO事例を分析し、共通する勝ちパターンを抽出。
そのそれぞれを本システムのどの部分で実装済みかを対応づけたものです。

## 分析した勝ちパターンと実装対応

### 1. トピッククラスター(ピラー+クラスター)で専門性を作る
事例では、記事を独立して量産するのではなく「中心となるピラー(hub)ページ＋関連する情報記事」を
テーマごとに束ね、90日で権威性を構築 → 6ヶ月で自然流入+48%を達成。
- **実装**: `keyword.ts` がカテゴリごとに **PILLARページ(best {category} tools)** を自動生成し、
  すべての記事に `cluster` を付与。money/info 記事が同一クラスターに紐づく。

### 2. 情報記事 → 収益(比較)ページへ内部リンクで送客
上位サイトは「how-to / what-is」等の**情報記事(top-funnel)**から、**比較・レビュー等の"money page"**へ
内部リンクで読者を誘導する構造を持つ。
- **実装**: `keyword.ts` に INFO テンプレ(how to choose / what is / tutorial)を追加。
  `publish.ts` が公開時に**同一クラスター内へ内部リンク("Related guides")を自動付与**、
  ピラーを優先的にリンク(supporting → cornerstone)。

### 3. 買い手直前キーワード(best / vs / alternatives / review)に money page を当てる
成約は「比較・評価段階」の検索で起きる。上位サイトはこの購買直前クエリに専用ページを用意。
- **実装**: MONEY テンプレでこの4型を最優先スコアリング(`score()` で intent 加点)。

### 4. 長尾キーワード優先(競合低・成約高)
まず競合の低い long-tail を取り、後から難関KWへ広げる。
- **実装**: `score()` が3〜8語の long-tail に加点。上位から順にキュー投入。

### 5. EEAT(経験・専門性・権威性・信頼性)の担保
著者バイライン/著者ページ、独自の視点・意見、独自データ、開示、カスタムビジュアル。
- **実装**: 記事 frontmatter に author/日付、Article schema を出力(`generate.ts` / `Base.astro`)。
  `/about`(運営者・テスト方法)、`/disclosure`、`/privacy` ページを常設。
  生成プロンプトで「独自の評価軸・具体性・正直な意見」を要求。

### 6. スニペット獲得(Q&A・表)
FAQ形式と比較表は Featured Snippet / AI Overview に拾われやすい。
- **実装**: `generate.ts` が **FAQセクション + 比較表**を必須生成。`quality.ts` が表・FAQの有無を採点。

### 7. 自然なリンク配置 + rel="sponsored nofollow"
リンクは本文に文脈で自然に置き、外部(アフィリ)リンクには rel を付ける。
- **実装**: `astro.config.mjs` の rehype-external-links で**外部リンクに自動で
  `rel="sponsored nofollow noopener"`**を付与。本文内に文脈配置。

### 8. 定期更新(最低四半期)で順位を維持・改善
上位維持には公開後の更新が効く。特に2ページ目(11-20位)の記事は一押しで1ページ目化。
- **実装**: `analytics.ts` が Search Console から**11-20位の"あと一歩"記事を検出し再生成キューへ戻す**
  (updatedDate も更新)。

### 9. スパム回避(Googleの大量低品質AI生成ペナルティ対策)
AI量産だけの薄いサイトは制裁対象。編集・品質の層が生死を分ける。
- **実装**: `quality.ts`(QA+コンプライアンス)が**薄い/重複/誇大/開示なし/プレースホルダを自動却下**。
  合格したものだけ公開。

## まだ人間(あるいは追加投資)で強化できる余地
- 独自スクリーンショット/実測データ/動画 → 信頼性がさらに上がる(将来的に半自動化可能)。
- 被リンク獲得(アウトリーチ/デジタルPR) → 上位化を加速。予算があれば外注も選択肢。

---
*分析ソース:*
- *[How Topic Clusters Built Topical Authority in 90 Days (Link Whisper)](https://linkwhisper.com/how-topic-clusters-built-topical-authority-in-90-days/)*
- *[Affiliate SEO — The Ultimate Guide (Mangools)](https://mangools.com/blog/affiliate-seo/)*
- *[SEO Topical Authority Case Study (Diggity Marketing)](https://diggitymarketing.com/seo-topical-authority-case-study/)*

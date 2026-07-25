# 引き継ぎ — 新しいセッションは作業前にこれを読む

このファイルはリポジトリ内にあります。clone した時点で必ず手に入るので、
claude.ai プロジェクトに紐づいていないセッションでも読めます。

---

## 1. これは何のリポジトリか

**codeschoolnavi.com** — 日本のプログラミングスクール比較アフィリエイトサイト。
目的は「ほぼ完全放置で収益が出る仕組み」をつくること。サイトを作ること自体は目的ではない。

- 本番: https://codeschoolnavi.com （GitHub Pages、HTTPS 強制済み、独自ドメインはムームードメイン）
- 記事の自動生成・公開は GitHub Actions の cron `0 2 * * *` UTC（= 11:00 JST）。
  **セッションを開いていなくても毎日動く。** 会話が途切れてもサイトは止まらない。
- 予算はひと月あたり 0〜10,000円。オーナーは手を動かさない。
  例外は「私（Claude）が規約上できないこと」だけ = アカウント作成・ログイン・支払い・
  APIキーの入力・本人のメールボックス内のリンクを開くこと。

## 2. 絶対に守る 3 点

1. **`git push` はできない。** 認証情報が無く `fatal: could not read Username for 'https://github.com'`
   になる。`gh` コマンドも無い。ただし **`git fetch origin` は動く**（公開リポジトリの読み取りは
   認証不要）。コミット後に `git fetch origin && git reset --mixed origin/main` でローカル HEAD を
   合わせれば、`git status` に本当に残っている差分だけが出る。
2. **コミットは GitHub の「Upload files」UI 経由で行う。**（手順は §4）
   ブラウザのエディタ（CodeMirror）に長い文字列を打ち込む方式は、およそ 6,000 字に 1 文字の割合で
   静かに壊れるので使わない。Upload files はバイト列をそのまま送るので壊れない。
3. **本番を目で見る工程を省略しない。** 文法チェックも表記チェックも通り抜ける日本語崩れが
   実際に起きた（例: 「専門実践は受講中50%に修了後の条件を満たすと最大80%です」— 機械的な
   言い換えの副作用で助詞が壊れた）。最後に必ず本番のスクリーンショットを目で読む。
   機械側の backstop としてこの grep を回す:
   ```bash
   grep -nE '(をを|がが|はは|にに|でで|とと|、、|。。|[ぁ-んァ-ヶ一-龥]、と|%に修了|ますが、が)' *.md
   ```

## 3. セットアップ

```bash
git clone https://github.com/yurunebals-ux/codeschoolnavi /tmp/csn
cd /tmp/csn && npm install && cd site && npm install
```

- サイトは Astro 4.16（`site/`）、記事生成パイプラインは TypeScript + tsx（`src/`）。
- 生成は gpt-4.1-mini（OpenAI API）。`LLM_API_KEY` は GitHub Secrets にあり、
  サンドボックス内には無い。だからローカルでは常にオフライン扱いになる（`isOffline()` が true）。
- `npx tsc --noEmit -p .` は `TS2688 Cannot find type definition file for 'node'` で失敗する。
  これは以前から存在する既知の問題で、ビルドとデプロイには影響しない。
- Astro のテンプレート内で `<=` をそのまま書くとコンパイルエラーになる。

## 4. コミット手順（Upload files UI）

1. 変えたファイルの `git hash-object <file>` を取る。
2. リポジトリ側の path→sha を 1 回の API 呼び出しで取る:
   `https://api.github.com/repos/yurunebals-ux/codeschoolnavi/git/trees/main?recursive=1`
   → sha が違うファイルだけアップロードする。
3. アップロード用のファイルは **`/mnt/user-data/working/up/`** にディレクトリ構造を再現して置く。
   `file_upload` は `/tmp` 配下を受け付けない。1 回の合計は 10MB 未満。
4. アップロード input は `webkitdirectory:false` なので、まとめて上げると全部リポジトリ直下に
   落ちてしまう。**ディレクトリごとに** `https://github.com/yurunebals-ux/codeschoolnavi/upload/main/<dir>`
   を開いてから上げる。
5. `find` で "choose your files file input" を探して ref を取り、`file_upload({paths, ref, tabId})`。
6. コミット欄（エディタのダイアログとは別物）:
   `#commit-summary-input` / `#commit-description-textarea` /
   `input[name="commit-choice"][value="direct"]`（既定でオン）/ ボタンの文字は正確に `Commit changes`。
7. tree API を再取得して全 blob sha を照合する。
8. `git fetch origin && git reset --mixed origin/main`。
   ただし `data/pricewatch.json` と `site/src/data/pricewatch.json` は CI が毎日更新していて
   リモートのほうが新しいので、`git checkout --` でリモート側を採用する（上書きすると価格監視の
   履歴が巻き戻る）。

## 5. 検証のときの注意

- 確認は Contents API / tree API を使う。**raw.githubusercontent.com は古いキャッシュを返す。**
- 本番ページの fetch は **codeschoolnavi.com のタブから** 実行する（github.com のタブからだと
  CSP で外部 fetch が止まる）。URL に `?cb=` + 乱数を付け、`cache:'no-store'` を指定する。
- `deploy-pages` の run が `cancelled` になるのは `concurrency: pages` の正常動作。
  `site/**` を触るコミットを連続で入れると前の run が畳まれる。**最後の run が success なら問題ない。**
- `src/`・`data/`・リポジトリ直下だけを触るコミットはデプロイを起こさない。
- Actions の状態は `…/actions/runs?per_page=N` で未認証でも読める。`…/pages` は未認証だと 404。
- javascript_tool は URL や長い base64 を返そうとするとブロックされる。真偽値・件数・長さ・
  短いハッシュだけを返す。`Runtime.evaluate` は 45 秒で強制終了。ページ遷移をまたぐ値は
  `window.__X` ではなく `sessionStorage` に置く。

## 6. 記事の事実関係（教育訓練給付金）

- 一般教育訓練 20%（上限 10万円）
- 特定一般教育訓練 40%（上限 20万円）
- 専門実践教育訓練 受講中 50%（年間上限 40万円）＋ 修了後の就職等 20% ＋ 賃上げ 10%
  = **最大 80%（年間上限 64万円）**
- 雇用保険の加入期間は一般・特定一般が 1年以上、専門実践が 2年以上
- 専門実践・特定一般は **受講開始日の 2週間前まで** にハローワークで手続き

「最大 70%」は古い数字。記事に出てきたら誤りなので直す。

## 7. E-E-A-T の線引き（オーナーが明示した方針）

編集長は **「佐倉 透（さくら とおる）」**。これはペンネームであり、ページ上でその旨を明示している。

- OK（演出）: ペンネーム、イラストのアバター、一人称の語り、編集部としての見解
- NG（捏造）: 実在しない経歴・保有資格・受講体験・利用者レビュー
  （景品表示法／ステマ規制に触れる）

デメリットと向かない人を必ず書く、というのがサイトの唯一のルール。

## 8. 詳しい版はどこにあるか

claude.ai プロジェクト **「アフィリエイト　海外」** の `claude/進捗と次のステップ.md`。
`project_read` が使えるセッション（= そのプロジェクトに紐づいたセッション）ならそちらを読む。
使えないセッションでは、このファイルが唯一の引き継ぎ資料になる。

## 9. 次にやること

1. **Google Search Console 登録** — オーナーの Google ログインが必要。収益化で一番効く外部依存。
2. **もしもアフィリエイトの提携承認**（apply_status=2）→ `data/affiliates.json` の PENDING URL を
   差し替える。これが収益発生のスイッチ。A8 の状態もあわせて確認する。
3. Netlify を無料プランへ落とす（$9/月の停止）。ロールバック用にサイト自体は残す。
4. info@codeschoolnavi.com の受信設定（ムームーの転送設定、オーナー作業）。
5. DMM WEBCAMP → SHIFT TERAS CAMPUS のリブランドを記事に反映。
6. 記事が 15本を超えたらカテゴリタブを追加。提携承認後に ASP バナーを設置。
7. Phase 2: 英語版。

## 10. 期限（オーナーの必達目標）

- 初成約まで 90日
- 月 5万円まで 180日（必達）
- 月 20万円まで 365日

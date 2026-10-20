# noto.

**すぐにメモできる、モバイルファーストのタスク・メモ管理Webアプリ。**

白基調のGlass UI、タスクの左右スワイプ、ダークモード、GoogleログインによるAndroid/PC同期、任意実行のWorkers AIを備えています。余計な紹介文や登録導線よりも、最初の入力欄を優先します。

> **費用の方針:** 個人利用で **0円での開発・公開・利用** を目指します。Cloudflare **Workers Free**、D1 Free、Workers AIの無料割当、Google OAuth、GitHubの公開リポジトリを利用します。**無料＝無制限ではありません。** 無料枠を超えるとリクエストが失敗することがあります。**有料プランへのアップグレードや課金登録は不要**な運用を前提とし、カスタムドメインは購入しません。

## 実装と検証の状態

| 機能 | 状態 |
| --- | --- |
| メモ/タスク作成・編集・検索・フィルター・取り消し・期限 | 実装済み / モックUIテスト済み |
| 右スワイプで `未着手 → 進行中 → 完了`、左で戻す | 実装済み / Chromiumタッチテスト済み |
| Glass UI、ダークモード、アニメーション、全画面スケルトン | 実装済み / モックUIテスト済み |
| Google OAuthのみ（ゲストは端末内保存でアカウント不要） | **本番のGoogleログインをユーザーが実機確認済み** |
| Android/PC同期、オフライン時の送信キュー | **Windows ⇄ Androidの双方向同期・オフライン復旧をユーザーが実機確認済み** |
| Cloudflare D1 / Workers AI | **D1による端末間データ共有をユーザーが確認済み** / Workers AIの本番呼び出し・UI描画を確認、従来モデルの日本語抽出精度は失敗。Gemma 4＋原文根拠照合で日本語3件を抽出し、タスク化・Android同期を実機確認済み |
| GitHub Actions | GitHub上のチェック成功を確認済み。実クラウド接続テストとは別 |
| Android PWA | **ホーム画面インストール・スタンドアロン起動・ログイン維持・データ表示・Windows同期の5項目を実機確認済み** |
| JSONバックアップ | 実装済み / 自動テスト済み。ダウンロードの実機確認済み（復元は未実装） |
| Cloudflare本番URL | **公開済み:** https://noto-task.kato25801313.workers.dev |

**「ローカルでテスト成功」と「クラウド上でも問題なく動く」は違います。** Google OAuth、実D1、Android実機同期は今回の条件で実機確認済み。Workers AIも今回の日本語テストで確認済み。ただし未テストの操作は別途確認してください。


## 初学者向け：どのファイルが何を担当している？

**重要：プログラムの処理とコメントは別物です。** `//`、`/* ... */`、HTMLの `<!-- ... -->`、SQLの `--` は解説文であり、コンピューターが実行する命令ではありません。今回の修正は解説を日本語化したもので、アプリの処理内容は変更していません。

### 1. 最初に押さえる全体像

| ファイル | 役割 | 関連するファイル |
| --- | --- | --- |
| `public/index.html` | 入力欄・一覧・ボタンなど画面の骨組み | `app.js` がIDで要素を探す |
| `public/style.css` | 色・Glass UI・スワイプ・ダークモードの見た目 | `index.html` のclass、`theme.js` |
| `public/app.js` | クリック、メモ追加、編集画面、画面の再描画 | `logic.js`、`sync.js`、`backup.js`、`quota.js` |
| `public/logic.js` | タスク状態、検索、件数計算、入力検査 | `app.js`、`sync.js`、テスト |
| `public/sync.js` | 未同期の保存・API送信・競合コピー | `app.js` → `worker/index.js` |
| `worker/index.js` | 認証、API、D1のメモ保存、AIの呼び出し、権限確認 | `schema.sql`、`worker/usage.js`、`worker/task-extraction.js` |
| `schema.sql` | D1のusers、sessions、items、ai_usageテーブル | `worker/index.js` のSQL |
| `worker/task-extraction.js` | AIへの日本語指示、原文に存在する候補の検査 | `worker/index.js` のAI API |
| `worker/usage.js` | Cloudflareの使用量を読み取り専用で集計 | `worker/index.js` → `public/quota.js` |
| `public/quota.js` | 集計値を無料枠のカードとして表示 | `app.js`、`worker/usage.js` |
| `public/backup.js` | メモ・タスクをJSON形式で書き出す | `app.js`、`logic.js` |
| `public/theme.js` | 初回表示前のライト／ダーク設定 | `index.html`、`style.css` |
| `public/sw.js` | PWAをオフラインで開くための静的ファイルキャッシュ | `index.html`、`app.js` |
| `wrangler.jsonc` | Worker、D1、Workers AIの接続設定 | `worker/index.js` で `env.DB`、`env.AI` として参照 |
| `test/*.test.mjs` | 入力処理、同期、AI、無料枠などを確認する自動テスト | 対応する`public/`、`worker/`の各ファイル |

### 2. メモを追加したときに何が起きるか

```text
① index.html: 利用者がメモを入力し「追加」を押す
          ↓
② app.js: addItem() で画面にすぐ追加する
          ↓
③ logic.js: createItem() でID・作成日時などを付ける
          ↓
④ app.js → sync.js: recordPut() で送信待ちキューに保存
          ↓
⑤ sync.js → worker/index.js: PUT /api/items/:id を送信
          ↓
⑥ worker/index.js → D1: 本人のuser_idで安全に保存
          ↓
⑦ sync.js → app.js: 同期後のデータを反映して再描画
```

**なぜ端末に先に保存するの？** 通信の完了を待たずにメモを記録でき、電波がないときも書けるようにするため。再接続したら送信待ちの変更を送ります。ただし、端末データの削除や端末故障への完全な保証ではありません。

### 3. 2台で同時に編集したら？

`sync.js` は編集前の版（`expectedUpdatedAt`）をサーバーへ渡します。`worker/index.js` はD1の `updated_at` と照合し、古い版からの更新を拒否してHTTP 409を返します。すると `sync.js` は古い編集を「【競合コピー】」として別メモに保存します。**元のメモと編集した内容が両方残る理由が、この連携にあります。** ただし未検証の競合パターンもあるので、万能な自動マージではありません。

### 4. Googleログイン・友達とのデータ分離

`app.js` がGoogleログインに進むと、`worker/index.js` がGoogle OAuthを処理してセッションを発行します。APIが受け取るのはHttpOnly Cookieであり、画面のJavaScriptからセッショントークンを直接読む設計ではありません。サーバーはセッションから本人を特定し、D1への問い合わせにその `user.id` を必ず含めます。**同じCloudflareの無料枠を共有していても、メモの保存先はGoogleアカウント別**です。

### 5. AI抽出・無料枠・PWAの連携

- **AI：** `app.js` のAIボタン → `worker/index.js` → `worker/task-extraction.js` → Workers AI。候補を表示し、利用者が選んだものだけタスク化します。
- **使用状況：** `app.js` → `worker/index.js` の管理者専用API → `worker/usage.js` → `public/quota.js`。取得失敗は「0」ではなく「未取得」にします。
- **オフライン起動：** `public/sw.js` がHTML/CSS/JSをキャッシュします。**メモの同期処理とは別**であり、認証APIの返答はキャッシュしません。

### 6. 勉強するときのおすすめ順

1. `index.html` と `app.js` の `submitCapture()`・`addItem()` を見比べる
2. `logic.js` の `createItem()`・`nextStatus()` を読んで、`test/logic.test.mjs` と比較する
3. `sync.js` の `recordPut()`・`performFlush()`・`refresh()` を追う
4. `worker/index.js` の `route()` と `schema.sql` を見比べる
5. AIの `task-extraction.js`、無料枠の `usage.js`、PWAの `sw.js` を読む

**注意：** `GOOGLE_CLIENT_SECRET` や `CF_ANALYTICS_TOKEN` などの秘密値はCloudflare WorkerのSecretsにのみ登録してください。コード・コメント・README・GitHubのIssueに貼らないでください。


## Phase 1: JSON復元と全記録削除（段階的リリース）

- 設定 → JSONバックアップを復元：ファイルを選択し、追加件数と重複件数を確認してから新しいIDで取り込みます。既存記録を上書きしません。元の作成時刻は復元時刻に変更されます。同じ種類・本文・期限の記録は重複とみなしてスキップします。一度の取り込みは最大200件、JSONサイズは2MB以下です。
- 設定 → すべての記録を削除：本人が「全削除」と入力した場合だけ実行。オンラインで同期済みの場合のみ使用可能。ユーザーIDで限定し、友達のデータやGoogleログインアカウント自体は削除しません。元に戻すには事前にJSONバックアップが必要です。
- 全削除後に同期済みでない他の端末が古い記録を送信しないよう、ユーザー単位の世代番号 `account_epochs.epoch` を導入します。別端末が新世代を検知すると古い未同期操作は破棄されます（未同期内容が必要なら全削除前にバックアップしてください）。
- `app.js` は確認画面、`restore.js` は復元検証、`sync.js` は世代の永続化とオフライン端末対策、`worker/index.js` はD1への一括削除を担当します。秘密値や外部の有料APIは不要です。

**重要：D1移行が必要なので、マイグレーションが適用されるまで本番へマージしないでください。** 古いD1には `account_epochs` が存在しないため、先にWorkerをデプロイすると同期が失敗します。

Cloudflare管理画面の D1 → noto-db → Console で `migrations/0001_account_epoch.sql` のCREATE TABLEとINSERT文を実行し、テーブル作成を確認してからアプリをリリースします。SQLは既存のメモを削除しません。SQLの内容はコードレビューで確認してください。D1の移行を先に済ませるまでは**既存アプリを使い続けて構いません**。

## 全技術と選定理由

| 層 | 採用技術 | なぜ選んだか | トレードオフ・不採用案 |
| --- | --- | --- | --- |
| 画面 | HTML5 + CSS3 + **Vanilla JavaScript / ES Modules** | JavaScriptフレームワークやビルドツールに依存せず、画面が開いてすぐ入力できる。学習時にDOMとイベントの動きが見える | React/Next.jsより手動の状態管理が多い。現規模では軽さを優先 |
| UI | **CSS変数 + backdrop-filter + グラデーション** | 白系の透明なGlass層とダークモードを少ない依存で表現 | Apple純正Liquid Glass APIではない（Web標準による表現） |
| 動き | CSS transitions/keyframes + Pointer Events | スワイプ/ドラッグをAndroid・PCで共通実装。`prefers-reduced-motion`を尊重 | 大きなアニメーションライブラリを入れないので軽い |
| 静的公開 | **Cloudflare Workers Static Assets** | UI資産を追加の有料ホスティング無しで配信、APIと同じオリジン | プロジェクト独自ドメインは購入せず、無料の `workers.dev` を使用 |
| API | **Cloudflare Workers** | サーバーを管理しなくてよく、D1 / AIとネイティブ連携 | Freeの1リクエストあたりCPU時間制約あり |
| DB | **Cloudflare D1 (SQLite)** | SQLでユーザー・メモ・セッションを関連付け、ユーザー単位のデータ分離を実装。個人規模に適する | KVよりSQLの学習要素が増えるが検索・整合性を優先 |
| 同期 | **Fetch API + localStorage のキュー + 25秒ポーリング** | 更新をすぐ画面に反映し、オフライン時は端末に再送待ちを保持。追加の有料リアルタイム基盤は使わない | 完全なリアルタイムではない。同一メモの競合は版を照合し、編集内容を別の「競合コピー」として保存する。あらゆる競合パターンの検証は未完了 |
| ログイン | **Google OAuth 2.0 / OpenID Connect + PKCE** | メールアドレスとパスワードを自前で保管しない。Googleのみでログインできる | Google CloudでOAuthクライアント設定が必要。ゲストモードはログイン手段ではない |
| セッション | **Secure / HttpOnly / SameSite Cookie + SHA-256ハッシュ** | JSからCookieを直接読めず、D1には生トークンを保存しない | 期限切れセッションの掃除は将来のメンテナンス課題 |
| AI | **Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`)** | 別会社の有料AI APIキー不要。ユーザーがボタンを押したときだけメモを解析 | 無料Neuron予算とモデルの出力精度に制限。1ユーザー20回/日のアプリ側上限を設定 |
| オフラインUI | **Service Worker / Cache API** | 静的UIをキャッシュし、ネット接続なしでも既存画面を開ける | APIレスポンスと認証情報はキャッシュしない。同期には再接続が必要 |
| PWA | Web App Manifest | Android Chromeのホーム画面に追加可能 | OSネイティブアプリではない |
| CI | **GitHub Actions + Node.js標準の `node:test`** | 公開Repoなら基本的な構文/単体テストを無料で回せる | 本番Google認証の自動E2Eは含まれない |
| 操作E2E | Chromium + Python Playwright | DOM・タッチイベントを動かして検証 | 既存テストはAPIとlocalStorageをモック。実クラウドではない |
| 配布CLI | **Wrangler 4** | Cloudflare公式ツール。D1の作成とWorkerデプロイを統一 | npm/Node.js環境が必要 |

### 無料枠の目安（公式情報、2026年10月確認）

| サービス | 無料枠・制約 | 超過時 |
| --- | --- | --- |
| Workers Free | Worker実行 **100,000リクエスト/日**、CPU **10ms/リクエスト** | APIは制限・失敗。静的アセット配信は別扱い |
| Workers Static Assets | 静的アセットへのリクエスト無料、ファイル数などの制限あり | 制約内で利用 |
| D1 Free | **読み取り500万行/日、書き込み10万行/日、総保存量5GB**。単一DBは500MB上限 | DB操作失敗（自動で従量課金しない） |
| Workers AI Free | **10,000 Neurons/日**（Neuron＝Cloudflareが使用量を計測する単位） | AIリクエスト失敗。モデルにより条件が異なる |
| GitHub Public repository / Actions | 公開Repoの標準GitHubホストrunnerを利用（最新のGitHub条件を確認） | Actionsのプラン・ポリシーに従う |
| Google OAuth | 標準の `openid email profile` スコープでログイン | 使用規約・ユーザー数・審査要件に従う。Google Cloudで有料APIを有効化しない |

根拠（公式）: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) / [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) / [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) / [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) / [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)。**無料枠は変更され得るため、デプロイ前にも確認すること。**

**0円を維持する運用ルール**

1. Cloudflareは **Workers Freeプランを維持**。Workers Paid、R2、追加の有料サービス、課金が発生するモデルは使わない。
2. `*.workers.dev` の無料URLを使用し、独自ドメインを買わない。
3. AIは任意操作のみに限定し、1ユーザー20回/日を上限とする。**これは全ユーザー合計のNeuron制限ではない**ので、Cloudflare管理画面のNeurons使用量を確認する。
4. 本番デプロイ後、Workers/D1/AIダッシュボードで無料枠とエラーを確認する。枠を使い切ったら追加課金ではなく、機能停止や翌日のリセットを受け入れる。
5. 無料での提供を保証する契約ではありません。Cloudflare/GitHub/Googleの条件変更や大量アクセス時には、制限・提供停止などがあり得ます。

## ディレクトリとコードの読み方

```text
public/
  index.html         最初の入力欄・シート・一覧の構造
  style.css          Glass UI、ライト/ダーク、アニメーション
  theme.js           初回描画前にテーマを決める
  app.js             DOM、イベント、カードのスワイプ、編集画面
  logic.js           純粋な関数：状態遷移・検索・カウント
  sync.js            オフライン再送キュー、キャッシュ、クラウド同期
  backup.js          現在のメモ/タスクのJSONバックアップ（未同期含む）
  sw.js              静的UIのオフラインキャッシュ（APIは対象外）
  manifest.webmanifest  Android向けPWA設定
worker/index.js      API / Google OAuth / D1 / Workers AI
schema.sql           D1テーブルとインデックス
wrangler.jsonc       Cloudflareリソースのバインディング
.dev.vars.example    ローカル開発用の環境変数サンプル（秘密値なし）
.github/workflows/   GitHub Actionsのテスト定義
test/                単体・同期・SQLite・ブラウザ検証
```

**おすすめの学習順:** `public/logic.js` → `public/app.js` の `addItem` / `changeStatus` / `makeCard` → `public/sync.js` の `record` / `performFlush` / `refresh` → `worker/index.js` の `route` → `schema.sql`。

### 設計で重要な3つの理由

**1. メモを入力するたびに通信しない:** 画面上の保存は先に行い、ログイン中なら送信待ちキューに入れます（optimistic UI）。入力中にネットが遅くても編集が止まりません。

**2. API再送と競合保護:** 同一IDの作成・更新・削除では既存の `updated_at` を版として照合し、古い端末からの操作が他端末の変更を黙って上書きしないようにします。競合する編集は別メモにコピーを作り、削除競合では古い削除を中止します。

**3. 同期がないゲストモードを明確にする:** Googleでログインしていない状態では、メモはその端末の `localStorage` のみです。端末データを消すと失われるため、重要なデータはログインして未同期件数が0になっていることを確認してください。

## 開発・起動

### A. UIのみ試す（Python 3、Cloudflare登録不要）

```bash
python3 test/dev_server.py
# http://127.0.0.1:8765
```

モックAPIです。**このPythonサーバーはインターネットに公開しないこと。** Google OAuth、実D1、Workers AIはモックのため、見た目・操作の確認用です。

### B. Cloudflareの実ランタイムで開発（無料アカウント必要）

```bash
npm install
npx wrangler login
npx wrangler d1 create noto-db
```

`wrangler.jsonc` の `database_id` を作成結果のIDへ置換してから、以下を実行します。

```bash
cp .dev.vars.example .dev.vars
# .dev.vars を自分のGoogle OAuth情報で編集。Gitにはコミットしない
npm run db:local
npm run dev
# http://localhost:8787
```

Google Cloud ConsoleでOAuth同意画面と **Webアプリケーション用のOAuthクライアント** を作成します。必要なスコープは `openid email profile` だけです。ローカルで認証する場合の認可済みリダイレクトURIは `http://localhost:8787/api/auth/callback`。テスト公開モードならGoogle側でテストユーザーを追加してください。

### C. Cloudflare本番へ公開（無料の `workers.dev` URL）

```bash
npm run db:remote
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

本番URLを確認したら `wrangler.jsonc` に **公開オリジン** を追加し、Google Cloudの認可済みリダイレクトURIと一致させます。

```jsonc
"vars": { "APP_ORIGIN": "https://noto-task.<your-subdomain>.workers.dev" }
```

トップレベルに挿入してください（`<your-subdomain>` は自分のCloudflare設定に置換）。Google Cloud側には `https://noto-task.<your-subdomain>.workers.dev/api/auth/callback` を登録し、再デプロイします。**Google Client SecretはGitHub/README/公開設定ファイルに書かないこと。**

Cloudflareアカウントの接続/秘密鍵の入力とデプロイは、管理者本人の操作が必要です。

## テスト

```bash
npm test                # JS単体 + 同期 + SQLiteロジック
npm run check           # JS構文 + 単体テスト
python3 test/e2e.py      # ChromiumによるUI操作（API・ストレージはモック）
```

本番テスト用チェック項目:

- PCでGoogleログイン → メモを保存 → `未同期 0件` になる。
- Android Chromeで**同じ公開URL・同じGoogleアカウント**を開く → 同じメモが表示される。
- Androidでタスクをスワイプ → PCに戻るか同期ボタンを押す → 状態が反映される。
- Androidをオフラインにしてメモを追加 → オンライン復帰 → PCに反映。
- 別Googleアカウントでログイン → 他人のデータが表示されない。
- メモのAIボタンから抽出 → 提案を確認してタスク化。AI無料枠超過時にはエラーが表示される。

### 2026年10月20日：競合復旧・実機テスト記録

- Windows/AndroidのGoogleログイン・メモ作成/編集/双方向同期：ユーザー報告で成功。
- Androidオフライン編集からオンライン復帰後の同期：ユーザー報告で成功。
- 同一メモを両端末で編集したときの無条件上書きを再現し、競合コピーを追加。
- 更新プロトコル切替で旧バージョンの未同期DELETEが `428` になる問題を発見・修正。ユーザー報告では両端末の同期復旧を確認。
- `競合テスト003`：Windowsの編集とAndroidの競合コピーが両方残り、両端末が同期済みとなったことをユーザーが確認。
- Workers AIの実推論と画面表示は成功。ただし旧モデルは意味不明な日本語タスクを生成したため、Gemma 4と原文からの正確な引用チェックに切り替え。**修正版の日本語抽出・タスク化・Android同期が実機で成功**（サンプル1件、あらゆる入力での品質は未保証）。

### 自分のデータをJSONでバックアップする

設定 → **JSONバックアップ** から現在この端末に表示されているメモ・タスクをJSONとして保存できます。未同期の編集も含まれます。クラウドと端末の内容が一致していることが重要なときは「クラウドに同期」を確認してから保存してください。バックアップにはGoogleアカウントの識別子、メモ本文やタスク本文が**暗号化されず**含まれます。共有・公開せず安全に保管してください。**JSONからの復元はまだ実装されていません。**

### セキュリティ・データに関する注意

- Cloudflare D1にはGoogleユーザー識別子・表示名等とメモ本文が保存されます。機密情報やパスワードは入力しないでください。
- AIに送信する本文は**ボタンを押したメモだけ**です。LLMの回答を信用せず、提案内容を確認してから登録します。
- `localStorage` はブラウザごとの保存です。サイトデータ削除・端末故障による未同期データの消失は防げません。
- 同一メモの古い版から更新した場合はサーバーが競合を検知して上書きを拒否し、クライアントは「【競合コピー】」として編集内容を退避します。WindowsとAndroidでのオフライン対オンラインの競合テストはユーザーが成功を確認済みですが、**すべての競合・削除パターンで完全にデータを保護できることを保証するものではありません**。自動マージ・変更履歴は未実装です。
- 公開アプリで不特定多数が使う場合は、追加のクォータ保護、セキュリティレビュー、プライバシーポリシーの整備が必要です。

## 開発の状態・今後の作業

本番Cloudflare Workersに公開済みで、Googleログイン・D1同期・Windows ⇄ Android同期・オフライン復旧・競合コピー保存（ユーザー実機報告）まで確認済みです。**AI日本語タスク抽出・アカウント管理者の無料枠集計・Android PWAを実機確認済み。未テストの競合パターン・複数アカウントの完全分離・セキュリティ監査・JSONバックアップの実機動作は引き続き検証中**です。ローカルテストと本番検証の範囲は区別してください。

MITなどのライセンスは**まだ指定していません**。公開GitHubリポジトリでも、明示したライセンスがない場合は一般に著作権が留保されます。再利用を認めたい場合は別途ライセンスを選択してください。

### Neuronsの自動表示（2026-10-20）

Workers AIの `aiInferenceAdaptiveGroups.sum.totalNeurons` をCloudflare GraphQL Analyticsの読み取り専用トークンで取得します。時刻範囲はUTC日付単位で、Worker/D1の取得に失敗してもほかのメトリクスに影響しないよう分離しています。取得エラー、権限不足、APIフィールド不一致の場合は「未取得」を維持し、ゼロを推定しません。**実クラウドでの値はリリース後に公式画面と照合する必要があります。**

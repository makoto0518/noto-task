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
| Google OAuthのみ（ゲストは端末内保存でアカウント不要） | コード実装済み / Google本番認証は未検証 |
| Android/PC同期、オフライン時の送信キュー | コード実装済み / 2端末模擬テスト済み、実機未検証 |
| Cloudflare D1 / Workers AI | コード実装済み / 本番サービス疎通は未検証 |
| GitHub Actions | 設定ファイルあり / 実GitHub上のチェック結果で確認 |
| Cloudflare本番URL | **未デプロイ**（管理者のCloudflareログイン等が必要） |

**「ローカルでテスト成功」と「クラウド上でも問題なく動く」は違います。** Google OAuth、実D1、Workers AI、Android実機同期は本番デプロイ後に別途確認してください。

## 全技術と選定理由

| 層 | 採用技術 | なぜ選んだか | トレードオフ・不採用案 |
| --- | --- | --- | --- |
| 画面 | HTML5 + CSS3 + **Vanilla JavaScript / ES Modules** | JavaScriptフレームワークやビルドツールに依存せず、画面が開いてすぐ入力できる。学習時にDOMとイベントの動きが見える | React/Next.jsより手動の状態管理が多い。現規模では軽さを優先 |
| UI | **CSS変数 + backdrop-filter + グラデーション** | 白系の透明なGlass層とダークモードを少ない依存で表現 | Apple純正Liquid Glass APIではない（Web標準による表現） |
| 動き | CSS transitions/keyframes + Pointer Events | スワイプ/ドラッグをAndroid・PCで共通実装。`prefers-reduced-motion`を尊重 | 大きなアニメーションライブラリを入れないので軽い |
| 静的公開 | **Cloudflare Workers Static Assets** | UI資産を追加の有料ホスティング無しで配信、APIと同じオリジン | プロジェクト独自ドメインは購入せず、無料の `workers.dev` を使用 |
| API | **Cloudflare Workers** | サーバーを管理しなくてよく、D1 / AIとネイティブ連携 | Freeの1リクエストあたりCPU時間制約あり |
| DB | **Cloudflare D1 (SQLite)** | SQLでユーザー・メモ・セッションを関連付け、ユーザー単位のデータ分離を実装。個人規模に適する | KVよりSQLの学習要素が増えるが検索・整合性を優先 |
| 同期 | **Fetch API + localStorage のキュー + 25秒ポーリング** | 更新をすぐ画面に反映し、オフライン時は端末に再送待ちを保持。追加の有料リアルタイム基盤は使わない | 完全なリアルタイムではない。競合は最後にサーバーへ到達した変更が優先 |
| ログイン | **Google OAuth 2.0 / OpenID Connect + PKCE** | メールアドレスとパスワードを自前で保管しない。Googleのみでログインできる | Google CloudでOAuthクライアント設定が必要。ゲストモードはログイン手段ではない |
| セッション | **Secure / HttpOnly / SameSite Cookie + SHA-256ハッシュ** | JSからCookieを直接読めず、D1には生トークンを保存しない | 期限切れセッションの掃除は将来のメンテナンス課題 |
| AI | **Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`)** | 別会社の有料AI APIキー不要。ユーザーがボタンを押したときだけメモを解析 | 無料Neuron予算とモデルの出力精度に制限。1ユーザー20回/日のアプリ側上限を設定 |
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

**2. API再送は冪等:** 同一IDに `PUT /api/items/:id` を送っても1件だけが保存され、`DELETE` も削除済みなら成功します。「応答が返らなかったから再送」を安全にするためです。

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

### セキュリティ・データに関する注意

- Cloudflare D1にはGoogleユーザー識別子・表示名等とメモ本文が保存されます。機密情報やパスワードは入力しないでください。
- AIに送信する本文は**ボタンを押したメモだけ**です。LLMの回答を信用せず、提案内容を確認してから登録します。
- `localStorage` はブラウザごとの保存です。サイトデータ削除・端末故障による未同期データの消失は防げません。
- 同一タスクを複数端末で同時編集した場合は、**最後にサーバーへ正常到達した内容が優先**されます。自動マージ・変更履歴は未実装。
- 公開アプリで不特定多数が使う場合は、追加のクォータ保護、セキュリティレビュー、プライバシーポリシーの整備が必要です。

## 開発の状態・今後の作業

画面とAPIのコードは作成済みですが、本番Cloudflareデプロイ、Google OAuth/D1/Workers AIの実接続、Android-PC実機間テストはまだ完了していません。コードのローカル動作検証結果と本番検証を混同しないでください。

MITなどのライセンスは**まだ指定していません**。公開GitHubリポジトリでも、明示したライセンスがない場合は一般に著作権が留保されます。再利用を認めたい場合は別途ライセンスを選択してください。

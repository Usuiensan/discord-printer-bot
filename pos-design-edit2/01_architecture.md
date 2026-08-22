# 01. アーキテクチャ設計

## 1. 技術スタック

| 領域 | 採用 |
| --- | --- |
| 言語 | TypeScript（`strict`、サーバー・ブラウザー・共通型を統一） |
| ランタイム | Node.js 24 LTS |
| パッケージ管理 | pnpm workspace |
| Web API | Fastify、JSON Schema/OpenAPI |
| 入出力検証 | TypeBox。APIスキーマを実行時検証とOpenAPIへ共用 |
| UI | React、Vite、React Router、TanStack Query |
| 状態同期 | RESTを正、WebSocketは更新通知と顧客画面投影に限定 |
| DB | SQLite 3、WAL、foreign keys有効、busy timeout設定 |
| DBアクセス | Kysely + `better-sqlite3`。マイグレーションは順序付きSQL |
| 認証 | サーバーセッション、HttpOnly/SameSite Cookie、PINはArgon2id |
| テスト | Vitest、Supertest相当のFastify inject、Playwright、k6 |
| ログ | pino JSON。秘密・PIN・身分証情報を構造化redaction |
| 配布 | Webアセットをサーバーへ同梱。Windows serviceとsystemdを提供 |

### 採用理由

- 会場LAN内の約10接続、最大1会計/秒は、単一プロセスとSQLite WALで十分処理できる。
- DB、API、印刷キューを同じプロセスで扱い、SQLiteの単一ライターを使うことで、確定・在庫・監査・印刷ジョブ登録を一つのトランザクションへ収められる。
- TypeScriptモノレポにより、金額、ID、状態列挙、API契約、レシートデータの型ずれを減らす。
- 外部クラウドやインターネットを通常運用の必須条件にしない。

## 2. 論理構成

```text
レジUI ─────┐
顧客画面 ───┼─ HTTP(S)/REST + WebSocket ─ POS Server
管理UI ─────┘                           ├─ Application services
                                        ├─ SQLite
                                        ├─ Print queue worker
                                        └─ PrinterTransport
                                             ├─ Windows adapter
                                             ├─ Linux adapter
                                             └─ Fake adapter
```

RESTレスポンスとDBが正であり、WebSocketイベントは再取得を促す通知として扱う。切断・イベント欠落後は、クライアントがRESTから最新状態を再取得する。

## 3. ディレクトリ構成

```text
apps/
  server/                 Fastify起動、DI、設定、マイグレーション、ワーカー
  register-web/           レジUI
  customer-display-web/   顧客画面
  admin-web/              管理UI
packages/
  contracts/              API schema、共有DTO、状態列挙
  domain/                 純粋な業務ルールと金額・値引き計算
  application/            ユースケース、権限、トランザクション境界
  db/                     Kysely schema、repository、migration
  receipt-template/       テンプレート検証・レンダリング
  receipt-ir/             DiscordコマンドIR parser/validator/canonicalizer
  escpos/                 IRからESC/POSへの純粋変換
  printer-port/           Transport/Status interface
  printer-windows/        Windows USB/RAW実装
  printer-linux/          Linux USB実装
  test-fixtures/          決定的fixture、golden、fake clock
tools/
  load-test/              k6シナリオ
  hardware-test/          実機試験CLIと証跡収集
  backup/                 バックアップ、検証、オフラインCSV出力
deploy/
  windows/                Windows service登録・更新・復旧
  linux/                  systemd unit、更新・復旧
docs/
  adr/                    Accepted/Superseded ADR
```

依存方向は `UI → contracts → application → domain`、`application → ports` とする。DB、USB、時刻、ID採番はポート越しに注入し、domainからOS・HTTP・DBへ依存しない。

## 4. サーバー内モジュール

| モジュール | 責務 |
| --- | --- |
| Identity | スタッフ、セッション、権限、責任者承認 |
| Catalog | 商品、コード、セットショートカット、価格・税区分 |
| Inventory | 在庫移動、取り置き、無料配布、負数在庫警告 |
| Checkout | カート、値引き、年齢確認、支払、確定 |
| Transactions | 確定取引、取消、返品、返金 |
| Cash | 現金箱、入出金、締め、再開 |
| Printing | テンプレート、IR、印刷ジョブ、再印刷、状態 |
| Reporting | CSV、終了時エクスポート、バックアップ |
| Audit | 追記専用監査イベント |
| Realtime | レジ状態通知、顧客画面投影 |

## 5. 整合性境界

### 会計確定

一つのDBトランザクションで次を実行する。

1. `Idempotency-Key` の未使用を確認または既存結果を返す。
2. カート版番号を検証し、サーバー側で価格・値引き・税・支払を再計算する。
3. R18確認と責任者承認を検証する。
4. 取引、明細、値引き、支払、年齢確認を保存する。
5. 在庫移動を追加し、負数在庫警告を作成する。
6. 監査イベントを追加する。
7. レシート用の不変スナップショット、print job、共通printer operationを追加する。現金会計では先行するdrawer operationも追加する。
8. 冪等キーへ取引IDとレスポンスを紐付けてcommitする。

ESC/POS生成とUSB送信はcommit後にワーカーが行い、会計確定トランザクションを待たせない。

### 取消・返品・訂正

元取引を更新・削除しない。元取引を参照する相殺取引、逆方向在庫移動、返金支払、監査イベントを同一トランザクションで追加する。

### 締め

締め対象営業の集計スナップショット、未解決項目、理論現金、実在高、過不足を保存する。締め後の変更は責任者承認と理由を伴う再開イベントを追加し、既存締めを上書きしない。

## 6. 実行モデル

- HTTPリクエスト処理と印刷ワーカーは同一サーバープロセス内で動かすが、キューはDB永続化する。
- 印刷ワーカーは常に1インスタンスだけリースを取得する。二重起動したサービスは印刷ワーカーを開始できない。
- アプリケーション起動時にマイグレーション整合性、DB書込み、テンプレート有効版を検査する。
- 正常終了時は新規会計受付を停止し、実行中DBトランザクションを完了させる。USB送信中は最大待機後、結果不明として記録する。
- OS時刻はUTC保存、表示・営業日境界はイベントのIANA timezone（既定 `Asia/Tokyo`）を使う。

## 7. セキュリティと監査

- LAN内運用でも認証を省略しない。初期管理者作成後は未認証APIをhealthと静的ファイルに限定する。
- PINそのもの、身分証の種類・番号・氏名・住所・生年月日・画像は保存・ログ出力しない。
- 権限判定はUI表示ではなく各application use caseで実施する。
- 監査ログはアプリケーションAPIから更新・削除不可とし、変更前後は秘密を除いたJSONスナップショットで保存する。
- CSV出力、バックアップ、設定変更、任意ドロアー開放も監査対象にする。
- Cookie認証の変更系APIはOrigin検査とCSRF tokenを要求する。本番はADR-D019に従いローカルCAで署名したHTTPSを使用し、HTTPはloopback開発または明示した隔離LANでの一時検証だけに限定する。

## 8. 運用と復旧

- 起動時にDBのintegrity check、印刷キューのlease回収、テンプレート参照整合性を検査する。
- DBバックアップはSQLite backup APIで整合したスナップショットを作成し、manifestとSHA-256を付ける。
- バックアップ復旧は別ディレクトリへ復元・整合性検査後に切り替える。稼働DBへ上書きしない。
- 営業終了時に全CSV、設定、テンプレート、manifestを一つのexport bundleへ出力する。
- event終了時にDB、canonical export、manifest、hashをevent固有鍵で暗号化したarchiveへ固定する。保持期限後もアプリから行単位削除せず、停止・backup・全コピー確認・責任者承認・archive削除・鍵破棄を行う保守runbookを使用する。
- `GET /health/live` はプロセス生存のみ、`GET /health/ready` はDB・ワーカーlease・設定を検査する。プリンター異常は会計APIを停止せずreadyの詳細へ警告として載せる。

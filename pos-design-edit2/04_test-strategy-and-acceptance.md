# 04. テスト戦略と受入条件分類

## 1. 完了判定

受入条件には次のタグを複数付けられる。複合タグは全証跡がそろうまで未完了とする。

- `A`: 自動試験。単体、DB/API統合、ブラウザーE2E、並行・負荷、障害注入、goldenを含む。
- `H`: 実機試験。TM-T70II、USB、Windows/Linux、キャッシュドロアー、紙面を使う。
- `R`: 人間レビュー。表示・紙面・操作・プライバシー・運用・設計境界を確認する。

各証跡には受入ID、実行日時、OS/機器、commit、設定、入力fixture、期待値、実測値、ログ/画像、判定者を記録する。

## 2. 自動テスト層

| 層 | 対象 |
| --- | --- |
| Domain unit | 金額、税、値引き探索、支払、入力文脈、権限、状態機械 |
| Property | 値引き決定性、金額非負、台帳不変条件、取り置き状態遷移 |
| DB integration | transaction境界、冪等性、追記専用、再起動、migration |
| API contract | schema、認証、権限、エラーcode、版競合 |
| Browser E2E | レジ/顧客/管理、キーボード、音声+表示、切断再接続 |
| Print golden | snapshot→AST→IR→bytes/hash、旧版再現、禁止コマンド |
| Adapter contract | fake/Windows/Linuxが同じport契約を満たす |
| Load/concurrency | 10端末、60会計/分、連打、同一商品の同時販売 |
| Fault injection | DB/USB切断、送信前後crash、service再起動、lease回収 |
| Privacy scan | DB/log/CSV/receipt/backupに禁止された身分証情報がない |

CIはunit、property、DB、API、browser、golden、fake adapterを必須にする。実機suiteは環境ラベル付き手動ジョブとし、リリース候補ごとにWindows/Linux双方で実行する。

## 3. 18.1 会計・同時処理

| ID | 受入条件（要約） | 分類 | 必須証跡 |
| --- | --- | --- | --- |
| AC-01 | 4レジ、4顧客画面、2管理端末の同時接続 | A | 10 client同時E2E、切断・再接続 |
| AC-02 | 60会計/分で売上・在庫に欠落・重複なし | A | 一定時間の負荷試験、要求/取引/在庫移動照合 |
| AC-03 | 最後の1点を同時販売して全取引を記録し負数在庫 | A | 並行DB統合、取引/移動一意性、負残高 |
| AC-04 | 負数在庫で対象商品・関係取引を警告/締め表示し、返品・返金可能 | A+R | E2E、締めsnapshot、関係取引、返品・返金、表示導線 |
| AC-05 | 商品コードによる同一/別商品集計 | A | 集計unitとDB統合 |
| AC-06 | セットは構成商品の売上・在庫だけ計上 | A | API/E2E、親セット非計上 |
| AC-07 | セット一部失敗時に部分残存しない | A | transaction失敗注入 |
| AC-08 | 自動値引きの適用・上限・解除 | A | 境界値とdraft状態遷移 |
| AC-09 | 競合値引きは最安、同額時も決定的 | A | 組合せ/property/反復試験 |
| AC-10 | 任意値引きの上限・承認 | A | P004で承認機能を見送ったためv0.5のままでは受入不可。要件次版で100%上限試験へ改訂 |
| AC-11 | 100%値引き可、行・合計は非負 | A | 0/100/超過/複数値引き境界 |
| AC-12 | Enter/ボタン連打/再送で二重確定しない | A | 冪等key並行E2E、取引/job件数 |
| AC-13 | 8桁以上は商品、1～7桁は現金 | A | 7/8桁browser E2E |
| AC-14 | 8桁未満の商品コードをUI/CSV/APIで拒否 | A | 3経路共通schema試験 |
| AC-15 | 8桁以上を預り金として拒否 | A | UI/API境界 |
| AC-16 | 商品なしの1～7桁で会計開始しない | A | browser状態遷移 |
| AC-17 | 未登録商品を預り金へ読み替えない | A | 未登録8桁E2E |
| AC-18 | 「預り金不足」を表示し取引・現金支払を確定しない | A+R | DB非更新、message code/文言E2E、視認性レビュー |
| AC-19 | 外部決済後の残額現金フロー | A | 併用払いbrowser E2E |
| AC-20 | 残額現金不足で支払明細を追加しない | A | DB統合/E2E |
| AC-21 | 現金超過を残額支払+釣り銭として記録 | A | 計算/DB/E2E |
| AC-22 | 複数外部決済と担当者拒否 | A+R | 設定別E2E、運用導線レビュー |

## 4. 18.2 印刷

| ID | 受入条件（要約） | 分類 | 必須証跡 |
| --- | --- | --- | --- |
| PR-01 | Windows/Linuxから同じ内容をTM-T70IIへ印刷 | A+H+R | IR/bytes hash、両OS実機、紙面比較 |
| PR-02 | 4レジ同時印刷でも混線しない | A+H+R | 並行queue、実機連続印刷、取引番号照合 |
| PR-03 | 紙切れ/カバー/USB切断を検出またはunknown表示 | A+H+R | 障害注入、両OS実機能力表、表示レビュー |
| PR-04 | 復旧後に対象取引だけ再印刷 | A+H | failure→reprint統合、現物結果3値、自己/別人承認、実機 |
| PR-05 | 再印刷で売上を再計上しない | A | 取引/支払/在庫不変、jobのみ追加 |
| PR-06 | カット・ドロアーが設定どおり | A+H+R | bytes、実機動作、ADR-P003との照合 |
| PR-07 | template→Discord IR→既存変換→実機印刷 | A+H+R | 既存変換器characterization互換、golden、TM-T70II、紙面 |
| PR-08 | デザイン変更が計算/売上/USB層へ非影響 | A+R | 回帰、依存境界レビュー |
| PR-09 | 構文/変数/command/引数エラーを有効化前検出 | A | validator unit/API/E2E |
| PR-10 | 同じ取引+版から同じIR/印字を再現 | A+H+R | hash反復、比較印刷、紙面 |
| PR-11 | jobへtemplate ID/versionを保存し再印刷参照 | A | DB統合、更新後の旧版再印刷 |

`PR-01` と `PR-10` はbytes一致だけで紙面一致と判定しない。フォント、printer設定、物理出力をH/Rで確認する。

## 5. 18.3 R18確認

| ID | 受入条件（要約） | 分類 | 必須証跡 |
| --- | --- | --- | --- |
| R18-01 | 必須確認完了までR18取引確定不可 | A+R | 初期appearance policy、顧客画面なし/故障、自己申告併用のAPI/E2E、両画面導線 |
| R18-02 | 確認不能時にR18商品だけ取消・再登録 | A+R | 混在draft E2E、導線 |
| R18-03 | 身分証個別情報を全出力へ保存しない | A+R | canary PIIによるDB/log/CSV/receipt/backup scan、privacy review |

R18-03では、R18 API schemaが身分証属性と未知fieldを拒否すること、request canaryがaccess/error logへ漏れないこと、R18 record/CSV/receipt/backupに禁止属性が存在しないことを検査する。正規に保存する一般メモへcanaryを入れて不在を期待する試験は行わない。

## 6. 18.4 締め・監査

| ID | 受入条件（要約） | 分類 | 必須証跡 |
| --- | --- | --- | --- |
| CL-01 | レジ別/共通現金箱で理論現金・過不足 | A | モード別計算/DB統合 |
| CL-02 | 金種なし、総額だけで締め | A+R | E2E、画面レビュー |
| CL-03 | 取消/返品/調整/締め修正が元記録を消さない | A+R | 追記型不変条件、監査レビュー |
| CL-04 | 無料配布を売上等から除外し在庫・記録へ反映 | A | 集計/在庫/CSV統合 |
| CL-05 | 取り置き登録/受取/解除で在庫整合 | A | 状態遷移/property |
| CL-06 | 未解決取り置きの一覧・件数・数量を締めへ保存 | A+R | 一覧、件数、総数量、締めsnapshot、表示レビュー |
| CL-07 | 見本を戻す/見本状態から販売 | A | D010で見本区分を廃止したためv0.5のままでは受入不可。要件次版で通常販売・破損試験へ改訂 |
| CL-08 | 初期値は切捨て、税端数3方式、変更は次営業から | A | 新規event=floor、3方式、営業中不変、締め後の次営業切替 |
| CL-09 | 自己承認を監査記録 | A+R | 自己承認/別人承認のAPI・権限・監査、表示レビュー |
| CL-10 | 再起動後も売上/在庫/queue整合 | A+R | process kill/restart、復旧レビュー |

P004、P005、D010の利用者判断は要件v0.5の受入文と差がある。要件次版が発行されるまではAC-10、CL-04、CL-07を総合受入済みにせず、`08_adr-decisions-2026-07-24.md` の差分を追跡する。

## 7. 非機能・回帰ゲート

- 60会計/分を15分継続し、900要求に対して取引・idempotency・在庫移動・初回print job/operationを照合する。
- 同一商品を4 workerで同時確定する試験を100回反復し、欠落・重複がないことを確認する。
- 主要APIのp50/p95を計測して記録する。要件にない閾値を受入gateへ追加せず、性能SLOを設ける場合は別ADRで決定する。
- POS process/worker停止をDB commit前後、print prepared後、dispatch直後、OS受付後、completed更新前で個別に注入する。
- DB I/O障害をtransaction commit前後、USB short write/途中切断、OS/service再起動を別シナリオとして試験する。
- 結果不明operationが自動再送されず、pending operationだけが再起動後一回処理され、send中にstatus/drawerが割り込まないことを確認する。
- migrationは空DB、直前版DB、失敗rollback、backup restoreで試験する。
- iPad横、PC横、スマートフォン拡大200%で主要操作欠落がないことをPlaywright screenshotと人間で確認する。
- 同じ商品数量tokenが複数の自動値引きへ割り当てられないこと、異なるtokenでは併用できることをproperty testで確認する。
- 4レジの並行採番、rollback欠番、締め再開を試験し、business day内で取引番号が重複・再利用されないことを確認する。
- canonical exportをevent/business day/日時範囲ごとに生成し、行数、UUID、金額、税率、manifest hash、同一snapshotからの再現性をDB正本と照合する。
- 暗号化event archiveの作成・別場所復旧・hash照合と、期限処理runbookの対象一覧・承認証跡を検証する。実データ削除試験は隔離fixtureだけで行う。
- 本番相当端末でローカルCAの信頼設定、HTTPS接続、HTTP拒否、Secure cookie、Origin/CSRF拒否を確認する。

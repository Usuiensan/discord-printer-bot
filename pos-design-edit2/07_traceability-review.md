# 07. 要件追跡と相互レビュー

## 1. Objective完了追跡

| Goal要求 | 証拠 | 状態 |
| --- | --- | --- |
| 技術スタック | `01_architecture.md` 1章 | 定義済み |
| ディレクトリ構成 | `01_architecture.md` 3章 | 定義済み |
| DBモデル | `02_data-and-api.md` 1〜3章 | 定義済み。業務未決はADRへ分離 |
| API境界 | `02_data-and-api.md` 4〜6章 | 定義済み |
| 印刷キュー | `03_printing.md` 5章 | 定義済み |
| OS固有プリンター層 | `03_printing.md` 6〜8章 | interface定義済み。採用品はADR-P001/P002 |
| テスト戦略 | `04_test-strategy-and-acceptance.md` 1〜2、7章 | 定義済み |
| ADR管理 | `05_pending-adrs.md`、`08_adr-decisions-2026-07-24.md` | Accepted判断と実機Pendingを分離 |
| 18章の分類 | `04_test-strategy-and-acceptance.md` 3〜6章 | 46/46件をA/H/R分類 |
| 未確定業務・実機結果を推測しない | `05_pending-adrs.md`、`03_printing.md` 8章 | gateと必要証拠を定義 |
| 成果物の相互レビュー | 本書2章 | 3観点の独立レビューを反映 |
| 実装フェーズ別Goal | `06_phase-goals.md` | 9件作成 |

## 2. 相互レビュー記録

| Review ID | Reviewer | 日付 | 対象 | 初回最大重要度 | 状態 | 再確認 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-DATA-01 | `domain_data_review` | 2026-07-24 | 業務・DB・API draft 1〜final | Critical | 検証済み | 再確認でP0/P1なし |
| RV-PRINT-01 | `printing_os_review` | 2026-07-24 | 印刷・OS・実機 draft 1〜final | P0 | 検証済み | 再確認でP0/P1なし |
| RV-ACCEPT-01 | `acceptance_goal_review` | 2026-07-24 | 受入分類・Goal draft 1 | P1 | 検証済み | 再確認でP0/P1なし |

各reviewerは要件v0.5と設計成果物を独立に照合した。指摘を重要度付きで受け取り、下表の修正後に同じreviewerへ再確認を依頼した。未解消のP0/P1がある間は設計完了にしない。

### Review A: 業務・DB・API

確認観点:

- 会計確定の原子性
- 追記型取引・在庫・現金・監査
- 負数在庫
- 返品・締め・冪等性
- APIの状態変更境界

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 初回print job/operationは会計確定と同一transactionに必要 | Architecture/DBの確定手順へ明記 |
| print送信はcommit後でなければならない | queue worker境界へ明記 |
| 現金を集計値だけにせずcash ledgerを正本にする | `cash_movements` とtransaction境界を追加 |
| 値引き配賦がないと税・返品・再印刷を再現できない | `applied_discount_lines` を追加 |
| 現行masterを過去取引から参照しない | transaction/receipt snapshotを固定 |
| 税、返品、見本、担当者印字等が初期設計で未確定 | ADR-D007〜D019を追加し、2026-07-24判断を08へ記録 |
| 取り置き受取をdraft追加時点で減算すると取消時に不整合 | active claimを導入し、会計確定時だけremaining/reservedを減算 |
| 責任者番号の3桁・有効期間重複制約が曖昧 | ASCII 3桁CHECKと半開区間重複拒否triggerを定義 |
| R18自己申告だけのpolicyが有効化できる | 自己申告とは別の容貌/身分証目視groupをvalidatorで必須化 |
| 再印刷の別人承認強制は要件5.3の自己承認許可と矛盾 | 自己承認を許可し、`self_approved` とrisk acceptanceを監査 |

### Review B: 印刷・OS・実機

確認観点:

- 永続直列queue
- template/IR/ESC-POS境界
- 二重印刷
- status能力差
- Windows/Linux adapter
- drawer/cut

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 差込み文字列からcommand injectionが起こり得る | 宣言的YAML→typed AST→canonical IRへ変更 |
| 送信途中crashを自動再送すると二重印刷になる | `delivery_certainty=unknown` を隔離し明示reprintだけ許可 |
| status失敗をoffline/正常と決めつけてはいけない | Capabilityのunsupported/unknownを定義 |
| status照会と印刷が競合する | 同一printer mutexでstatus/send/device jobを直列化 |
| drawerをtemplateに置くと再印刷でも開く | Receipt ASTからdrawerを除外し専用device job化 |
| template版だけではOS間画像再現性が不足 | renderer/font/asset/hashをjobへ保存 |
| full命令と完全切断は同義ではない | fullをTM-T70II allowlistから除外し実機結果を別証拠化 |
| jobとoperationにqueue状態が重複すると競合する | `printer_operations.state` を唯一のqueue正本に統一 |
| `retry_wait` の順序・上限・復旧条件が不明 | strict FIFO、2/5/15秒、最大3再試行、fault block/resumeを定義 |
| 再印刷元・版・現物結果が曖昧 | source jobと版を固定し、現物結果3値・risk acceptance・承認を必須化 |

### Review C: 受入試験・Goal分割

確認観点:

- 18章全項目数
- 自動/実機/人間の責任分離
- ADR gate
- Goalの独立性と完了基準

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 18章は46件 | AC 22、PR 11、R18 3、CL 10を全件採番 |
| 「同じ印字」はbytesだけでは証明不能 | PR-01/10をA+H+Rに分類 |
| privacyはschema不在だけでは証拠が弱い | canary PIIを全保存先でscan |
| 実機未決を環境変数defaultで埋めてはいけない | ADR gate、起動拒否/機能無効を規定 |
| 一つのGoalでは大きすぎる | 技術検証を含む9 Goalへ分割 |

## 3. 章別要件追跡

| 要件章 | 主設計 | 主受入 |
| --- | --- | --- |
| 1〜4 目的・構成・性能 | Architecture 1〜6 | AC-01〜03、AC-12、CL-10 |
| 5 認証・承認 | Architecture 7、Data 2.1 | AC-10、CL-09 |
| 6 商品・在庫・値引き | Data 2.2/2.5 | AC-03〜11、CL-04〜07 |
| 7 会計・支払 | Data 2.3/2.4、API 5.2 | AC-12〜22 |
| 8 R18 | Data age verification、ADR-D011 | R18-01〜03 |
| 9 顧客画面 | Architecture realtime、API 6 | AC-01/04、R18-01/02 |
| 10 プリンター | Printing全章 | PR-01〜11 |
| 11 レシート・税 | Data tax summary、Printing snapshot | AC-08〜11、PR-07/10、CL-08 |
| 12 取消・返品 | Data transaction境界、ADR-D009 | AC-04、CL-03 |
| 13 現金・締め | Data 2.6 | CL-01〜03/08〜10 |
| 14 保存・CSV | Architecture 8、Data export | CL-03/04/10 |
| 15 操作性 | Architecture UI、Test browser | AC-13〜22、Rレビュー |
| 16 障害 | Architecture 6/8、Printing 5〜8 | PR-03/04、CL-10 |
| 17 監査 | Architecture 7、Data audit | CL-03/09 |
| 18 受入 | Test document | 46件 |
| 19 未確定 | ADR登録簿・判断記録 | P001〜P006 |

## 4. 設計上の既知の保留

以下は設計漏れではなく、決定権者または実機証拠を待つ意図的な保留である。

- P001〜P003/P006の実機・本番構成決定
- D020バーコード名前空間の採否と、使用予定scanner・58 mm実機読取り結果
- P004/P005/D010による要件v0.5差分を次版へ反映
- Windows/LinuxのUSB・status実測能力表
- drawer型番/pulse
- 税/値引き/返品の業務判断
- 本番hardwareと復旧目標

これらを未決のまま総合受入完了へ進めない。

## 5. 実装引渡し判定

設計は次の条件を満たしたため、ADRが許す範囲のフェーズ実装へ引き渡せる。

- 各write use caseのtransaction境界が明示されている。
- public API、状態、冪等・版競合が定義されている。
- printの論理生成と物理送信、成功証拠が分離されている。
- 46件の受入条件に必要な証拠種別が割り当てられている。
- 未確定事項は暗黙defaultではなくADR gateになっている。
- 各実装Goalに成果、制約、verificationがある。

## 6. 2026-07-24 ADR更新監査

| 確認項目 | 結果 |
| --- | --- |
| 利用者が確定した判断 | P004、D007〜D012、D015〜D017をAcceptedとして08へ記録 |
| P005確定 | 特定会計ソフト非依存のcanonical bundleを随時再生成し、製品別adapterは将来追加 |
| 推奨案採用 | D013、D014、D018、D019をAcceptedへ移行 |
| 要件v0.5との差分 | P004、P005、D010をAC-10、CL-04、CL-07の受入blockとして記録 |
| DB/API整合 | event別商品、税込・税率別一回丸め、全部返品、見本区分廃止、R18初期appearance、担当者印字設定、超過取り置きを反映 |
| Goal整合 | Goal 2/3/8の前提と対象外機能を更新 |
| 最終保留 | 実機・本番構成P001〜P003/P006がPending、追加ADR-D020がProposed |
| 追加提案 | D020で伝票・取り置き・商品・ISDNを分離するCode 128名前空間を提案 |

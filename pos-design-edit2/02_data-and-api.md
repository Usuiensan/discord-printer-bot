# 02. データモデルとAPI設計

## 1. 共通データ規約

- 主キーはUUIDv7文字列とする。人に見せる取引番号・レジ番号・責任者番号は別列にする。
- 金額、税額、値引額、原価は整数円の `INTEGER`。小数・浮動小数点を使わない。
- 税率はbasis points（10% = 1000）の整数で保存する。
- 商品コードは先頭ゼロを保持する `TEXT`。`CHECK(length(product_code) >= 8 AND product_code NOT GLOB '*[^0-9]*')` で数字のみを保証し、`unique(event_id,product_code)` とする。
- 日時はUTCのISO 8601、営業日はイベントtimezoneの `YYYY-MM-DD`。
- 可変状態は列挙値とDB `CHECK` の両方で制限する。
- 不変記録には `created_at` を必須とし、監査対象マスターには `version` と `updated_at` を持たせる。
- 確定済み取引は商品マスターを表示時参照せず、取引時点の名称、価格、税、値引きを明細へ保存する。

## 2. テーブル

### 2.1 運用・認証

| テーブル | 主要列・制約 |
| --- | --- |
| `events` | name, timezone, sales_state, retention_policy_text |
| `event_setting_versions` | event_id, version, tax_rounding_mode（初版はfloor）, cashbox_mode, staff_print_mode(manager_no/display_name), customer_display_clear_seconds, effective_business_day_id, created_by |
| `business_days` | event_id, business_date, setting_version_id, tax_rounding_mode snapshot, next_transaction_no, state(open/closed/reopened), opened_at, closed_at |
| `terminals` | event_id, terminal_no unique/event, type(register/customer/admin), paired_register_id, enabled |
| `staff` | display_name, enabled。永続的な人物ID |
| `staff_event_assignments` | staff_id, event_id, manager_no TEXT, valid_from/to, role。責任者番号の付替履歴 |
| `staff_credentials` | staff_id, kind(pin/barcode), secret_hashまたはbarcode_hash、平文を保存しない |
| `sessions` | staff_id, terminal_id, expires_at, revoked_at |
| `approvals` | operation_type, subject_type/id, executor_id, approver_id, self_approved, reason, used_at |

`manager_no` は先頭ゼロを保持するTEXTで、`CHECK(length(manager_no)=3 AND manager_no NOT GLOB '*[^0-9]*')` を持つ。SQLiteの `BEFORE INSERT/UPDATE` triggerが、同一event・manager noの半開区間 `[valid_from, valid_to)` の重複を拒否する。取引はstaff IDと取引時点のmanager noを保存する。`approvals` は操作要求に対して一回だけ消費し、業務記録が `approval_id` を直接参照する。実行者と承認者が同じでも保存し、`self_approved=true` とする。

税端数設定の初版は要件どおり `floor` とする。変更予約は次のbusiness dayを `effective_business_day_id` に指定し、営業開始時に一版だけ固定する。

### 2.2 商品・値引き

| テーブル | 主要列・制約 |
| --- | --- |
| `event_products` | product_id, event_id, product_code, name, short_name, price_yen（税込）, tax_bps, tax_category, cost_yen, r18, inventory_tracked, sale_state, display_order。unique(event_id,product_code) |
| `bundle_shortcuts` | stable key, usage_counter_enabled |
| `bundle_versions` | bundle_id, version, name, enabled, unique(bundle_id,version) |
| `bundle_components` | bundle_version_id, product_id, quantity, unique(bundle_version_id, product_id) |
| `discount_rules` | name, kind(amount/rate), value, priority, stackable, max_applications, enabled。同一数量tokenは一つのrule applicationだけが消費 |
| `discount_requirements` | rule_id, product_id, required_quantity |
| `manual_discount_policies` | event_id, max_rate_bps。初期版は10000固定。承認・理由機能は実装しない |
| `payment_methods` | event_id, code, name, kind(cash/external), enabled |
| `payment_combination_policies` | event_id, first_method_id, second_method_id, allowed。external+cashは常にallowed |
| `age_verification_policies` | event_id, version, enabled |
| `age_verification_policy_groups` | policy_id, group_no, minimum_satisfied |
| `age_verification_policy_methods` | policy_id, group_no, method(self_declaration/appearance/id_visual) |

自動値引き探索は純粋関数として、支払額最小、priority、rule_idの順で決定的に選ぶ。適用結果は次の確定取引テーブルへスナップショット保存する。

`stackable=true` は異なる数量tokenまたは商品行との併用だけを許可し、同じtokenへの重複値引きは常に禁止する。率値引きはruleへ割り当てた値引前税込額を基礎に一回計算し、別値引き後の残額へ順番に掛けない。

価格は税込円で保持する。取引共通値引きは値引前税込金額比の最大剰余法で行へ整数配賦し、余りの同順位は税率、行番号順とする。税額は配賦後の税込額を税率別に合計してから税率ごとに一回だけ計算し、初期値 `floor` で丸める。元取引返品は保存済み配賦・税summaryを反転し、現在設定で再計算しない。

event初期R18 policyは `appearance` だけを必須とする。R18 policyはANDで結ぶgroupと、group内の `minimum_satisfied` により、任意設定として「自己申告 AND（容貌 OR 身分証目視）」も表現できる。身分証個別情報はpolicyにも記録にも持たない。

policy保存・有効化時、`self_declaration` を含むpolicyには、別の必須AND groupとして `appearance` または `id_visual` の少なくとも一方を要求する。自己申告だけのpolicyは有効化できない。

支払では `SUM(amount_yen)=transaction.total_yen` を必須にする。外部決済は未払残額を超えず釣り銭なし、現金は `tendered_yen >= amount_yen`、差額をchangeとする。釣り銭省略時はtendered/changeをNULLとする。

### 2.3 ドラフトと顧客画面

| テーブル | 主要列・制約 |
| --- | --- |
| `sale_drafts` | register_id unique/active, version, state(editing/payment/finalizing/completed/canceled), staff_id |
| `sale_draft_lines` | draft_id, line_no, product_id, quantity, source(manual/scan/bundle/hold), bundle_version_id/instance_id nullable |
| `draft_payments` | draft_id, sequence, method_id, amount_yen, tendered_yen, change_yen, reference_note |
| `draft_age_verifications` | draft_id, method, result, confirmer_id nullable, terminal_id, supersedes_id nullable |
| `customer_display_states` | register_id, version, public_projection_json, expires_at |

ドラフト更新は `If-Match: <version>` を要求し、成功時にversionを増やす。競合時は409と最新表現を返す。顧客画面投影にはスタッフID、承認、R18方式、内部メモを含めない。

### 2.4 確定取引

| テーブル | 主要列・制約 |
| --- | --- |
| `transactions` | event_id, business_day_id, transaction_no（business day内全レジ共通6桁、欠番可）, display_transaction_no, register_id, staff_id, staff_print_label_snapshot, manager_no_snapshot, type(sale/void/return), original_transaction_id nullable, approval_id nullable, subtotal, discount_total, tax_total, total, tax_rounding_mode |
| `transaction_lines` | transaction_id, line_no, original_transaction_line_id nullable, product_id nullable, product_code/name/price/tax snapshot, quantity, gross, discount, tax, net |
| `transaction_bundle_usages` | transaction_id, bundle_id/version, bundle_instance_id, usage_count, component_snapshot_json |
| `applied_discounts` | transaction_id, rule_id nullable, rule_name snapshot, kind(auto/manual), application_no, amount, executor_id, approval_id nullable |
| `applied_discount_lines` | applied_discount_id, transaction_line_id, quantity, allocated_amount |
| `payments` | transaction_id, sequence, method_id, method_name snapshot, amount, tendered, change, external_result, reference_note |
| `tax_summaries` | transaction_id, tax_bps, taxable_gross_yen, discount_allocated_yen, tax_amount_yen, rounding_mode |
| `age_verifications` | transaction_id, source_draft_verification_id, method, result, confirmer_id nullable, terminal_id, reversed_by_id nullable |
| `idempotency_records` | scope, key, request_hash, response_json, transaction_id, unique(scope,key)。会計transaction内で完成形だけを挿入 |

`transaction_lines.quantity` はsaleで正、returnで負とする。元記録を消さない。元レシート返品は全明細・全支払を反転し `original_transaction_id` を必須にする。レシートなし返品は商品コードから独立returnを作り、元取引IDをNULLにできる。同一販売数量・支払額を超える累積返金はapplication service内の同一トランザクションで防ぐ。

取引番号のcanonical表記は `YYYY-MMDD-NNNNNN`、レシート上の読みやすい表記は `YYYY-MMDD-NNN-NNN`（例 `2026-0724-123-456`）とする。eventとbusiness dayの内側で全レジ共通採番し、会計確定transaction内で `business_days.next_transaction_no` を増加させる。rollback等による欠番を許可し番号を詰め直さない。締め再開後も同じbusiness dayの続きから採番し、番号を再利用しない。異なるevent間の同一表示番号は内部UUIDとevent IDで区別する。初期版の締めはbusiness day全体だけを対象とし、部分締めは設けない。

R18確認はdraft中に `draft_age_verifications` へ記録し、確定時に必要な記録だけを不変の `age_verifications` へ複写する。身分証個別情報を格納できる列や汎用JSONを両表へ置かない。

冪等recordは会計transaction内で完成形だけを挿入する。commit前にprocessが落ちれば全体がrollbackし、`processing` recordは残らない。同じkey/hashは既存responseを返し、同じkeyで異なるhashは409とする。

### 2.5 在庫・取り置き・無料配布

| テーブル | 主要列・制約 |
| --- | --- |
| `inventory_movements` | product_id, event_id, type, quantity_delta, transaction_line_id/hold_id nullable, reason_code, actor_id |
| `inventory_balances` | event_id, product_id, on_hand, reserved, version, unique(event_id,product_id) |
| `inventory_alerts` | event_id, product_id, observed_on_hand, related_transaction_id, state(open/resolved), resolution_note |
| `holds` | event_id, product_id, requested_quantity, remaining_quantity, label, note, state(active/fulfilled/released/carried), created_by/at |
| `hold_events` | hold_id, type(create/fulfill/release/carry), quantity, transaction_id nullable, actor_id |
| `hold_claims` | hold_id, draft_id, quantity, state(active/fulfilled/released), version, created_at。unique(active hold,draft) |
| `distribution_records` | inventory_movement_id, cost_snapshot_yen。理由・メモは初期版で持たない |

`inventory_movements` が正本で、`inventory_balances` は同じトランザクションで更新する投影である。`on_hand >= 0` 制約を置かない。利用可能数は `on_hand - reserved`。見本区分と `sample_out/sample_return` は実装せず、展示中の商品も販売可能在庫として扱う。汚損時だけ `damage` を記録する。

`reserved >= 0`、`0 <= hold.remaining_quantity <= requested_quantity` を保証する。投影はmovement/hold eventから再構築・照合できる管理コマンドを持つ。販売可能数を超える取り置きも許可するが、不足数と作成後利用可能数を警告し、明示続行を監査する。

draftへ受け取る時点では `hold_claims(active)` とdraft lineを同じtransactionで作り、reserved/remainingを減らさない。active claim合計がremainingを超えないようhold versionで楽観lockする。draft取消・期限切れはclaimをreleasedへする。会計確定時にclaimをfulfilled、remainingとreservedを同量減算、販売movementを追加する。直接releaseできるのはactive claimされていない数量だけとする。

### 2.6 現金・締め

| テーブル | 主要列・制約 |
| --- | --- |
| `cashboxes` | event_id, register_id nullable, name, mode(register/shared) |
| `cash_sessions` | cashbox_id, business_day_id, opening_float, state(open/closed/reopened) |
| `cash_movements` | cash_session_id, type(sale/return/pay_in/pay_out), amount_delta, transaction_id nullable, reason, actor_id |
| `closings` | business_day_id, cashbox_id, theoretical, actual, difference, state, closed_by, approval_id nullable |
| `closing_issues` | closing_id, kind, subject_id, snapshot_json, resolved_at nullable |

理論現金は台帳から再計算できるようにし、締め時の算出値も保存する。金種テーブルは作らない。

register modeではcashboxにregister IDを必須、shared modeではNULLとし、同一営業でregisterが複数cashboxへ属さないよう制約する。営業中のmode変更はADR-D015決定までAPIで拒否する。

### 2.7 印刷・テンプレート・監査

| テーブル | 主要列・制約 |
| --- | --- |
| `receipt_templates` | template_key, version, source_text, source_sha256, status(draft/active/retired), unique(key,version) |
| `printer_operations` | unique monotonic sequence, kind(print/drawer), unique payload_ref, state, available_at, attempt_count/max_attempts, block_reason, lease_owner/until。queue状態の唯一の正本 |
| `print_jobs` | unique operation_id, transaction_id, kind(original/reprint/closing/test), source_job_id, reprint_no, requested_by/reason/approval, source_physical_outcome, risk_accepted, template/version, finishing_policy/version, payload_json, renderer/font version, ir/hash, bytes/hash, delivery_certainty, completion_evidence |
| `print_attempts` | job_id, attempt_no, phase(prepared/dispatch_started/transport_accepted/postcheck_completed), started/ended_at, compiler/adapter/write byte hashes, accepted_bytes, result, error_code/message, status_snapshot_json |
| `device_jobs` | unique operation_id, kind(drawer), business_reason, transaction_id nullable, requested_by, approval_id。レシート再印刷と分離 |
| `receipt_template_assets` | template_id/version, asset_key, mime, immutable content/hash, width, height |
| `printer_observations` | observed_at, transport, normalized_status_json, raw_status_json |
| `audit_events` | event_id, actor_id, approver_id, terminal_id, action, subject_type/id, before_json, after_json, reason, occurred_at |
| `export_jobs` | kind, schema_version, export_id, event_id, range_from/to, requested_by, state, path, manifest_sha256, completed_at |

初回jobはtransaction ID・kind=`original`を一意、再印刷は `(transaction_id,reprint_no)` を一意にする。`audit_events` はaction別にallowlistした業務snapshotをcanonical JSONで保存し、PIN/session/身分証情報を除外する。`audit_events`、`inventory_movements`、確定取引群にUPDATE/DELETEを発行するrepositoryを実装しない。DB保守はアプリ停止・バックアップ・別手順とする。

canonical export bundleは運用中でもevent、business day、日時範囲を指定して随時作成できる。UTF-8 BOM付きRFC 4180 CSVで取引、明細、値引配賦、税率別集計、支払、返品・取消、在庫移動、無料配布、取り置き、現金台帳、締めを別ファイルにし、`manifest.json` へschema version、export ID、抽出条件、生成日時、行数、各SHA-256を保存する。金額は整数円、時刻はUTC ISO 8601、コード類は文字列、税率はbasis pointsとする。exportは正本を変更せず何度でも再生成でき、製品別会計adapterは将来別packageとして追加する。

## 3. ユースケースのトランザクション境界

| ユースケース | 同一DBトランザクションに含めるもの |
| --- | --- |
| 会計確定 | 冪等claim、再計算、取引全表、在庫、現金、R18、承認、監査、初回print jobとprinter operation。現金時は先行drawer operation |
| セット追加 | draft version、全構成行または0件、値引き再計算 |
| 取り置き作成 | hold event、balance reserved、監査 |
| 取り置き受取をdraftへ追加 | hold version検査、active claim、draft line、監査。remaining/reservedはまだ減らさない |
| draft取消・期限切れ | active claim解除、draft状態、監査 |
| 取り置き解除 | 未claim数量だけを対象にhold event、balance reserved、監査 |
| 会計確定（取り置き受取を含む） | active claimをfulfilled化し、hold remaining/reserved減算、販売在庫移動、取引、監査を原子的に確定 |
| 全部返品・レシートなし返品 | 相殺取引、支払/返金、逆在庫、現金、承認、監査、print job/operation。元レシートの部分返品は不可 |
| 締め | 集計、closing、未解決issue snapshot、監査 |
| 締め再開 | approval消費、reopen event、監査 |
| テンプレート有効化 | 検証済みversionのactive化、旧版retire、監査 |
| 再印刷 | 元job・元取引読取り、再印刷番号採番、print job/operation、承認、監査。売上表は変更しない |

## 4. API規約

- base path: `/api/v1`
- JSONのみ。日時はUTC ISO 8601、金額は整数。
- 変更系は認証Cookie、CSRF、`X-Terminal-Id` を必須とする。
- 会計確定、取消、返品、ドロアー開放、締めは `Idempotency-Key` 必須。
- ドラフト更新は `If-Match` 必須。
- エラー形式:

```json
{
  "error": {
    "code": "PAYMENT_INSUFFICIENT",
    "message": "預り金が不足しています",
    "details": {},
    "requestId": "..."
  }
}
```

業務エラーは400/409/422、未認証401、権限不足403、版競合409、予期しない障害500とする。日本語messageにロジックを依存させずcodeを契約とする。

## 5. API境界

### 5.1 認証・運用

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/sessions` | 責任者番号/PINまたはbarcodeでログオン |
| DELETE | `/sessions/current` | ログオフ |
| GET | `/me` | 権限・担当イベント |
| POST | `/approvals/challenges` | 操作対象を固定した承認要求 |
| POST | `/approvals/{id}/confirm` | PINで承認し一回用token発行 |
| GET | `/health/live`, `/health/ready` | 生存・準備状態 |

`POST /sessions` はcredential kindを明示し、3桁責任者番号だけ、責任者番号+PIN、barcodeを混同しない。認証結果は現在eventで有効なassignmentへ解決する。

### 5.2 商品・ドラフト・会計

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/products?code=` | 商品コード完全一致検索 |
| GET | `/registers/{registerId}/sale-draft` | registerの現在draft取得 |
| POST | `/registers/{registerId}/sale-drafts` | 新規draft開始 |
| GET | `/sale-drafts/{draftId}` | draft IDで取得 |
| POST | `/sale-drafts/{draftId}/lines` | 商品追加 |
| POST | `/sale-drafts/{draftId}/bundles` | セットを全件または0件で追加 |
| PATCH/DELETE | `/sale-drafts/{draftId}/lines/{lineId}` | 数量変更・行取消 |
| POST | `/sale-drafts/{draftId}/age-verifications` | R18確認追加 |
| POST | `/sale-drafts/{draftId}/payments` | 外部支払または現金入力 |
| DELETE | `/sale-drafts/{draftId}/payments/{paymentId}` | 未確定支払取消 |
| POST | `/sale-drafts/{draftId}/finalize` | 会計確定。Idempotency-Key必須 |
| GET | `/transactions/{id}` | 再接続時の確定結果照会 |
| POST | `/transactions/{id}/returns` | 取消・返品 |

`finalize` はクライアント計算値を信用しない。draft ID/versionと入力事実だけを受け、サーバーが全金額を再計算する。

### 5.3 在庫・締め・管理

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/inventory` | 在庫・負数警告 |
| POST | `/inventory/movements` | 追加入庫、破損、無料配布、手動調整 |
| POST | `/holds` | 取り置き作成 |
| POST | `/holds/{id}/receive` | 数量をdraftへ受取 |
| POST | `/holds/{id}/release` | 数量を解除 |
| POST | `/holds/{id}/carry-over` | 締め後の持越し |
| GET/POST | `/cash-sessions` | 現金セッション |
| POST | `/cash-sessions/{id}/movements` | 入金・出金 |
| POST | `/closings` | 締め |
| POST | `/closings/{id}/reopen` | 承認付き再開 |
| GET/POST/PATCH | `/admin/products`, `/admin/discount-rules` | マスター管理 |
| POST | `/exports` | event/business day/日時範囲を指定してcanonical CSV bundle作成 |

管理APIには `/admin/events`、`/business-days/open`、`/admin/staff`、`/admin/staff-assignments`、`/admin/bundles`、`/admin/payment-methods`、`/admin/payment-combinations`、`/admin/age-policies`、`/admin/manual-discount-policies` を設ける。無料配布理由master APIは初期版で設けない。全スタッフ向け読取りAPIとして期間・cursor pagination付きの `/reports/sales`、`/inventory`、`/audit-events` を設け、変更権限とは分離する。

### 5.4 印刷

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/printer/status` | 正規化状態と取得可否 |
| GET | `/print-jobs/{id}` | 状態、試行、テンプレート版 |
| POST | `/transactions/{id}/reprints` | 明示的再印刷。売上を変更しない |
| POST | `/print-jobs/{id}/cancel` | pending/retry_waitのみ取消 |
| GET/POST | `/receipt-templates` | 一覧・draft作成 |
| POST | `/receipt-templates/{id}/validate` | 構文・変数・引数検査とpreview |
| POST | `/receipt-templates/{id}/activate` | 検証済み版を有効化 |
| POST | `/printer/test-jobs` | 権限付きテスト印刷 |

### 5.5 顧客画面

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/customer-displays/{terminalId}` | pair済みregisterの現在public projectionを再取得 |
| POST | `/customer-displays/{terminalId}/age-confirmations` | 許可された自己申告だけを入力 |

顧客画面はWebSocketイベント本文から状態を復元せず、通知後または再接続時にGETする。商品、数量、価格、支払を変更するAPIを顧客画面scopeへ公開しない。取引内の無料配布はpublic projection上の0円行として短時間表示できるが、会計外の無料配布操作は投影せず待機表示を維持する。初期版は0円演出を省略して待機表示を継続してよい。

`sending` の取消は409。`failed` からは同じjobを再送せず、新しいreprint jobを作る。

ドロアー開放は `/device-jobs/drawer` の専用権限付きAPIで作成する。現金会計確定時は会計transactionと同時にdevice jobを登録できるが、レシートtemplateと再印刷からは生成しない。

`POST /transactions/{id}/reprints` は `sourcePrintJobId`、`reasonCode`、任意 `reasonText`、`physicalOutcome`（`printed` / `not_printed` / `indeterminate`）、`riskAccepted`、責任者承認を要求する。source jobがpath上の取引に属することを検証し、template/version・asset/font/renderer/finishing policy版はsource jobと同一に固定して上書きを許さない。`printed` または `indeterminate` では `riskAccepted=true` と有効な `approval_id` がなければ409にする。要件5.3どおり実行者と承認者の同一人物を許可し、承認記録と監査へ `self_approved` を保存する。`requestedBy` は認証sessionから設定し、reprint no、job、operation、承認消費、監査を同じDB transactionで確定する。

## 6. WebSocket契約

endpointは `/api/v1/events`。接続後に認証・terminal scopeを確定し、次の通知だけを送る。

- `sale-draft.changed { registerId, version }`
- `customer-display.changed { registerId, version }`
- `transaction.finalized { registerId, transactionId }`
- `print-job.changed { jobId, state }`
- `printer-status.changed { observationId }`
- `inventory-alert.changed { alertId }`
- `approval.requested { challengeId }`

イベント本文を正本にせず、受信側は対応REST APIを再取得する。再接続時のイベント再生は不要で、現在version比較により回復する。

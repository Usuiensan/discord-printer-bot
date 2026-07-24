# 05. ADR登録簿

## 運用ルール

- 状態は `Accepted`、`Proposed`、`Research`、`Pending decision` を使用する。
- 「仮の本番既定値」で穴埋めしない。
- 各ADRは候補、実測、影響、決定者、決定日を追記し、別の正式ADRを `Accepted` として発行する。
- ブロック対象の受入条件は、ADR決定と必要な再試験まで完了にしない。

2026-07-24の判断と推奨案は `08_adr-decisions-2026-07-24.md` に記録した。現在の状態は次のとおり。

| ADR | 状態 | 補足 |
| --- | --- | --- |
| P001〜P003、P006 | Pending decision | 実機・本番構成の証拠待ち |
| P004 | Accepted | 100%上限、承認・理由機能を当面実装しない。要件改訂が必要 |
| P005 | Accepted | 特定会計ソフト非依存のcanonical bundleを随時出力。製品別adapterは将来追加 |
| D007〜D019 | Accepted | 詳細および要件差分は決定記録を参照 |
| D020 | Proposed | 伝票・取り置き・商品バーコード名前空間。09を参照 |

## 要件19章のADR

### ADR-P001 Windows/Linux USB通信方式

- 決めること: OS別ライブラリー/driver、RAW送信方式、対応CPU、配布、ライセンス、timeout、排他、再接続。
- 必要証拠: Windows x64、Linux x64/ARM候補で同一bytes送信、install再現、競合・切断試験。
- ブロック: OS adapter、PR-01〜04、PR-06、PR-07。
- 決定まで可能: `PrinterTransport`、fake adapter、contract test。

### ADR-P002 USBクラスと状態取得保証範囲

- 決めること: OS/接続方式ごとのreachable、online、cover、paper、recoverable/fatal errorの `supported/unsupported/unknown` 能力表。
- 必要証拠: 紙切れ、カバー開、USB切断、再接続の両OS実測とraw response。
- ブロック: 状態監視正式実装、PR-03、PR-04。
- 決定まで可能: normalized status型、unknown UI、fake fault injection。

### ADR-P003 キャッシュドロアー仕様

- 決めること: 型番、TM-T70II互換性、pin、ON/OFF pulse、安全制限、開放条件。
- 必要証拠: 製品仕様、接続図、実機一回動作、連続駆動制限。
- ブロック: drawer adapter、PR-06。
- 決定まで可能: 権限、監査、専用device job、fake test。

### ADR-P004 任意値引きのイベント初期値

- 状態: `Accepted`（2026-07-24）
- 決定: 率上限100%を初期値とし、承認・理由入力機能は当面実装しない。
- 要件差分: v0.5 6.6、17章、AC-10の改訂が必要。
- 決定者: サークル運営責任者。
- ブロック: 本番event初期化、AC-10。
- 決定まで可能: policyを必須入力にし、engineと全選択肢を実装。

### ADR-P005 無料配布理由と会計ソフト連携

- 状態: `Accepted`（2026-07-24）
- 決定済み: 理由入力機能は当面実装しない。
- 決定: 特定会計ソフトに依存せず、正本から随時canonical export bundleを再生成できるようにする。製品別変換は導入時に追加する。
- 決定者: サークル運営・会計担当。
- ブロック: 本番reason master、会計連携CSV、CL-04最終受入。
- 決定まで可能: 汎用内部モデル、売上非計上、在庫移動、暫定fixtureによる自動試験。

### ADR-P006 本番ハードウェア構成

- 決めること: server/OS/CPU/storage、router、UPS、予備server/printer/cable、復旧時間目標。
- 必要証拠: BOM、消費電力、LAN/停電/交換訓練、本番相当負荷。
- ブロック: 総合性能保証、障害訓練、PR-01〜04、CL-10の最終受入。
- 決定まで可能: 開発PC上の自動試験、配布scriptの雛形。

## 要件間または実装境界で発見したADR

### ADR-D007 商品・価格・在庫の所属単位

- 状態: `Accepted`（2026-07-24）
- 決定: 商品コード、価格、税、原価、sale state、在庫をevent別にする。
- 影響: master schema、CSV import、過去取引、複数event運用。
- 決定までの設計: transaction lineへ全値をsnapshot。schemaはevent商品設定を分離可能に保つ。

### ADR-D008 税計算と値引き配賦

- 状態: `Accepted`（2026-07-24）
- 決定: 頒布価格は税込。税率別にレシート1枚につき1回だけ丸め、初期値は切捨て。配賦と返品復元は決定記録の方式とする。
- 要件で確定済み: 税率ごとにレシート1枚につき1回丸め、方式は切捨て/四捨五入/切上げ、変更は次営業。
- ブロック: 税engine、AC-08〜11、CL-08の金額正当性。
- 決定者: サークル会計担当。必要に応じ税務専門家レビュー。

### ADR-D009 取消・部分返品・外部決済返金

- 状態: `Accepted`（2026-07-24）
- 決定: 元レシートの部分返品は実装せず、全部返品後に残す商品を再登録する。レシートなしの商品コード返品は許可する。
- 影響: transaction/payment state machine、cash ledger、監査。
- 原則: 外部端末結果を推測せず記録する。元取引は更新・削除しない。

### ADR-D010 見本在庫の意味

- 状態: `Accepted`（2026-07-24）
- 決定: 見本区分を廃止し、販売可能在庫と完全に同じ扱いにする。汚損時だけ破損・廃棄movementを使う。
- 要件差分: v0.5 6.2、6.9、14.4、CL-07の改訂が必要。

### ADR-D011 R18確認ルール表現

- 状態: `Accepted`（2026-07-24）
- 決定: 初期policyは容貌確認。自己申告は補助で、省略可能かつ容貌/身分証目視の代替にしない。
- 禁止: 身分証の種類、番号、氏名、住所、生年月日、画像の保存。
- ブロック: R18-01〜03。

### ADR-D012 レシートの担当者表記

- 状態: `Accepted`（2026-07-24）
- 決定: event設定で責任者番号または登録表示名の一方を選ぶ。初期値は番号。表示名はペンネーム/ハンドルネームを許可する。
- 影響: `ReceiptSnapshot.staffPrintLabel`、privacy、紙幅、PR-07。

### ADR-D013 自動値引きの重複定義

- 状態: `Accepted`（2026-07-24）
- 決定: 同一数量tokenの重複適用を禁止し、率値引きは割当て前税込額へ一回だけ適用する。
- 要件で確定済み: 最終支払額最小、同額はpriority→rule ID、数量/回数上限。
- AC-08、AC-09をこの規則で検証する。

### ADR-D014 取引番号と営業単位

- 状態: `Accepted`（2026-07-24）
- 決定: business day内全レジ共通6桁、欠番許容、再開後継続、部分締めなし。
- 影響: business day schema、receipt、CSV、closing。
- 原則: 内部UUIDと表示番号を分離し、番号を再利用しない。

### ADR-D015 現金箱モード変更

- 状態: `Accepted`（2026-07-24）
- 決定: 営業中変更を禁止し、締め後に予約して次営業から適用する。
- ブロック: CL-01、CL-02。

### ADR-D016 取り置き不足時の扱い

- 状態: `Accepted`（2026-07-24）
- 決定: 販売可能数量超過を警告付きで許可し、明示続行を監査する。
- 影響: hold作成validation、available算出、CL-05/06。

### ADR-D017 無料配布の顧客画面表示

- 状態: `Accepted`（2026-07-24）
- 決定: 取引内無料配布は0円表示への短い演出を推奨。会計外の管理操作または初期版fallbackは待機表示を維持する。
- 影響: customer projection、privacy、操作フロー。

### ADR-D018 保持期限後の保守手順

- 状態: `Accepted`（2026-07-24）
- 決定: event単位の暗号化archiveと手動期限処理を採用し、行単位削除は実装しない。
- 要件で確定済み: アプリから自動削除しない、監査ログの編集・削除機能を設けない。
- 設計済み: action別allowlistのcanonical business snapshotを監査へ保存し、秘密・身分証情報を除外する。
- 影響: export、backup、保守runbook。

### ADR-D019 会場LANの通信保護

- 状態: `Accepted`（2026-07-24）
- 決定: 本番はローカルCAによるHTTPS。HTTPはloopback開発または明示した隔離LANでの一時検証だけ。
- 影響: session cookie属性、CSRF、初期導入、端末追加、脅威モデル。
- 原則: LAN内であっても認証・Origin検査を省略せず、PINやsession tokenをログへ残さない。
- 本番端末導入前にCA配布・信頼設定・fingerprint確認をrunbookで検証する。

### ADR-D020 バーコード名前空間

- 状態: `Proposed`
- 決めること: 伝票、取り置き、内部商品、外部EAN/UPC/ISBN/ISDNを一つのscanner routerで衝突なく識別する形式。
- 改訂推奨: `PS` magic＋version/type数字＋14桁乱数＋Luhnの非GS1 Code 128とする。Crockford Base32と単独 `T1/H1/P1` は使わない。数字だけの全領域を商品コードとして許可し、20x〜29x、278〜279、292を含めシステム用使用不可領域を作らない。
- 詳細: `09_barcode-namespace-proposal.md`。
- ブロック: scanner router、レシート伝票バーコード、取り置きラベル、内部商品ラベルの正式実装。

## 決定順序

1. P001、P002: OS/印刷統合前
2. P003: drawer実装前
3. D020: scanner・各バーコード正式実装前
4. P006: 総合受入前

# 03. 印刷・OS固有層設計

## 1. 境界

印刷は次の5段階に分ける。

```text
ReceiptSnapshot
  → Declarative template renderer
  → Typed ReceiptDocument AST
  → Canonical Discord command IR text
  → Strict existing-command parser
  → ESC/POS bytes
  → PrinterTransport
```

- `ReceiptSnapshot` は確定時の不変JSONであり、現在の商品・税・値引き設定を参照しない。
- テンプレートは表示と反復・条件分岐だけを行う。金額、税、値引き、R18可否を計算しない。
- 差込み値をコマンド文字列へ直接連結せず、必ずliteral AST nodeとして生成する。
- Discord用コマンド文字列は要件で指定された中間表現である。ASTからcanonical serializeし、既存変換器のstrict parserを通す。
- ESC/POS変換はOS非依存の純粋関数とする。
- USB、Windows spooler、状態取得は `PrinterTransport` に限定する。

## 2. 既存Discordプリンターボットの再利用

既存実装を直接importするのではなく、次の順でパッケージとして抽出する。

1. ESC/POS builder、文字コード、画像ラスタ、QR/バーコード、カットのgolden testを固定する。
2. Discord messageやbot configへの依存を除き、`packages/escpos` と `packages/receipt-ir` へ分離する。
3. POSが使用するコマンドallowlistと引数範囲を明文化する。
4. 同じIRから同じbytesが出ることをWindows/Linux共通テストで保証する。
5. TM-T70II実機で文字、円記号、画像、紙送り、部分カットを確認する。

既存実装の知見として、次を設計制約にする。

- 384 dotsを標準内容幅、416 dotsを物理上限として別々に扱う。
- U+00A5の円記号は、日本語設定TM-T70II上のCP932 `0x5C` 等価表現として実機確認する。
- 非対応文字を含む場合はレシート内の対象テキストを決定的に画像化し、再印刷で同じラスタを再生成できるようフォントID・版と設定を記録する。
- full cut命令の生成成功と完全切断は別である。TM-T70IIの物理カッター仕様を超える結果を保証しない。
- テンプレート末尾とジョブ共通処理の二重カットを禁止する。

## 3. テンプレート

### 3.1 形式

UTF-8 YAMLの宣言的テンプレートを採用する。テンプレートは `text`、`row`、`align`、`emphasis`、`size`、`rule`、`feed`、`image`、`qr`、`finish` nodeと、`each`、`if` だけを持つ。

```yaml
schemaVersion: 1
body:
  - reset: true
  - align: center
  - text: "{{eventName}}"
  - each: lines
    body:
      - row:
          left: "{{name}} x{{quantity}}"
          right: "{{netFormatted}}"
  - finish:
      feedLines: 3
      cutMode: partial
```

変数展開は文字列コマンドの再parseではなく、nodeのliteral valueへ代入する。任意helper、式評価、ファイル参照、ネットワーク、JavaScript実行、動的includeを禁止する。変数schemaを明示し、未知変数を保存時エラーにする。

### 3.2 `ReceiptSnapshot` 最低項目

- template schema version
- event/circle name
- transaction ID/no/type/original no
- confirmed timestamp、business date、register no、staff print label
- lines: name, quantity, unit price, gross, allocated discounts, tax, net
- discountsとtax summaries
- payments、tendered、change
- total
- reprint flag/no
- footer/return policy snapshot

印字する担当者表記はevent設定の `manager_no` または `display_name` の一方から会計確定時に `staffPrintLabel` を生成し、snapshot保存する。初期値は `manager_no`。`display_name` は法的氏名を要求せず、登録されたペンネームまたはハンドルネームを許容する。

### 3.3 版管理と有効化

- draft作成時に `template_key` と次versionを採番する。
- validateは構文、変数、コマンド、引数、最大幅、初期化、末尾責務を検査する。
- previewはcanonical IR、PNG、警告一覧を返す。
- activateは検証結果のsource SHA-256一致を必須にする。
- active版は更新せず、新versionを作る。
- print jobにtemplate key/version/source hash、ReceiptSnapshot、canonical IR/hashを保存する。
- 画像assetと配布fontは不変blob/hashでtemplate版へ紐付ける。source hashはasset、font、renderer、finishing policyの各version/hashを含む。
- 長期再現用としてcanonical IR、最終ESC/POS payload hash、画像化したラスタassetをjobへ保存する。

## 4. 中間表現

テンプレートrendererは次のASTを生成する。

```ts
type ReceiptNode =
  | { kind: "reset" }
  | { kind: "text"; value: string }
  | { kind: "align"; value: "left" | "center" | "right" }
  | { kind: "emphasis"; bold: boolean; underline: boolean; invert: boolean }
  | { kind: "size"; width: 1 | 2; height: 1 | 2 }
  | { kind: "row"; left: string; right: string }
  | { kind: "rule"; style: "single" | "double" }
  | { kind: "feed"; lines: number }
  | { kind: "image"; assetId: string; widthDots: number }
  | { kind: "qr"; data: string; moduleSize: number; errorCorrection: "L" | "M" | "Q" | "H" }
  | { kind: "cut"; mode: "none" | "partial" | "partial3" };
```

POSテンプレートではraw ESC/POS、drawer、buzzerを許可しない。drawerはADR-P003決定後、権限付きの専用device jobからだけ生成し、再印刷では実行しない。`full` cutはTM-T70II正式対象のallowlistへ入れない。

canonicalizerは改行、空白、数値表現を正規化し、同じASTから同じIR文字列を生成する。時刻や乱数をrenderer内で取得せず、snapshotからのみ読む。

canonical Discord IRを既存parserへ入力し、再度得たASTが元ASTと等価であることを検査してからESC/POS変換する。未知コマンドや未対応プロパティを黙って無視する互換モードは、本番テンプレートでは使用しない。

`finish` は紙送り・カットの業務上の意図であり、production templateにちょうど1個必須とする。template compilerだけが末尾feed/cut nodeを生成し、job workerは追加しない。`finishing_policy_id/version` をtemplate版とjobへsnapshotし、IR hashの入力に含める。

有効化時のschema検査に加え、各job生成時に実データで再検査する。384/416 dots、倍率込み2列幅、決定的wrap、画像高、総ラスタ/bytes上限、QR容量を検査し、失敗時は売上を戻さず `failed/delivery_certainty=not_sent` とする。

## 5. 印刷キュー

### 5.1 状態

DB状態は要件の日本語状態へ次のように対応する。

| DB | 表示 |
| --- | --- |
| `pending` | 待機 |
| `sending` | 送信中 |
| `completed` | 完了 |
| `failed` | 失敗 |
| `retry_wait` | 再試行待ち |
| `canceled` | 取消 |

`failed` は `delivery_certainty` を持つ。値は `not_sent`、`accepted`、`unknown`。`unknown` のUI表示は「結果不明（紙面を確認）」とし、通常の既知失敗と区別する。

### 5.2 claimと直列化

1. 単一arbiterがDBのprinter leaseを取得する。
2. `printer_operations` の最小sequenceにある `pending/retry_wait` 操作をclaimする。printとdrawerを別workerでclaimしない。
3. printならtemplate snapshot/IR/hashと実データ幅を検証し、attempt phase=`prepared` をcommitする。
4. プリンター事前状態をarbiter内で取得する。取得不能は `unknown` として記録し、ADR-P002の能力表に従う。
5. I/O呼出し直前にphase=`dispatch_started` を別commitし、compiler/adapter/write直前のbytes hashを記録する。
6. Transportへ一回だけ渡す。`acceptedBytes === payload.length` だけを全bytes受理とする。
7. 全bytes受理後にphase=`transport_accepted`、postcheck後に `postcheck_completed` を記録する。
8. 完了時はjobをcompletedにし、`completion_evidence` を `transport_accepted`、`device_postcheck_ok`、`operator_verified` から記録する。UIは「送信完了」と表示し、紙面保証とは表示しない。
9. 0 bytes未送信を証明できる一時エラーだけretry_waitにする。short write、timeout、1 byte以上送信した可能性、dispatch_started後のcrashは `failed/delivery_certainty=unknown` とし自動再送しない。

アプリ再起動時、phase=`prepared` までならpendingへ戻せる。`dispatch_started` 以降は全bytes未送信をtransport証拠で立証できない限り結果不明として隔離する。

queueはprinterごとの厳格FIFOとする。arbiterは常に未完了の最小sequenceだけを評価し、その操作が将来の `available_at` を持つ `retry_wait` またはdevice faultでblock中なら後続操作を追い越させない。dispatch前かつ0 bytes未送信を証明できるtransient errorだけを初回に加えて最大3回、2秒・5秒・15秒の固定backoffで再試行する（`attempt_count` 上限4）。各失敗で `attempt_count` と次の `available_at` を同一transactionで更新し、上限到達後は `failed/not_sent` として後続を解放する。

紙切れ、カバー開、offline等の物理faultはtimerで回し続けず `block_reason=device_fault` とする。lease ownerが同じarbiter内でstatus refreshを行い、正常を観測した場合、または責任者が現物確認してresumeした場合だけpendingへ戻す。取得不能は正常と推測せずblockを維持し、観測値とresume操作を監査へ残す。

状態照会、print、drawerは単一arbiterとprinter leaseの内側で直列実行する。status APIは最新observationを返し、refresh要求はlease ownerへ渡す。別プロセスの状態監視を起動して応答を奪わない。

現金会計確定時は同じDB transactionでdrawer operation、続いてreceipt print operationのsequenceを採番する。drawer失敗とprint失敗は独立表示し、どちらも売上をrollbackしない。再印刷はprint operationだけを作る。

### 5.3 再印刷

再印刷は元jobの状態変更ではなく、新しいjobを作る。

- `sourcePrintJobId`、責任者権限、理由、元取引ID、現物結果 `printed/not_printed/indeterminate`、risk acceptanceを必須にする。
- source jobが元取引に属することを検証し、その取引snapshotとsource jobのtemplate/version・asset/font/renderer/finishing policy版を必ず使う。版の上書きは許可しない。
- `printed` または `indeterminate` では二重印刷リスクの明示承認を要求する。要件5.3に従い自己承認を許可し、`self_approved` を監査する。
- 「再印刷」、回数、元取引番号をsnapshotへ追加する。
- transaction、payment、inventory、cash ledgerへ書かない。
- 現物結果と承認者を新job・監査へ保存する。

## 6. ポート

```ts
interface PrinterTransport {
  readonly id: string;
  send(bytes: Uint8Array, signal: AbortSignal): Promise<SendReceipt>;
  readStatus(signal: AbortSignal): Promise<PrinterStatusObservation>;
  openDrawer?(command: DrawerPulse, signal: AbortSignal): Promise<void>;
}

type SendReceipt = {
  acceptedBytes: number;
  completedAt: string;
  transportEvidence: Record<string, string | number | boolean>;
};

type Capability<T> =
  | { support: "supported"; value: T }
  | { support: "unsupported" }
  | { support: "unknown"; reason: string };

type PrinterStatusObservation = {
  observedAt: string;
  reachable: Capability<boolean>;
  online: Capability<boolean>;
  coverOpen: Capability<boolean>;
  paper: Capability<"ok" | "near_end" | "empty">;
  error: Capability<"none" | "recoverable" | "unrecoverable">;
  raw: unknown;
};
```

Transportのsend成功は「OS/デバイスが全bytesを受理した」証拠であり、紙への物理印字完了を意味しない。APIとログでこの区別を保つ。

adapterが部分writeを内部継続してよいのは、同一接続内の未送信offsetを確実に保持できる場合だけである。再接続後に途中offsetから再開せず結果不明にする。

## 7. OSアダプター

### Windows

- 選定USB/RAW方式はADR-P001で決定する。
- Windows spoolerを使う場合、job ID、spooler job ID、bytes hashを証跡にする。
- OPOSを状態取得だけに使う場合は、印刷との排他・Claim timeoutを測定する。
- Windows serviceは専用アカウントで動かし、UIセッションを必要としない。

### Linux

- 選定ライブラリーまたは `/dev/usb/lp*` 方式はADR-P001で決定する。
- デバイスパスを固定値とみなさず、udev ruleによる安定名を使う。
- service user、group、device permissionを導入手順で検証する。
- read/write双方向可否とDLE EOT応答を実機能力表へ記録する。

両OSアダプターは同じcontract testを通す。status能力差は実装で埋めず、`unsupported/unknown` として表現する。

## 8. 実機試験証跡

各ケースで次を保存する。

- OS/version、CPU、adapter/lib version、USB接続方式
- printer model/serial/firmware、紙幅、DIP/メモリスイッチ
- template version、IR hash、bytes hash、job/attempt ID
- compiler出力、adapter受領、OS書込み直前の各bytes hash
- raw status、normalized status、ログ
- 紙面写真またはscan、担当者判定
- cut/drawerではコマンドbytes、設定、物理結果

同じ内容の両OS比較は、IR hashとbytes hashの一致を自動証明し、紙面は人間が取引番号、全文、配置、文字化け、カットを比較する。

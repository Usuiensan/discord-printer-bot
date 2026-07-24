# 06. 実装フェーズ別Goal文

## 共通実行規則

- 本設計と要件v0.5を正とし、未決ADRを推測しない。
- 各Goalは専用branch/worktreeで実行し、同じファイルへ複数Goalから同時書込みしない。
- force-pushを前提にせず、通常のcommit、rebase/merge、pushを使う。
- 各Goalで設計追跡表、テスト、差分レビュー、運用文書を更新する。
- 実機・人間レビューが必要な項目を自動試験だけで完了にしない。

## Goal 1: 基盤・認証・監査

> Accepted済みのADR-D014に従い、pnpm/TypeScript monorepo、Fastify、React shell、SQLite migration、設定、認証session、role権限、責任者番号のevent別履歴、責任者承認、`YYYY-MMDD-NNNNNN` 取引番号、営業、端末、追記型監査、CIを実装する。D020がAcceptedになるまでは伝票Code 128と共通BarcodeRouterを正式実装しない。Windows/Linuxで同じDBと業務コードを使い、OS固有処理をprinter portとservice管理の外へ漏らさない。PINと身分証情報をログへ保存しない。空DB/更新DB migration、採番競合・欠番・締め再開、認証・権限拒否、自己承認監査、両OS起動の自動試験が成功し、設計差分が記録されたら完了とする。

## Goal 2: 商品・在庫・値引き

> Accepted済みのADR-D007/D008/D010/D013/D016/P004に従い、event別商品コード・価格・税・原価・販売状態・在庫、負数在庫警告、版付きセットショートカット、同一数量tokenの重複を禁止したまとめ値引き最適化、100%上限の任意値引き、取り置き、無料配布の内部モデルを実装する。D020がAcceptedになるまでは内部商品・取り置きbarcodeとscanner routerを正式実装しない。見本区分、任意値引きの承認・理由、無料配布理由は実装しない。商品コード8桁以上をUI/CSV/APIで共通検証し、セットは全件または0件、在庫移動は追記専用、値引きは最安・同額時決定的とする。要件次版へ改訂したAC-05〜11、AC-14、CL-05〜07のdomain/API部分とCL-04の内部集計部分が成功したら完了とする。

## Goal 3: 会計・支払・返品・同時実行

> Accepted済みのADR-D009/D014/D015に従い、draft、価格再計算、現金、外部決済、併用払い、釣り銭、冪等会計確定、取引snapshot、在庫・現金台帳、取消、全部返品、レシートなし返品、返金、初回print operation outboxを実装する。元レシートの部分返品は実装しない。会計確定の取引・明細・値引き・税・支払・R18参照・承認・在庫・現金・監査・print operation登録を一つのDB transactionにし、USB送信を含めない。60会計/分、最後の1点、連打、再送、process crashを試験し、AC-02/03/07/12とAC-18〜22のUI非依存A部分が成功したら完了とする。A+R項目の全体は完了扱いにしない。

## Goal 4: レジ・顧客・管理画面とR18

> Accepted済みのADR-D011/D012/D017に従い、4レジ、4顧客画面、2管理端末の同期、担当者ログオン、キーボード/タッチ、数字入力文脈、負数在庫の関係取引・返品返金導線、警告と音声、顧客画面clear、R18確認を実装する。WebSocketを通知に限定し、切断後はRESTから復元する。身分証個別情報を収集・保存・出力せず、確認不能時はR18商品だけを外して再登録可能にする。AC-01/04/13〜22、R18-01〜03のA/R証跡がそろったら完了とする。

## Goal 5: レシート・永続印刷キュー

> 宣言的template、型付きReceiptDocument AST、canonical Discord互換IR、既存ESC/POS変換の厳格モード、asset/版管理、preview、共通printer operation queue、永続attempt phase、再印刷、delivery certaintyを実装する。取引差込み値をcommandとして解釈せず、同じsnapshot・template・asset/font/renderer/finishing policy版から同じIR/bytesを生成する。USBはfake adapterまでとし、会計を印刷完了から分離する。PR-02/05/08〜11のA証跡、既存変換器characterization、command injection、worker kill、short write、二重送信防止試験が成功したら完了とする。

## Goal 6: プリンター技術検証とADR決定

> 製品コードへ採用方式を固定する前にWindows/Linuxの最小probeを作り、候補USB/RAW方式でTM-T70IIへの同一bytes送信、排他、再接続、紙切れ、カバー、USB切断、status raw responseを測定する。drawer型番が提供された場合は安全なpulse試験も行う。OS/CPU/driver/library/USB class/実測結果を比較し、推測せずADR-P001/P002/P003をAcceptedまたは追加証拠待ちに更新する。Accepted方式と能力表、再現可能なprobe、ログ・紙面証拠が揃ったら完了とする。

## Goal 7: Windows/Linuxプリンター実機統合

> Accepted済みのADR-P001/P002/P003に従い、Windows/Linux PrinterTransport、USB/RAW送信、status、排他、再接続、部分カット、drawer専用operationを実装する。取得不能状態を正常/異常と推測せずunknownとする。両OSで同じIR/bytesをTM-T70IIへ送り、紙切れ、カバー、USB切断、送信途中停止、復旧再印刷、4レジ同時投入、カット、drawerを検証する。PR-01〜07/10のA/H/R証跡がすべてそろったら完了とする。

## Goal 8: 締め・CSV・バックアップ・復旧

> Accepted済みのADR-P005/D014/D015/D018に従い、register/shared現金箱、準備金、cash ledger、理論現金、実在高、過不足、締め、承認付き再開、随時生成可能なcanonical CSV bundle、暗号化event archive、SQLite backup/restore、offline出力を実装する。会計ソフト固有adapterは初期対象外とする。取消・返品・調整・締め修正は元記録を変更せず追記する。CL-01〜10のA/R証跡、export再現性・manifest hash・期間抽出、archive復旧、migration/backup/強制終了/再起動試験が成功したら完了とする。

## Goal 9: 総合受入・運用引渡し

> ADR-P006で決定した本番相当構成を使用し、要件18章46件を `04_test-strategy-and-acceptance.md` の台帳で実行する。各項目にcommit、環境、入力、期待値、実測値、ログ、画面、紙面または実機動画、判定者を紐付ける。60会計/分、10端末、Windows/Linux実機印刷、障害復旧、停電/再起動、backup restoreを再実施する。未決ADR、未実施タグ、重大不具合、説明できないデータ差異が0件であり、運用・復旧runbookを実演できた場合だけ完了とする。

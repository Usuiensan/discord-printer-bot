# Discord Printer Bot for Epson TM-T70II 58mm

Discord の指定チャンネルに投稿された内容を、USB 接続された Epson TM-T70II 58mm 幅プリンタへ即時印刷する bot です。

## できること

- 指定 Discord チャンネルの新規メッセージを監視
- メッセージ本文を ESC/POS のプリンタ内蔵フォントで印刷
- 発言したユーザーのアイコンをディザ処理した疑似グレースケール画像として印刷
- URL を本文として印刷し、プリンタ内蔵機能で QR コードとしても印刷
- 通常メッセージコマンドから対応バーコード/二次元コードを印刷
- カスタム絵文字、Unicode 絵文字、スタンプ、添付画像をディザ処理した疑似グレースケール画像として印刷
- Windows に登録されたプリンタキューへ RAW ESC/POS データを送信

## 前提

- Windows PC
- Node.js 20 以上
- Epson TM-T70II が USB 接続され、Windows の「プリンターとスキャナー」に登録済み
- Discord Developer Portal で作成した bot
- bot の `MESSAGE CONTENT INTENT` が有効

## セットアップ

```powershell
npm install
Copy-Item .env.example .env
```

もし `npm install` で `Cannot find module ... npm-cli.js` が出る場合は、PC の npm インストールが壊れています。Node.js 公式インストーラで Node.js を修復インストールしてから、もう一度 `npm install` を実行してください。

`.env` を編集します。

- `DISCORD_TOKEN`: Discord bot token
- `DISCORD_CHANNEL_ID`: 印刷したいチャンネル ID
- `DISCORD_GUILD_ID`: 任意。設定するとスラッシュコマンドがそのサーバーへ即時登録されます
- `PRINTER_NAME`: Windows のプリンタ名
- `PRINT_RETRY_ATTEMPTS`: 前ジョブ処理中など一時的なプリンタ状態での最大試行回数
- `PRINT_RETRY_DELAY_MS`: リトライ待機時間。試行ごとに少しずつ伸びます
- `PRINTER_MONITOR_ENABLED`: 起動中にプリンタ状態を定期監視し、問題を Discord に通知するか
- `PRINTER_MONITOR_INTERVAL_MS`: プリンタ状態の監視間隔
- `MEMBER_JOIN_PRINT_ENABLED`: 新しいメンバーがサーバーへ参加した時にレシートを印刷するか
- `OPOS_STATUS_ENABLED`: OPOS ADK for .NET でプリンタ状態を確認するか
- `OPOS_LOGICAL_NAME`: SetupPOS で登録した論理デバイス名
- `OPOS_CLAIM_TIMEOUT_MS`: OPOS Claim の待ち時間
- `CUT_MODE`: `none`、`partial`、`partial3`、`full`。通常は `partial` 推奨
- `MERGE_SAME_USER_WINDOW_MS`: 同じユーザーの連投でヘッダーを省略する時間
- `PRINT_AUTHOR_AVATAR`: 発言者アイコンを印刷するか
- `AUTHOR_AVATAR_WIDTH_DOTS`: 発言者アイコンの印刷幅
- `IMAGE_DITHER_MODE`: 画像変換方式。`ordered` は網点でグレーを表現、`threshold` は単純な白黒2値
- `IMAGE_MAX_BYTES`: 画像ダウンロード上限。画像は印刷幅まで縮小されます
- `PRINT_URL_QR`: URL を QR コードとして印刷するか
- `QR_MODULE_SIZE`: QR コードのドットサイズ
- `QR_ERROR_CORRECTION`: QR コードの誤り訂正レベル
- `PRINTED_REACTION`: 印刷完了後に bot が付けるリアクション絵文字
- `PRINT_NEAR_END_REACTION`: レシート用紙残量少の状態で印刷完了した時に付けるリアクション絵文字
- `PRINT_ERROR_REACTION`: 印刷失敗または一部スキップ時に bot が付けるリアクション絵文字

プリンタ名は PowerShell で確認できます。

```powershell
Get-Printer | Select-Object Name
```

## Discord 側の設定

1. Discord Developer Portal で bot を作成します。
2. Bot 設定で `MESSAGE CONTENT INTENT` と `SERVER MEMBERS INTENT` を有効にします。
3. OAuth2 URL Generator で `bot` を選び、権限は最低限 `View Channels`、`Read Message History`、`Send Messages`、`Add Reactions` を付けます。
4. bot をサーバーに招待します。
5. Discord の開発者モードを有効にして、印刷対象チャンネルを右クリックし「IDをコピー」します。

`Error: Used disallowed intents` が出る場合は、ほぼ `MESSAGE CONTENT INTENT` または `SERVER MEMBERS INTENT` が無効です。Discord Developer Portal の `Bot` ページで `Privileged Gateway Intents` の両方をオンにして保存し、`.env` の `DISCORD_TOKEN` が同じアプリの bot token か確認してください。

## 実行

```powershell
npm start
```

## OPOS ADK for .NET 状態確認

紙切れやカバーオープンをより確実に検出したい場合は、EPSON OPOS ADK for .NET をインストールし、SetupPOS で TM-T70II を登録してください。登録した論理デバイス名を `.env` に設定します。

```env
OPOS_STATUS_ENABLED=true
OPOS_LOGICAL_NAME=TM-T70II
```

単体確認:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\opos-status.ps1 -LogicalName "TM-T70II"
```

## コード印刷コマンド

通常メッセージのコマンドでプリンタ内蔵コード印字を実行できます。

```text
!qr https://example.com
!print-code qr https://example.com
!print-code code128 ABC123
!print-code jan13 490123456789
```

1つのDiscord投稿に複数行書くと、Discordヘッダー付きの1ジョブとして順番に印刷します。通常本文も同じ投稿内に混ぜられます。カットは最後に1回だけです。

```text
通常文の上
!print-code qr https://example.com
!print-code code128 ABC123
通常文の下
!qr https://openai.com
```

短縮名として `gs1128` は `GS1-128`、`databar` は `GS1 DataBar Omnidirectional` として扱います。
`code128` は数字のみ偶数桁のデータなら自動で Code Set C を使います。明示したい場合は `code128c` を使えます。

対応種別: UPC-A、UPC-E、JAN/EAN 8、JAN/EAN 13、CODE 39、ITF、CODABAR/NW-7、CODE 93、CODE 128、GS1-128、GS1 DataBar 系、PDF417、QR Code、MaxiCode、Composite Symbology。

## 再印刷コマンド

過去の投稿をもう一度印刷できます。メッセージリンク、メッセージID、または返信先が使えます。

```text
!reprint 1513138512247918662
!reprint https://discord.com/channels/1507235720912179200/1513044471275589752/1513138512247918662
```

対象メッセージへの返信として `!reprint` だけ打つこともできます。

## 本文内 ESC/POS 制御コマンド

印刷本文の行頭に制御コマンドを書くと、その行は印字せず、後続の印刷設定を変更します。短縮形または `!escpos` 付きで使えます。

```text
!center
中央揃えの文字
!right
右揃えの文字
!left
左揃えに戻す
```

よく使うコマンド:

- `!left` / `!center` / `!right`: 揃え位置
- `!align left|center|right`: 揃え位置
- `!row 左側 | 右側`: 同じ行に左寄せテキストと右寄せテキストを印字
- `!rule -` / `!rule *`: 現在の文字幅いっぱいに区切り線を印字
- `!blank 2`: 空行
- `!box text`: `* text *` 形式の注意書き
- `!bold on|off`: 太字
- `**太字**`: Discord の太字をプリンタ太字で印刷
- `!underline on|off|2`: 下線。`2` は太線
- `__下線__`: Discord の下線をプリンタ下線で印刷
- `!doublestrike on|off`: 二重印字
- `!invert on|off`: 白黒反転
- `!rotate on|off`: 90度回転
- `!upsidedown on|off`: 倒立印字
- `!font a|b`: 内蔵フォント切り替え
- `!smoothing on|off`: スムージング
- `!printmode font=a bold=on double-width=on double-height=off underline=off`: 印字モード一括指定
- `!small on|off`: 小さいフォント
- `!size 1-8 1-8`: 横倍率・縦倍率
- `!normal`: 太字、下線、反転、回転、倍率、揃えを標準へ戻す
- `!reset`: プリンタ初期化
- `!linespacing 24` / `!linespacing default`: 行間
- `!charspacing 0`: 文字間隔
- `!tab`: 水平タブ
- `!tabs 8 16 24`: タブ位置
- `!feed 3`: 改行
- `!feeddots 48`: ドット単位紙送り
- `!position 120`: 横方向の絶対位置
- `!relative 24`: 横方向の相対移動
- `!margin 0`: 左マージン
- `!width 384`: 印字領域幅
- `!motion 203 203`: 基本計算ピッチ
- `!cut partial|partial3|full|none`: その場でカット
- `!drawer 0 80 240`: キャッシュドロアー用パルス
- `!buzzer 1 1 3`: ブザー

ページモード:

```text
!page begin
!page area 0 0 384 300
!page direction left-to-right
!page position 20 40
!page relative 24
ページモード内の文字
!page print
!page end
```

ページモードは機種・ドライバー・現在の状態により無視される命令があります。通常のレシート印字では `!left`、`!center`、`!right`、`!bold`、`!size`、`!cut` から使うのがおすすめです。

Discord からは、電源オフ、バッファクリア、NVメモリー書き込み/消去、メモリースイッチ変更、通信条件変更、リアルタイムステータス要求など、プリンタ設定や永続メモリーに影響する命令は実装しません。

## レシート風レイアウトとプレビュー

`!row` は現在の `!small` や `!size` の状態を見て、右側の金額が端に揃うように整形します。印刷前に確認したいときは、先頭に `!preview` を付けると印刷せず Discord にプレビューを返信します。

```text
!preview
!center
北大ジャンクPC・USEDPC研究会
!left
ご来場ありがとうございます！
!rule -
!row 外コロロ　SKYTIME味 | ¥165
!row 内iPhone17 Pro Max 256GB 60コメ単164800 | ¥9888,000

!row 小計 | ¥9927,055
!row 外税 | ¥88
!bold on
!size 2 1
!row 合計 | ¥9927,143
!size 1 1
!bold off

!rule *
!box 裏面に収入印紙を貼り割印して下さい
```

## Windows 起動時に非表示で常駐

ログオン時に bot を非表示で起動するタスクを登録できます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-startup-task.ps1
```

すぐに非表示起動したい場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-bot-hidden.ps1
```

停止:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-bot.ps1
```

自動起動を解除して、起動中の bot も止める場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-startup-task.ps1 -StopBot
```

ログは `logs\discord-printer-bot.out.log` と `logs\discord-printer-bot.err.log` に出力されます。

## プリンタ状態通知

紙切れ、カバーオープン、オフラインなど印刷できない状態は Discord に通知します。レシート用紙残量少だけの場合はチャンネルに「問題があります」と投稿せず、印刷完了リアクションを `PRINT_NEAR_END_REACTION` に変えます。

## 注意

- Unicode 絵文字は Twemoji CDN から画像を取得して印刷します。インターネット接続が必要です。
- Discord のユーザーアイコン、スタンプ、添付画像も Discord CDN から取得します。
- 動画、音声、PDF など画像ではない添付ファイルは印刷されません。
- 日本語は Shift_JIS/CP932 と ESC/POS 漢字モードで送ります。プリンタ側の日本語フォント対応が必要です。

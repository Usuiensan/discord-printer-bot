# Discord Printer Bot 管理者ガイド

Epson TM-T70II 58mm 幅プリンタへ、Discord の指定チャンネル投稿を印刷する bot の管理者向け手順です。

サーバー参加者向けの使い方は [README.md](README.md) を参照してください。

## 構成

推奨構成は Proxmox 上の Debian 13 standard CT だけで bot と印刷を動かす構成です。

- Debian 13 standard CT: Discord bot 本体を常駐
- Epson TM-T70II: Debian CT に USB パススルー
- 印刷: `/dev/usb/lp0` などへ RAW ESC/POS を送信
- 状態監視: ESC/POS リアルタイムステータスで紙切れ、カバーオープン、ニアエンド等を検出

Windows VM + OPOS 印刷ブリッジ構成も代替として残せますが、通常は `PRINTER_BACKEND=linux-usb` を推奨します。

詳しい構築手順は [PROXMOX.md](PROXMOX.md) を参照してください。

単体 Windows PC 上で bot も印刷も実行する旧構成も引き続き利用できます。

## 単体 Windows 構成の前提

- Windows PC
- Node.js 20 以上
- Epson TM-T70II が USB 接続され、Windows の「プリンターとスキャナー」に登録済み
- Discord Developer Portal で作成した bot
- bot の `MESSAGE CONTENT INTENT` と `SERVER MEMBERS INTENT` が有効

## セットアップ

```powershell
npm install
Copy-Item .env.example .env
```

もし `npm install` で `Cannot find module ... npm-cli.js` が出る場合は、PC の npm インストールが壊れています。Node.js 公式インストーラで Node.js を修復インストールしてから、もう一度 `npm install` を実行してください。

プリンタ名は PowerShell で確認できます。

```powershell
Get-Printer | Select-Object Name
```

## .env 設定

`.env` を編集します。

- `DISCORD_TOKEN`: Discord bot token
- `DISCORD_CHANNEL_ID`: 印刷したいチャンネル ID
- `DISCORD_GUILD_ID`: 任意。設定するとスラッシュコマンドがそのサーバーへ即時登録されます
- `PRINTER_BACKEND`: `windows`、`bridge`、`linux-usb`。Debian CT 単体構成は `linux-usb`
- `PRINTER_NAME`: Windows のプリンタ名。`PRINTER_BACKEND=linux-usb` では不要
- `PRINT_BRIDGE_URL`: Debian bot から Windows 印刷ブリッジへ送る場合の URL。例: `http://192.168.1.50:8787`
- `PRINT_BRIDGE_TOKEN`: 印刷ブリッジの bearer token。Windows 側と同じ値にします
- `PRINT_BRIDGE_HOST`: Windows 印刷ブリッジの待受アドレス。通常 `0.0.0.0`
- `PRINT_BRIDGE_PORT`: Windows 印刷ブリッジの待受ポート。通常 `8787`
- `LINUX_PRINTER_DEVICE`: Debian CT で使う USB プリンタデバイス。通常 `/dev/usb/lp0`
- `LINUX_STATUS_ENABLED`: `linux-usb` で ESC/POS リアルタイムステータス監視を行うか
- `LINUX_STATUS_TIMEOUT_MS`: Linux USB ステータス応答待ち時間
- `PRINT_RETRY_ATTEMPTS`: 前ジョブ処理中など一時的なプリンタ状態での最大試行回数
- `PRINT_RETRY_DELAY_MS`: リトライ待機時間。試行ごとに少しずつ伸びます
- `PRINTER_MONITOR_ENABLED`: 起動中にプリンタ状態を定期監視し、問題を Discord に通知するか
- `PRINTER_MONITOR_INTERVAL_MS`: プリンタ状態の監視間隔
- `MEMBER_JOIN_PRINT_ENABLED`: 新しいメンバーがサーバーへ参加した時にレシートを印刷するか
- `OPOS_STATUS_ENABLED`: OPOS ADK for .NET でプリンタ状態を確認するか
- `OPOS_LOGICAL_NAME`: SetupPOS で登録した論理デバイス名
- `OPOS_CLAIM_TIMEOUT_MS`: OPOS Claim の待ち時間
- `PRINT_WIDTH_DOTS`: 印字幅。TM-T70II 58mm は通常 `384`
- `CUT_MODE`: `none`、`partial`、`partial3`、`full`。通常は `partial` 推奨
- `CUT_FEED_LINES`: `!cut`とReceiptLineの途中カット前後に送る行数。既定値は`3`
- `TEXT_IMAGE_FONT_PATH`: CP932外文字を画像化する等幅フォント。Debianでは`NotoSansCJK-Regular.ttc`内の`Noto Sans Mono CJK JP`を使用
- `TEXT_IMAGE_FONT_SIZE_DOTS` / `TEXT_IMAGE_LINE_HEIGHT_DOTS`: 文字画像の字面サイズと行高。既定値は`28` / `30`
- `TEXT_IMAGE_LINE_GAP_DOTS`: 画像化文字の行ごとに加える余白。既定値は`6`
- `TEXT_IMAGE_DITHER_MODE` / `TEXT_IMAGE_THRESHOLD`: 文字画像専用の2値化設定。既定値は`threshold` / `170`
- `PRINT_HEADER`: Discordヘッダーを印刷するか
- `MERGE_SAME_USER_WINDOW_MS`: 同じユーザーの連投でヘッダーを省略する時間
- `PRINT_AUTHOR_AVATAR`: 発言者アイコンを印刷するか
- `AUTHOR_AVATAR_WIDTH_DOTS`: 発言者アイコンの印刷幅
- `IMAGE_DITHER_MODE`: 画像変換方式。`ordered` は網点でグレーを表現、`threshold` は単純な白黒2値
- `IMAGE_MAX_BYTES`: 画像ダウンロード上限。画像は印刷幅まで縮小されます
- `TEXT_ATTACHMENT_MAX_BYTES`: テキスト添付ファイルのダウンロード上限
- `URL_QR_MODE`: `manual` なら通常URLは文字だけ、`auto` なら検出したURLもQR印刷します
- `PRINT_URL_QR`: 互換用。`URL_QR_MODE` 未設定時だけ参照されます
- `EMOJI_RENDER_MODE`: `inline_image`、`alias_append`、`text`。絵文字画像の印字方式
- `EMOJI_IMAGE_WIDTH_DOTS`: 絵文字画像の最大印刷幅
- `QR_MODULE_SIZE`: QR コードのドットサイズ
- `QR_ERROR_CORRECTION`: QR コードの誤り訂正レベル
- `BARCODE_HRI`: 1次元バーコードの人間可読テキスト位置。`none`、`above`、`below`、`both`
- `MESSAGE_COMMAND_PREFIX`: Discord本文コマンドの接頭辞
- `AI_CHAT_ENABLED`: `true`でBotへのメンションをローカルLLMチャットとして処理する
- `OLLAMA_URL` / `OLLAMA_MODEL`: Ollama native APIのURLと使用モデル
- `OLLAMA_THINK`: 対応モデルの詳細思考テキストを取得して回答へ添付するか
- `AI_FAST_TIMEOUT_MS` / `AI_THINK_TIMEOUT_MS`: 高速回答と長時間思考のタイムアウト。既定は300秒 / 1200秒
- `AI_THINK_PROGRESS_INTERVAL_MS`: 長時間思考のDiscord進捗更新間隔。既定は2500ms
- `AI_THINK_PROGRESS_MAX_CHARS`: 進捗に表示する直近の思考文字数。既定は800文字
- `AI_CHAT_HISTORY_MESSAGES`: チャンネルごとにメモリ保持する会話メッセージ数
- `AI_THINKING_REACTION` / `AI_ERROR_REACTION`: AI処理中・失敗時のリアクション
- `AI_SYSTEM_PROMPT_FILE`: 任意のUTF-8システムプロンプトファイル
- `RAW_ESCPOS_USER_IDS`: raw ESC/POS を許可するDiscordユーザーID。カンマ区切り
- `RAW_ESCPOS_ADMIN_USER_IDS`: 設定変更系を含むraw ESC/POSも許可するDiscordユーザーID。カンマ区切り
- `RAW_ESCPOS_MAX_BYTES`: raw ESC/POS の最大バイト数
- `PRINTED_REACTION`: 印刷完了後に bot が付けるリアクション絵文字
- `PRINT_NEAR_END_REACTION`: レシート用紙残量少の状態で印刷完了した時に付けるリアクション絵文字
- `PRINT_ERROR_REACTION`: 印刷失敗または一部スキップ時に bot が付けるリアクション絵文字

## Discord 側の設定

1. Discord Developer Portal で bot を作成します。
2. Bot 設定で `MESSAGE CONTENT INTENT` と `SERVER MEMBERS INTENT` を有効にします。
3. OAuth2 URL Generator で `bot` を選びます。
4. 権限は最低限 `View Channels`、`Read Message History`、`Send Messages`、`Add Reactions` を付けます。
5. bot をサーバーに招待します。
6. Discord の開発者モードを有効にして、印刷対象チャンネルを右クリックし「IDをコピー」します。

`Error: Used disallowed intents` が出る場合は、ほぼ `MESSAGE CONTENT INTENT` または `SERVER MEMBERS INTENT` が無効です。Discord Developer Portal の `Bot` ページで `Privileged Gateway Intents` の両方をオンにして保存し、`.env` の `DISCORD_TOKEN` が同じアプリの bot token か確認してください。

## 実行

```powershell
npm start
```

Windows VM で印刷ブリッジだけを起動する場合:

```powershell
npm run bridge
```

Debian CT で USB プリンタ状態を単体確認する場合:

```bash
npm run linux:status
```

構文確認:

```powershell
node --check src/index.js
node --check src/discordContent.js
node --check src/symbolContent.js
node --check src/printer.js
node --check src/escpos.js
```

`npm run check` が使える環境では、まとめて確認できます。

```powershell
npm run check
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

## プリンタ状態通知

紙切れ、カバーオープン、オフラインなど印刷できない状態は Discord に通知します。レシート用紙残量少だけの場合はチャンネルに「問題があります」と投稿せず、印刷完了リアクションを `PRINT_NEAR_END_REACTION` に変えます。

## 本文内 ESC/POS 制御コマンド詳細

通常利用者向けには [README.md](README.md) に主要コマンドだけを載せています。ここでは実装済みの詳細コマンドを列挙します。

印刷本文の行頭に制御コマンドを書くと、その行は印字せず、後続の印刷設定を変更します。短縮形または `!escpos` 付きで使えます。

```text
!center
中央揃えの文字
!right
右揃えの文字
!left
左揃えに戻す
```

対応コマンド:

- `!left` / `!center` / `!right`: 揃え位置
- `!align left|center|right`: 揃え位置
- `!row 左側 | 右側`: 同じ行に左寄せテキストと右寄せテキストを印字
- `!img 1`: 1番目の添付画像をその位置に印字
- `!img 1 50%`: 1番目の添付画像を紙幅の50%以内で印字
- `!img-notext 1 50%`: 画像ファイル名のラベルを印字せず、画像だけを印字
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

## ReceiptLine 記法

`!receiptline` または `!rl` で ReceiptLine 文書として本文を解釈します。`!preview` と組み合わせると同じ内容を PNG プレビューにします。
対応記法の詳細は [RECEIPTLINE.md](RECEIPTLINE.md) を参照してください。

実装済み:

- 列区切り `|`
- `{width:...}` / `{w:...}`
- `{border:space|none|line|2}` / `{b:...}`
- `{align:left|center|right}` / `{a:...}`
- `{text:wrap|nowrap}` / `{t:...}`
- 水平線 `---`
- カット `===`
- 下線 `_`、強調 `"`、白黒反転 `` ` ``、倍角 `^`
- `{code:...; option:...}` の QR/主要バーコード
- `{image:...}` の PNG base64 画像

未知のプロパティ、コメント、ReceiptLine の `{command:...}` は安全のため無視します。デバイス固有コマンドが必要な場合は、既存の raw ESC/POS 許可ユーザー機能を使ってください。

## raw ESC/POS 権限

raw ESC/POS は16進数のバイト列をそのままプリンタへ送ります。通常のDiscordヘッダー、通し番号、カットは追加しません。

未設定の場合、誰も使えません。

```env
RAW_ESCPOS_USER_IDS=111111111111111111,222222222222222222
RAW_ESCPOS_ADMIN_USER_IDS=111111111111111111
RAW_ESCPOS_MAX_BYTES=4096
```

`RAW_ESCPOS_USER_IDS` は通常のraw印刷を許可します。

`RAW_ESCPOS_ADMIN_USER_IDS` は、リアルタイムステータス要求、周辺機器設定、NVメモリー/ユーザー設定系など、プリンタ状態や設定に触れる可能性があるバイト列も許可します。

許可ユーザー向けの使い方:

```text
!raw-escpos 1B 40 48 65 6C 6C 6F 0A
```

コードブロックでも指定できます。

````text
!raw-escpos
```hex
1B 40
48 65 6C 6C 6F 0A
```
````

## Discord から実装しない命令

通常の本文コマンドとしては、電源オフ、バッファクリア、NVメモリー書き込み/消去、メモリースイッチ変更、通信条件変更、リアルタイムステータス要求など、プリンタ設定や永続メモリーに影響する命令は実装しません。

必要な場合は `RAW_ESCPOS_ADMIN_USER_IDS` で明示的に許可した管理者だけが raw ESC/POS として実行します。

## 注意

- Unicode 絵文字は Twemoji CDN から画像を取得して印刷します。`EMOJI_RENDER_MODE=inline_image` では出現位置ごとに印字し、`alias_append` では重複排除して末尾に印字します。
- Discord のユーザーアイコン、スタンプ、添付画像も Discord CDN から取得します。
- テキスト添付はUTF-8を優先し、読めない場合はShift_JIS系として読みます。サイズ上限は `TEXT_ATTACHMENT_MAX_BYTES` です。
- 動画、音声、PDF など画像ではない添付ファイルは印刷されません。
- 日本語は Shift_JIS/CP932 と ESC/POS 漢字モードで送ります。プリンタ側の日本語フォント対応が必要です。

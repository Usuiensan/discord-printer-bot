# Proxmox Debian CT 単体構成ガイド

Discord bot 本体と TM-T70II への印刷を Debian 13 standard CT 内で完結させる構成です。Windows VM と OPOS ブリッジは不要です。

## 全体構成

```text
Discord
  |
  v
Debian 13 standard CT
  - Node.js bot
  - ESC/POS データ生成
  - /dev/usb/lp0 へ RAW 書き込み
  - ESC/POS リアルタイムステータス監視
  |
  v
Epson TM-T70II
```

この bot は ESC/POS バイト列を自前で生成します。Linux CUPS ドライバに依存せず、CT に渡した USB プリンタデバイスへ RAW 送信します。

## Proxmox 側

1. Proxmox host で TM-T70II を確認します。

```bash
lsusb
ls -l /dev/usb/lp* /dev/bus/usb/*/* 2>/dev/null
```

2. CT に USB プリンタデバイスを渡します。Proxmox の UI で `Resources` > `Add` > `Device Passthrough` を使える場合は、`/dev/usb/lp0` または固定できる device path を指定します。

3. 手動で CT 設定を編集する場合の例です。CT ID が `101` の場合:

```text
dev0: /dev/usb/lp0,gid=7,mode=0660
```

`gid=7` は Debian の `lp` group を想定しています。環境により group id が違う場合は CT 内の `getent group lp` で確認してください。

4. CT を再起動し、CT 内でデバイスが見えることを確認します。

```bash
ls -l /dev/usb/lp0
```

## Debian 13 CT 側

### インストール

```bash
sudo apt update
sudo apt install -y ca-certificates curl git fonts-vlgothic fonts-noto-cjk
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
git clone <このリポジトリのURL> /opt/discord-printer-bot
cd /opt/discord-printer-bot
npm install
cp .env.example .env
```

bot を root 以外で動かす場合は、実行ユーザーを `lp` group に入れます。

```bash
sudo usermod -aG lp <botユーザー>
```

### Debian CT の `.env`

```env
DISCORD_TOKEN=Discord bot token
DISCORD_CHANNEL_IDS=印刷対象チャンネルID1,印刷対象チャンネルID2
PRINTER_MONITOR_CHANNEL_ID=状態通知先チャンネルID
DISCORD_GUILD_ID=必要ならサーバーID

PRINTER_BACKEND=linux-usb
LINUX_PRINTER_DEVICE=/dev/usb/lp0
LINUX_STATUS_ENABLED=true
LINUX_STATUS_TIMEOUT_MS=1000

PRINTER_MONITOR_ENABLED=true
PRINTER_MONITOR_INTERVAL_MS=10000

PRINT_WIDTH_DOTS=384
CUT_MODE=partial
CUT_FEED_LINES=3
PRINT_HEADER=true
PRINT_AUTHOR_AVATAR=true
PRINT_FONT_PATH=/usr/share/fonts/truetype/vlgothic/VL-Gothic-Regular.ttf
PRINT_FONT_FAMILY=VL Gothic
TEXT_RENDER_MODE=auto
TEXT_IMAGE_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
TEXT_IMAGE_FONT_FAMILY=Noto Sans Mono CJK JP
TEXT_IMAGE_FONT_SIZE_DOTS=28
TEXT_IMAGE_LINE_HEIGHT_DOTS=30
TEXT_IMAGE_LINE_GAP_DOTS=6
TEXT_IMAGE_DITHER_MODE=threshold
TEXT_IMAGE_THRESHOLD=170
```

`PRINTER_BACKEND=linux-usb` の場合、`PRINTER_NAME` は不要です。

### 更新と再デプロイ

更新、依存関係の反映、検査、テスト、サービス再起動をまとめて実行できます。

```bash
sudo /opt/discord-printer-bot/tools/update-debian.sh
```

リポジトリ、実行ユーザー、サービス名、ブランチを変更する場合は、それぞれ`DISCORD_PRINTER_REPO_DIR`、`DISCORD_PRINTER_BOT_USER`、`DISCORD_PRINTER_SERVICE`、`DISCORD_PRINTER_BRANCH`を指定します。

## 動作確認

状態確認:

```bash
npm run linux:status
```

期待例:

```json
{
  "device": "/dev/usb/lp0",
  "problems": []
}
```

構文確認:

```bash
npm run check
```

bot 起動:

```bash
npm start
```

Discord の対象チャンネルで以下を確認します。

```text
!preview test
```

通常メッセージ、画像添付、QR/バーコード、ReceiptLine、raw ESC/POS 許可ユーザー機能も同じ Linux backend で印刷されます。

## 状態監視

`linux-usb` backend は ESC/POS のリアルタイムステータス要求 `DLE EOT` を使って状態を読みます。検出対象:

- オフライン
- カバーオープン
- 用紙切れ
- レシート用紙残量少
- 紙詰まり
- サービス要求

レシート用紙残量少だけの場合は、従来どおり通常のエラー通知ではなく `PRINT_NEAR_END_REACTION` を使います。

ステータス取得がタイムアウトする場合:

```env
LINUX_STATUS_TIMEOUT_MS=2000
```

どうしても USB ステータス読み取りが安定しない場合のみ、印刷優先で以下を設定できます。ただし OPOS 相当の事前監視は無効になります。

```env
LINUX_STATUS_ENABLED=false
```

## systemd 常駐例

`/etc/systemd/system/discord-printer-bot.service`:

```ini
[Unit]
Description=Discord Printer Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/discord-printer-bot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
User=<botユーザー>
Group=<botユーザー>

[Install]
WantedBy=multi-user.target
```

有効化:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now discord-printer-bot
sudo journalctl -u discord-printer-bot -f
```

## トラブルシュート

- `/dev/usb/lp0` がない: Proxmox host 側で `usblp` がロードされているか、CT への device passthrough が設定されているか確認します。
- `EACCES`: CT 内の実行ユーザーが `/dev/usb/lp0` に書けません。`lp` group、device passthrough の `gid`/`mode`、systemd の `User` を確認します。
- `オフライン` が出る: プリンタ電源、USB パススルー、デバイスパス、カバー、用紙を確認します。
- `ESC/POS status response timed out`: USB デバイスが読み取りに対応していない、または CT への渡し方が片方向になっています。`LINUX_STATUS_TIMEOUT_MS` を伸ばし、それでも駄目なら Proxmox の device passthrough 設定を見直します。
- 印刷はできるが状態監視だけ失敗する: 一時回避として `LINUX_STATUS_ENABLED=false` にできます。OPOS 相当を維持する運用では、USB 双方向通信ができる構成に直してください。

## JavaPOS を検証する場合

通常運用はこのリポジトリの `linux-usb` backend だけで完結します。Epson JavaPOS ADK for Linux を検証したい場合は、Epson 公式配布物を取得し、CT 内に Java と JavaPOS ADK を導入して POSPrinter の CheckHealth が動くか確認します。

確認ポイント:

- JavaPOS ADK が Debian 13 CT で起動すること
- SetupPOS 相当の登録で TM-T70II の USB デバイスを認識すること
- CheckHealth または POSPrinter status でカバーオープン、紙切れ、ニアエンドが取れること

JavaPOS が安定して使える場合でも、bot 側の印刷データは引き続き ESC/POS で生成します。JavaPOS は状態監視の代替候補として扱います。

## Windows VM ブリッジを残す代替構成

Windows VM で OPOS ADK for .NET を使う既存構成も残せます。その場合:

Debian 側:

```env
PRINTER_BACKEND=bridge
PRINTER_NAME=EPSON TM-T70II Receipt
PRINT_BRIDGE_URL=http://192.168.1.50:8787
PRINT_BRIDGE_TOKEN=長いランダム文字列
```

Windows 側:

```powershell
npm run bridge
```

通常は Debian CT 単体の `PRINTER_BACKEND=linux-usb` を推奨します。Windows 固有の OPOS 検証が必要な場合だけ bridge 構成を使います。

## 運用メモ

- CUPS ドライバは主経路にしません。RAW ESC/POS、カット、ドロワー、ブザー、ページモード、ステータス監視の同等性を保つためです。
- CT 再起動後も同じ device path が維持されるよう、Proxmox 側でパススルー対象を固定してください。
- force-push が必要になった場合は、本当に必要か再考してから実行してください。

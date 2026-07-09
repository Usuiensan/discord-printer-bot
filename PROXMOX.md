# Proxmox 分離構成ガイド

Discord bot 本体を Debian 13 standard に置き、Windows VM は OPOS と印刷ブリッジだけを担当する構成です。

## 全体構成

```text
Discord
  |
  v
Debian 13 standard
  - Node.js bot
  - ESC/POS データ生成
  - Windows 印刷ブリッジへ HTTP 送信
  |
  v
Windows VM
  - Epson プリンタドライバ
  - OPOS ADK for .NET
  - npm run bridge
  |
  v
Epson TM-T70II
```

Windows VM は Discord token を持つ必要がありません。プリンタと OPOS に触る最小役割にします。

## Proxmox 側

1. Windows VM に TM-T70II の USB デバイスをパススルーします。
2. Windows VM と Debian 13 standard が同じ LAN または到達可能な VLAN にいることを確認します。
3. Windows VM の IP アドレスを固定します。例: `192.168.1.50`
4. Proxmox firewall を使う場合は、Debian から Windows VM の `8787/tcp` への通信を許可します。

## Windows VM 側

Windows VM は OPOS only + 印刷ブリッジとして使います。

### インストール

1. Epson Advanced Printer Driver をインストールします。
2. Windows の「プリンターとスキャナー」に TM-T70II が登録されていることを確認します。
3. EPSON OPOS ADK for .NET をインストールします。
4. SetupPOS で TM-T70II を登録し、論理デバイス名を決めます。例: `TM-T70II`
5. Node.js 20 以上をインストールします。
6. このリポジトリを配置して `npm install` を実行します。

プリンタ名確認:

```powershell
Get-Printer | Select-Object Name
```

OPOS 状態確認:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\opos-status.ps1 -LogicalName "TM-T70II"
```

### Windows VM の `.env`

Windows 側は Discord 設定を使いませんが、既存の config 読み込みと共通にするため `.env` には最低限の値を入れておきます。Discord token はダミーで構いません。

```env
DISCORD_TOKEN=unused-on-windows-bridge
DISCORD_CHANNEL_ID=unused-on-windows-bridge
PRINTER_NAME=EPSON TM-T70II Receipt

PRINT_BRIDGE_HOST=0.0.0.0
PRINT_BRIDGE_PORT=8787
PRINT_BRIDGE_TOKEN=長いランダム文字列

PRINT_RETRY_ATTEMPTS=8
PRINT_RETRY_DELAY_MS=5000
OPOS_STATUS_ENABLED=true
OPOS_LOGICAL_NAME=TM-T70II
OPOS_CLAIM_TIMEOUT_MS=1000
```

`PRINT_BRIDGE_TOKEN` は Debian 側と同じ値にします。LAN 内だけでも、空欄運用は避けてください。

### ブリッジ起動

```powershell
npm run bridge
```

疎通確認:

```powershell
Invoke-RestMethod -Headers @{ Authorization = "Bearer 長いランダム文字列" } http://127.0.0.1:8787/health
```

Windows Defender Firewall で `8787/tcp` を Debian 13 standard の IP から許可します。

## Debian 13 standard 側

Debian 側は Discord bot 本体だけを常駐させます。プリンタドライバ、OPOS、PowerShell は不要です。

### インストール

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
git clone <このリポジトリのURL> discord-printer-bot
cd discord-printer-bot
npm install
cp .env.example .env
```

### Debian 側の `.env`

```env
DISCORD_TOKEN=Discord bot token
DISCORD_CHANNEL_ID=印刷対象チャンネルID
DISCORD_GUILD_ID=必要ならサーバーID

PRINTER_NAME=EPSON TM-T70II Receipt
PRINT_BRIDGE_URL=http://192.168.1.50:8787
PRINT_BRIDGE_TOKEN=長いランダム文字列

PRINTER_MONITOR_ENABLED=true
PRINTER_MONITOR_INTERVAL_MS=10000
OPOS_STATUS_ENABLED=true
OPOS_LOGICAL_NAME=TM-T70II
OPOS_CLAIM_TIMEOUT_MS=1000

PRINT_WIDTH_DOTS=384
CUT_MODE=partial
PRINT_HEADER=true
PRINT_AUTHOR_AVATAR=true
```

`PRINTER_NAME` と `OPOS_LOGICAL_NAME` は Windows VM 側の値に合わせます。Debian 側で直接プリンタを認識させる必要はありません。

### 起動

```bash
npm start
```

構文確認:

```bash
npm run check
```

## systemd 常駐例

Debian 側:

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

[Install]
WantedBy=multi-user.target
```

Windows 側はタスクスケジューラでログオン時または起動時に以下を実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "cd C:\private\discord-printer-bot; npm run bridge"
```

## 動作確認

1. Windows VM で `npm run bridge` を起動します。
2. Debian からブリッジへ疎通確認します。

```bash
curl -H "Authorization: Bearer 長いランダム文字列" http://192.168.1.50:8787/health
```

3. Debian で `npm start` を起動します。
4. Discord の対象チャンネルに `!preview test` を投稿して preview が返ることを確認します。
5. 通常メッセージを投稿して TM-T70II から印刷されることを確認します。

## トラブルシュート

- `Unauthorized`: `PRINT_BRIDGE_TOKEN` が Debian 側と Windows 側で一致していません。
- `fetch failed` / `ECONNREFUSED`: Windows ブリッジが起動していない、IP/port が違う、または firewall で遮断されています。
- `PRINTER_NAME is required`: Windows 側 `.env` の `PRINTER_NAME` が空です。
- `OPOS printer status check failed`: SetupPOS の論理デバイス名、OPOS ADK for .NET、USB パススルーを確認してください。
- 印刷はできるが状態通知が弱い: `OPOS_STATUS_ENABLED=true` と `OPOS_LOGICAL_NAME` を Windows 側・Debian 側で合わせてください。

## 運用メモ

- Windows VM は OPOS/印刷専用にし、Discord token を置かない運用を推奨します。
- `PRINT_BRIDGE_TOKEN` は長いランダム値にし、リポジトリへコミットしないでください。
- Windows VM の IP を変える場合は Debian 側の `PRINT_BRIDGE_URL` も更新します。
- force-push が必要になった場合は、本当に必要か再考してから実行してください。

#!/bin/sh
set -eu

REPO_DIR=${DISCORD_PRINTER_REPO_DIR:-/opt/discord-printer-bot}
BOT_USER=${DISCORD_PRINTER_BOT_USER:-printerbot}
SERVICE_NAME=${DISCORD_PRINTER_SERVICE:-discord-printer-bot}
BRANCH=${DISCORD_PRINTER_BRANCH:-main}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root: sudo $0" >&2
  exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Git repository not found: $REPO_DIR" >&2
  exit 1
fi

echo "[1/6] Fetch and fast-forward $BRANCH"
runuser -u "$BOT_USER" -- git -C "$REPO_DIR" fetch origin "$BRANCH"
runuser -u "$BOT_USER" -- git -C "$REPO_DIR" switch "$BRANCH"
runuser -u "$BOT_USER" -- git -C "$REPO_DIR" merge --ff-only "origin/$BRANCH"

echo "[2/6] Install Node.js dependencies"
runuser -u "$BOT_USER" -- npm --prefix "$REPO_DIR" install

echo "[3/6] Static checks"
runuser -u "$BOT_USER" -- npm --prefix "$REPO_DIR" run check

echo "[4/6] Tests"
runuser -u "$BOT_USER" -- npm --prefix "$REPO_DIR" test

echo "[5/6] Restart $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[6/6] Verify service"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager -o cat

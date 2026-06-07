import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_PRINT_SCRIPT = join(__dirname, '..', 'tools', 'rawprint.ps1');
const PRINTER_STATUS_SCRIPT = join(__dirname, '..', 'tools', 'printer-status.ps1');

export async function sendRawToPrinter(bytes, printerName) {
  await assertPrinterReady(printerName);

  const dir = join(os.tmpdir(), 'discord-printer-bot');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${randomUUID()}.bin`);
  await writeFile(filePath, bytes);

  try {
    await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      RAW_PRINT_SCRIPT,
      '-PrinterName',
      printerName,
      '-Path',
      filePath,
      '-DocumentName',
      'Discord message'
    ]);
  } finally {
    await rm(filePath, { force: true });
  }
}

export async function assertPrinterReady(printerName) {
  let status;
  try {
    status = await getPrinterStatus(printerName);
  } catch (error) {
    console.warn(`Printer status check skipped: ${error.message}`);
    return;
  }

  const problems = describePrinterProblems(status);
  if (problems.length > 0) {
    throw new Error(`プリンタエラー: ${problems.join(' / ')}`);
  }
}

async function getPrinterStatus(printerName) {
  const stdout = await runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PRINTER_STATUS_SCRIPT,
    '-PrinterName',
    printerName
  ]);

  return JSON.parse(stdout);
}

function describePrinterProblems(status) {
  const problems = [];
  const printerStatus = String(status.PrinterStatus ?? '');
  const detectedErrorState = Number(status.DetectedErrorState ?? 0);
  const extendedPrinterStatus = Number(status.ExtendedPrinterStatus ?? 0);
  const printerState = Number(status.PrinterState ?? 0);

  if (status.WorkOffline) problems.push('オフライン');
  if (status.Paused) problems.push('一時停止中');

  if (printerStatus && !['Normal', 'Idle', 'Printing', 'Processing', 'WarmingUp'].includes(printerStatus)) {
    problems.push(`状態=${printerStatus}`);
  }

  const detectedErrorMap = {
    3: '用紙不足',
    4: '用紙切れ',
    5: 'トナー不足',
    6: 'トナー切れ',
    7: 'ドア/カバーオープン',
    8: '紙詰まり',
    9: 'オフライン',
    10: 'サービス要求',
    11: '排紙トレイ満杯'
  };
  if (detectedErrorMap[detectedErrorState]) {
    problems.push(detectedErrorMap[detectedErrorState]);
  }

  const extendedStatusMap = {
    7: 'オフライン',
    8: '一時停止中',
    9: 'エラー',
    11: '使用不可',
    16: 'I/O待ち',
    18: '手動給紙待ち'
  };
  if (extendedStatusMap[extendedPrinterStatus]) {
    problems.push(extendedStatusMap[extendedPrinterStatus]);
  }

  const stateFlags = [
    [0x00000002, 'エラー'],
    [0x00000008, '紙詰まり'],
    [0x00000010, '用紙切れ'],
    [0x00000020, '手動給紙待ち'],
    [0x00000080, 'オフライン'],
    [0x00000400, '印刷中止中'],
    [0x00000800, '排紙トレイ満杯'],
    [0x00400000, 'ドア/カバーオープン'],
    [0x01000000, '用紙不足']
  ];
  for (const [flag, label] of stateFlags) {
    if ((printerState & flag) !== 0) problems.push(label);
  }

  return Array.from(new Set(problems));
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`PowerShell exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

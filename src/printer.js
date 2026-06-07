import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_PRINT_SCRIPT = join(__dirname, '..', 'tools', 'rawprint.ps1');
const PRINTER_STATUS_SCRIPT = join(__dirname, '..', 'tools', 'printer-status.ps1');
const OPOS_STATUS_SCRIPT = join(__dirname, '..', 'tools', 'opos-status.ps1');
const RETRYABLE_PRINTER_PROBLEMS = new Set([
  '印刷中止中',
  '印刷ジョブ処理中',
  'I/O待ち',
  '使用不可'
]);
const HARD_PRINTER_PROBLEMS = new Set([
  'オフライン',
  '一時停止中',
  '用紙不足',
  '用紙切れ',
  'トナー不足',
  'トナー切れ',
  'ドア/カバーオープン',
  '紙詰まり',
  'サービス要求',
  '排紙トレイ満杯',
  '手動給紙待ち'
]);

export async function sendRawToPrinter(bytes, printerName, options = {}) {
  const dir = join(os.tmpdir(), 'discord-printer-bot');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${randomUUID()}.bin`);
  await writeFile(filePath, bytes);

  try {
    await retryPrintOperation(async () => {
      await assertPrinterReady(printerName, options);
      await runPowerShell([
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
    }, options);
  } finally {
    await rm(filePath, { force: true });
  }
}

export async function assertPrinterReady(printerName, options = {}) {
  if (options.oposStatusEnabled && options.oposLogicalName) {
    try {
      const oposStatus = await getOposStatus(options.oposLogicalName, options.oposClaimTimeoutMs);
      const oposProblems = describeOposProblems(oposStatus);
      if (oposProblems.length > 0) {
        throw new Error(`プリンタエラー(OPOS): ${oposProblems.join(' / ')}`);
      }
      return;
    } catch (error) {
      console.warn(`OPOS printer status check failed: ${error.message}`);
    }
  }

  let status;
  try {
    status = await getPrinterStatus(printerName);
  } catch (error) {
    console.warn(`Printer status check skipped: ${error.message}`);
    return;
  }

  const problems = describePrinterProblems(status);
  if (problems.length > 0) {
    throw printerStatusError('プリンタエラー', problems);
  }
}

async function retryPrintOperation(operation, options) {
  const attempts = Math.max(1, Number.parseInt(options.printRetryAttempts ?? 8, 10) || 8);
  const delayMs = Math.max(100, Number.parseInt(options.printRetryDelayMs ?? 1500, 10) || 1500);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryablePrintError(error) || attempt >= attempts) {
        throw error;
      }

      const waitMs = delayMs * attempt;
      console.warn(`Printer busy or not ready; retrying ${attempt}/${attempts - 1} in ${waitMs}ms: ${error.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function printerStatusError(prefix, problems) {
  const error = new Error(`${prefix}: ${problems.join(' / ')}`);
  error.printerProblems = problems;
  error.retryable = problems.some((problem) => RETRYABLE_PRINTER_PROBLEMS.has(problem))
    && !problems.some((problem) => HARD_PRINTER_PROBLEMS.has(problem));
  return error;
}

function isRetryablePrintError(error) {
  if (error?.retryable) return true;
  const message = String(error?.message ?? error);
  return [
    '印刷中止中',
    '印刷ジョブ処理中',
    'I/O待ち',
    '使用不可',
    'The printer is busy',
    'プリンターはビジー',
    '別のプロセス'
  ].some((pattern) => message.includes(pattern));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getOposStatus(logicalName, claimTimeoutMs = 1000) {
  const stdout = await runWindowsPowerShell([
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    OPOS_STATUS_SCRIPT,
    '-LogicalName',
    logicalName,
    '-ClaimTimeoutMs',
    String(claimTimeoutMs)
  ]);

  return JSON.parse(stdout);
}

function describeOposProblems(status) {
  const problems = [];

  if (status.CoverOpen === true) problems.push('カバーオープン');
  if (status.RecEmpty === true) problems.push('レシート用紙切れ');
  if (status.RecNearEnd === true) problems.push('レシート用紙残量少');

  const state = String(status.State ?? '');
  if (state && !['Idle', 'OK', 'Normal'].includes(state)) {
    problems.push(`状態=${state}`);
  }

  const health = String(status.CheckHealthText ?? '');
  if (/cover\s*open|カバー.*(開|オープン)/i.test(health)) problems.push('カバーオープン');
  if (/paper\s*(empty|end)|用紙.*(切|なし|ありません)/i.test(health)) problems.push('用紙切れ');
  if (/offline|オフライン/i.test(health)) problems.push('オフライン');

  return Array.from(new Set(problems));
}

async function getPrinterStatus(printerName) {
  const stdout = await runPowerShell([
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

  const okPrinterStatuses = new Set(['Normal', 'Idle', 'Printing', 'Processing', 'WarmingUp', '3', '4', '5']);
  if (printerStatus && !okPrinterStatuses.has(printerStatus)) {
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
  const candidates = process.env.POWERSHELL_EXE?.trim()
    ? [process.env.POWERSHELL_EXE.trim()]
    : ['pwsh.exe', 'powershell.exe'];

  return runPowerShellCandidate(candidates, args);
}

function runWindowsPowerShell(args) {
  return runPowerShellCandidate(['powershell.exe'], args);
}

function runPowerShellCandidate(candidates, args) {
  return new Promise((resolve, reject) => {
    const executable = candidates[0];
    const child = spawn(executable, wrapPowerShellArgs(args), {
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
    child.on('error', (error) => {
      if (error.code === 'ENOENT' && candidates.length > 1) {
        runPowerShellCandidate(candidates.slice(1), args).then(resolve, reject);
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${executable} exited with ${code}: ${cleanPowerShellError(stderr || stdout)}`));
      }
    });
  });
}

function wrapPowerShellArgs(args) {
  const commandArgs = stripPowerShellHostArgs(args);
  const command = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()',
    'if ([Console].GetProperty("ErrorEncoding")) { [Console]::ErrorEncoding=[System.Text.UTF8Encoding]::new() }',
    '$OutputEncoding=[System.Text.UTF8Encoding]::new()',
    `& ${commandArgs.map(quotePowerShellArg).join(' ')}`
  ].join('; ');

  return [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ];
}

function stripPowerShellHostArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-ExecutionPolicy') {
      index += 1;
      continue;
    }
    if (arg === '-File') {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

function quotePowerShellArg(value) {
  if (/^-[A-Za-z][A-Za-z0-9]*$/.test(String(value))) {
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cleanPowerShellError(value) {
  const cleaned = String(value)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();

  if (cleaned.includes('#< CLIXML')) {
    return cleanPowerShellCliXml(cleaned);
  }

  return cleaned;
}

function cleanPowerShellCliXml(value) {
  const entries = [];
  const textNodePattern = /<(S|AV)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;

  for (const match of value.matchAll(textNodePattern)) {
    const text = decodePowerShellXmlText(match[2])
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\r/g, '')
      .trim();
    if (text) entries.push(text);
  }

  const usefulEntries = entries.filter((entry) => (
    !entry.includes('モジュールを初めて使用するための準備') &&
    !entry.startsWith('発生場所 ') &&
    !entry.startsWith('At ') &&
    !entry.startsWith('+ ') &&
    !/^~+$/.test(entry) &&
    !entry.includes('CategoryInfo') &&
    !entry.includes('FullyQualifiedErrorId')
  ));

  const uniqueEntries = [];
  for (const entry of usefulEntries.length > 0 ? usefulEntries : entries) {
    if (uniqueEntries.includes(entry)) continue;
    if (uniqueEntries.some((existing) => existing.endsWith(entry))) continue;
    uniqueEntries.push(entry);
  }

  return uniqueEntries.slice(0, 6).join('\n') || value;
}

function decodePowerShellXmlText(value) {
  return value
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000D_/g, '\r')
    .replace(/_x000A_/g, '\n')
    .replace(/_x001B_/g, '\x1b')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { sendRawToPrinter } from '../src/printer.js';

const [, , filePath, devicePath] = process.argv;
if (!filePath) {
  console.error('Usage: node tools/linux-rawprint.js <escpos.bin> [/dev/usb/lp0]');
  process.exit(2);
}

const bytes = await readFile(filePath);
await sendRawToPrinter(bytes, '', {
  printerBackend: 'linux-usb',
  linuxPrinterDevice: devicePath || process.env.LINUX_PRINTER_DEVICE || '/dev/usb/lp0',
  linuxStatusEnabled: process.env.LINUX_STATUS_ENABLED !== 'false',
  linuxStatusTimeoutMs: Number.parseInt(process.env.LINUX_STATUS_TIMEOUT_MS ?? '1000', 10) || 1000,
  printRetryAttempts: Number.parseInt(process.env.PRINT_RETRY_ATTEMPTS ?? '8', 10) || 8,
  printRetryDelayMs: Number.parseInt(process.env.PRINT_RETRY_DELAY_MS ?? '1500', 10) || 1500
});

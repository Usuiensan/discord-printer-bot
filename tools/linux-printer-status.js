import 'dotenv/config';
import { checkPrinterProblems } from '../src/printer.js';

const options = {
  printerBackend: 'linux-usb',
  linuxPrinterDevice: process.env.LINUX_PRINTER_DEVICE || process.argv[2] || '/dev/usb/lp0',
  linuxStatusEnabled: true,
  linuxStatusTimeoutMs: Number.parseInt(process.env.LINUX_STATUS_TIMEOUT_MS ?? '1000', 10) || 1000
};

const problems = await checkPrinterProblems('', options);
console.log(JSON.stringify({
  device: options.linuxPrinterDevice,
  problems
}, null, 2));

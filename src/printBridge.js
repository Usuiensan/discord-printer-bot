import http from 'node:http';
import 'dotenv/config';
import { checkLocalPrinterProblems, sendRawToLocalPrinter } from './printer.js';

const host = process.env.PRINT_BRIDGE_HOST?.trim() || '0.0.0.0';
const port = positiveInt(process.env.PRINT_BRIDGE_PORT, 8787);
const token = process.env.PRINT_BRIDGE_TOKEN?.trim() || '';
const defaultPrinterName = process.env.PRINTER_NAME?.trim() || '';

const server = http.createServer(async (request, response) => {
  try {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const printerName = url.searchParams.get('printerName') || defaultPrinterName;
      requirePrinterName(printerName);
      const problems = await checkLocalPrinterProblems(printerName, localOptions());
      sendJson(response, 200, { problems });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/print') {
      const body = await readJson(request);
      const printerName = body.printerName || defaultPrinterName;
      requirePrinterName(printerName);
      const bytes = Buffer.from(String(body.data || ''), 'base64');
      if (bytes.length === 0) throw new Error('印刷データが空です');

      await sendRawToLocalPrinter(bytes, printerName, {
        ...localOptions(),
        ...remoteSafeOptions(body.options)
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error.message,
      printerProblems: error.printerProblems,
      retryable: error.retryable
    });
  }
});

server.listen(port, host, () => {
  console.log(`Print bridge listening on http://${host}:${port}`);
});

function isAuthorized(request) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function localOptions() {
  return {
    printRetryAttempts: positiveInt(process.env.PRINT_RETRY_ATTEMPTS, 8),
    printRetryDelayMs: positiveInt(process.env.PRINT_RETRY_DELAY_MS, 1500),
    oposStatusEnabled: boolEnv(process.env.OPOS_STATUS_ENABLED, false),
    oposLogicalName: process.env.OPOS_LOGICAL_NAME?.trim() || '',
    oposClaimTimeoutMs: positiveInt(process.env.OPOS_CLAIM_TIMEOUT_MS, 1000)
  };
}

function remoteSafeOptions(value) {
  if (!value || typeof value !== 'object') return {};
  const options = {};
  if (value.printRetryAttempts != null) options.printRetryAttempts = positiveInt(value.printRetryAttempts, localOptions().printRetryAttempts);
  if (value.printRetryDelayMs != null) options.printRetryDelayMs = positiveInt(value.printRetryDelayMs, localOptions().printRetryDelayMs);
  if (value.oposStatusEnabled != null) options.oposStatusEnabled = Boolean(value.oposStatusEnabled);
  if (value.oposLogicalName != null) options.oposLogicalName = String(value.oposLogicalName).trim();
  if (value.oposClaimTimeoutMs != null) options.oposClaimTimeoutMs = positiveInt(value.oposClaimTimeoutMs, localOptions().oposClaimTimeoutMs);
  return options;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function requirePrinterName(printerName) {
  if (!printerName) throw new Error('PRINTER_NAME is required');
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        request.destroy(new Error('Request body is too large'));
      }
    });
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

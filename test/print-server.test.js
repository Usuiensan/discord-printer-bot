import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createPrintServer } from '../src/printServer.js';
import { sendRawToPrinter } from '../src/printer.js';

test('GET /health returns 200 without printing', async (t) => {
  let printCalls = 0;
  const server = createPrintServer({ print: async () => { printCalls += 1; } });
  const address = await listen(server, t);
  if (!address) return;
  t.after(() => server.close());

  const response = await request(address.port, { method: 'GET', path: '/health' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(printCalls, 0);
});

test('POST /print decodes and passes the exact bytes', async (t) => {
  const printed = [];
  const server = createPrintServer({ print: async (bytes) => printed.push(bytes) });
  const address = await listen(server, t);
  if (!address) return;
  t.after(() => server.close());
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0x0a]);

  const response = await request(address.port, {
    method: 'POST',
    path: '/print',
    body: { data: bytes.toString('base64') }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, bytes: bytes.length });
  assert.equal(printed.length, 1);
  assert.deepEqual(printed[0], bytes);
});

test('token authentication rejects missing and incorrect tokens', async (t) => {
  const server = createPrintServer({ token: 'secret', print: async () => {} });
  const address = await listen(server, t);
  if (!address) return;
  t.after(() => server.close());
  const body = { data: Buffer.from('print').toString('base64') };

  assert.equal((await request(address.port, { method: 'POST', path: '/print', body })).status, 401);
  assert.equal((await request(address.port, {
    method: 'POST',
    path: '/print',
    body,
    headers: { authorization: 'Bearer wrong' }
  })).status, 401);
  assert.equal((await request(address.port, {
    method: 'POST',
    path: '/print',
    body,
    headers: { authorization: 'Bearer secret' }
  })).status, 200);
});

test('missing and empty data return 400 without printing', async (t) => {
  let printCalls = 0;
  const server = createPrintServer({ print: async () => { printCalls += 1; } });
  const address = await listen(server, t);
  if (!address) return;
  t.after(() => server.close());

  assert.equal((await request(address.port, { method: 'POST', path: '/print', body: {} })).status, 400);
  assert.equal((await request(address.port, { method: 'POST', path: '/print', body: { data: '' } })).status, 400);
  assert.equal(printCalls, 0);
});

test('sendRawToPrinter serializes bridge requests in call order', async (t) => {
  let active = 0;
  let maximumActive = 0;
  const received = [];
  const bridge = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname !== '/print') {
      response.writeHead(404).end();
      return;
    }
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push(Buffer.from(body.data, 'base64').toString('utf8'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  const address = await listen(bridge, t);
  if (!address) return;
  t.after(() => bridge.close());

  await Promise.all([
    sendRawToPrinter(Buffer.from('first'), '', {
      printerBackend: 'bridge',
      printBridgeUrl: `http://127.0.0.1:${address.port}`
    }),
    sendRawToPrinter(Buffer.from('second'), '', {
      printerBackend: 'bridge',
      printBridgeUrl: `http://127.0.0.1:${address.port}`
    })
  ]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(received, ['first', 'second']);
});

function listen(server, t) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  }).catch((error) => {
    if (error.code === 'EPERM') {
      t.skip('この実行環境ではローカルHTTPサーバを起動できません');
      return null;
    }
    throw error;
  });
}

function request(port, { method, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body));
    else request.end();
  });
}

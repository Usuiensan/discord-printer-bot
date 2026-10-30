import http from 'node:http';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function createPrintServer({ print = async () => {}, token = '', maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const bodyLimit = Math.max(1024, maxBytes * 2);
  return http.createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/print') {
        const body = await readJson(request, bodyLimit);
        if (typeof body.data !== 'string' || body.data.length === 0) {
          throw clientError('印刷データがありません');
        }
        if (!isBase64(body.data)) {
          throw clientError('印刷データが正しいbase64ではありません');
        }

        const bytes = Buffer.from(body.data, 'base64');
        if (bytes.length === 0) throw clientError('印刷データが空です');
        if (bytes.length > maxBytes) throw clientError(`印刷データが大きすぎます（最大${maxBytes}バイト）`);

        await print(bytes);
        sendJson(response, 200, { ok: true, bytes: bytes.length });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status === 400) {
        sendJson(response, status, { error: error.message });
        return;
      }

      const body = { error: error.message };
      if (Object.hasOwn(error, 'printerProblems')) body.printerProblems = error.printerProblems;
      if (Object.hasOwn(error, 'retryable')) body.retryable = error.retryable;
      sendJson(response, status, body);
    }
  });
}

export async function startPrintServer({ host = '127.0.0.1', port = 8787, token = '', print } = {}) {
  const server = createPrintServer({ print, token });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`Print server listening on http://${host}:${port}`);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  return server;
}

function isAuthorized(request, token) {
  return !token || request.headers.authorization === `Bearer ${token}`;
}

function isBase64(value) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return false;
  const padding = value.match(/=*$/)[0].length;
  return padding === 0 || value.length % 4 === 0;
}

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !rejected) {
        rejected = true;
        request.resume();
        reject(clientError('リクエストボディが大きすぎます'));
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(clientError('JSONが不正です'));
      }
    });
    request.on('error', reject);
  });
}

function clientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

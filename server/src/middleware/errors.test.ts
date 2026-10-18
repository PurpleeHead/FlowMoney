import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { errorHandler } from './errors.js';

async function withErrorApi(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(new Error('database password=secret internal details')));
  app.get('/cors-denied', (_req, _res, next) => next(new Error('Origin not allowed by CORS')));
  app.get('/too-large', (_req, _res, next) => next({ status: 413, message: 'raw parser error' }));
  app.get('/malformed', (_req, _res, next) => next({ status: 400, message: 'raw parser error' }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('API error handler security', () => {
  it('does not expose internal error details in JSON responses', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      await withErrorApi(async baseUrl => {
        const response = await fetch(`${baseUrl}/boom`);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(response.status, 500);
        assert.deepEqual(body, { message: 'An unexpected server error occurred.' });
        assert.equal(JSON.stringify(body).includes('secret'), false);
      });
    } finally {
      console.error = originalError;
    }
  });
  it('returns 403 for rejected CORS origins without exposing internal error text', async () => {
    await withErrorApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/cors-denied`);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { message: 'Request origin is not allowed.' });
    });
  });

  it('preserves safe body-parser statuses and uses generic messages', async () => {
    await withErrorApi(async baseUrl => {
      const tooLarge = await fetch(`${baseUrl}/too-large`);
      assert.equal(tooLarge.status, 413);
      assert.deepEqual(await tooLarge.json(), { message: 'Request body is too large.' });

      const malformed = await fetch(`${baseUrl}/malformed`);
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { message: 'Request body is invalid.' });
    });
  });

});

'use strict';

/**
 * Unit/integration tests using only node:test and node:http (no supertest).
 * The app is bound to an ephemeral port on 127.0.0.1 for each test file run.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('./app');

let server;
let baseUrl;
let app;

function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, baseUrl), { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /healthz returns 200 ok', async () => {
  const res = await request('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});

test('GET /readyz returns 200 when ready', async () => {
  app.locals.state.ready = true;
  app.locals.state.shuttingDown = false;
  const res = await request('/readyz');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ready' });
});

test('GET /readyz returns 503 while draining', async () => {
  app.locals.state.shuttingDown = true;
  const res = await request('/readyz');
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { status: 'draining' });
  app.locals.state.shuttingDown = false;
});

test('GET /api/v1/hello returns default greeting and metadata', async () => {
  const res = await request('/api/v1/hello');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.message, 'hello, world');
  assert.ok(body.service);
  assert.ok(body.version);
  assert.ok(body.commit);
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
});

test('GET /api/v1/hello honours the name query parameter', async () => {
  const res = await request('/api/v1/hello?name=gke');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).message, 'hello, gke');
});

test('GET /api/v1/hello rejects over-long names by falling back to default', async () => {
  const res = await request(`/api/v1/hello?name=${'a'.repeat(100)}`);
  assert.equal(JSON.parse(res.body).message, 'hello, world');
});

test('GET /metrics exposes Prometheus text format with request counters', async () => {
  await request('/api/v1/hello');
  const res = await request('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /^# TYPE http_requests_total counter/m);
  assert.match(res.body, /http_requests_total\{[^}]*route="\/api\/v1\/hello"[^}]*status_code="200"/);
  assert.match(res.body, /^# TYPE http_request_duration_seconds histogram/m);
  assert.match(res.body, /process_cpu_seconds_total/);
});

test('unknown route returns JSON 404', async () => {
  const res = await request('/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error, 'not_found');
});

test('security headers are set and x-powered-by is removed', async () => {
  const res = await request('/healthz');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-powered-by'], undefined);
});

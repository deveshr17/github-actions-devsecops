'use strict';

/**
 * Express application factory.
 *
 * Kept separate from server.js so tests can build the app without binding a
 * port or installing signal handlers.
 */
const express = require('express');
const client = require('prom-client');

const SERVICE_NAME = process.env.SERVICE_NAME || 'devsecops-sample-service';
const SERVICE_VERSION = process.env.SERVICE_VERSION || '0.0.0-dev';
const GIT_SHA = process.env.GIT_SHA || 'unknown';

function createApp(options = {}) {
  const registry = options.registry || new client.Registry();
  registry.setDefaultLabels({ service: SERVICE_NAME });
  client.collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled, by method, route and status code.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Readiness state is mutable so the server can flip it during shutdown and
  // let the Kubernetes endpoint controller drain traffic before exit.
  const state = { ready: true, shuttingDown: false };
  app.locals.state = state;

  app.use(express.json({ limit: '64kb' }));

  // Baseline security headers without pulling in an extra dependency.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Request metrics. Route label uses the matched route path to avoid
  // unbounded label cardinality from raw URLs.
  app.use((req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.on('finish', () => {
      const route = (req.route && req.route.path) || 'unmatched';
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      end(labels);
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    // Liveness: the process is up and the event loop is responsive.
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', (req, res) => {
    // Readiness: flips to 503 during graceful shutdown so the pod is removed
    // from Service endpoints before connections are closed.
    if (!state.ready || state.shuttingDown) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    res.status(200).json({ status: 'ready' });
  });

  app.get('/api/v1/hello', (req, res) => {
    const name = typeof req.query.name === 'string' && req.query.name.length <= 64
      ? req.query.name
      : 'world';
    res.status(200).json({
      message: `hello, ${name}`,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      commit: GIT_SHA,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/metrics', async (req, res, next) => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.status(200).send(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      // Never leak stack traces to clients; log structured JSON for the platform.
      process.stderr.write(JSON.stringify({
        level: 'error',
        msg: 'unhandled_error',
        error: err.message,
        path: req.path,
      }) + '\n');
    }
    res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message });
  });

  return app;
}

module.exports = { createApp };

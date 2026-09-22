'use strict';

/**
 * Process entrypoint: binds the HTTP server and handles graceful shutdown.
 *
 * Shutdown sequence on SIGTERM/SIGINT:
 *   1. Mark the app not-ready so /readyz returns 503 (kubelet stops routing).
 *   2. Wait a short drain period for the endpoint controller to catch up.
 *   3. Stop accepting new connections and close idle keep-alive sockets.
 *   4. Exit 0 once in-flight requests finish, or force-exit after a deadline.
 */
const http = require('http');
const { createApp } = require('./app');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DRAIN_DELAY_MS = Number.parseInt(process.env.DRAIN_DELAY_MS || '5000', 10);
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);

function log(level, msg, extra = {}) {
  process.stdout.write(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }) + '\n');
}

function start() {
  const app = createApp();
  const server = http.createServer(app);

  // Keep-alive shorter than the upstream LB idle timeout to avoid races on close.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  server.listen(PORT, HOST, () => {
    log('info', 'server_listening', { host: HOST, port: PORT, pid: process.pid });
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.locals.state.shuttingDown = true;
    app.locals.state.ready = false;
    log('info', 'shutdown_started', { signal, drainDelayMs: DRAIN_DELAY_MS });

    const forceExit = setTimeout(() => {
      log('warn', 'shutdown_forced', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    setTimeout(() => {
      server.close((err) => {
        if (err) {
          log('error', 'shutdown_error', { error: err.message });
          process.exit(1);
        }
        log('info', 'shutdown_complete');
        process.exit(0);
      });
      // Node >= 18.2: proactively close idle keep-alive connections.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    }, DRAIN_DELAY_MS).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled_rejection', { reason: String(reason) });
    shutdown('unhandledRejection');
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };

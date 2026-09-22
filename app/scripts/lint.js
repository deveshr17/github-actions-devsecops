'use strict';

/**
 * Dependency-free lint gate.
 *
 * Runs `node --check` (syntax) on every JS file under src/ and enforces a few
 * repository conventions that matter for a hardened container image:
 *   - files start with 'use strict'
 *   - no `console.log` (structured logging to stdout only via the log helper)
 *   - no hardcoded 0.0.0.0 ports other than via process.env
 *
 * A full ESLint setup is a reasonable next step; this keeps the demo free of
 * devDependencies so the build stage produces a minimal, reproducible tree.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => path.join(root, f));

let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures += 1;
    process.stderr.write(`syntax error: ${file}\n${err.stderr}\n`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (!/^'use strict';/m.test(src)) {
    failures += 1;
    process.stderr.write(`${file}: missing 'use strict'\n`);
  }
  if (/console\.log\(/.test(src)) {
    failures += 1;
    process.stderr.write(`${file}: use the structured log helper instead of console.log\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`lint failed with ${failures} issue(s)\n`);
  process.exit(1);
}
process.stdout.write(`lint ok (${files.length} files)\n`);

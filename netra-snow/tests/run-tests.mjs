#!/usr/bin/env node
/**
 * run-tests.mjs — zero-dependency test runner for the Netra script includes.
 *
 *   node tests/run-tests.mjs               # run everything
 *   node tests/run-tests.mjs --filter vuln # only suites whose name matches
 *
 * Each suite file exports `{ name, run(t) }` where t is a tiny assertion API.
 * Exit code is nonzero if any assertion fails.
 */
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const filterIdx = process.argv.indexOf('--filter');
const FILTER = filterIdx >= 0 ? process.argv[filterIdx + 1] : null;

const suites = [
  './test-vulnerability.mjs',
  './test-performance.mjs',
  './test-intent-regression.mjs',
  './test-server-static.mjs',
  './test-update-set.mjs',
];

let totalPass = 0, totalFail = 0, totalSkip = 0;
const failures = [];

function makeT(suiteName) {
  let pass = 0, fail = 0, skip = 0;
  const api = {
    ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(suiteName + ': ' + msg); console.log('    ✗ ' + msg); } },
    eq(a, b, msg) { const c = JSON.stringify(a) === JSON.stringify(b); if (c) pass++; else { fail++; failures.push(suiteName + ': ' + msg + ' (' + JSON.stringify(a) + ' !== ' + JSON.stringify(b) + ')'); console.log('    ✗ ' + msg + '  got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); } },
    truthy(v, msg) { this.ok(!!v, msg); },
    falsy(v, msg) { this.ok(!v, msg); },
    contains(hay, needle, msg) { this.ok(String(hay).indexOf(needle) >= 0, msg + ' (looking for "' + needle + '" in "' + String(hay).slice(0, 120) + '")'); },
    skip(msg) { skip++; console.log('    ⊘ SKIP ' + msg); },
    _tally() { return { pass, fail, skip }; },
  };
  return api;
}

for (const rel of suites) {
  const name = rel.replace('./test-', '').replace('.mjs', '');
  if (FILTER && name.indexOf(FILTER) < 0) continue;
  const abs = path.join(__dirname, rel);
  if (!fs.existsSync(abs)) { console.log('• ' + name + ' (missing, skipped)'); totalSkip++; continue; }
  let mod;
  try { mod = await import(url.pathToFileURL(abs).href); }
  catch (e) { console.log('• ' + name + ' — LOAD ERROR: ' + e.message); failures.push(name + ' load: ' + e.message); totalFail++; continue; }
  const suite = mod.default || mod;
  const t0 = Date.now();
  console.log('• ' + (suite.name || name));
  const t = makeT(suite.name || name);
  try { await suite.run(t); }
  catch (e) { t.ok(false, 'threw: ' + e.message + '\n' + (e.stack || '')); }
  const r = t._tally();
  totalPass += r.pass; totalFail += r.fail; totalSkip += r.skip;
  console.log('  ' + r.pass + ' passed, ' + r.fail + ' failed, ' + r.skip + ' skipped  (' + (Date.now() - t0) + 'ms)');
}

console.log('\n' + '='.repeat(60));
console.log('TOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed, ' + totalSkip + ' skipped');
if (totalFail) {
  console.log('\nFAILURES:');
  failures.slice(0, 40).forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);

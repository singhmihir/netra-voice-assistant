#!/usr/bin/env node
/*
 * Netra test runner: node netra-snow/tests/run.js [filter]
 * Runs every *.test.js in its own node process (the loaders install globals,
 * so files must not share one), prints a summary, exits non-zero on failure.
 */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var filter = process.argv[2] || '';
var files = fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f) && f.indexOf(filter) >= 0; }).sort();
var failed = [], started = Date.now();
files.forEach(function (f) {
    var r = cp.spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 180000 });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stdout.write(r.stderr);
    if (r.status !== 0) failed.push(f);
});
console.log('\n' + (failed.length ? 'FAILED: ' + failed.join(', ') : 'all ' + files.length + ' test files passed') + ' (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
process.exit(failed.length ? 1 : 0);

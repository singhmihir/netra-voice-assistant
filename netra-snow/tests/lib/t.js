/* A tiny test harness: test(name, fn), eq/ok/match/notMatch, run() -> exit code. */
'use strict';
var assert = require('assert');
var tests = [];

function test(name, fn) { tests.push({ name: name, fn: fn }); }
function eq(got, want, msg) { assert.deepStrictEqual(got, want, (msg ? msg + ': ' : '') + 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function ok(cond, msg) { assert.ok(cond, msg || 'expected truthy'); }
function match(text, re, msg) { assert.ok(re.test(String(text)), (msg ? msg + ': ' : '') + JSON.stringify(String(text)) + ' should match ' + re); }
function notMatch(text, re, msg) { assert.ok(!re.test(String(text)), (msg ? msg + ': ' : '') + JSON.stringify(String(text)) + ' should NOT match ' + re); }

function run(file) {
    var pass = 0, fail = 0;
    tests.forEach(function (t) {
        try { t.fn(); pass++; }
        catch (e) { fail++; console.log('  FAIL ' + t.name + '\n       ' + String(e && e.message || e).split('\n').join('\n       ')); }
    });
    console.log((fail ? 'FAIL ' : 'ok   ') + require('path').basename(file) + ': ' + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ''));
    process.exitCode = fail ? 1 : 0;
}

module.exports = { test: test, eq: eq, ok: ok, match: match, notMatch: notMatch, run: run };

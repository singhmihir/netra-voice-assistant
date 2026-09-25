/* A tiny test harness: test(name, fn), eq/ok/match/notMatch, run() -> exit code. */
'use strict';
var assert = require('assert');
var tests = [];

function test(name, fn) { tests.push({ name: name, fn: fn }); }
function eq(got, want, msg) { assert.deepStrictEqual(got, want, (msg ? msg + ': ' : '') + 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function ok(cond, msg) { assert.ok(cond, msg || 'expected truthy'); }
function match(text, re, msg) { assert.ok(re.test(String(text)), (msg ? msg + ': ' : '') + JSON.stringify(String(text)) + ' should match ' + re); }
function notMatch(text, re, msg) { assert.ok(!re.test(String(text)), (msg ? msg + ': ' : '') + JSON.stringify(String(text)) + ' should NOT match ' + re); }

// a test that returns a promise (the ear's worker answers asynchronously)
// is awaited; every other test runs in turn, synchronously as before
function run(file) {
    var pass = 0, fail = 0, i = 0;
    function failed(t, e) { fail++; console.log('  FAIL ' + t.name + '\n       ' + String(e && e.message || e).split('\n').join('\n       ')); }
    function report() {
        console.log((fail ? 'FAIL ' : 'ok   ') + require('path').basename(file) + ': ' + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ''));
        process.exitCode = fail ? 1 : 0;
    }
    function next() {
        while (i < tests.length) {
            var t = tests[i++], r;
            try { r = t.fn(); } catch (e) { failed(t, e); continue; }
            if (r && typeof r.then === 'function') return r.then(function () { pass++; next(); }, function (e) { failed(t, e); next(); });
            pass++;
        }
        report();
    }
    next();
}

module.exports = { test: test, eq: eq, ok: ok, match: match, notMatch: notMatch, run: run };

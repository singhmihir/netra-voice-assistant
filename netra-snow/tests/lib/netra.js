/*
 * Loads the REAL Netra code into node for tests.
 *
 * Script includes are evaluated as-is. The widget server script is one IIFE
 * whose router runs first; we inject a hook just before the router that hands
 * every (hoisted) function declaration to the test, plus get/set access to the
 * IIFE's closure variables, and returns before the router runs. Module-level
 * vars declared below the router are therefore undefined here exactly as they
 * are during a real chat turn - the tests see the real hoisting behaviour.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var glide = require('./glide');

var SRC = path.join(__dirname, '..', '..', 'source');
var SERVER = path.join(SRC, 'widget', 'server.js');
var CLIENT = path.join(SRC, 'widget', 'client.js');
var ROUTER_MARKER = '    var action = (input && input.action) ? String(input.action) : null;';
var CLIENT_MARKER = 'api.controller = function ($scope, $timeout, $window) {\n    var c = this;\n';

function functionNames(src) {
    var re = /^    function ([A-Za-z0-9_$]+)\s*\(/gm, m, seen = {}, out = [];
    while ((m = re.exec(src))) { if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); } }
    return out;
}

function loadScriptIncludes() {
    glide.install(global);
    var dir = path.join(SRC, 'script_includes');
    fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) {
        vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
    });
}

/**
 * opts.input  - the widget input object (default undefined = boot)
 * returns { fn: {name: function}, get(name), set(name, value), data }
 */
function loadServer(opts) {
    opts = opts || {};
    loadScriptIncludes();
    var src = fs.readFileSync(SERVER, 'utf8');
    if (src.indexOf(ROUTER_MARKER) < 0) throw new Error('router marker not found in server.js - update tests/lib/netra.js');
    var names = functionNames(src);
    var hook = '    if (typeof __NETRA_TEST_EXPORT__ === "function") { __NETRA_TEST_EXPORT__({' +
               names.map(function (n) { return n + ': ' + n; }).join(', ') +
               '}, function (k) { return eval(k); }, function (k, v) { eval(k + " = v"); }); if (__NETRA_TEST_EXPORT__.stop) return; }\n';
    src = src.replace(ROUTER_MARKER, hook + ROUTER_MARKER);
    var out = {};
    global.input = opts.input;
    global.data = {};
    global.$sp = { getParameter: function () { return null; } };
    global.options = {};
    global.__NETRA_TEST_EXPORT__ = function (fns, get, set) { out.fn = fns; out.get = get; out.set = set; };
    // opts.route: let the real router run the request (a full widget request)
    global.__NETRA_TEST_EXPORT__.stop = !opts.route;
    vm.runInThisContext(src, { filename: 'server.js' });
    delete global.__NETRA_TEST_EXPORT__;
    out.data = global.data;
    return out;
}

/** client controller: returns { fn, c, get, set } without starting the mic or timers */
function loadClient() {
    var src = fs.readFileSync(CLIENT, 'utf8');
    if (src.indexOf(CLIENT_MARKER) < 0) throw new Error('client marker not found in client.js - update tests/lib/netra.js');
    var names = functionNames(src);
    var hook = '    if (typeof __NETRA_CLIENT_EXPORT__ === "function") { __NETRA_CLIENT_EXPORT__({' +
               names.map(function (n) { return n + ': ' + n; }).join(', ') +
               '}, c, function (k) { return eval(k); }, function (k, v) { eval(k + " = v"); }); return; }\n';
    src = src.replace(CLIENT_MARKER, CLIENT_MARKER + hook);
    var out = {};
    global.api = {};
    global.__NETRA_CLIENT_EXPORT__ = function (fns, c, get, set) { out.fn = fns; out.c = c; out.get = get; out.set = set; };
    vm.runInThisContext(src, { filename: 'client.js' });
    var ctrl = {};
    global.api.controller.call(ctrl, { $on: function () {}, $applyAsync: function () {} }, function (f) { return f; }, {});
    delete global.__NETRA_CLIENT_EXPORT__;
    // the hook returns before the rest of the controller body runs, so the
    // UPPER_CASE constants declared below it (regexes, thresholds, lists on
    // one line) are hoisted but undefined: give them their real values, so
    // a test exercises the same thresholds the page does
    // controller state assigned below the hook that every input path reads
    if (!out.c.ear) out.c.ear = { mode: 'auto', on: false, status: 'off', progress: 0, model: '', device: 'wasm', error: '', heard: 0, why: '' };
    var constRe = /^    var ([A-Z][A-Z0-9_]*)\s*=\s*(\/(?:[^\/\\\n]|\\.)+\/[gimuy]*|-?\d+(?:\.\d+)?|'[^'\n]*'|\[[^\]]*\]|true|false);/gm, cm;
    while ((cm = constRe.exec(src))) {
        try { if (out.get(cm[1]) === undefined) out.set(cm[1], vm.runInThisContext('(' + cm[2] + ')')); } catch (e) {}
    }
    return out;
}

/** one full widget request through the real router: returns data */
function request(input) { return loadServer({ input: input, route: true }).data; }

module.exports = { request: request, loadServer: loadServer, loadClient: loadClient, loadScriptIncludes: loadScriptIncludes, glide: glide, SRC: SRC };

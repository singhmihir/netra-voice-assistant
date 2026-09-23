/*
 * Structural guarantees checked on the source itself: everything parses,
 * no secrets ship, the hoisting trap stays closed, every declared tool is
 * implemented, and the installer and packager know every script include.
 */
'use strict';
var T = require('./lib/t'), fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..'), SRC = path.join(ROOT, 'source');
function read(p) { return fs.readFileSync(p, 'utf8'); }
function walk(dir, out) {
    fs.readdirSync(dir).forEach(function (f) {
        var p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) { if (!/node_modules|\.git/.test(f)) walk(p, out); }
        else out.push(p);
    });
    return out;
}
var server = read(path.join(SRC, 'widget', 'server.js'));

T.test('every server-side and client script parses', function () {
    walk(SRC, []).filter(function (p) { return /\.js$/.test(p) && !/widget[\/\\]lib/.test(p); }).forEach(function (p) {
        try { new vm.Script(read(p), { filename: p }); }
        catch (e) { T.ok(false, path.relative(ROOT, p) + ': ' + e.message); }
    });
});

T.test('no secrets or instance ids in anything that ships', function () {
    var files = walk(ROOT, []).filter(function (p) { return !/[\/\\]tests[\/\\]/.test(p) && /\.(js|xml|md|json|html|scss|properties)$/.test(p); });
    files.forEach(function (p) {
        var t = read(p);
        T.notMatch(t, /AIza[0-9A-Za-z_\-]{30,}/, path.relative(ROOT, p) + ' contains a Google API key');
        T.notMatch(t, /\bAQ\.[0-9A-Za-z_\-]{20,}/, path.relative(ROOT, p) + ' contains a Gemini key');
        T.notMatch(t, /dev390397/, path.relative(ROOT, p) + ' names the development instance');
    });
});

T.test('no module-level var below the router is used by a chat turn (hoisting trap)', function () {
    var at = server.indexOf('    var action = (input && input.action)');
    T.ok(at > 0, 'router marker');
    var ALLOWED = { action: 1, dn: 1, fn: 1, _ctxBlobCache: 1 };   // action is the router's own; the rest are lazily initialised
    var re = /^    var ([A-Za-z0-9_$]+)\s*=/gm, m, bad = [];
    var below = server.slice(at);
    while ((m = re.exec(below))) if (!ALLOWED[m[1]]) bad.push(m[1] + ' (line ' + server.slice(0, at + m.index).split('\n').length + ')');
    T.eq(bad, [], 'move these above the router or initialise them lazily');
});

T.test('every declared tool has a handler, and every handler is declared', function () {
    var declStart = server.indexOf('function _toolDeclarations'), declEnd = server.indexOf('function _runTool');
    var decl = server.slice(declStart, declEnd);
    var declared = {}, m, re = /\bname:\s*'([a-z_]+)'/g;
    while ((m = re.exec(decl))) declared[m[1]] = true;
    var run = server.slice(declEnd, server.indexOf('\n    }\n', server.indexOf('switch (name)', declEnd)));
    var handled = {}, re2 = /case '([a-z_]+)':/g;
    while ((m = re2.exec(run))) handled[m[1]] = true;
    var missing = Object.keys(declared).filter(function (n) { return !handled[n]; });
    T.eq(missing, [], 'declared but no _runTool case');
    T.ok(Object.keys(declared).length > 60, 'found the declarations (' + Object.keys(declared).length + ')');
});

T.test('installer and packager know every script include', function () {
    var sis = fs.readdirSync(path.join(SRC, 'script_includes')).filter(function (f) { return /\.js$/.test(f); }).map(function (f) { return f.replace(/\.js$/, ''); });
    var installer = read(path.join(SRC, 'fix_script', 'netra-install.js'));
    var packager = read(path.join(ROOT, 'scripts', 'build-setup-script.mjs'));
    sis.forEach(function (n) {
        T.ok(installer.indexOf(n) >= 0, 'installer does not mention ' + n);
        T.ok(packager.indexOf(n) >= 0, 'build-setup-script does not bundle ' + n);
    });
});

T.test('prompt and code agree on the undo grammar and the plan gate', function () {
    T.match(server, /"undo that" -> undo_last_action\. "undo the plan" -> undo_plan\. "undo task N" -> undo_task_action\./);
    T.match(server, /if \(lc === '\[continue plan\]'\) \{[\s\S]{0,400}!bp\.confirmed/, 'continue can never confirm');
});

T.run(__filename);

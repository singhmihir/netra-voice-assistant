/**
 * test-server-static.mjs — static integrity checks over the widget + script
 * includes: parse-ability, ES5-only, tool-declaration<->dispatch parity,
 * VIT routing, no secret leaks, no gs.setProperty in widget, source_scope
 * (never 'source') on privilege ops.
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SN_FILES = [
  'source/widget/server.js', 'source/widget/client.js',
  'source/script_includes/NetraVulnerability.js',
  'source/script_includes/NetraPerformance.js',
  'source/script_includes/NetraScanner.js',
  'source/script_includes/NetraTools.js',
  'source/script_includes/NetraIntent.js',
  'source/script_includes/NetraResponder.js',
  'source/script_includes/NetraContext.js',
  'source/script_includes/NetraKnowledge.js',
  'source/script_includes/NetraChat.js',
  'source/script_includes/NetraNavigator.js',
  'source/script_includes/NetraSummarizer.js',
  'source/scripted_rest/command.js',
  'source/scripted_rest/notifications.js',
  'source/scripted_rest/ping.js',
  'source/business_rule/netra_notify_on_comment.js',
  'source/scheduled_jobs/netra_watch.js',
  'source/fix_script/netra-install.js',
];

// Strip block comments, line comments, and string literals (', ", `) so the
// ES5 scan only sees real code. Backtick strings that contain ${ interpolation
// are flagged as real template literals via a returned marker. Regex literals
// are left intact (we don't flag bare backticks/lookbehind — the target
// ServiceNow engine supports them; we only flag unambiguous ES6 syntax that
// the scoped Rhino-compatible sandbox would reject on load).
function stripCode(src) {
  let out = '';
  let templateInterp = false;
  let i = 0;
  const n = src.length;
  // helper: emit newlines for each \n consumed, so line numbers stay aligned
  const nl = (s) => s.replace(/[^\n]/g, '');
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    // block comment (preserve embedded newlines)
    if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; out += nl(src.slice(i, j + 2)) + ' '; i = j + 2; continue; }
    // line comment
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    // strings (single-line for '/", multi-line possible for `)
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; out += '""'; continue; }
    if (c === '`') { let j = i + 1; let body = ''; while (j < n && src[j] !== '`') { if (src[j] === '\\') { body += src[j]; j++; } body += src[j] || ''; j++; } if (/\$\{/.test(body)) templateInterp = true; out += '``' + nl(src.slice(i, j + 1)); i = j + 1; continue; }
    out += c; i++;
  }
  return { code: out, templateInterp };
}

function es5Scan(src) {
  const hits = [];
  const { code, templateInterp } = stripCode(src);
  const lines = code.split('\n');
  const rawLines = src.split('\n');
  lines.forEach((code0, i) => {
    if (/=>/.test(code0)) hits.push([i + 1, 'arrow function', (rawLines[i] || '').trim().slice(0, 80)]);
    if (/\blet\s+[A-Za-z_$]/.test(code0)) hits.push([i + 1, 'let', (rawLines[i] || '').trim().slice(0, 80)]);
    if (/\bconst\s+[A-Za-z_$]/.test(code0)) hits.push([i + 1, 'const', (rawLines[i] || '').trim().slice(0, 80)]);
    if (/\bclass\s+[A-Za-z_$]+\s*(extends|\{)/.test(code0)) hits.push([i + 1, 'class declaration', (rawLines[i] || '').trim().slice(0, 80)]);
    // spread/rest in real code: [...x], f(...x), {...x}, function(...x)
    if (/[[({,]\s*\.\.\.[A-Za-z_$]/.test(code0)) hits.push([i + 1, 'spread/rest', (rawLines[i] || '').trim().slice(0, 80)]);
  });
  if (templateInterp) hits.push([0, 'template literal with ${} interpolation', '(somewhere in file)']);
  return hits;
}

export default {
  name: 'server/static integrity',
  run(t) {
    // ---------- parse all SN files ----------
    SN_FILES.forEach((f) => {
      try { new Function(read(f)); t.ok(true, 'parses: ' + f); }
      catch (e) { t.ok(false, 'PARSE FAIL ' + f + ': ' + e.message); }
    });

    // ---------- ES5-only ----------
    SN_FILES.forEach((f) => {
      const hits = es5Scan(read(f));
      if (hits.length) hits.slice(0, 5).forEach((h) => t.ok(false, 'ES5 violation in ' + f + ':' + h[0] + ' ' + h[1] + ' -> ' + h[2]));
      else t.ok(true, 'ES5-clean: ' + f);
    });

    // ---------- widget server: tool parity ----------
    (function () {
      const s = read('source/widget/server.js');
      // declaration names live as  name: 'tool_name'  inside _toolDeclarations
      const decls = new Set();
      let m; const declRe = /name:\s*'([a-z0-9_]+)'/g;
      while ((m = declRe.exec(s)) !== null) decls.add(m[1]);
      const cases = new Set();
      const caseRe = /case '([a-z0-9_]+)':/g;
      while ((m = caseRe.exec(s)) !== null) cases.add(m[1]);
      t.ok(decls.size >= 80, 'tool declarations found (' + decls.size + ')');
      t.ok(cases.size >= 80, 'dispatch cases found (' + cases.size + ')');
      const noCase = [...decls].filter((d) => !cases.has(d));
      const noDecl = [...cases].filter((c) => !decls.has(c));
      t.eq(noCase, [], 'every declared tool has a dispatch case');
      t.eq(noDecl, [], 'every dispatch case has a declaration');
      // R5 tools present
      ['overdue_vulnerabilities', 'mark_false_positive', 'bulk_vulnerability_preview', 'bulk_vulnerability_apply',
       'create_change_for_vulnerability', 'vulnerability_trend', 'next_vulnerable_item',
       'instance_health', 'list_heavy_jobs', 'integration_report'].forEach((tool) => {
        t.ok(decls.has(tool), 'R5 tool declared: ' + tool);
        t.ok(cases.has(tool), 'R5 tool dispatched: ' + tool);
      });
    })();

    // ---------- VIT routing + no key leak + version + no setProperty ----------
    (function () {
      const s = read('source/widget/server.js');
      t.contains(s, "if (p === 'VIT') return 'sn_vul_vulnerable_item'", 'VIT routed in _tableForNumber');
      t.contains(s, "if (p === 'VUL') return 'sn_vul_vulnerability_group'", 'VUL routed in _tableForNumber');
      t.ok(!/key\.substring\(0,\s*6\)/.test(s) && !/key\.length/.test(s), 'API key length/prefix leak removed from debug');
      t.contains(s, "v8.0 (R5)", 'debug version bumped to v8.0 (R5)');
      t.ok(!/gs\.setProperty/.test(s), 'no gs.setProperty in server.js (Yokohama banner)');
      t.contains(s, "args.confirmed", 'bulk apply confirm gate present');
    })();

    // ---------- no gs.setProperty in any widget file ----------
    ['source/widget/server.js', 'source/widget/client.js'].forEach((f) => {
      t.ok(!/gs\.setProperty/.test(read(f)), 'no gs.setProperty in ' + f);
    });

    // ---------- privilege ops use source_scope, never bare 'source' ----------
    (function () {
      const inst = read('source/fix_script/netra-install.js');
      // there must be no addQuery('source', or setValue('source', on scope_privilege
      t.ok(!/setValue\('source',/.test(inst), "installer never writes the phantom 'source' column");
      t.ok(!/addQuery\('source',/.test(inst), "installer never queries the phantom 'source' column");
      t.contains(inst, "setValue('source_scope'", 'installer uses source_scope');
    })();

    // ---------- no XML-illegal control chars in files shipped via update set ----------
    (function () {
      const codeFiles = ['source/widget/client.js', 'source/widget/server.js',
        'source/widget/template.html', 'source/widget/stylesheet.scss',
        ...SN_FILES.filter((f) => f.indexOf('script_includes') >= 0 || f.indexOf('scripted_rest') >= 0 ||
          f.indexOf('business_rule') >= 0 || f.indexOf('scheduled_jobs') >= 0)];
      codeFiles.forEach((f) => {
        const buf = fs.readFileSync(path.join(ROOT, f));
        let bad = 0;
        for (let i = 0; i < buf.length; i++) { const b = buf[i]; if (b < 9 || b === 11 || b === 12 || (b > 13 && b < 32)) bad++; }
        t.eq(bad, 0, 'no XML-illegal control chars in ' + f);
      });
    })();

    // ---------- client VIT/CVE normalization present ----------
    (function () {
      const c = read('source/widget/client.js');
      t.contains(c, 'VIT', 'client references VIT');
      t.ok(/CVE-\$1-\$2|CVE-'\s*\+\s*y\s*\+/.test(c) || /CVE-' \+ y \+/.test(c), 'client has CVE normalization');
    })();
  }
};

#!/usr/bin/env node
/**
 * Generate install/setup-netra.js — a single ServiceNow Background Script that
 * creates every artifact for the Netra Voice Assistant app.
 *
 * Node port of build-setup-script.ps1, switched to the modern scope-agnostic
 * installer template (source/fix_script/netra-install.js). Reads every source
 * file from source/, escapes each line as a JS string literal, and injects
 * them at the /*__EMBEDDED_SOURCE__* / marker.
 *
 * Usage:  node scripts/build-setup-script.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'source');
const tmpl = path.join(src, 'fix_script', 'netra-install.js');
const outDir = path.join(root, 'install');
const out = path.join(outDir, 'setup-netra.js');

// ---- Source files to embed: key -> relative path under source/ ----
const sources = [
  ['NetraIntent',             'script_includes/NetraIntent.js'],
  ['NetraTools',              'script_includes/NetraTools.js'],
  ['NetraResponder',          'script_includes/NetraResponder.js'],
  ['NetraScanner',            'script_includes/NetraScanner.js'],
  ['NetraKnowledge',          'script_includes/NetraKnowledge.js'],
  ['NetraChat',               'script_includes/NetraChat.js'],
  ['NetraSummarizer',         'script_includes/NetraSummarizer.js'],
  ['NetraContext',            'script_includes/NetraContext.js'],
  ['NetraNavigator',          'script_includes/NetraNavigator.js'],
  ['NetraVulnerability',      'script_includes/NetraVulnerability.js'],
  ['NetraPerformance',        'script_includes/NetraPerformance.js'],
  ['netra_notify_on_comment', 'business_rule/netra_notify_on_comment.js'],
  ['netra_watch',             'scheduled_jobs/netra_watch.js'],
  ['command',                 'scripted_rest/command.js'],
  ['notifications',           'scripted_rest/notifications.js'],
  ['ping',                    'scripted_rest/ping.js'],
  ['template',                'widget/template.html'],
  ['client',                  'widget/client.js'],
  ['server',                  'widget/server.js'],
  ['stylesheet',              'widget/stylesheet.scss'],
];

// Convert a multi-line string into: ["line one", "line two", ...].join("\n")
// Each line double-quoted with backslashes/quotes escaped — identical output
// shape to the original PowerShell generator, but with a proper \n escape.
function toJsArrayJoin(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const escaped = lines.map((l) => '"' + l.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  return '[' + escaped.join(',\n        ') + '].join("\\n")';
}

let body = '    var SRC = {};\n';
for (const [key, rel] of sources) {
  const p = path.join(src, rel);
  if (!fs.existsSync(p)) throw new Error('Missing source file: ' + p);
  const content = fs.readFileSync(p, 'utf8');
  body += '\n    SRC.' + key + ' = ' + toJsArrayJoin(content) + ';\n';
  console.log(`  + embedded ${key.padEnd(25)} (${String(content.length).padStart(7)} bytes from ${rel})`);
}

const template = fs.readFileSync(tmpl, 'utf8');
const marker = '/*__EMBEDDED_SOURCE__*/';
if (!template.includes(marker)) throw new Error('Template marker not found in ' + tmpl);
const final = template.split(marker).join(body);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, final, 'utf8');
console.log(`\nWrote ${out}`);
console.log(`  size: ${fs.statSync(out).size.toLocaleString()} bytes, ${final.split('\n').length.toLocaleString()} lines`);

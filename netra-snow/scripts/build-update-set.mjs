#!/usr/bin/env node
/**
 * build-update-set.mjs — regenerate the Netra batch update-set XML from source.
 *
 * The R4.7 batch XML was a hand-curated instance export. This generator makes
 * the update set a BUILD PRODUCT again: it takes the R4.7 batch as a base,
 * refreshes every code-bearing record from the files under source/, adds the
 * new R5 artifacts into a new child set, and writes a fresh R5 batch that
 * imports as one file (Preview & Commit the parent).
 *
 * Usage:
 *   node scripts/build-update-set.mjs                 # writes update-set/Netra_v2.0.0-R5_Batch.xml
 *   node scripts/build-update-set.mjs --out /tmp/x.xml
 *   node scripts/build-update-set.mjs --check         # build in memory + validate, no write unless --out
 *   node scripts/build-update-set.mjs --date "2026-07-10 12.00.00"
 *
 * Zero dependencies. Node >= 18.
 *
 * Payload discipline (the #1 way to corrupt this file is mis-escaping):
 *   - <payload> holds an entity-ESCAPED inner document.
 *   - Unescape exactly once (&lt;->< &gt;->> &amp;->&, in that order) to edit.
 *   - Re-escape exactly once (&->&amp; FIRST, then <->&lt; >->&gt;).
 *   - Script fields inside the inner doc are wrapped in <![CDATA[ ... ]]>.
 */

import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // netra-snow/
const SRC = path.join(ROOT, 'source');
const BASE_XML = path.join(ROOT, 'update-set', 'Netra_v2.0.0-R4.7_Batch.xml');
const DEFAULT_OUT = path.join(ROOT, 'update-set', 'Netra_v2.0.0-R5_Batch.xml');
const SCOPE = 'x_196061_netra_v1';
const APP_SYS_ID = '26a2121093424710e3aef0aefaba106a';
const PARENT_SET_ID = '32a2961093424710e3aef0aefaba1082';

// ---- args ----
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : (CHECK ? null : DEFAULT_OUT);
const dateIdx = args.indexOf('--date');
const BUILD_DATE_DOTTED = dateIdx >= 0 ? args[dateIdx + 1] : dottedNow();
const BUILD_DATE = BUILD_DATE_DOTTED.replace(/\.(\d{2})\.(\d{2})$/, ':$1:$2').replace(/ (\d{2})\.(\d{2})\.(\d{2})/, ' $1:$2:$3');

function dottedNow() {
  // deterministic-ish default; caller can override with --date
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}`;
}
const NOW_COLON = BUILD_DATE_DOTTED.replace(/\.(\d{2})\.(\d{2})$/, (m, a, b) => ':' + a + ':' + b).replace(/(\d{2})\.(\d{2})\.(\d{2})$/, '$1:$2:$3');

// ---------- escape helpers ----------
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Java String.hashCode -> signed 32-bit int (matches the file's convention).
function javaHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

// Deterministic 32-hex guid derived from record identity + content, so
// repeat builds of the same source are byte-stable (no Math.random).
function guidFor(seed) {
  let a = 0x9e3779b9 ^ seed.length;
  const out = [];
  for (let i = 0; i < seed.length; i++) {
    a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  let x = a >>> 0;
  for (let i = 0; i < 32; i++) {
    // xorshift32
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    out.push((x & 0xf).toString(16));
  }
  return out.join('');
}

// ---------- source loading + scope substitution ----------
function loadSource(rel) {
  const p = path.join(SRC, rel);
  let text = fs.readFileSync(p, 'utf8');
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/__NETRA_SCOPE__/g, SCOPE);
  return text;
}

// target_name -> { file, field } for records refreshed from source
const REFRESH_MAP = {
  // Script Includes (field: script)
  'NetraIntent':       { file: 'script_includes/NetraIntent.js',       field: 'script' },
  'NetraTools':        { file: 'script_includes/NetraTools.js',        field: 'script' },
  'NetraResponder':    { file: 'script_includes/NetraResponder.js',    field: 'script' },
  'NetraScanner':      { file: 'script_includes/NetraScanner.js',      field: 'script' },
  'NetraKnowledge':    { file: 'script_includes/NetraKnowledge.js',    field: 'script' },
  'NetraChat':         { file: 'script_includes/NetraChat.js',         field: 'script' },
  'NetraSummarizer':   { file: 'script_includes/NetraSummarizer.js',   field: 'script' },
  'NetraContext':      { file: 'script_includes/NetraContext.js',      field: 'script' },
  'NetraNavigator':    { file: 'script_includes/NetraNavigator.js',    field: 'script' },
  'NetraVulnerability':{ file: 'script_includes/NetraVulnerability.js', field: 'script' },
  // Automation
  'Netra Watch':            { file: 'scheduled_jobs/netra_watch.js',        field: 'script' },
  'Netra Notify On Comment':{ file: 'business_rule/netra_notify_on_comment.js', field: 'script' },
  // Scripted REST resources (field: operation_script)
  'command':       { file: 'scripted_rest/command.js',       field: 'operation_script' },
  'notifications': { file: 'scripted_rest/notifications.js', field: 'operation_script' },
  'ping':          { file: 'scripted_rest/ping.js',          field: 'operation_script' },
  // Widget (multi-field)
  'Netra Mic': { widget: true },
};

// ---------- record parsing ----------
function parseRecords(xml) {
  // Split into a flat list of chunks, tagging update_xml records.
  const records = [];
  const re = /<sys_update_xml action="INSERT_OR_UPDATE">[\s\S]*?<\/sys_update_xml>/g;
  let m, lastIndex = 0;
  const segments = [];
  while ((m = re.exec(xml)) !== null) {
    if (m.index > lastIndex) segments.push({ type: 'raw', text: xml.slice(lastIndex, m.index) });
    segments.push({ type: 'update', text: m[0] });
    lastIndex = re.lastIndex;
  }
  segments.push({ type: 'raw', text: xml.slice(lastIndex) });
  return segments;
}

function getTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1] : null;
}
function setTag(block, tag, value) {
  const re = new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>');
  // Function replacement so '$' sequences in `value` (source code often has
  // $1/$& in regex replacement strings) are inserted LITERALLY.
  return block.replace(re, () => '<' + tag + '>' + value + '</' + tag + '>');
}

// Replace one field's content inside an (unescaped) inner payload document.
// Handles CDATA-wrapped and plain fields. Returns null if field absent.
function replaceInnerField(inner, field, newContent) {
  // Function replacements so '$1'/'$&' etc. inside source code are inserted
  // LITERALLY, not treated as regex backreferences.
  const cdataRe = new RegExp('(<' + field + '>)<!\\[CDATA\\[[\\s\\S]*?\\]\\]>(</' + field + '>)');
  if (cdataRe.test(inner)) {
    return inner.replace(cdataRe, (m, g1, g2) => g1 + '<![CDATA[' + newContent + ']]>' + g2);
  }
  const plainRe = new RegExp('(<' + field + '>)[\\s\\S]*?(</' + field + '>)');
  if (plainRe.test(inner)) {
    const escaped = escapeInnerText(newContent);
    return inner.replace(plainRe, (m, g1, g2) => g1 + escaped + g2);
  }
  return null;
}
// plain (non-CDATA) inner text still lives inside the once-escaped payload,
// so its own metacharacters must be escaped as part of the inner document.
function escapeInnerText(s) {
  return escapeXml(s);
}

// ---------- refresh an update record from source ----------
const stats = { updated: [], unchanged: [], added: [], roundtrip_fail: [] };

function refreshRecord(block) {
  const targetName = getTag(block, 'target_name');
  const type = getTag(block, 'type');
  if (!targetName || !REFRESH_MAP[targetName]) return block; // not source-driven
  const spec = REFRESH_MAP[targetName];

  const payloadEsc = getTag(block, 'payload');
  if (payloadEsc == null) return block;
  let inner = unescapeXml(payloadEsc);
  const before = inner;

  if (spec.widget) {
    const map = [
      ['template', loadSource('widget/template.html')],
      ['client_script', loadSource('widget/client.js')],
      ['script', loadSource('widget/server.js')],
      ['css', loadSource('widget/stylesheet.scss')],
    ];
    for (const [field, content] of map) {
      const next = replaceInnerField(inner, field, content);
      if (next != null) inner = next;
    }
  } else {
    const content = loadSource(spec.file);
    const next = replaceInnerField(inner, spec.field, content);
    if (next == null) {
      // Some REST resources name the field differently; try 'script'.
      const alt = replaceInnerField(inner, 'script', content);
      if (alt != null) inner = alt; else console.warn('  ! field not found for ' + targetName + ' (' + spec.field + ')');
    } else {
      inner = next;
    }
  }

  if (inner === before) {
    stats.unchanged.push(targetName);
    return block;
  }

  // bump inner + outer metadata, re-escape once
  inner = bumpInnerTimestamps(inner);
  const newPayload = escapeXml(inner);
  let out = setTag(block, 'payload', newPayload);

  const hash = javaHash(newPayload);
  out = setTag(out, 'payload_hash', String(hash));
  const name = getTag(block, 'name');
  const newGuid = guidFor(name + '|' + hash);
  const prevGuid = getTag(out, 'update_guid') || '';
  const prevHist = getTag(out, 'update_guid_history') || '';
  out = setTag(out, 'update_guid', newGuid);
  const histEntry = newGuid + ':' + hash;
  const newHist = prevHist && prevHist.indexOf(histEntry) < 0 ? (histEntry + ',' + prevHist) : (prevHist || histEntry);
  out = setTag(out, 'update_guid_history', newHist);
  out = setTag(out, 'sys_updated_on', BUILD_DATE);

  stats.updated.push(targetName);
  return out;
}

function bumpInnerTimestamps(inner) {
  let out = inner.replace(/<sys_updated_on>[\s\S]*?<\/sys_updated_on>/, '<sys_updated_on>' + BUILD_DATE + '</sys_updated_on>');
  const mc = out.match(/<sys_mod_count>(\d+)<\/sys_mod_count>/);
  if (mc) out = out.replace(/<sys_mod_count>\d+<\/sys_mod_count>/, '<sys_mod_count>' + (parseInt(mc[1], 10) + 1) + '</sys_mod_count>');
  return out;
}

// ---------- new-record builders ----------
function makeUpdateRecord({ name, type, targetName, remoteSet, payloadInner }) {
  const payload = escapeXml(payloadInner);
  const hash = javaHash(payload);
  const guid = guidFor(name + '|' + hash);
  const domain = "{'link': 'https://dev390397.service-now.com/api/now/table/sys_user_group/global', 'value': 'global'}";
  return [
    '<sys_update_xml action="INSERT_OR_UPDATE">',
    '    <action>INSERT_OR_UPDATE</action>',
    '    <category>customer</category>',
    '    <name>' + name + '</name>',
    '    <payload>' + payload + '</payload>',
    '    <payload_hash>' + hash + '</payload_hash>',
    '    <remote_update_set>' + remoteSet + '</remote_update_set>',
    '    <replace_on_upgrade>false</replace_on_upgrade>',
    '    <sys_created_by>admin</sys_created_by>',
    '    <sys_created_on>' + BUILD_DATE + '</sys_created_on>',
    '    <sys_id>' + guidFor('rec|' + name) + '</sys_id>',
    '    <sys_updated_by>admin</sys_updated_by>',
    '    <sys_updated_on>' + BUILD_DATE + '</sys_updated_on>',
    '    <target_name>' + targetName + '</target_name>',
    '    <type>' + type + '</type>',
    '    <update_domain>' + domain + '</update_domain>',
    '    <update_guid>' + guid + '</update_guid>',
    '    <update_guid_history>' + guid + ':' + hash + '</update_guid_history>',
    '    <view/>',
    '</sys_update_xml>',
  ].join('\n');
}

function scriptIncludePayload({ sysId, name, apiName, description, scriptText }) {
  const esc = escapeXml; // inner field values get escaped as part of one-pass escape at the end; here we build RAW inner then escape once
  return '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    '<access>package_private</access>' +
    '<active>true</active>' +
    '<api_name>' + apiName + '</api_name>' +
    '<caller_access/>' +
    '<client_callable>false</client_callable>' +
    '<description>' + description + '</description>' +
    '<mobile_callable>false</mobile_callable>' +
    '<name>' + name + '</name>' +
    '<sandbox_callable>false</sandbox_callable>' +
    '<script><![CDATA[' + scriptText + ']]></script>' +
    '<sys_class_name>sys_script_include</sys_class_name>' +
    '<sys_created_by>admin</sys_created_by>' +
    '<sys_created_on>' + BUILD_DATE + '</sys_created_on>' +
    '<sys_id>' + sysId + '</sys_id>' +
    '<sys_mod_count>0</sys_mod_count>' +
    '<sys_name>' + name + '</sys_name>' +
    '<sys_package display_value="Netra Voice Assistant" source="' + SCOPE + '">' + APP_SYS_ID + '</sys_package>' +
    '<sys_policy/>' +
    '<sys_scope display_value="Netra Voice Assistant">' + APP_SYS_ID + '</sys_scope>' +
    '<sys_update_name>sys_script_include_' + sysId + '</sys_update_name>' +
    '<sys_updated_by>admin</sys_updated_by>' +
    '<sys_updated_on>' + BUILD_DATE + '</sys_updated_on>' +
    '</sys_script_include></record_update>';
}

function propertyPayload({ sysId, name, value, description }) {
  return '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_properties">' +
    '<sys_properties action="INSERT_OR_UPDATE">' +
    '<choices/>' +
    '<description>' + description + '</description>' +
    '<ignore_cache>false</ignore_cache>' +
    '<is_private>false</is_private>' +
    '<name>' + name + '</name>' +
    '<read_roles/>' +
    '<suffix/>' +
    '<sys_created_by>admin</sys_created_by>' +
    '<sys_created_on>' + BUILD_DATE + '</sys_created_on>' +
    '<sys_id>' + sysId + '</sys_id>' +
    '<sys_mod_count>0</sys_mod_count>' +
    '<sys_name>' + name + '</sys_name>' +
    '<sys_package display_value="Netra Voice Assistant" source="' + SCOPE + '">' + APP_SYS_ID + '</sys_package>' +
    '<sys_policy/>' +
    '<sys_scope display_value="Netra Voice Assistant">' + APP_SYS_ID + '</sys_scope>' +
    '<sys_update_name>sys_properties_' + sysId + '</sys_update_name>' +
    '<sys_updated_by>admin</sys_updated_by>' +
    '<sys_updated_on>' + BUILD_DATE + '</sys_updated_on>' +
    '<type>string</type>' +
    '<value>' + value + '</value>' +
    '<write_roles/>' +
    '<sys_translated_text action="delete_multiple" query="documentkey=' + sysId + '"/>' +
    '</sys_properties></record_update>';
}

function privilegePayload({ sysId, targetName, operation }) {
  return '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_scope_privilege">' +
    '<sys_scope_privilege action="INSERT_OR_UPDATE">' +
    '<operation>' + operation + '</operation>' +
    '<source_scope display_value="Netra Voice Assistant">' + APP_SYS_ID + '</source_scope>' +
    '<status>allowed</status>' +
    '<sys_class_name>sys_scope_privilege</sys_class_name>' +
    '<sys_created_by>admin</sys_created_by>' +
    '<sys_created_on>' + BUILD_DATE + '</sys_created_on>' +
    '<sys_id>' + sysId + '</sys_id>' +
    '<sys_mod_count>0</sys_mod_count>' +
    '<sys_name>' + targetName + '</sys_name>' +
    '<sys_package display_value="Netra Voice Assistant" source="' + SCOPE + '">' + APP_SYS_ID + '</sys_package>' +
    '<sys_policy/>' +
    '<sys_scope display_value="Netra Voice Assistant">' + APP_SYS_ID + '</sys_scope>' +
    '<sys_update_name>sys_scope_privilege_' + sysId + '</sys_update_name>' +
    '<sys_updated_by>admin</sys_updated_by>' +
    '<sys_updated_on>' + BUILD_DATE + '</sys_updated_on>' +
    '<target_name>' + targetName + '</target_name>' +
    '<target_scope display_value="Global">global</target_scope>' +
    '<target_type>sys_db_object</target_type>' +
    '</sys_scope_privilege></record_update>';
}

function childSet07() {
  const id = guidFor('set07|Netra 07');
  return {
    id,
    xml: [
      '<sys_remote_update_set action="INSERT_OR_UPDATE">',
      '    <application>' + APP_SYS_ID + '</application>',
      '    <application_name>Netra Voice Assistant</application_name>',
      '    <application_scope>' + SCOPE + '</application_scope>',
      '    <application_version>2.0.0</application_version>',
      '    <collisions/>',
      '    <commit_date/>',
      '    <description>Netra batch 7/7: R5 VR analyst expansion (lifecycle, groups, bulk ops, change creation, trend/aging) delivered via the refreshed NetraVulnerability script include, plus NetraPerformance instance-health analytics, role properties, and cross-scope read privileges for the performance tooling.</description>',
      '    <name>Netra 07 - VR Analyst Expansion &amp; Performance</name>',
      '    <origin_sys_id>' + id + '</origin_sys_id>',
      '    <release_date/>',
      '    <remote_base_update_set/>',
      '    <remote_parent_id>' + PARENT_SET_ID + '</remote_parent_id>',
      '    <remote_sys_id>' + id + '</remote_sys_id>',
      '    <state>loaded</state>',
      '    <summary/>',
      '    <sys_created_by>admin</sys_created_by>',
      '    <sys_created_on>' + BUILD_DATE + '</sys_created_on>',
      '    <sys_id>' + id + '</sys_id>',
      '    <sys_updated_by>admin</sys_updated_by>',
      '    <sys_updated_on>' + BUILD_DATE + '</sys_updated_on>',
      '    <update_source/>',
      '</sys_remote_update_set>',
    ].join('\n'),
  };
}

// ---------- main build ----------
function build() {
  const xml = fs.readFileSync(BASE_XML, 'utf8').replace(/\r\n/g, '\n');
  const segments = parseRecords(xml);

  // 1. refresh existing update records from source
  for (const seg of segments) {
    if (seg.type === 'update') seg.text = refreshRecord(seg.text);
  }

  // 2. build new child set 07 + its records
  const set07 = childSet07();
  const perfSysId = guidFor('si|NetraPerformance');
  const perfPayload = scriptIncludePayload({
    sysId: perfSysId,
    name: 'NetraPerformance',
    apiName: SCOPE + '.NetraPerformance',
    description: 'Read-only instance performance analytics for Netra voice (R5): job load, slow transactions, integration inventory, safe-pause classification.',
    scriptText: loadSource('script_includes/NetraPerformance.js'),
  });
  const newRecords = [];
  newRecords.push(makeUpdateRecord({
    name: 'sys_script_include_' + perfSysId, type: 'Script Include',
    targetName: 'NetraPerformance', remoteSet: set07.id, payloadInner: perfPayload,
  }));

  const props = [
    ['vr_read_roles', '', 'R5: extra roles (comma list) allowed to READ Vulnerability Response data through Netra, in addition to the standard sn_vul roles.'],
    ['vr_write_roles', '', 'R5: extra roles (comma list) allowed to CHANGE Vulnerability Response records through Netra, in addition to the standard sn_vul write roles.'],
    ['perf_read_roles', '', 'R5: extra roles (comma list) allowed to use the read-only instance-health voice tools (default: admin only).'],
    ['vr_overdue_days', '30', 'R5: fallback age (days) after which an open vulnerable item counts as overdue when the remediation_target field is absent.'],
  ];
  for (const [suffix, value, desc] of props) {
    const name = SCOPE + '.' + suffix;
    const sysId = guidFor('prop|' + name);
    newRecords.push(makeUpdateRecord({
      name: 'sys_properties_' + sysId, type: 'System Property',
      targetName: name, remoteSet: set07.id,
      payloadInner: propertyPayload({ sysId, name, value, description: desc }),
    }));
  }

  // new cross-scope privileges (match installer privRules R5 additions)
  const privs = [
    ['sn_vul_vulnerability_group', 'write'],
    ['task', 'read'],
    ['sys_trigger', 'read'],
    ['sysauto', 'read'],
    ['syslog_transaction', 'read'],
    ['scheduled_import_set', 'read'],
    ['sys_rest_message', 'read'],
    ['ecc_agent', 'read'],
    ['ldap_server_config', 'read'],
  ];
  for (const [tbl, op] of privs) {
    const sysId = guidFor('priv|' + tbl + '|' + op);
    newRecords.push(makeUpdateRecord({
      name: 'sys_scope_privilege_' + sysId, type: 'Cross scope privilege',
      targetName: tbl, remoteSet: set07.id,
      payloadInner: privilegePayload({ sysId, targetName: tbl, operation: op }),
    }));
    stats.added.push('privilege ' + tbl + ':' + op);
  }
  stats.added.push('NetraPerformance (Script Include)');
  for (const [suffix] of props) stats.added.push('property ' + suffix);

  // 3. reassemble: parent rename + child desc fix + insert set07 + new records
  let out = segments.map((s) => s.text).join('');

  // parent set rename + description + timestamp
  out = out.replace(
    /(<name>Netra v2\.0\.0-R4\.7 - Complete App<\/name>)/,
    '<name>Netra v2.0.0-R5 - Complete App</name>'
  );
  out = out.replace(
    /(<description>BATCH PARENT[\s\S]*?<\/description>)/,
    '<description>BATCH PARENT (R5). Commit this one update set to deploy the entire Netra Voice Assistant app: VR analyst suite, instance-health tooling, widget, tables, REST, portal, properties and privileges. The seven child sets (Netra 01 through 07) are committed automatically in hierarchy order.</description>'
  );

  // child descriptions batch N/5 -> N/7 (cosmetic but correct)
  out = out.replace(/Netra batch (\d) of 5/g, 'Netra batch $1 of 7');
  out = out.replace(/Netra batch (\d):/g, 'Netra batch $1/7:');

  // unload_date -> build date (dotted)
  out = out.replace(/<unload unload_date="[^"]*">/, '<unload unload_date="' + BUILD_DATE_DOTTED + '">');

  // insert set07 right after set06's closing tag (keeps all sets before updates)
  const set06Close = '</sys_remote_update_set>';
  const lastSetIdx = out.lastIndexOf(set06Close, out.indexOf('<sys_update_xml'));
  const insertAt = lastSetIdx + set06Close.length;
  out = out.slice(0, insertAt) + '\n' + set07.xml + out.slice(insertAt);

  // append new update records just before </unload>
  const closeIdx = out.lastIndexOf('</unload>');
  out = out.slice(0, closeIdx) + newRecords.join('\n') + '\n' + out.slice(closeIdx);

  return { out, set07Id: set07.id };
}

// ---------- validation ----------
function validate(outXml, set07Id) {
  const problems = [];
  // 1. tag balance for the wrapper record tags
  const openU = (outXml.match(/<sys_update_xml /g) || []).length;
  const closeU = (outXml.match(/<\/sys_update_xml>/g) || []).length;
  if (openU !== closeU) problems.push(`sys_update_xml open/close mismatch: ${openU}/${closeU}`);
  const openS = (outXml.match(/<sys_remote_update_set /g) || []).length;
  const closeS = (outXml.match(/<\/sys_remote_update_set>/g) || []).length;
  if (openS !== closeS) problems.push(`sys_remote_update_set open/close mismatch: ${openS}/${closeS}`);
  if (!/^<\?xml/.test(outXml)) problems.push('missing XML prolog');
  if (!/<\/unload>\s*$/.test(outXml)) problems.push('missing/!last </unload>');

  // 2. collect sets and records
  const setIds = new Set();
  for (const m of outXml.matchAll(/<sys_remote_update_set [\s\S]*?<sys_id>([0-9a-f]{32})<\/sys_id>[\s\S]*?<\/sys_remote_update_set>/g)) {
    setIds.add(m[1]);
  }
  let recCount = 0, nameMismatch = 0, badRef = 0;
  const roundtrip = { checked: 0, ok: 0, fail: [] };
  for (const m of outXml.matchAll(/<sys_update_xml action="INSERT_OR_UPDATE">([\s\S]*?)<\/sys_update_xml>/g)) {
    recCount++;
    const block = m[1];
    const name = (block.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '';
    const type = (block.match(/<type>([\s\S]*?)<\/type>/) || [])[1] || '';
    const remoteSet = (block.match(/<remote_update_set>([0-9a-f]{32})<\/remote_update_set>/) || [])[1] || '';
    if (remoteSet && !setIds.has(remoteSet)) { badRef++; problems.push('record ' + name + ' -> unknown set ' + remoteSet); }
    // name sys_id suffix must match payload sys_id for sys_id-named types
    const sm = name.match(/_([0-9a-f]{32})$/);
    if (sm) {
      const payload = (block.match(/<payload>([\s\S]*?)<\/payload>/) || [])[1] || '';
      const inner = unescapeXml(payload);
      const psid = (inner.match(/<sys_id>([0-9a-f]{32})<\/sys_id>/) || [])[1] || '';
      if (psid && psid !== sm[1]) { nameMismatch++; problems.push('name/sys_id mismatch: ' + name + ' vs payload ' + psid); }
    }
    // round-trip: refreshed code records' field content must equal source
    const tn = (block.match(/<target_name>([\s\S]*?)<\/target_name>/) || [])[1] || '';
    if (REFRESH_MAP[tn] && !REFRESH_MAP[tn].widget) {
      const spec = REFRESH_MAP[tn];
      const payload = (block.match(/<payload>([\s\S]*?)<\/payload>/) || [])[1] || '';
      const inner = unescapeXml(payload);
      const field = spec.field;
      let cm = inner.match(new RegExp('<' + field + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + field + '>'));
      if (!cm) cm = inner.match(/<script><!\[CDATA\[([\s\S]*?)\]\]><\/script>/);
      roundtrip.checked++;
      if (cm) {
        const got = cm[1];
        const want = loadSource(spec.file);
        if (got === want) roundtrip.ok++;
        else { roundtrip.fail.push(tn); problems.push('round-trip mismatch: ' + tn + ' (payload code != source)'); }
      } else {
        roundtrip.fail.push(tn + ' (field not found)');
      }
    }
  }
  if (!setIds.has(set07Id)) problems.push('set07 not present: ' + set07Id);

  // 3. XML 1.0 forbids most control chars even inside CDATA/escaped payloads.
  //    Catch them here so a stray SOH-style sentinel byte in source can never
  //    silently produce a batch that fails to import.
  let ctrl = 0;
  for (let i = 0; i < outXml.length; i++) {
    const c = outXml.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      ctrl++;
      if (ctrl <= 3) problems.push('XML-illegal control char 0x' + c.toString(16) + ' near: ' + JSON.stringify(outXml.slice(i - 30, i + 10)));
    }
  }
  if (ctrl) problems.push('total XML-illegal control chars: ' + ctrl + ' (fix the source, do not strip here)');

  return { problems, recCount, setCount: setIds.size, roundtrip, ctrl };
}

// ---------- run ----------
console.log('Netra update-set generator');
console.log('  base : ' + path.relative(ROOT, BASE_XML));
console.log('  date : ' + BUILD_DATE_DOTTED + '  (' + (CHECK ? 'check' : 'build') + ')');
const { out, set07Id } = build();
const v = validate(out, set07Id);

console.log('\nManifest:');
console.log('  sets       : ' + v.setCount + ' (added Netra 07 = ' + set07Id + ')');
console.log('  records    : ' + v.recCount);
console.log('  refreshed  : ' + stats.updated.length + ' [' + stats.updated.join(', ') + ']');
console.log('  unchanged  : ' + stats.unchanged.length + (stats.unchanged.length ? ' [' + stats.unchanged.join(', ') + ']' : ''));
console.log('  added      : ' + stats.added.length + ' [' + stats.added.join(', ') + ']');
console.log('  round-trip : ' + v.roundtrip.ok + '/' + v.roundtrip.checked + ' code records match source' + (v.roundtrip.fail.length ? ' — FAIL: ' + v.roundtrip.fail.join(', ') : ''));

if (v.problems.length) {
  console.log('\nVALIDATION PROBLEMS (' + v.problems.length + '):');
  for (const p of v.problems.slice(0, 40)) console.log('  ✗ ' + p);
  if (!CHECK && !OUT) process.exit(1);
} else {
  console.log('\nValidation: PASS (well-formed, names consistent, refs resolve, code round-trips)');
}

if (OUT) {
  fs.writeFileSync(OUT, out);
  console.log('\nWrote ' + OUT + ' (' + out.length + ' bytes, ' + out.split('\n').length + ' lines)');
} else {
  console.log('\n(--check only; no file written. Pass --out <path> to write.)');
}
process.exit(v.problems.length && CHECK ? 1 : 0);

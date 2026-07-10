#!/usr/bin/env node
/**
 * deploy-release.mjs — push the Netra source tree to a ServiceNow
 * instance over REST, captured in a named update set.
 *
 * The repo is the source of truth; this replaces the paste-into-Studio
 * loop entirely. Every artifact write is recorded by ServiceNow's
 * update tracking into the "current" update set, which this script
 * creates (or reuses) and selects first — so a run produces a complete,
 * committable release update set on the instance.
 *
 * Usage:
 *   SN_INSTANCE=https://devXXXX.service-now.com \
 *   SN_USER=admin SN_PASS=... \
 *   node netra-snow/scripts/deploy-release.mjs \
 *     [--release "Netra Release X"] [--complete] [--export out.xml] [--dry-run]
 *
 * Flags:
 *   --release NAME   update set name            (default "Netra Release X")
 *   --complete       mark the update set Complete after a verified push
 *   --export FILE    export the update set XML to FILE (implies --complete)
 *   --dry-run        show what would be pushed, write nothing
 *
 * Credentials come ONLY from the environment — never hardcode them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'source');

const INSTANCE = (process.env.SN_INSTANCE || '').replace(/\/+$/, '');
const USER = process.env.SN_USER || '';
const PASS = process.env.SN_PASS || '';
if (!INSTANCE || !USER || !PASS) {
  console.error('Set SN_INSTANCE, SN_USER and SN_PASS in the environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const RELEASE_NAME = opt('--release', 'Netra Release X');
const DRY = flag('--dry-run');
const EXPORT_FILE = opt('--export', null);
const COMPLETE = flag('--complete') || !!EXPORT_FILE;

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function sn(method, path, body) {
  const res = await fetch(`${INSTANCE}${path}`, {
    method,
    headers: {
      Authorization: AUTH,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const one = (r) => (r.result && r.result[0]) || null;

function log(msg) { console.log(msg); }

async function main() {
  log(`Netra deploy -> ${INSTANCE}`);
  log(`Release: "${RELEASE_NAME}"${DRY ? '  (DRY RUN)' : ''}\n`);

  /* 1. Resolve the scoped app */
  const app = one(await sn('GET',
    '/api/now/table/sys_app?sysparm_query=scopeLIKEnetra&sysparm_fields=sys_id,scope,name,version&sysparm_limit=1'));
  if (!app) throw new Error('Netra scoped app not found on instance');
  const SCOPE = app.scope;
  log(`Scoped app: ${app.name} (${SCOPE}) v${app.version} [${app.sys_id}]`);

  const fill = (s) => s.replace(/__NETRA_SCOPE__/g, SCOPE);
  const read = (rel) => fill(readFileSync(join(SRC, rel), 'utf8'));

  /* 2. Ensure the release update set exists + is in progress */
  let us = one(await sn('GET',
    `/api/now/table/sys_update_set?sysparm_query=name=${encodeURIComponent(RELEASE_NAME)}^application=${app.sys_id}&sysparm_fields=sys_id,name,state&sysparm_limit=1`));
  if (!us) {
    if (DRY) { log(`[dry] would create update set "${RELEASE_NAME}"`); }
    else {
      us = (await sn('POST', '/api/now/table/sys_update_set', {
        name: RELEASE_NAME,
        application: app.sys_id,
        state: 'in progress',
        description:
          'Netra R6 "Release X" - complete application snapshot pushed from source control via deploy-release.mjs.\n' +
          'Human turn-taking (barge-in, interjections, turn epochs, pipelined TTS), read-only ticket safety policy, ' +
          'expanded conversation limits, violet voice-ring brand identity.',
      })).result;
      log(`Created update set "${RELEASE_NAME}" [${us.sys_id}]`);
    }
  } else {
    log(`Update set exists [${us.sys_id}] state=${us.state}`);
    if (us.state !== 'in progress' && !DRY) {
      await sn('PATCH', `/api/now/table/sys_update_set/${us.sys_id}`, { state: 'in progress' });
      log('  -> reopened to in progress');
    }
  }

  /* 3. Make it the CURRENT update set for this user so writes are captured */
  const admin = one(await sn('GET',
    `/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(USER)}&sysparm_fields=sys_id&sysparm_limit=1`));
  if (!DRY && us) {
    const pref = one(await sn('GET',
      `/api/now/table/sys_user_preference?sysparm_query=user=${admin.sys_id}^name=sys_update_set&sysparm_fields=sys_id,value&sysparm_limit=1`));
    if (pref) await sn('PATCH', `/api/now/table/sys_user_preference/${pref.sys_id}`, { value: us.sys_id });
    else await sn('POST', '/api/now/table/sys_user_preference', { user: admin.sys_id, name: 'sys_update_set', value: us.sys_id });
    log('Current update set preference -> release set');
  }

  const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  /* 4. Push artifacts */
  const patched = [];
  async function patch(table, sysId, fields, label) {
    if (DRY) { log(`[dry] would PATCH ${table}/${label}`); return; }
    await sn('PATCH', `/api/now/table/${table}/${sysId}`, fields);
    patched.push(label);
    log(`  pushed ${label}`);
  }

  // 4a. Widget
  const widget = one(await sn('GET',
    '/api/now/table/sp_widget?sysparm_query=id=netra-mic&sysparm_fields=sys_id&sysparm_limit=1'));
  if (!widget) throw new Error('sp_widget netra-mic not found');
  await patch('sp_widget', widget.sys_id, {
    template: read('widget/template.html'),
    client_script: read('widget/client.js'),
    script: read('widget/server.js'),
    css: read('widget/stylesheet.scss'),
  }, 'sp_widget netra-mic');

  // 4b. Script Includes
  const INCLUDES = ['NetraIntent', 'NetraTools', 'NetraResponder', 'NetraScanner',
    'NetraKnowledge', 'NetraChat', 'NetraNavigator', 'NetraContext',
    'NetraSummarizer', 'NetraVulnerability'];
  for (const name of INCLUDES) {
    const si = one(await sn('GET',
      `/api/now/table/sys_script_include?sysparm_query=name=${name}^api_name=${SCOPE}.${name}&sysparm_fields=sys_id&sysparm_limit=1`));
    if (!si) { log(`  !! script include ${name} missing on instance - skipped`); continue; }
    await patch('sys_script_include', si.sys_id, { script: read(`script_includes/${name}.js`) }, `sys_script_include ${name}`);
  }

  // 4c. Scripted REST operations
  const OPS = [
    ['command', 'scripted_rest/command.js'],
    ['notifications', 'scripted_rest/notifications.js'],
    ['ping', 'scripted_rest/ping.js'],
  ];
  for (const [opName, rel] of OPS) {
    const op = one(await sn('GET',
      `/api/now/table/sys_ws_operation?sysparm_query=name=${opName}^web_service_definition.name=Netra Voice&sysparm_fields=sys_id,name&sysparm_limit=1`));
    if (!op) { log(`  !! REST op ${opName} missing - skipped`); continue; }
    await patch('sys_ws_operation', op.sys_id, { operation_script: read(rel) }, `sys_ws_operation ${opName}`);
  }

  // 4d. Scheduled job + business rule
  const job = one(await sn('GET',
    '/api/now/table/sysauto_script?sysparm_query=name=Netra Watch&sysparm_fields=sys_id&sysparm_limit=1'));
  if (job) await patch('sysauto_script', job.sys_id, { script: read('scheduled_jobs/netra_watch.js') }, 'sysauto_script Netra Watch');
  const br = one(await sn('GET',
    '/api/now/table/sys_script?sysparm_query=name=Netra Notify On Comment&sysparm_fields=sys_id&sysparm_limit=1'));
  if (br) await patch('sys_script', br.sys_id, { script: read('business_rule/netra_notify_on_comment.js') }, 'sys_script Netra Notify On Comment');

  // 4e. New system property: ticket_writes (Release X safety policy)
  const propName = `${SCOPE}.ticket_writes`;
  const prop = one(await sn('GET',
    `/api/now/table/sys_properties?sysparm_query=name=${propName}&sysparm_fields=sys_id,value&sysparm_limit=1`));
  if (!prop) {
    if (DRY) log(`[dry] would create property ${propName}=false`);
    else {
      await sn('POST', '/api/now/table/sys_properties', {
        name: propName,
        value: 'false',
        type: 'string',
        sys_scope: app.sys_id,
        description:
          'Release X ticket safety policy. Netra is READ-ONLY on tickets: creation is permanently disabled, ' +
          'and modification tools (resolve, comment, reassign, priority, field edits) only exist when this is exactly "true". Default false.',
      });
      patched.push(`sys_properties ${propName}`);
      log(`  created property ${propName}=false`);
    }
  } else {
    log(`  property ${propName} already present (value=${prop.value})`);
  }

  // 4f. Version bump on the app itself
  await patch('sys_app', app.sys_id, {
    version: '3.0.0',
    short_description: 'Netra R6 "Release X" - voice-first assistant with human turn-taking; read-only on tickets.',
  }, 'sys_app version 3.0.0');

  if (DRY) { log('\nDry run complete.'); return; }

  /* 5. Verify capture: every write should have landed in the release set */
  const captured = await sn('GET',
    `/api/now/table/sys_update_xml?sysparm_query=update_set=${us.sys_id}&sysparm_fields=name,type&sysparm_limit=200`);
  const capturedNames = (captured.result || []).map((r) => r.name);
  log(`\nCaptured in "${RELEASE_NAME}": ${capturedNames.length} update records`);

  // Adopt strays: writes that ServiceNow tracked into some other set in
  // this window (e.g. the scope's Default set if the preference did not
  // apply to the API session) are moved into the release set.
  const strays = await sn('GET',
    `/api/now/table/sys_update_xml?sysparm_query=update_set!=${us.sys_id}^sys_updated_on>=${encodeURIComponent(startedAt)}^nameLIKEnetra^ORnameLIKENetra&sysparm_fields=sys_id,name,update_set&sysparm_limit=200`);
  for (const s of strays.result || []) {
    await sn('PATCH', `/api/now/table/sys_update_xml/${s.sys_id}`, { update_set: us.sys_id });
    log(`  adopted stray update: ${s.name}`);
  }

  const finalList = await sn('GET',
    `/api/now/table/sys_update_xml?sysparm_query=update_set=${us.sys_id}&sysparm_fields=name&sysparm_limit=300`);
  log(`Final release contents: ${(finalList.result || []).length} records`);
  for (const r of finalList.result || []) log(`   - ${r.name}`);

  /* 6. Optionally complete + export */
  if (COMPLETE) {
    await sn('PATCH', `/api/now/table/sys_update_set/${us.sys_id}`, { state: 'complete' });
    log(`\nUpdate set "${RELEASE_NAME}" marked COMPLETE.`);
  }
  if (EXPORT_FILE) {
    const res = await fetch(`${INSTANCE}/export_update_set.do?sysparm_sys_id=${us.sys_id}`, {
      headers: { Authorization: AUTH },
    });
    const xml = await res.text();
    if (res.ok && xml.includes('<unload')) {
      writeFileSync(EXPORT_FILE, xml);
      log(`Exported update set XML -> ${EXPORT_FILE} (${(xml.length / 1024).toFixed(0)} KB)`);
    } else {
      log(`!! export endpoint returned ${res.status}; XML not saved`);
    }
  }
  log('\nDeploy complete.');
}

main().catch((e) => { console.error('\nDEPLOY FAILED: ' + e.message); process.exit(1); });

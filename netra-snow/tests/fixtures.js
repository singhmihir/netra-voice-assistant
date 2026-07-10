/**
 * fixtures.js — an in-memory ServiceNow "world" for the Netra unit tests:
 * users/groups/membership, a VR dataset (VITs across bands/states/CIs/CVEs,
 * entries, groups), and scheduled-job/telemetry rows for the perf tests.
 *
 * ref(table, sys_id) builds a reference-field value the mock understands.
 */

function ref(table, sysId) { return { __ref: { table: table, sys_id: sysId } }; }

function buildWorld(o) {
  o = o || {};
  var now = Date.parse('2026-07-10T00:00:00Z');
  function daysAgo(n) { return new Date(now - n * 86400000).toISOString().replace('T', ' ').substring(0, 19); }

  var world = {
    sys_user: [
      { sys_id: 'user_self', name: 'Test Analyst', user_name: 'tanalyst', email: 'tanalyst@example.com', active: true },
      { sys_id: 'user_pat', name: 'Pat Kumar', user_name: 'pkumar', email: 'pat@example.com', active: true },
      { sys_id: 'user_pat2', name: 'Pat Singh', user_name: 'psingh', email: 'pats@example.com', active: true },
      { sys_id: 'user_lee', name: 'Lee Fox', user_name: 'lfox', email: 'lee@example.com', active: true }
    ],
    sys_user_group: [
      { sys_id: 'grp_sec', name: 'Security Operations', active: true },
      { sys_id: 'grp_seceng', name: 'Security Engineering', active: true },
      { sys_id: 'grp_net', name: 'Network Team', active: true }
    ],
    sys_user_grmember: [
      { sys_id: 'gm1', user: 'user_self', group: 'grp_sec' }
    ],
    cmdb_ci: [
      { sys_id: 'ci_web1', name: 'web-prod-01' },
      { sys_id: 'ci_db1', name: 'db-prod-01' },
      { sys_id: 'ci_app1', name: 'app-prod-02' }
    ],
    sn_vul_entry: [
      { sys_id: 'ent_log4j', id: 'CVE-2021-44228', summary: 'Apache Log4j2 JNDI remote code execution (Log4Shell).', source: 'NVD', solution: '<p>Upgrade to Log4j 2.17.1 or later.</p>' },
      { sys_id: 'ent_ssl', id: 'CVE-2014-0160', summary: 'OpenSSL Heartbleed information disclosure.', source: 'NVD', solution: 'Upgrade OpenSSL and rotate keys.' },
      { sys_id: 'ent_win', id: 'CVE-2014-0322', summary: 'Microsoft Internet Explorer use-after-free.', source: 'NVD', solution: 'Apply MS14-012.' },
      { sys_id: 'ent_struts', id: 'CVE-2017-5638', summary: 'Apache Struts2 Jakarta multipart parser RCE.', source: 'NVD', solution: 'Upgrade Struts.' }
    ],
    sn_vul_vulnerability_group: [
      { sys_id: 'vg_log4j', number: 'VULG0001001', short_description: 'Log4Shell remediation', state: '1', active: true, assignment_group: ref('sys_user_group', 'grp_sec'), assigned_to: ref('sys_user', 'user_self'), state__display: 'Open' },
      { sys_id: 'vg_ssl', number: 'VULG0001002', short_description: 'Heartbleed cleanup', state: '3', active: true, state__display: 'Closed' }
    ],
    sn_vul_vulnerable_item: [],
    change_request: [],
    // ---- perf world ----
    sysauto: [],
    sysauto_script: [],
    sys_trigger: [],
    syslog_transaction: [],
    scheduled_import_set: [
      { sys_id: 'si1', name: 'Nightly CMDB import', active: true },
      { sys_id: 'si2', name: 'HR employee import', active: true }
    ],
    ldap_server_config: [{ sys_id: 'ldap1', name: 'Corp AD' }],
    sys_rest_message: [
      { sys_id: 'rm1', name: 'Weather API' },
      { sys_id: 'rm2', name: 'Netra internal (unused)' }
    ],
    ecc_agent: [{ sys_id: 'mid1', name: 'MID-01' }]
  };

  // ---- VITs: 15 across bands/states/CIs/CVEs ----
  var vits = [
    // number, risk, state, ci, entry, group(sys_user_group), assigned_to, ageDays
    ['VIT0000001', 95, '1', 'ci_web1', 'ent_log4j', 'grp_sec', 'user_self', 120],
    ['VIT0000002', 88, '2', 'ci_web1', 'ent_log4j', 'grp_sec', 'user_self', 95],
    ['VIT0000003', 82, '1', 'ci_db1', 'ent_struts', 'grp_seceng', '', 40],
    ['VIT0000004', 75, '1', 'ci_app1', 'ent_ssl', 'grp_sec', 'user_self', 12],
    ['VIT0000005', 68, '2', 'ci_db1', 'ent_ssl', 'grp_seceng', 'user_pat', 8],
    ['VIT0000006', 61, '10', 'ci_web1', 'ent_win', 'grp_sec', 'user_self', 3],
    ['VIT0000007', 55, '1', 'ci_app1', 'ent_struts', 'grp_net', '', 45],
    ['VIT0000008', 48, '1', 'ci_db1', 'ent_win', 'grp_sec', 'user_self', 200],
    ['VIT0000009', 42, '11', 'ci_web1', 'ent_ssl', 'grp_seceng', 'user_pat', 60],
    ['VIT0000010', 35, '1', 'ci_app1', 'ent_win', 'grp_net', '', 5],
    ['VIT0000011', 90, '1', 'ci_db1', 'ent_log4j', 'grp_sec', 'user_self', 15],
    ['VIT0000012', 20, '12', 'ci_app1', 'ent_win', 'grp_sec', 'user_self', 70],  // deferred
    ['VIT0000013', 78, '101', 'ci_web1', 'ent_struts', 'grp_sec', 'user_self', 30], // resolved
    ['VIT0000014', 66, '3', 'ci_db1', 'ent_ssl', 'grp_seceng', 'user_pat', 90],   // closed
    ['VIT0000015', 85, '1', 'ci_web1', 'ent_log4j', 'grp_seceng', '', 22]
  ];
  var withSubstate = o.substate !== false; // default: substate field present
  vits.forEach(function (v, i) {
    var closed = (v[2] === '3' || v[2] === '101');
    var row = {
      sys_id: 'vit_' + (i + 1),
      number: v[0],
      short_description: 'Vulnerable item ' + v[0] + ' on host',
      risk_score: v[1],
      state: v[2],
      active: !closed,
      cmdb_ci: ref('cmdb_ci', v[3]),
      vulnerability: ref('sn_vul_entry', v[4]),
      assignment_group: v[5] ? ref('sys_user_group', v[5]) : '',
      assigned_to: v[6] ? ref('sys_user', v[6]) : '',
      first_found: daysAgo(v[7]),
      sys_created_on: daysAgo(v[7]),
      sys_updated_on: daysAgo(Math.max(0, v[7] - 1)),
      work_notes: '',
      vulnerability_group: (v[4] === 'ent_log4j') ? ref('sn_vul_vulnerability_group', 'vg_log4j') : ''
    };
    if (closed) { row.closed_at = daysAgo(Math.max(0, v[7] - 5)); row.close_notes = ''; }
    if (withSubstate) row.substate = '';
    world.sn_vul_vulnerable_item.push(row);
  });

  // ---- scheduled jobs for perf tests ----
  var jobs = [
    // name, active, scope, repeat(seconds via glide dur)
    ['Netra Watch', true, 'Netra Voice Assistant', '1970-01-01 00:03:00'],
    ['Trident Nightly Sync', true, 'Trident', '1970-01-02 00:00:00'],
    ['NVD Auto-Update', true, 'Vulnerability Response', '1970-01-01 06:00:00'],
    ['SLA Update Engine', true, 'Global', '1970-01-01 00:01:00'],
    ['Text Index Events Process', true, 'Global', '1970-01-01 00:00:30'],
    ['Email Reader (SMTP)', true, 'Global', '1970-01-01 00:02:00'],
    ['Table Cleaner', true, 'Global', '1970-01-02 00:00:00'],
    ['PA Daily Data Collection', true, 'Performance Analytics', '1970-01-02 00:00:00'],
    ['Predictive Intelligence ML Training', true, 'Global', '1970-01-08 00:00:00'],
    ['Agent Client Collector telemetry', true, 'Global', '1970-01-01 00:05:00'],
    ['Benchmarks upload', true, 'Global', '1970-01-08 00:00:00'],
    ['Cross-Scope Privilege Auto-Healer (temporary)', true, 'Global', '1970-01-01 00:05:00'],
    ['Some Custom Report Blast', true, 'Global', '1970-01-02 00:00:00']
  ];
  jobs.forEach(function (j, i) {
    var row = { sys_id: 'job_' + (i + 1), name: j[0], active: j[1], sys_scope: ref('__scope', 'sc_' + i), run_type: 'periodically' };
    // give sys_scope a display via a scope table row
    world['__scope'] = world['__scope'] || [];
    world['__scope'].push({ sys_id: 'sc_' + i, name: j[2] });
    world.sysauto.push(row);
    world.sysauto_script.push({ sys_id: 'jobs_' + (i + 1), name: j[0], active: j[1], sys_scope: ref('__scope', 'sc_' + i) });
    world.sys_trigger.push({ sys_id: 'trg_' + (i + 1), name: j[0], trigger_type: 1, repeat: j[3], next_action: daysAgo(-0.01) });
  });

  // slow transactions
  world.syslog_transaction = [
    { sys_id: 'tx1', response_time: 8200, url: '/nav_to.do?uri=incident_list.do', sys_created_on: daysAgo(0.2) },
    { sys_id: 'tx2', response_time: 6100, url: '/sp?id=netra', sys_created_on: daysAgo(0.5) },
    { sys_id: 'tx3', response_time: 3000, url: '/fast.do', sys_created_on: daysAgo(0.1) } // under 5s, excluded
  ];

  return world;
}

// schema flags for isValidField per table (controls defensive-field branches)
function schema(o) {
  o = o || {};
  var vit = {
    number: true, sys_id: true, short_description: true, risk_score: true, state: true,
    active: true, cmdb_ci: true, vulnerability: true, assignment_group: true, assigned_to: true,
    first_found: true, sys_created_on: true, sys_updated_on: true, work_notes: true,
    vulnerability_group: true, closed_at: true, close_notes: true,
    substate: o.substate !== false,
    remediation_target: o.remediation_target === true,
    change_request: o.change_request !== false
  };
  return {
    sn_vul_vulnerable_item: vit,
    sn_vul_entry: { id: true, summary: true, source: true, solution: true, sys_id: true },
    sn_vul_vulnerability_group: { number: true, short_description: true, state: true, active: true, assignment_group: true, assigned_to: true, sys_id: true },
    change_request: { short_description: true, description: true, type: true, cmdb_ci: true, assignment_group: true, number: true, sys_id: true },
    sysauto: { name: true, active: true, sys_scope: true, run_type: true, sys_id: true },
    sysauto_script: { name: true, active: true, sys_scope: true, sys_id: true },
    sys_trigger: { name: true, trigger_type: true, repeat: true, next_action: true, sys_id: true },
    syslog_transaction: { response_time: true, url: true, sys_created_on: true, sys_id: true },
    scheduled_import_set: { name: true, active: true, sys_id: true },
    ldap_server_config: { name: true, sys_id: true },
    sys_rest_message: { name: true, sys_id: true },
    ecc_agent: { name: true, sys_id: true },
    sys_user: { name: true, user_name: true, email: true, active: true, sys_id: true },
    sys_user_group: { name: true, active: true, sys_id: true },
    sys_user_grmember: { user: true, group: true, sys_id: true },
    cmdb_ci: { name: true, sys_id: true }
  };
}

var choiceLabels = {
  state: {
    '1': 'Open', '2': 'Under Investigation', '3': 'Closed', '10': 'Awaiting Implementation',
    '11': 'In Review', '12': 'Deferred', '101': 'Resolved'
  }
};

module.exports = { buildWorld: buildWorld, schema: schema, choiceLabels: choiceLabels, ref: ref, now: Date.parse('2026-07-10T00:00:00Z') };

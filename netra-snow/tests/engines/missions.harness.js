// Mock-Glide harness for NetraMissionRunner / NetraSemantic (node, no instance)
var fs = require('fs');
var assert = require('assert');
var DIR = require('path').join(__dirname, '..', '..', 'source', 'script_includes') + '/';

var PROPS = { 'x_196061_netra_v1.ticket_writes': 'true' };
var STORE = {};           // table -> sys_id -> rec
var HOOKS = {};           // table -> fn(rec, changed) after update
var NOW = Date.UTC(2026, 8, 23, 20, 0);
var guid = 0;
function id() { guid++; var s = String(guid); while (s.length < 32) s = '0' + s; return s; }

global.gs = {
  getProperty: function (k, d) { return PROPS.hasOwnProperty(k) ? PROPS[k] : d; },
  info: function () {}, warn: function (m) { WARN.push(m); }, error: function () {},
  generateGUID: function () { return id(); }
};
var WARN = [];
global.Class = { create: function () { return function () { this.initialize.apply(this, arguments); }; } };
function GDT(s) { this._ms = (s === undefined) ? NOW : Date.parse(String(s).replace(' ', 'T') + 'Z'); }
GDT.prototype.getNumericValue = function () { return this._ms; };
GDT.prototype.toString = function () { return new Date(this._ms).toISOString().replace('T', ' ').substring(0, 19); };
GDT.prototype.addSeconds = function (s) { this._ms += s * 1000; };
global.GlideDateTime = GDT;
function fmt(ms) { return new Date(ms).toISOString().replace('T', ' ').substring(0, 19); }

var DATE_FIELDS = { lease_until: 1, next_check_at: 1, expires_at: 1, opened_at: 1, embedded_at: 1 };
var DISPLAY = {};   // sys_id -> display name (for references)

function GR(table) {
  var self = { _t: table, _rec: null, _q: [], _rows: null, _i: -1, _limit: 1e9, _order: null };
  var api = {
    initialize: function () { self._rec = { sys_mod_count: 0 }; },
    isValid: function () { return true; },
    isValidField: function (f) { return f !== 'nope'; },
    canRead: function () { return true; },
    canWrite: function () { return true; },
    get: function (a, b) {
      var sid = (b === undefined) ? a : null;
      var t = STORE[table] || {};
      if (sid && t[sid]) { self._rec = JSON.parse(JSON.stringify(t[sid])); return true; }
      self._rec = null; return false;
    },
    getValue: function (f) { var v = self._rec ? self._rec[f] : null; return (v === undefined || v === '') ? null : (v === null ? null : String(v)); },
    setValue: function (f, v) { self._rec[f] = v; },
    getUniqueValue: function () { return self._rec.sys_id; },
    getTableName: function () { return table; },
    insert: function () {
      var sid = self._rec.sys_id || id(); self._rec.sys_id = sid;
      STORE[table] = STORE[table] || {}; STORE[table][sid] = JSON.parse(JSON.stringify(self._rec)); return sid;
    },
    update: function () {
      var t = STORE[table]; var old = t[self._rec.sys_id];
      var changed = {}; for (var k in self._rec) if (String(self._rec[k]) !== String(old[k])) changed[k] = 1;
      self._rec.sys_mod_count = (parseInt(old.sys_mod_count, 10) || 0) + 1;
      if (self._rec.work_notes) { (self._rec._notes = self._rec._notes || []).push(self._rec.work_notes); self._rec.work_notes = ''; }
      t[self._rec.sys_id] = JSON.parse(JSON.stringify(self._rec));
      if (HOOKS[table]) HOOKS[table](t[self._rec.sys_id], changed);
      return self._rec.sys_id;
    },
    addQuery: function (f, op, v) { if (v === undefined) { v = op; op = '='; } self._q.push([f, op, v]); },
    addEncodedQuery: function () {}, addActiveQuery: function () { self._q.push(['active', '=', 'true']); },
    orderBy: function (f) { self._order = f; }, orderByDesc: function (f) { self._order = f; },
    setLimit: function (n) { self._limit = n; },
    query: function () {
      var t = STORE[table] || {}, rows = [];
      for (var k in t) {
        var r = t[k], ok = true;
        for (var i = 0; i < self._q.length; i++) {
          var q = self._q[i], val = String(r[q[0]] === undefined ? '' : r[q[0]]);
          if (q[1] === 'IN') { if (String(q[2]).split(',').indexOf(val) === -1) ok = false; }
          else if (val !== String(q[2])) ok = false;
        }
        if (ok) rows.push(r);
      }
      if (self._order) rows.sort(function (a, b) { return (a[self._order] > b[self._order]) ? 1 : -1; });
      self._rows = rows.slice(0, self._limit); self._i = -1;
    },
    next: function () { self._i++; if (self._i < self._rows.length) { self._rec = JSON.parse(JSON.stringify(self._rows[self._i])); return true; } return false; }
  };
  return new Proxy(api, {
    get: function (o, p) {
      if (p in o) return o[p];
      if (typeof p !== 'string') return undefined;
      var v = self._rec ? self._rec[p] : undefined;
      return {
        toString: function () { return v === undefined || v === null ? '' : String(v); },
        valueOf: function () { return this.toString(); },
        getDisplayValue: function () { return DISPLAY[v] || (v ? String(v) : ''); },
        setDateNumericValue: function (ms) { self._rec[p] = fmt(ms); }
      };
    },
    set: function (o, p, v) { self._rec[p] = (v && v.toString && typeof v === 'object') ? v.toString() : v; return true; }
  });
}
global.GlideRecord = GR;
global.GlideRecordSecure = GR;   // no ACLs in this harness: the user may do everything
global.GlideAggregate = function (t) { var g = GR(t); var n = 0; return { addAggregate: function () {}, addEncodedQuery: function () {}, query: function () { n = Object.keys(STORE[t] || {}).length; }, next: function () { return true; }, getAggregate: function () { return String(n); } }; };

eval(fs.readFileSync(DIR + 'NetraTaskRunner.js', 'utf8').replace(/^var NetraTaskRunner/m, 'global.NetraTaskRunner'));
eval(fs.readFileSync(DIR + 'NetraMissionRunner.js', 'utf8').replace(/^var NetraMissionRunner/m, 'global.NetraMissionRunner'));
eval(fs.readFileSync(DIR + 'NetraSemantic.js', 'utf8').replace(/^var NetraSemantic/m, 'global.NetraSemantic'));

var M = new NetraMissionRunner();
var pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

// ---- pure ----
ok(M.nextPtMidnightMs(Date.UTC(2026, 8, 23, 20, 0)) === Date.UTC(2026, 8, 24, 7, 0), 'PDT midnight');
ok(M.nextPtMidnightMs(Date.UTC(2026, 11, 1, 12, 0)) === Date.UTC(2026, 11, 2, 8, 0), 'PST midnight');
ok(M._ntKey('14') === 'NT0014' && M._ntKey('00014') === 'NT0014' && M._ntKey('NT0014') === 'NT0014', 'ntKey');
var S = new NetraSemantic();
var pr = S.parseRetry(JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }, { violations: [{ quotaId: 'EmbedContentRequestsPerMinutePerProjectPerModel' }] }] } }));
ok(pr.retry_ms === 31000 && pr.quota_kind === 'per_minute', 'parseRetry');

// triage voters: 9 unassigned lookalikes + 1 assigned one must not be write-confident
S.semanticIncidents = function () {
  var m = []; for (var i = 0; i < 9; i++) m.push({ number: 'INC9' + i, assignment_group: '', category: 'network', priority: '3', score: 0.9 });
  m.push({ number: 'INC77', assignment_group: 'Network', group_id: 'g1', category: 'network', priority: '3', score: 0.8 });
  return { ok: true, matches: m, count: m.length, stats: {} };
};
var tri = S.triageVotes('vpn down', {});
ok(tri.confident === true && tri.voters === 1, 'triage flag itself unchanged (widget parity), voters=1');
var bf = M.buildFindings('vpn down', tri, null, null, {}, NOW);
ok(bf.proposal.confident === false && bf.proposal.group === 'Network', 'mission refuses one-voter confidence');
ok(/too thin or too split/.test(M.reportLine({ number: 'INC1', state: 'reviewed', proposal: bf.proposal })), 'report wording');

// log cap
var fake = { action_log: '[]' };
for (var L = 0; L < 60; L++) M._log(fake, new Array(290).join('x'));
ok(fake.action_log.length <= 8000 && JSON.parse(fake.action_log).length > 5, 'action_log fits column');

// ---- apply path with the mock store ----
function seedTicket(extra) {
  var sid = id();
  STORE.incident = STORE.incident || {};
  var r = { sys_id: sid, number: 'INC' + sid.substring(26), active: 'true', assignment_group: '', assigned_to: '', category: 'inquiry',
            priority: '4', impact: '2', urgency: '3', sys_mod_count: 5, short_description: 'vpn drops' };
  for (var k in extra || {}) r[k] = extra[k];
  STORE.incident[sid] = r; return sid;
}
STORE.sys_user_group = { g1: { sys_id: 'g1', active: 'true', name: 'Network' } }; DISPLAY.g1 = 'Network';
STORE.sys_user = { u1: { sys_id: 'u1', first_name: 'Mihir', name: 'Mihir S' } };
function seedItem(tid, conf) {
  var it = GR(M.ITEM); it.initialize();
  it.mission = 'H1'; it.seq = 1; it.target_table = 'incident'; it.target_sys_id = tid; it.target_number = 'INCx';
  it.state = 'reviewed'; it.mod_count_at_review = 5; it.attempts = 0;
  it.findings_json = JSON.stringify({ sd: 'vpn', proposal: { group: 'Network', group_id: 'g1', group_share: 0.8, category: 'network', category_share: 0.7,
        priority: '3', priority_share: 0.7, cur_priority: '4', confident: conf !== false, evidence: ['INC1', 'INC2', 'INC3'], voters: 3 }, duplicate_of: null, known_fix: null });
  it.undo_json = '';
  return String(it.insert());
}
function item(iid) { return STORE[M.ITEM][iid]; }

// 1. normal apply + undo
var t1 = seedTicket(); var i1 = seedItem(t1);
var r1 = M._applyItem(i1, 'NT0014', 'Mihir');
ok(r1.status === 'applied' && STORE.incident[t1].assignment_group === 'g1' && STORE.incident[t1].category === 'network', 'applied');
ok(STORE.incident[t1].priority === '3', 'priority set');
ok(/closed with the note|routed this to Network/.test(STORE.incident[t1]._notes.join(' ')), 'work note');
var u1 = JSON.parse(item(i1).undo_json); ok(!u1.pending && u1.mod_after === STORE.incident[t1].sys_mod_count, 'undo recorded');
var ur = M._undoItem({ sys_id: i1, target_table: 'incident', target_sys_id: t1 }, u1, 'NT0014', 'Mihir');
ok(ur === 'restored' && STORE.incident[t1].assignment_group === '' && STORE.incident[t1].category === 'inquiry' && STORE.incident[t1].priority === '4', 'undo restored');

// 2. human touched after review -> skip, no write
var t2 = seedTicket({ sys_mod_count: 6 }); var i2 = seedItem(t2);
ok(M._applyItem(i2, 'NT0014', 'Mihir').status === 'skipped' && STORE.incident[t2].assignment_group === '', 'mod_count guard');
ok(JSON.parse(item(i2).findings_json).skip_reason === 'someone changed it after my review', 'skip reason');

// 3. kill switch -> hold, nothing written
PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
var t3 = seedTicket(); var i3 = seedItem(t3);
var r3 = M._applyItem(i3, 'NT0014', 'Mihir');
ok(r3.hold && STORE.incident[t3].assignment_group === '' && item(i3).undo_json === '', 'kill switch');
PROPS['x_196061_netra_v1.ticket_writes'] = 'true';

// 4. not confident -> never written
var t4 = seedTicket(); var i4 = seedItem(t4, false);
ok(M._applyItem(i4, 'NT0014', 'Mihir').status === 'noop' && STORE.incident[t4].assignment_group === '', 'non-confident noop');

// 5. someone re-routes right after our write -> group NOT in undo
var t5 = seedTicket(); var i5 = seedItem(t5); var fired = false;
HOOKS.incident = function (rec, ch) { if (rec.sys_id === t5 && ch.assignment_group && rec.assignment_group === 'g1' && !fired) { fired = true; rec.assignment_group = 'g9'; rec.sys_mod_count++; } };
var r5 = M._applyItem(i5, 'NT0014', 'Mihir'); HOOKS.incident = null;
var u5 = item(i5).undo_json ? JSON.parse(item(i5).undo_json) : null;
ok(r5.status === 'error' && (!u5 || !u5.restore.hasOwnProperty('assignment_group')), 'never restores over their group');

// 6. pending recovery with extra changes -> error, no undo
var t6 = seedTicket({ assignment_group: 'g1', sys_mod_count: 7 }); var i6 = seedItem(t6);
STORE[M.ITEM][i6].undo_json = JSON.stringify({ t: 'incident', id: t6, restore: { assignment_group: '' }, set: { assignment_group: 'g1' }, pending: true });
ok(M._applyItem(i6, 'NT0014', 'Mihir').status === 'error' && item(i6).undo_json === '', 'pending recovery refuses when mod_count jumped');
var t7 = seedTicket({ assignment_group: 'g1', sys_mod_count: 6 }); var i7 = seedItem(t7);
STORE[M.ITEM][i7].undo_json = JSON.stringify({ t: 'incident', id: t7, restore: { assignment_group: '' }, set: { assignment_group: 'g1' }, pending: true });
ok(M._applyItem(i7, 'NT0014', 'Mihir').status === 'applied', 'pending recovery accepts exactly one write');

// 7. priority stomped by a lookup AND matrix fails AND a rule will not let
//    urgency go back -> the moved urgency stays undoable
var t8 = seedTicket(); var i8 = seedItem(t8);
HOOKS.incident = function (rec, changed) { if (rec.sys_id === t8) { rec.priority = '4'; if (changed.urgency) rec.urgency = '2'; } };   // derived priority never moves
var r8 = M._applyItem(i8, 'NT0014', 'Mihir'); HOOKS.incident = null;
var u8 = JSON.parse(item(i8).undo_json);
console.log(JSON.stringify(u8), JSON.parse(item(i8).findings_json).applied.notes); ok(r8.status === 'applied' && u8.restore.urgency === '3' && !u8.restore.hasOwnProperty('impact') && u8.set.urgency === '2', 'matrix leftovers undoable');

// 8. launch: header born with the launch lease, released after items exist
STORE[M.TASK] = {};
var t9 = seedTicket(); STORE.incident[t9].opened_at = '2026-09-01 00:00:00';
M._queue = function () { return { ok: true, rows: [{ sys_id: t9, number: 'INC9', short_description: 'x', opened_ms: 0 }], total: 1, sources: {} }; };
var L1 = M.launch('u1', 'work through the unassigned queue');
var hdr = STORE[M.TASK][Object.keys(STORE[M.TASK])[0]];
var hc = JSON.parse(hdr.condition_json);
ok(L1.ok && hdr.state === 'running' && hc.lease_owner === '' && hc.lease_until_ms === 0 && hc.counts.total === 1, 'launch lease released');

console.log('mission harness: ' + pass + ' checks passed');

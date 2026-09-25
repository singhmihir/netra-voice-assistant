const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'source', 'script_includes', 'NetraBrain.js'), 'utf8');
// minimal ServiceNow shims
global.Class = { create: () => function () { this.initialize.apply(this, arguments); } };
const DB = [];
global.gs = { warn: m => console.log('WARN', m), info: () => {} };
global.GlideDateTime = function (v) { this.v = v; };
GlideDateTime.prototype.getNumericValue = function () { return Date.parse(this.v.replace(' ', 'T') + 'Z'); };
function Elem(rec, f) { this.rec = rec; this.f = f; }
Elem.prototype.setDateNumericValue = function (ms) { this.rec.data[this.f] = new Date(ms).toISOString().slice(0,19).replace('T',' '); };
global.GlideRecord = function () { this.data = {}; this._rows = null; this._i = -1; this._q = []; };
const P = GlideRecord.prototype;
P.setLimit = function(){}; P.addQuery = function(f,v){ this._q.push([f,v]); };
P.query = function(){ this._rows = DB.filter(r => this._q.every(([f,v]) => r[f] === v)); this._i = -1; };
P.next = function(){ this._i++; if (this._i < this._rows.length) { this._load(this._rows[this._i]); return true; } return false; };
P._load = function(row){ this.data = row; const self=this; Object.keys(row).forEach(k => { self[k] = row[k]; });
  ['dead_until','last_ok_at'].forEach(f => self[f] = new Elem(self, f)); };
P.get = function(id){ const r = DB.find(x => x.sys_id === id); if (!r) return false; this._load(r); return true; };
P.getValue = function(f){ return this.data[f] === undefined ? null : (this.data[f] === '' ? null : String(this.data[f])); };
P.setValue = function(f,v){ this.data[f] = v; };
P.initialize = function(){ this.data = {}; const self=this; ['dead_until','last_ok_at'].forEach(f => self[f] = new Elem(self, f)); };
P.update = function(){ const d=this.data, self=this; ['key','state','reason','day_key','used_today','fails_today','quota_limit','last_err','avg_ms'].forEach(k=>{ if (self[k]!==undefined && typeof self[k] !== 'object') d[k]=self[k]; }); };
P.insert = function(){ this.data.sys_id = 'id' + (DB.length+1); this.update(); DB.push(this.data); return this.data.sys_id; };
eval(src + '\nglobal.NetraBrain = NetraBrain;');

let fails = 0;
function eq(label, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok?'PASS ':'FAIL ') + label + (ok?'':'  got='+JSON.stringify(got)+' want='+JSON.stringify(want))); }

eq('PDT reset 2026-09-23 20:00Z', NetraBrain.nextPtMidnightMs(Date.UTC(2026,8,23,20,0)), Date.UTC(2026,8,24,7,0));
eq('PST reset 2026-12-01 12:00Z', NetraBrain.nextPtMidnightMs(Date.UTC(2026,11,1,12,0)), Date.UTC(2026,11,2,8,0));
eq('just after reset 07:30Z',     NetraBrain.nextPtMidnightMs(Date.UTC(2026,8,24,7,30)), Date.UTC(2026,8,25,7,0));
eq('fall-back night: Nov 1 2026 07:30Z (still PDT Oct 31 local) -> Nov 1 local midnight in PDT', NetraBrain.nextPtMidnightMs(Date.UTC(2026,10,1,6,30)), Date.UTC(2026,10,1,7,0));
eq('reset landing after fall-back uses PST', NetraBrain.nextPtMidnightMs(Date.UTC(2026,10,1,12,0)), Date.UTC(2026,10,2,8,0));
eq('spring-forward: Mar 8 2026 12:00Z -> Mar 9 07:00Z', NetraBrain.nextPtMidnightMs(Date.UTC(2026,2,8,12,0)), Date.UTC(2026,2,9,7,0));
eq('day key at 06:59Z is previous PT day', NetraBrain.ptDayKey(Date.UTC(2026,8,24,6,59)), '2026-09-23');
eq('day key at 07:01Z is new PT day', NetraBrain.ptDayKey(Date.UTC(2026,8,24,7,1)), '2026-09-24');

const realDay = JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[
  {'@type':'type.googleapis.com/google.rpc.Help'},
  {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier',quotaValue:'20'}]},
  {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'9s'}]}});
eq('parse429 per_day', NetraBrain.parse429(realDay), {kind:'per_day',retry_ms:9000,limit:20,quota_id:'GenerateRequestsPerDayPerProjectPerModel-FreeTier'});
const perMin = JSON.stringify({error:{details:[{'@type':'x.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',quotaValue:'10'}]},{'@type':'x.RetryInfo',retryDelay:'31s'}]}});
eq('parse429 per_minute', NetraBrain.parse429(perMin).kind + '/' + NetraBrain.parse429(perMin).retry_ms, 'per_minute/31000');
eq('parse429 garbage', NetraBrain.parse429('<html>').kind, 'unknown');

const now = Date.UTC(2026,8,23,18,0);
const b = new NetraBrain();
b.recordFail('gemini-2.5-flash-lite', 429, realDay, now);
b.recordFail('gemini-3.6-flash', 429, perMin, now);
const pick = b.pickChain(['gemini-2.5-flash-lite','gemini-3.6-flash','gemini-3-flash-preview'], now);
eq('pickChain skips both', pick.tryList, ['gemini-3-flash-preview']);
eq('skipped count', pick.skipped.length, 2);
eq('per_minute rest is 31s', b.restingInfo('gemini-3.6-flash', now + 30000).resting, true);
eq('per_minute rest over after 32s', b.restingInfo('gemini-3.6-flash', now + 32000).resting, false);
eq('per_day rest until reset', b.restingInfo('gemini-2.5-flash-lite', now).until_ms, Date.UTC(2026,8,24,7,0));
eq('learned limit stored', b.rows['gemini-2.5-flash-lite'].quota_limit, 20);
b.flush();
eq('flush wrote 2 rows', DB.length, 2);
// reload from "DB" in a new request
const b2 = new NetraBrain();
eq('reload keeps rest', b2.restingInfo('gemini-2.5-flash-lite', now + 3600000).resting, true);
eq('new PT day revives per_day', b2.restingInfo('gemini-2.5-flash-lite', Date.UTC(2026,8,24,7,5)).resting, false);
// learned limit pre-emptive rest
const b3 = new NetraBrain(); b3.rows = {}; 
const k='gemini-x'; b3._row(k, now).quota_limit = 2; b3.recordOk(k, 500, now); b3.recordOk(k, 700, now);
eq('limit reached -> resting without calling', b3.restingInfo(k, now).reason, 'limit');
eq('400 does not rest a model', (b3.recordFail('gemini-y', 400, '{}', now), b3.restingInfo('gemini-y', now).resting), false);
eq('503 cools 30s', (b3.recordFail('gemini-z', 503, '{}', now), b3.restingInfo('gemini-z', now+29000).resting), true);
eq('all resting -> soonest until', b3.pickChain(['gemini-z'], now).all_resting_until_ms, now+30000);

// R18 review: a per-minute 429 must not become the daily cap
(function () {
  const pm = JSON.stringify({ error: { code: 429, details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' } ] } });
  const q = NetraBrain.parse429(pm);
  eq('per-minute parse kind', q.kind, 'per_minute');
  const b = new NetraBrain(); b.rows = {};
  const now = Date.UTC(2026, 8, 23, 20, 0);
  for (let i = 0; i < 6; i++) b.recordOk('gemini-rpm-test', 500, now);
  b.recordFail('gemini-rpm-test', 429, pm, now);
  eq('per-minute keeps quota_limit unset', b.rows['gemini-rpm-test'].quota_limit || 0, 0);
  const after = b.pickChain(['gemini-rpm-test'], now + 40000);
  eq('per-minute rest is short (usable after 40s)', after.tryList, ['gemini-rpm-test']);
  // both quotas in one body, per-minute listed first: daily must win
  const both = JSON.stringify({ error: { code: 429, details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' },
      { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' } ] } ] } });
  const q2 = NetraBrain.parse429(both);
  eq('mixed violations -> per_day wins', [q2.kind, q2.limit], ['per_day', 20]);
})();
(function () {
  var b = new NetraBrain(); b.rows = {};
  var d1 = Date.UTC(2026, 8, 23, 20, 0);
  b.recordOk('gemini-heal', 500, d1);
  b.rows['gemini-heal'].quota_limit = 5;   // a per-minute value stored by an older build
  var d2 = Date.UTC(2026, 8, 24, 20, 0);   // next Pacific day
  for (var i = 0; i < 6; i++) b.recordOk('gemini-heal', 500, d2);
  eq('stale daily cap cleared at rollover', b.pickChain(['gemini-heal'], d2).tryList, ['gemini-heal']);
})();
console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

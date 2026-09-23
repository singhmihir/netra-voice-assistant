// reuse the mission harness mocks, then drive NetraSemantic for real
var src = require('fs').readFileSync(__dirname + '/missions.harness.js', 'utf8');
src = src.split('// ---- pure ----')[0];
eval(src);
var assert = require('assert'); var n = 0; function ok(c, m) { assert.ok(c, m); n++; }
function unit(v) { var s = 0; for (var i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s); return v.map(function (x) { return x / s; }); }
var DIM = 768; function vec(k) { var v = []; for (var i = 0; i < DIM; i++) v.push(i === k ? 1 : (i === k + 1 ? 0.2 : 0)); return unit(v); }
var HTTP = { calls: 0, code: 200, body: null };
global.sn_ws = { RESTMessageV2: function () { return { setEndpoint: function () {}, setHttpMethod: function () {}, setRequestHeader: function () {}, setRequestBody: function () {}, setHttpTimeout: function () {},
  execute: function () { HTTP.calls++; return { getStatusCode: function () { return HTTP.code; }, getBody: function () { return HTTP.code === 200 ? JSON.stringify({ embedding: { values: vec(0).map(function (x) { return x * 3; }) } }) : HTTP.body; } }; } }; } };
PROPS['x_196061_netra_v1.gemini_api_key'] = 'k';
STORE.incident = {}; STORE.x_196061_netra_v1_kb_embedding = {};
function inc(sid, state, active, notes, v) {
  STORE.incident[sid] = { sys_id: sid, number: 'INC' + sid, state: state, active: active, short_description: 'vpn ' + sid, close_notes: notes || '', assignment_group: '', sys_mod_count: 0, sys_updated_on: sid };
  if (v) STORE.x_196061_netra_v1_kb_embedding['e' + sid] = { sys_id: 'e' + sid, source_table: 'incident', source_sys_id: sid, model: 'gemini-embedding-001', embedding: JSON.stringify(v) };
}
inc('a1', '6', 'false', 'rebooted the vpn concentrator', vec(0));
inc('a2', '2', 'true', '', vec(0));            // open, same vector: must NOT appear in resolved
inc('a3', '7', 'false', '', null);             // resolved, uncached -> live embed
inc('a4', '7', 'false', '', null);             // resolved, uncached -> over budget
var S = new NetraSemantic();
var r = S.findSimilarResolved('vpn broken', 3, { maxLive: 1 });
ok(r.ok, 'ok');
var nums = r.matches.map(function (m) { return m.number; });
ok(nums.indexOf('INCa2') === -1, 'open ticket excluded from resolved search: ' + nums);
ok(nums[0] === 'INCa1' && r.matches[0].close_notes, 'with-fix first');
ok(r.stats.live_attempts === 1 && r.stats.skipped_uncached === 1, 'live budget counts attempts');
ok(HTTP.calls === 2, 'one query embed + one doc embed, got ' + HTTP.calls);
var cached = Object.keys(STORE.x_196061_netra_v1_kb_embedding).map(function (k) { return STORE.x_196061_netra_v1_kb_embedding[k]; }).filter(function (x) { return x.embedded_at; });
ok(cached.length === 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(cached[0].embedded_at), 'cache row written with an epoch-derived UTC date');
// memoised query embed: dup + triage on same text cost no more query calls
S.checkDuplicates('vpn broken', 'a2', { maxLive: 0 }); ok(HTTP.calls === 2, 'query embed memoised');
// 429 on a doc embed -> rate_limited, then no more HTTP in this instance
HTTP.code = 429; HTTP.body = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45s' }, { violations: [{ quotaId: 'EmbedContentRequestsPerDayPerProject' }] }] } });
inc('a5', '6', 'false', 'x', null);
var S2 = new NetraSemantic(); S2._queryMemo = S._queryMemo; S2._queryMemoKeys = S._queryMemoKeys;
var r2 = S2.findSimilarResolved('vpn broken', 3, { maxLive: 2 });
ok(r2.ok && r2.stats.rate_limited && r2.stats.rate_limited.retry_ms === 45000 && r2.stats.rate_limited.quota_kind === 'per_day', '429 surfaced with RetryInfo');
var M = new NetraMissionRunner();
var sf = M._semFailure(r2);
ok(sf && sf.wait && sf.wait.reason === 'daily embedding quota' && sf.wait.until_ms === M.nextPtMidnightMs(M._now()), 'per_day waits until PT midnight');
console.log('semantic harness: ' + pass + ' checks passed');

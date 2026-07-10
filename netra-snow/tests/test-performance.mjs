/**
 * test-performance.mjs — unit tests for NetraPerformance against the mock.
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { makeEnv, loadScriptInclude } = require('./glide-mock.js');
const fx = require('./fixtures.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'source', 'script_includes', 'NetraPerformance.js'), 'utf8');

function newPerf(opts) {
  opts = opts || {};
  const env = makeEnv(fx.buildWorld({}), {
    roles: opts.roles || ['admin'],
    properties: opts.properties || {},
    userId: 'user_self', userName: 'Test Admin',
    now: fx.now, choiceLabels: fx.choiceLabels, schema: fx.schema({})
  });
  const Ctor = loadScriptInclude(SRC, env, 'NetraPerformance');
  return { perf: new Ctor(), env };
}

export default {
  name: 'NetraPerformance',
  run(t) {
    // ---------- RBAC ----------
    (function () {
      const { perf } = newPerf({ roles: [] });
      t.falsy(perf.healthSummary().ok, 'non-admin denied health');
      t.falsy(perf.topJobs(5).ok, 'non-admin denied topJobs');
      t.contains(perf.integrationReport().error, 'admin', 'denial mentions admin');
    })();
    (function () {
      const { perf } = newPerf({ roles: ['perf_viewer'], properties: { 'x_196061_netra_v1.perf_read_roles': 'perf_viewer' } });
      t.truthy(perf.healthSummary().ok, 'property-granted perf role works');
    })();

    // ---------- classification ----------
    (function () {
      const { perf } = newPerf();
      const c = (n, s) => perf._classify(n, s || '');
      t.eq(c('Netra Watch', 'Netra Voice Assistant').klass, 'protected', 'Netra protected');
      t.eq(c('Trident Nightly Sync', 'Trident').klass, 'protected', 'Trident protected');
      t.eq(c('NVD Auto-Update', 'Vulnerability Response').klass, 'protected', 'NVD/VR feed protected');
      t.eq(c('SLA Update Engine', 'Global').klass, 'protected', 'SLA protected');
      t.eq(c('Text Index Events Process', 'Global').klass, 'protected', 'indexing protected');
      t.eq(c('Email Reader (SMTP)', 'Global').klass, 'protected', 'email protected');
      t.eq(c('Table Cleaner', 'Global').klass, 'protected', 'cleanup protected');
      t.eq(c('PA Daily Data Collection', 'Performance Analytics').klass, 'candidate', 'PA is a candidate');
      t.eq(c('Predictive Intelligence ML Training', 'Global').klass, 'candidate', 'PI training is a candidate');
      t.eq(c('Cross-Scope Privilege Auto-Healer (temporary)', 'Global').klass, 'remove-recommended', 'auto-healer flagged for removal');
      t.eq(c('Some Custom Report Blast', 'Global').klass, 'review', 'unknown -> review');
      // protected must win even if a candidate keyword also matches
      t.eq(c('Netra PA Data Collection', 'Netra Voice Assistant').klass, 'protected', 'protected beats candidate');
    })();

    // ---------- healthSummary ----------
    (function () {
      const { perf } = newPerf();
      const h = perf.healthSummary();
      t.truthy(h.ok, 'health ok');
      t.ok(h.jobs_active > 0, 'active job count');
      t.ok(h.busiest.length > 0 && h.busiest[0].per_day >= h.busiest[h.busiest.length - 1].per_day, 'busiest sorted desc');
      t.eq(h.slow_transactions_24h.count, 2, 'two slow transactions over 5s in 24h');
      t.ok(h.slow_transactions_24h.worst_ms === 8200, 'worst transaction ms');
      t.ok(h.flags.some((f) => /Auto-Healer/i.test(f)), 'auto-healer flagged in health');
      t.contains(h.message, 'scheduled jobs', 'spoken message present');
    })();

    // ---------- topJobs ordering + classification ----------
    (function () {
      const { perf } = newPerf();
      const tj = perf.topJobs(20);
      t.truthy(tj.ok, 'topJobs ok');
      t.ok(tj.jobs.length > 0, 'jobs returned');
      for (let i = 1; i < tj.jobs.length; i++) t.ok(tj.jobs[i - 1].runs_per_day >= tj.jobs[i].runs_per_day, 'runs_per_day descending');
      const idx = tj.jobs.find((j) => j.name === 'Text Index Events Process');
      t.ok(idx && idx.runs_per_day > 1000, 'a 30s job runs thousands of times/day');
      t.ok(idx.classification === 'protected', 'indexing job classified protected in topJobs');
    })();

    // ---------- integration report ----------
    (function () {
      const { perf } = newPerf();
      const r = perf.integrationReport();
      t.truthy(r.ok, 'integration report ok');
      t.eq(r.scheduled_imports.active_count, 2, 'two active imports');
      t.eq(r.ldap.configured, 1, 'one LDAP server');
      t.ok(r.outbound_rest.definitions >= 2, 'outbound REST counted');
      t.eq(r.mid_servers, 1, 'one MID server');
      t.contains(r.message, 'scheduled imports', 'spoken message present');
    })();

    // ---------- missing tables degrade gracefully ----------
    (function () {
      const env = makeEnv({ /* empty world: no perf tables at all */ }, {
        roles: ['admin'], userId: 'user_self', now: fx.now, schema: {}
      });
      const Ctor = loadScriptInclude(SRC, env, 'NetraPerformance');
      const perf = new Ctor();
      const h = perf.healthSummary();
      t.truthy(h.ok, 'health ok even with no tables');
      t.eq(h.jobs_active, 0, 'zero jobs when table absent');
      const r = perf.integrationReport();
      t.truthy(r.ok, 'integration report ok with no tables');
      t.eq(r.mid_servers, 0, 'zero mids when table absent');
    })();

    // ---------- auditReport ----------
    (function () {
      const { perf } = newPerf();
      const a = perf.auditReport();
      t.truthy(a.ok && a.count > 0, 'audit report lists jobs');
      t.ok(a.jobs.some((j) => j.classification === 'protected'), 'audit has protected jobs');
      t.ok(a.jobs.some((j) => j.classification === 'candidate'), 'audit has candidate jobs');
    })();
  }
};

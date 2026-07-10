/**
 * glide-mock.js — a small in-memory ServiceNow API mock, just enough to load
 * and exercise the Netra script includes (NetraVulnerability, NetraPerformance,
 * NetraScanner, ...) under Node for unit testing.
 *
 * It is NOT a full GlideRecord. It implements the query surface the Netra code
 * actually uses: addQuery (with =, !=, IN, NOT IN, >=, <=, >, <, CONTAINS,
 * STARTSWITH), addEncodedQuery (^, ^OR, IN, NOT IN, LIKE, =), addNotNullQuery,
 * addNullQuery, addOrCondition, orderBy/orderByDesc, setLimit, get, query/next,
 * getValue/setValue, element proxies (.nil()/.getDisplayValue()), journal
 * fields, isValid()/isValidField(), plus GlideAggregate, GlideDateTime,
 * GlideDuration, and a settable gs (roles + properties).
 *
 * A test builds a "world": { tableName: [ {field:value, ...}, ... ] } plus a
 * schema map for isValidField and a set of the current user's roles.
 */

function makeEnv(world, opts) {
  opts = opts || {};
  var schema = opts.schema || {};          // { table: { field: true } }
  var roles = new Set(opts.roles || []);   // current user's roles
  var props = Object.assign({}, opts.properties || {});
  var userId = opts.userId || 'user_self';
  var userName = opts.userName || 'Test Analyst';
  var log = [];

  function tableRows(t) {
    if (!world[t]) world[t] = [];
    return world[t];
  }
  function tableExists(t) {
    return Object.prototype.hasOwnProperty.call(world, t) ||
           Object.prototype.hasOwnProperty.call(schema, t);
  }
  function fieldValid(t, f) {
    // dotted fields (cmdb_ci.name) are always "valid" for query purposes
    if (f.indexOf('.') >= 0) return true;
    if (schema[t]) return !!schema[t][f];
    // if no schema declared for the table, assume common fields exist
    return true;
  }

  // ---- value helpers ----
  function cmp(op, a, b) {
    var na = Number(a), nb = Number(b);
    var numeric = a !== '' && b !== '' && !isNaN(na) && !isNaN(nb);
    switch (op) {
      case '=': return String(a) === String(b);
      case '!=': return String(a) !== String(b);
      case '>=': return numeric ? na >= nb : String(a) >= String(b);
      case '<=': return numeric ? na <= nb : String(a) <= String(b);
      case '>': return numeric ? na > nb : String(a) > String(b);
      case '<': return numeric ? na < nb : String(a) < String(b);
      case 'CONTAINS': return String(a).toLowerCase().indexOf(String(b).toLowerCase()) >= 0;
      case 'STARTSWITH': return String(a).toLowerCase().indexOf(String(b).toLowerCase()) === 0;
      case 'IN': return String(b).split(',').indexOf(String(a)) >= 0;
      case 'NOT IN': return String(b).split(',').indexOf(String(a)) < 0;
      case 'LIKE': return String(a).toLowerCase().indexOf(String(b).toLowerCase()) >= 0;
      default: return false;
    }
  }

  // resolve possibly-dotted field to a value; supports x.name / x.id lookups
  function resolveField(row, field) {
    if (field.indexOf('.') < 0) return row[field];
    var parts = field.split('.');
    var base = row[parts[0]];
    // reference fields in the mock can carry a __ref: {table, sys_id} or a display
    if (base && typeof base === 'object' && base.__ref) {
      var ref = findById(base.__ref.table, base.__ref.sys_id);
      if (ref) return ref[parts[1]];
      return '';
    }
    // or a flat "<field>.name" precomputed on the row
    if (row[field] !== undefined) return row[field];
    return '';
  }

  function findById(table, sysId) {
    var rows = world[table] || [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i].sys_id) === String(sysId)) return rows[i];
    return null;
  }

  function displayValue(row, field) {
    var v = row[field];
    if (v && typeof v === 'object' && v.__ref) {
      var ref = findById(v.__ref.table, v.__ref.sys_id);
      if (ref) return ref.name || ref.short_description || ref.number || String(v.__ref.sys_id);
      return '';
    }
    // choice display via schema-provided choice map
    if (opts.choiceLabels && opts.choiceLabels[field] && opts.choiceLabels[field][String(v)] !== undefined) {
      return opts.choiceLabels[field][String(v)];
    }
    if (row[field + '__display'] !== undefined) return row[field + '__display'];
    return v === undefined || v === null ? '' : String(v);
  }

  function rawValue(row, field) {
    var v = row[field];
    if (v && typeof v === 'object' && v.__ref) return v.__ref.sys_id;
    return v === undefined || v === null ? '' : v;
  }

  // ---- element proxy (row.field with .nil()/.getDisplayValue()) ----
  function makeElement(gr, field) {
    function el() {}
    el.nil = function () {
      var v = gr._cur ? rawValue(gr._cur, field) : '';
      return v === '' || v === undefined || v === null;
    };
    el.getDisplayValue = function () { return gr._cur ? displayValue(gr._cur, field) : ''; };
    el.toString = function () { return gr._cur ? String(rawValue(gr._cur, field)) : ''; };
    el.getJournalEntry = function () { return gr._cur ? String(gr._cur[field + '__journal'] || gr._cur[field] || '') : ''; };
    return el;
  }

  // ---- GlideRecord ----
  function GlideRecord(table) {
    this._table = table;
    this._q = [];        // {field, op, value} ANDed; OR handled via _or groups
    this._orGroups = []; // array of arrays for addOrCondition chains
    this._order = null;
    this._orderDir = 1;
    this._limit = Infinity;
    this._results = null;
    this._idx = -1;
    this._cur = null;
    this._encoded = [];
    this._pendingOr = null;
  }
  GlideRecord.prototype.isValid = function () { return tableExists(this._table); };
  GlideRecord.prototype.isValidField = function (f) { return fieldValid(this._table, f); };
  GlideRecord.prototype.isValidRecord = function () { return !!this._cur; };
  GlideRecord.prototype.initialize = function () { this._cur = { __new: true }; };
  GlideRecord.prototype.setLimit = function (n) { this._limit = Number(n) || Infinity; return this; };
  GlideRecord.prototype.orderBy = function (f) { this._order = f; this._orderDir = 1; return this; };
  GlideRecord.prototype.orderByDesc = function (f) { this._order = f; this._orderDir = -1; return this; };
  GlideRecord.prototype.addQuery = function (field, opOrVal, val) {
    var cond;
    if (arguments.length === 2) cond = { field: field, op: '=', value: opOrVal };
    else cond = { field: field, op: opOrVal, value: val };
    this._q.push(cond);
    this._pendingOr = [cond]; // addOrCondition attaches to the last addQuery
    return {
      addOrCondition: function (f2, o2, v2) {
        var c2 = (arguments.length === 2) ? { field: f2, op: '=', value: o2 } : { field: f2, op: o2, value: v2 };
        // model OR by removing the AND cond and adding an OR group of both
        return glideAddOr.call(this);
      }.bind(this)
    };
  };
  function glideAddOr() { return this; }
  // richer addOrCondition: we implement it by converting the previous addQuery
  // into an OR group.
  GlideRecord.prototype.addOrCondition = function (field, opOrVal, val) {
    var cond = (arguments.length === 2) ? { field: field, op: '=', value: opOrVal } : { field: field, op: opOrVal, value: val };
    if (this._pendingOr) {
      // remove the pending AND cond from _q and create an OR group
      var last = this._pendingOr[0];
      var i = this._q.indexOf(last);
      if (i >= 0) this._q.splice(i, 1);
      this._pendingOr.push(cond);
      this._orGroups.push(this._pendingOr);
      this._pendingOr = this._pendingOr; // subsequent addOrCondition extends same group
    } else {
      this._q.push(cond);
    }
    return this;
  };
  GlideRecord.prototype.addNotNullQuery = function (field) { this._q.push({ field: field, op: 'NOTNULL' }); return this; };
  GlideRecord.prototype.addNullQuery = function (field) { this._q.push({ field: field, op: 'NULL' }); return this; };
  GlideRecord.prototype.addActiveQuery = function () { this._q.push({ field: 'active', op: '=', value: true }); return this; };
  GlideRecord.prototype.addEncodedQuery = function (enc) { this._encoded.push(String(enc)); return this; };

  GlideRecord.prototype.get = function (a, b) {
    // get(sys_id) or get(field, value)
    var field = (b === undefined) ? 'sys_id' : a;
    var value = (b === undefined) ? a : b;
    var rows = tableRows(this._table);
    for (var i = 0; i < rows.length; i++) {
      if (String(rawValue(rows[i], field)) === String(value)) {
        this._cur = rows[i];
        return true;
      }
    }
    this._cur = null;
    return false;
  };

  function matchEncoded(row, encList) {
    // very small encoded-query evaluator: handles ^ (AND), ^OR (OR),
    // field=val, fieldINa,b, fieldNOT INa,b, fieldLIKEx, field>=n, field<=n
    for (var e = 0; e < encList.length; e++) {
      var enc = encList[e];
      // split OR first
      var orParts = enc.split('^OR');
      var anyOr = false;
      for (var o = 0; o < orParts.length; o++) {
        var andParts = orParts[o].split('^');
        var allAnd = true;
        for (var a = 0; a < andParts.length; a++) {
          if (!andParts[a]) continue;
          if (!evalClause(row, andParts[a])) { allAnd = false; break; }
        }
        if (allAnd) { anyOr = true; break; }
      }
      if (!anyOr) return false;
    }
    return true;
  }
  function clauseValue(row, field) {
    var v = resolveField(row, field);
    if (v && typeof v === 'object' && v.__ref) return v.__ref.sys_id;
    return v;
  }
  function evalClause(row, clause) {
    var m;
    if ((m = clause.match(/^(.+?)NOT IN(.*)$/))) return cmp('NOT IN', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)IN(.*)$/)) && clause.indexOf('LIKE') < 0) return cmp('IN', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)LIKE(.*)$/))) return cmp('LIKE', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)>=(.*)$/))) return cmp('>=', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)<=(.*)$/))) return cmp('<=', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)!=(.*)$/))) return cmp('!=', clauseValue(row, m[1]), m[2]);
    if ((m = clause.match(/^(.+?)=(.*)$/))) return cmp('=', clauseValue(row, m[1]), m[2]);
    return true; // unknown clause: don't over-filter
  }

  GlideRecord.prototype._run = function () {
    var self = this;
    var rows = tableRows(this._table).slice();
    rows = rows.filter(function (row) {
      // AND conditions
      for (var i = 0; i < self._q.length; i++) {
        var c = self._q[i];
        if (c.op === 'NOTNULL') { var vN = rawValue(row, c.field); if (vN === '' || vN === undefined || vN === null) return false; continue; }
        if (c.op === 'NULL') { var vNu = rawValue(row, c.field); if (!(vNu === '' || vNu === undefined || vNu === null)) return false; continue; }
        var lhs = resolveField(row, c.field);
        if (lhs && typeof lhs === 'object' && lhs.__ref) lhs = lhs.__ref.sys_id;
        if (!cmp(c.op, lhs, c.value)) return false;
      }
      // OR groups (each group: at least one true)
      for (var g = 0; g < self._orGroups.length; g++) {
        var grp = self._orGroups[g], ok = false;
        for (var j = 0; j < grp.length; j++) {
          var gc = grp[j];
          var gv = resolveField(row, gc.field);
          if (gv && typeof gv === 'object' && gv.__ref) gv = gv.__ref.sys_id;
          if (cmp(gc.op, gv, gc.value)) { ok = true; break; }
        }
        if (!ok) return false;
      }
      // encoded queries
      if (self._encoded.length && !matchEncoded(row, self._encoded)) return false;
      return true;
    });
    if (this._order) {
      var f = this._order, dir = this._orderDir;
      rows.sort(function (x, y) {
        var xv = rawValue(x, f), yv = rawValue(y, f);
        var nx = Number(xv), ny = Number(yv);
        if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
        return String(xv) < String(yv) ? -dir : (String(xv) > String(yv) ? dir : 0);
      });
    }
    if (rows.length > this._limit) rows = rows.slice(0, this._limit);
    this._results = rows;
    this._idx = -1;
  };
  GlideRecord.prototype.query = function () { this._run(); };
  GlideRecord.prototype.next = function () {
    if (this._results === null) this._run();
    this._idx++;
    if (this._idx < this._results.length) { this._cur = this._results[this._idx]; return true; }
    this._cur = null;
    return false;
  };
  GlideRecord.prototype.hasNext = function () { return this._results && this._idx + 1 < this._results.length; };
  GlideRecord.prototype.getRowCount = function () { if (this._results === null) this._run(); return this._results.length; };
  GlideRecord.prototype.getValue = function (f) { return this._cur ? String(rawValue(this._cur, f)) : null; };
  GlideRecord.prototype.getDisplayValue = function (f) { return this._cur ? displayValue(this._cur, f) : ''; };
  GlideRecord.prototype.setValue = function (f, v) { if (!this._cur) this._cur = {}; this._cur[f] = v; };
  GlideRecord.prototype.update = function () {
    if (this._cur && this._cur.__new) { return this.insert(); }
    log.push({ op: 'update', table: this._table, sys_id: this._cur && this._cur.sys_id, row: this._cur });
    return this._cur ? this._cur.sys_id : null;
  };
  GlideRecord.prototype.insert = function () {
    if (!this._cur) this._cur = {};
    if (!this._cur.sys_id) this._cur.sys_id = 'sys_' + Math.floor((world.__seq = (world.__seq || 0) + 1));
    if (!this._cur.number && /vul|incident|change|problem/.test(this._table)) this._cur.number = (this._table.indexOf('change') >= 0 ? 'CHG' : 'REC') + String(1000 + (world.__seq || 0));
    delete this._cur.__new;
    tableRows(this._table).push(this._cur);
    log.push({ op: 'insert', table: this._table, sys_id: this._cur.sys_id, row: this._cur });
    return this._cur.sys_id;
  };
  GlideRecord.prototype.deleteRecord = function () {
    if (!this._cur) return false;
    var rows = tableRows(this._table);
    var i = rows.indexOf(this._cur);
    if (i >= 0) rows.splice(i, 1);
    log.push({ op: 'delete', table: this._table, sys_id: this._cur.sys_id });
    return true;
  };

  // element access: define getters lazily via a Proxy-like shim.
  // Netra code accesses gr.<field>. We back that with a getter that returns
  // an element function bound to the current row.
  var elementCache = {};
  function installAccessors(gr) {
    return new Proxy(gr, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return target[prop];
        // field access -> element
        return makeElement(target, String(prop));
      },
      set: function (target, prop, value) {
        if (prop in target || String(prop).charAt(0) === '_') { target[prop] = value; return true; }
        // gr.field = value  -> set on current row
        if (!target._cur) target._cur = {};
        target._cur[String(prop)] = value;
        return true;
      }
    });
  }

  function GlideRecordFactory(table) {
    var gr = new GlideRecord(table);
    return installAccessors(gr);
  }

  // ---- GlideAggregate ----
  function GlideAggregate(table) {
    this._gr = new GlideRecord(table);
    this._aggs = [];      // {fn, field}
    this._groupBy = null;
    this._orderAgg = null;
    this._rows = null;
    this._idx = -1;
    this._cur = null;
  }
  GlideAggregate.prototype.isValid = function () { return tableExists(this._gr._table); };
  GlideAggregate.prototype.addQuery = function () { GlideRecord.prototype.addQuery.apply(this._gr, arguments); return this; };
  GlideAggregate.prototype.addEncodedQuery = function (e) { this._gr.addEncodedQuery(e); return this; };
  GlideAggregate.prototype.addNotNullQuery = function (f) { this._gr.addNotNullQuery(f); return this; };
  GlideAggregate.prototype.addNullQuery = function (f) { this._gr.addNullQuery(f); return this; };
  GlideAggregate.prototype.addAggregate = function (fn, field) { this._aggs.push({ fn: fn, field: field || null }); return this; };
  GlideAggregate.prototype.groupBy = function (f) { this._groupBy = f; return this; };
  GlideAggregate.prototype.orderByAggregate = function () { this._orderAgg = 'desc'; return this; };
  GlideAggregate.prototype.orderBy = function () { return this; };
  GlideAggregate.prototype.setLimit = function () { return this; };
  GlideAggregate.prototype.query = function () {
    this._gr._run();
    var rows = this._gr._results;
    var groups = {};
    var self = this;
    if (this._groupBy) {
      rows.forEach(function (row) {
        var key = String(rawValue(row, self._groupBy));
        (groups[key] = groups[key] || []).push(row);
      });
    } else {
      groups['__all'] = rows;
    }
    this._rows = Object.keys(groups).map(function (k) {
      return { key: k, rows: groups[k] };
    });
    if (this._orderAgg && this._aggs.length) {
      // order by first COUNT-ish aggregate desc
      this._rows.sort(function (a, b) { return b.rows.length - a.rows.length; });
    }
    this._idx = -1;
  };
  GlideAggregate.prototype.next = function () {
    this._idx++;
    if (this._rows && this._idx < this._rows.length) { this._cur = this._rows[this._idx]; return true; }
    return false;
  };
  GlideAggregate.prototype.getAggregate = function (fn, field) {
    if (!this._cur) return '0';
    var rows = this._cur.rows;
    if (fn === 'COUNT') return String(rows.length);
    var nums = rows.map(function (r) { return Number(rawValue(r, field)) || 0; });
    if (fn === 'MAX') return String(nums.reduce(function (a, b) { return Math.max(a, b); }, 0));
    if (fn === 'MIN') return String(nums.reduce(function (a, b) { return Math.min(a, b); }, nums.length ? nums[0] : 0));
    if (fn === 'SUM') return String(nums.reduce(function (a, b) { return a + b; }, 0));
    if (fn === 'AVG') return String(nums.length ? (nums.reduce(function (a, b) { return a + b; }, 0) / nums.length) : 0);
    return '0';
  };
  GlideAggregate.prototype.getValue = function (f) { return this._cur ? this._cur.key : null; };
  // element access for groupBy field display
  function installAggAccessors(ag) {
    return new Proxy(ag, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return target[prop];
        // element for group key field
        var el = function () {};
        el.nil = function () { return !target._cur || target._cur.key === '' || target._cur.key === 'null'; };
        el.getDisplayValue = function () {
          if (!target._cur || !target._cur.rows.length) return '';
          return displayValue(target._cur.rows[0], String(prop));
        };
        el.toString = function () { return target._cur ? target._cur.key : ''; };
        return el;
      }
    });
  }
  function GlideAggregateFactory(table) { return installAggAccessors(new GlideAggregate(table)); }

  // ---- GlideDateTime / GlideDuration ----
  function GlideDateTime(str) {
    if (str instanceof GlideDateTime) { this._ms = str._ms; }
    else if (str) { this._ms = Date.parse(String(str).replace(' ', 'T') + 'Z'); if (isNaN(this._ms)) this._ms = (opts.now || Date.parse('2026-07-10T00:00:00Z')); }
    else this._ms = (opts.now || Date.parse('2026-07-10T00:00:00Z'));
  }
  GlideDateTime.prototype.getNumericValue = function () { return this._ms; };
  GlideDateTime.prototype.addDaysUTC = function (d) { this._ms += d * 86400000; };
  GlideDateTime.prototype.addSeconds = function (s) { this._ms += s * 1000; };
  GlideDateTime.prototype.subtract = function (ms) { this._ms -= ms; };
  GlideDateTime.prototype.compareTo = function (o) { return this._ms < o._ms ? -1 : (this._ms > o._ms ? 1 : 0); };
  GlideDateTime.prototype.getDisplayValue = function () { return new Date(this._ms).toISOString().replace('T', ' ').substring(0, 19); };
  GlideDateTime.prototype.toString = function () { return new Date(this._ms).toISOString().replace('T', ' ').substring(0, 19); };

  function GlideDuration(str) { this._s = str; }
  GlideDuration.prototype.getDurationValue = function () { return this._s; };

  // ---- gs ----
  var gs = {
    getUserID: function () { return userId; },
    getUserName: function () { return userName; },
    hasRole: function (r) { return roles.has('admin') && r !== '__never__' ? true : roles.has(r); },
    getProperty: function (name, def) { return (props[name] !== undefined ? props[name] : (def !== undefined ? def : '')); },
    setProperty: function () { throw new Error('gs.setProperty must never be called from scoped widget code'); },
    info: function (m) { log.push({ op: 'info', msg: String(m) }); },
    warn: function (m) { log.push({ op: 'warn', msg: String(m) }); },
    error: function (m) { log.push({ op: 'error', msg: String(m) }); },
    nowDateTime: function () { return new GlideDateTime().getDisplayValue(); },
    getMessage: function (m) { return m; }
  };
  // admin should NOT auto-grant sn_vul roles unless explicitly present; but in
  // ServiceNow admin does satisfy hasRole('admin'). Model that precisely:
  gs.hasRole = function (r) {
    if (roles.has(r)) return true;
    if (r === 'admin') return roles.has('admin');
    // admin implies most roles in real SN, but Netra checks explicit roles;
    // keep it strict so RBAC tests are meaningful: only 'admin' shortcut is
    // that admin passes the admin check (handled above).
    return false;
  };

  function Class() {}
  // Mirror ServiceNow's Class.create(): the returned constructor calls
  // this.initialize(...) when instantiated with `new`.
  Class.create = function () {
    function C() { if (typeof this.initialize === 'function') this.initialize.apply(this, arguments); }
    return C;
  };

  var GlideSysAttachment = function () {};
  GlideSysAttachment.prototype.getContent = function () { return ''; };

  return {
    world: world, log: log, props: props, roles: roles,
    globals: {
      GlideRecord: GlideRecordFactory,
      GlideAggregate: GlideAggregateFactory,
      GlideDateTime: GlideDateTime,
      GlideDuration: GlideDuration,
      GlideSysAttachment: GlideSysAttachment,
      gs: gs,
      Class: Class
    }
  };
}

/**
 * Load a script-include source string and return its constructor.
 * extraGlobals: optional { name: value } injected as additional globals (used
 * to provide sibling script includes that a class constructs in initialize).
 */
function loadScriptInclude(source, env, name, extraGlobals) {
  var g = env.globals;
  extraGlobals = extraGlobals || {};
  // strip the __NETRA_SCOPE__ placeholder to a concrete scope for eval
  source = source.replace(/__NETRA_SCOPE__/g, 'x_196061_netra_v1');
  var extraNames = Object.keys(extraGlobals);
  var paramNames = ['GlideRecord', 'GlideAggregate', 'GlideDateTime', 'GlideDuration',
    'GlideSysAttachment', 'gs', 'Class'].concat(extraNames);
  var paramVals = [g.GlideRecord, g.GlideAggregate, g.GlideDateTime, g.GlideDuration,
    g.GlideSysAttachment, g.gs, g.Class].concat(extraNames.map(function (k) { return extraGlobals[k]; }));
  var args = paramNames.concat([source + '\nreturn ' + name + ';']);
  var factory = new (Function.bind.apply(Function, [null].concat(args)))();
  return factory.apply(null, paramVals);
}

module.exports = { makeEnv: makeEnv, loadScriptInclude: loadScriptInclude };

/*
 * In-memory stand-in for the ServiceNow server APIs Netra uses, so the real
 * widget server script and script includes can run under plain node.
 *
 * It is deliberately small and strict: records live in STORE[table][sys_id],
 * queries support the operators Netra actually uses, and anything the shim
 * does not understand is recorded in UNSUPPORTED rather than silently
 * matching everything - a test that relies on an unsupported query fails
 * loudly instead of passing by accident.
 */
'use strict';

var P = {
    STORE: {},          // table -> sys_id -> record (plain object of strings)
    PROPS: {},          // system properties
    DISPLAY: {},        // sys_id -> display value for reference fields
    CHOICES: {},        // 'table.field' -> { value: label } choice labels
    INVALID_FIELDS: {}, // table -> { field: true } fields that do not exist
    UNSUPPORTED: [],    // encoded-query terms the shim could not evaluate
    LOG: [],            // gs.info/warn/error lines
    HTTP: null,         // function (req) -> { status, body } for sn_ws
    now: Date.UTC(2026, 8, 23, 20, 0, 0),
    user: { sys_id: 'u_admin', name: 'System Administrator', user_name: 'admin' },
    guid: 0,
    tzOffsetMs: 0,      // user timezone offset for display values (ms east of UTC)
    ROLES: null,        // null = admin (every role); or { role: true }
    ACL: null           // function (table, op, rec) -> boolean, enforced by GlideRecordSecure only
};

function newId() {
    P.guid++;
    var s = String(P.guid);
    while (s.length < 32) s = '0' + s;
    return s;
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtUtc(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
           pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
function parseUtc(s) {
    if (s === null || s === undefined || s === '') return NaN;
    return Date.parse(String(s).replace(' ', 'T') + 'Z');
}

/* ---------------- GlideDateTime ---------------- */
function GlideDateTime(v) {
    this._ms = (v === undefined || v === null) ? P.now : parseUtc(v);
    if (v instanceof GlideDateTime) this._ms = v._ms;
}
GlideDateTime.prototype.getNumericValue = function () { return this._ms; };
GlideDateTime.prototype.setNumericValue = function (ms) { this._ms = Number(ms); };
GlideDateTime.prototype.setValue = function (s) { this._ms = parseUtc(s); };
GlideDateTime.prototype.getValue = function () { return fmtUtc(this._ms); };
GlideDateTime.prototype.toString = function () { return fmtUtc(this._ms); };
GlideDateTime.prototype.getDisplayValueInternal = function () { return fmtUtc(this._ms + P.tzOffsetMs); };
// the user-format display value: 12-hour clock, like a real profile can have
GlideDateTime.prototype.getDisplayValue = function () {
    var d = new Date(this._ms + P.tzOffsetMs);
    var h = d.getUTCHours(), ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
           pad(h12) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' ' + ap;
};
GlideDateTime.prototype.addSeconds = function (s) { this._ms += s * 1000; };
GlideDateTime.prototype.add = function (ms) { this._ms += Number(ms); };
GlideDateTime.prototype.subtract = function (ms) { this._ms -= Number(ms); };
// like the platform: the time part already shifted to the session timezone,
// so reading it with getHourOfDayLocalTime() shifts it a second time
GlideDateTime.prototype.getLocalTime = function () { return new GlideTime(this._ms + P.tzOffsetMs); };
function GlideTime(ms) { this._ms = ms; }
GlideTime.prototype.getHourOfDayUTC = function () { return new Date(this._ms).getUTCHours(); };
GlideTime.prototype.getMinutesUTC = function () { return new Date(this._ms).getUTCMinutes(); };
GlideTime.prototype.getHourOfDayLocalTime = function () { return new Date(this._ms + P.tzOffsetMs).getUTCHours(); };
GlideDateTime.prototype.before = function (o) { return this._ms < o._ms; };
GlideDateTime.prototype.after = function (o) { return this._ms > o._ms; };
GlideDateTime.prototype.compareTo = function (o) { return this._ms < o._ms ? -1 : (this._ms > o._ms ? 1 : 0); };

/* ---------------- query evaluation ---------------- */
function cmp(recVal, op, want) {
    var v = recVal === undefined || recVal === null ? '' : String(recVal);
    var w = want === undefined || want === null ? '' : String(want);
    switch (op) {
        case '=': return v === w;
        case '!=': return v !== w;
        case 'IN': return w.split(',').indexOf(v) >= 0;
        case 'NOT IN': return w.split(',').indexOf(v) < 0;
        case 'LIKE': case 'CONTAINS': return v.toLowerCase().indexOf(w.toLowerCase()) >= 0;
        case 'NOT LIKE': case 'DOES NOT CONTAIN': return v.toLowerCase().indexOf(w.toLowerCase()) < 0;
        case 'STARTSWITH': return v.toLowerCase().indexOf(w.toLowerCase()) === 0;
        case 'ENDSWITH': return v.toLowerCase().slice(-w.length) === w.toLowerCase();
        case 'ISEMPTY': return v === '';
        case 'ISNOTEMPTY': return v !== '';
        case '>': case '>=': case '<': case '<=': {
            // plain numbers compare as numbers ("92" is not the year 1992)
            var NUM = /^-?\d+(\.\d+)?$/;
            var a = parseUtc(v), b = parseUtc(w);
            if (NUM.test(v) || NUM.test(w) || isNaN(a) || isNaN(b)) { a = parseFloat(v); b = parseFloat(w); }
            if (op === '>') return a > b;
            if (op === '>=') return a >= b;
            if (op === '<') return a < b;
            return a <= b;
        }
    }
    P.UNSUPPORTED.push('operator ' + op);
    return false;
}

// "a=1^b!=2^ORc=3^ORDERBYx" -> groups of OR-terms; each group ANDed
var ENC_OPS = ['NOT IN', 'NOT LIKE', 'ISNOTEMPTY', 'ISEMPTY', 'STARTSWITH', 'ENDSWITH', 'LIKE', 'IN', '!=', '>=', '<=', '=', '>', '<'];
function parseEncoded(q) {
    // "^NQ" starts a new query block: a row matches if ANY block matches
    if (String(q || '').indexOf('^NQ') >= 0) {
        var parts = String(q).split('^NQ').map(parseEncoded);
        return { nq: parts, groups: [], order: [].concat.apply([], parts.map(function (x) { return x.order; })) };
    }
    var out = { groups: [], order: [] };
    String(q || '').split('^').forEach(function (term, i, all) {
        if (!term) return;
        var isOr = term.indexOf('OR') === 0 && i > 0 && !/^ORDERBY/.test(term);
        if (isOr) term = term.substring(2);
        if (/^ORDERBYDESC/.test(term)) { out.order.push({ f: term.substring(11), desc: true }); return; }
        if (/^ORDERBY/.test(term)) { out.order.push({ f: term.substring(7), desc: false }); return; }
        if (/javascript:/.test(term)) { P.UNSUPPORTED.push('javascript term: ' + term); return; }
        var hit = null;
        for (var k = 0; k < ENC_OPS.length && !hit; k++) {
            var op = ENC_OPS[k], at = term.indexOf(op);
            if (at > 0) hit = { f: term.substring(0, at), op: op, v: term.substring(at + op.length) };
        }
        if (!hit) { P.UNSUPPORTED.push('term: ' + term); return; }
        if (isOr && out.groups.length) out.groups[out.groups.length - 1].push(hit);
        else out.groups.push([hit]);
    });
    return out;
}

function groupsMatch(r, groups) {
    for (var g = 0; g < groups.length; g++) {
        var anyG = false;
        for (var h = 0; h < groups[g].length; h++) if (cmp(fieldVal(r, groups[g][h].f), groups[g][h].op, groups[g][h].v)) anyG = true;
        if (!anyG) return false;
    }
    return true;
}

/* ---------------- table hierarchy ---------------- */
// querying a parent table returns its children's rows, like the platform
var PARENT = { incident: 'task', problem: 'task', change_request: 'task', change_task: 'task', sc_task: 'task',
               sc_req_item: 'task', sc_request: 'task', problem_task: 'task', sn_vul_vulnerable_item: 'task',
               cmdb_ci_linux_server: 'cmdb_ci_server', cmdb_ci_win_server: 'cmdb_ci_server', cmdb_ci_server: 'cmdb_ci_computer',
               cmdb_ci_computer: 'cmdb_ci_hardware', cmdb_ci_hardware: 'cmdb_ci', cmdb_ci_appl: 'cmdb_ci', cmdb_ci_service: 'cmdb_ci' };
function isA(child, ancestor) {
    for (var t = child; t; t = PARENT[t]) if (t === ancestor) return true;
    return false;
}
function tablesFor(table) {
    var out = [];
    for (var t in P.STORE) if (P.STORE.hasOwnProperty(t) && isA(t, table)) out.push(t);
    return out;
}
function allRows(table) {
    var rows = [];
    tablesFor(table).forEach(function (t) { var st = P.STORE[t]; for (var k in st) rows.push({ t: t, r: st[k] }); });
    return rows;
}

/* ---------------- GlideRecord ---------------- */
function label(table, field, str) {
    var ch = P.CHOICES[table + '.' + field] || P.CHOICES['*.' + field];
    if (ch && ch.hasOwnProperty(str)) return ch[str];
    return P.DISPLAY.hasOwnProperty(str) ? P.DISPLAY[str] : str;
}
// dot-walking: a reference value is a sys_id; find the row it points to
function findById(id) {
    if (!id) return null;
    for (var t in P.STORE) if (P.STORE.hasOwnProperty(t) && P.STORE[t][id]) return { t: t, r: P.STORE[t][id] };
    return null;
}
function fieldVal(r, path) {
    if (path.indexOf('.') < 0) return r[path];
    var parts = path.split('.'), cur = r, t = null;
    for (var i = 0; i < parts.length - 1; i++) {
        var hit = findById(cur && cur[parts[i]]);
        if (!hit) return undefined;
        cur = hit.r; t = hit.t;
    }
    var last = parts[parts.length - 1];
    return last === 'sys_class_name' && cur && !cur.sys_class_name ? t : cur[last];
}
function makeElement(self, field) {
    var el = makeElementBase(self, field);
    return new Proxy(el, {
        get: function (o, p) {
            if (p in o || typeof p !== 'string') return o[p];
            var hit = findById(self._rec ? self._rec[field] : '');
            if (!hit) return makeElementBase({ _rec: null, table: '' }, p);
            var rec = hit.r;
            if (p === 'sys_class_name' && !rec.sys_class_name) rec = Object.assign({}, rec, { sys_class_name: hit.t });
            return makeElement({ _rec: rec, table: hit.t }, p);
        }
    });
}
function makeElementBase(self, field) {
    var v = self._rec ? self._rec[field] : undefined;
    var str = (v === undefined || v === null) ? '' : String(v);
    return {
        toString: function () { return str; },
        valueOf: function () { return str; },
        getDisplayValue: function () { return label(self.table || '', field, str); },
        getLabel: function () { return field.replace(/_/g, ' '); },
        nil: function () { return str === ''; },
        getRefRecord: function () { var g = new GlideRecord('sys_user'); g.get(str); return g; },
        setDateNumericValue: function (ms) { self._rec[field] = fmtUtc(ms); },
        getGlideObject: function () { return new GlideDateTime(str); },
        changes: function () { return false; },
        // field-level ACLs: evaluated for the current user on any record
        canRead: function () { return aclOk(self.table || '', 'read', self._rec, field); },
        canWrite: function () { return aclOk(self.table || '', 'write', self._rec, field); }
    };
}

function GlideRecord(table) {
    var self = { table: table, rec: null, q: [], encoded: [], order: [], limit: 1e9, rows: null, i: -1 };
    var api = {
        _self: self,
        initialize: function () { self.rec = { sys_mod_count: '0' }; self._rec = self.rec; },
        newRecord: function () { this.initialize(); },
        isValid: function () { return true; },
        isValidRecord: function () { return !!(self.rec && self.rec.sys_id && P.STORE[table] && P.STORE[table][self.rec.sys_id]); },
        isNewRecord: function () { return !(self.rec && self.rec.sys_id); },
        isValidField: function (f) { return !(P.INVALID_FIELDS[table] && P.INVALID_FIELDS[table][f]); },
        // canX() evaluate the ACLs for the current user on any GlideRecord;
        // only GlideRecordSecure ENFORCES them on query/get/update/insert
        canRead: function () { return aclOk(self.recTable || table, 'read', self.rec); },
        canWrite: function () { return aclOk(self.recTable || table, 'write', self.rec); },
        canCreate: function () { return aclOk(self.recTable || table, 'create', self.rec); },
        canDelete: function () { return aclOk(self.recTable || table, 'delete', self.rec); },
        getTableName: function () { return self.recTable || table; },
        getRecordClassName: function () { return self.recTable || table; },
        getUniqueValue: function () { return self.rec ? self.rec.sys_id : null; },
        getValue: function (f) {
            if (!self.rec) return null;
            var v = self.rec[f];
            return (v === undefined || v === null || v === '') ? null : String(v);
        },
        getDisplayValue: function (f) {
            if (f === undefined) return self.rec ? String(self.rec.number || self.rec.name || '') : '';
            var v = self.rec ? self.rec[f] : '';
            v = v === undefined || v === null ? '' : String(v);
            return label(table, f, v);
        },
        getElement: function (f) { self._rec = self.rec; return makeElement({ _rec: self.rec, table: self.recTable || table }, f); },
        setValue: function (f, v) { if (self.secure && !fieldWritable(self, table, f)) return; self.rec[f] = v === null || v === undefined ? '' : String(v); },
        get: function (a, b) {
            var found = null, rows = allRows(table);
            for (var i = 0; i < rows.length && !found; i++) {
                var r = rows[i].r;
                if (b === undefined ? r.sys_id === String(a) : String(r[a]) === String(b)) { found = rows[i]; }
            }
            self.rec = found ? JSON.parse(JSON.stringify(found.r)) : null;
            self.recTable = found ? found.t : table;
            self._rec = self.rec;
            self.base = found ? JSON.parse(JSON.stringify(found.r)) : null;
            return !!found;
        },
        addQuery: function (f, op, v) {
            if (v === undefined) { v = op; op = '='; }
            if (f && f.indexOf('^') >= 0 && op === '=' && v === undefined) { self.encoded.push(parseEncoded(f)); return; }
            self.q.push([f, String(op).toUpperCase(), v]);
            return { addOrCondition: function (f2, op2, v2) { if (v2 === undefined) { v2 = op2; op2 = '='; } self.q[self.q.length - 1].or = (self.q[self.q.length - 1].or || []).concat([[f2, String(op2).toUpperCase(), v2]]); } };
        },
        addEncodedQuery: function (q) { var e = parseEncoded(q); self.encoded.push(e); self.order = self.order.concat(e.order); },
        addActiveQuery: function () { self.q.push(['active', '=', 'true']); },
        addNullQuery: function (f) { self.q.push([f, 'ISEMPTY', '']); },
        addNotNullQuery: function (f) { self.q.push([f, 'ISNOTEMPTY', '']); },
        orderBy: function (f) { self.order.push({ f: f, desc: false }); },
        orderByDesc: function (f) { self.order.push({ f: f, desc: true }); },
        setLimit: function (n) { self.limit = n; },
        setWorkflow: function () {}, autoSysFields: function () {},
        query: function () {
            var all = allRows(table), rows = [];
            for (var ai = 0; ai < all.length; ai++) {
                var r = all[ai].r, ok = true;
                for (var i = 0; i < self.q.length && ok; i++) {
                    var c = self.q[i];
                    var any = cmp(fieldVal(r, c[0]), c[1], c[2]);
                    (c.or || []).forEach(function (o) { if (cmp(fieldVal(r, o[0]), o[1], o[2])) any = true; });
                    ok = any;
                }
                for (var e = 0; e < self.encoded.length && ok; e++) {
                    var enc = self.encoded[e];
                    ok = enc.nq ? enc.nq.some(function (b) { return groupsMatch(r, b.groups); }) : groupsMatch(r, enc.groups);
                }
                if (ok) rows.push(all[ai]);
            }
            var order = self.order;
            if (order.length) {
                rows.sort(function (a, b) {
                    for (var i = 0; i < order.length; i++) {
                        var x = String(a.r[order[i].f] || ''), y = String(b.r[order[i].f] || '');
                        if (x !== y) return (x < y ? -1 : 1) * (order[i].desc ? -1 : 1);
                    }
                    return 0;
                });
            }
            self.rows = rows.slice(0, self.limit);
            self.i = -1;
        },
        hasNext: function () { return self.rows && self.i + 1 < self.rows.length; },
        next: function () {
            self.i++;
            if (self.rows && self.i < self.rows.length) {
                self.rec = JSON.parse(JSON.stringify(self.rows[self.i].r)); self.recTable = self.rows[self.i].t; self._rec = self.rec;
                self.base = JSON.parse(JSON.stringify(self.rows[self.i].r));
                return true;
            }
            return false;
        },
        getRowCount: function () { return self.rows ? self.rows.length : 0; },
        insert: function () {
            if (GlideRecord.refuseInsert[table]) return null;   // a refused insert returns null, it does not throw
            var sid = self.rec.sys_id || newId();
            self.rec.sys_id = sid;
            if (!self.rec.sys_created_on) self.rec.sys_created_on = fmtUtc(P.now);
            self.rec.sys_updated_on = fmtUtc(P.now);
            journal(table, sid, self.rec);
            if (self.rec.work_notes) { self.rec._work_notes = [self.rec.work_notes]; self.rec.work_notes = ''; }
            if (self.rec.comments) { self.rec._comments = [self.rec.comments]; self.rec.comments = ''; }
            if (!self.rec.sys_class_name) self.rec.sys_class_name = table;
            P.STORE[table] = P.STORE[table] || {};
            P.STORE[table][sid] = JSON.parse(JSON.stringify(self.rec));
            self.recTable = table;
            self.base = JSON.parse(JSON.stringify(self.rec));
            if (GlideRecord.onInsert[table]) GlideRecord.onInsert[table](P.STORE[table][sid]);
            // task tables number their records, like the platform
            var PFX = { incident: 'INC', change_request: 'CHG', problem: 'PRB', sc_task: 'SCTASK', sc_req_item: 'RITM', sc_request: 'REQ' };
            if (!P.STORE[table][sid].number && PFX[table]) P.STORE[table][sid].number = PFX[table] + String(10100 + (++P.guid)).padStart(7, '0');
            if (P.STORE[table][sid].number) self.rec.number = P.STORE[table][sid].number;
            return sid;
        },
        update: function () {
            if (!self.rec || !self.rec.sys_id) return this.insert();
            var rt = self.recTable || table;
            if (GlideRecord.refuseUpdate[rt]) return null;   // e.g. a before rule that aborts the action
            var t = P.STORE[rt] = P.STORE[rt] || {};
            var stored = t[self.rec.sys_id] || {};
            // like the platform: only fields changed on THIS object are written,
            // so a stale object cannot put back values someone else changed
            var base = self.base || {}, next = JSON.parse(JSON.stringify(stored));
            for (var f in self.rec) {
                if (!self.rec.hasOwnProperty(f) || f === 'sys_mod_count' || f === 'sys_updated_on' || f.charAt(0) === '_') continue;
                if (String(self.rec[f]) !== String(base[f] === undefined ? '' : base[f])) next[f] = self.rec[f];
            }
            next.sys_mod_count = String((parseInt(stored.sys_mod_count, 10) || 0) + 1);
            next.sys_updated_on = fmtUtc(P.now);
            journal(rt, next.sys_id, next);
            if (next.work_notes) { next._work_notes = (stored._work_notes || []).concat([next.work_notes]); next.work_notes = ''; }
            if (next.comments) { next._comments = (stored._comments || []).concat([next.comments]); next.comments = ''; }
            if (GlideRecord.onUpdate[rt]) GlideRecord.onUpdate[rt](next, stored);
            t[self.rec.sys_id] = next;
            self.rec = JSON.parse(JSON.stringify(next)); self._rec = self.rec;
            self.base = JSON.parse(JSON.stringify(next));
            return next.sys_id;
        },
        deleteRecord: function () {
            var dt = self.recTable || table;
            if (GlideRecord.refuseDelete[dt]) return false;
            if (self.rec && P.STORE[dt]) delete P.STORE[dt][self.rec.sys_id];
            return true;
        },
        deleteMultiple: function () { this.query(); var s = this; while (s.next()) s.deleteRecord(); }
    };
    return new Proxy(api, {
        get: function (o, p) {
            if (p in o) return o[p];
            if (typeof p !== 'string') return undefined;
            // like the platform: under GlideRecordSecure an unreadable field is null
            if (self.secure && self.rec && self.rec.sys_id && !aclOk(self.recTable || table, 'read', self.rec, p)) return null;
            return makeElement({ _rec: self.rec, table: self.recTable || table }, p);
        },
        set: function (o, p, v) {
            if (typeof v === 'function' && p in o) { o[p] = v; return true; }   // GlideRecordSecure wraps methods
            if (!self.rec) self.rec = { sys_mod_count: '0' };
            if (self.secure && !fieldWritable(self, table, p)) return true;   // Secure ignores fields the user may not write
            self.rec[p] = (v === null || v === undefined) ? '' : String(v);
            self._rec = self.rec;
            return true;
        }
    });
}
GlideRecord.onUpdate = {};     // table -> fn(next, old): simulate business rules
GlideRecord.onInsert = {};
GlideRecord.refuseDelete = {}; // table -> true: simulate cross-scope delete refusal
GlideRecord.refuseInsert = {}; // table -> true: simulate an insert the platform refuses
GlideRecord.refuseUpdate = {}; // table -> true: simulate an update the platform refuses
// journal fields: the platform stores each entry as a sys_journal_field row
function journal(table, sysId, rec) {
    ['work_notes', 'comments'].forEach(function (f) {
        if (!rec[f] || table === 'sys_journal_field') return;
        P.STORE.sys_journal_field = P.STORE.sys_journal_field || {};
        var id = newId();
        P.STORE.sys_journal_field[id] = { sys_id: id, element_id: sysId, element: f, name: table, value: rec[f],
                                          sys_created_on: fmtUtc(P.now), sys_created_by: P.user.user_name, sys_class_name: 'sys_journal_field' };
    });
}
function aclOk(table, op, rec, field) { return !P.ACL || P.ACL(table, op, rec || {}, field) !== false; }
function fieldWritable(self, table, f) {
    if (!self.rec || !self.rec.sys_id) return true;              // new record: create ACL decides at insert
    return aclOk(self.recTable || table, 'write', self.rec, f);
}
function GlideRecordSecure(table) {
    var gr = GlideRecord(table), self = gr._self;
    self.secure = true;
    var baseQuery = gr.query, baseGet = gr.get, baseUpdate = gr.update, baseInsert = gr.insert, baseDelete = gr.deleteRecord;
    gr.query = function () {
        baseQuery.call(gr);
        self.rows = (self.rows || []).filter(function (x) { return aclOk(x.t, 'read', x.r); });
    };
    gr.get = function (a, b) { var ok = baseGet.call(gr, a, b); if (ok && !aclOk(self.recTable || table, 'read', self.rec)) { self.rec = null; return false; } return ok; };
    gr.deleteRecord = function () { if (!aclOk(self.recTable || table, 'delete', self.rec)) return false; return baseDelete.call(gr); };
    var baseValid = gr.isValidField, baseElement = gr.getElement;
    var unreadable = function (f) { return self.rec && self.rec.sys_id && !aclOk(self.recTable || table, 'read', self.rec, f); };
    gr.isValidField = function (f) { return unreadable(f) ? false : baseValid.call(gr, f); };
    gr.getElement = function (f) { return unreadable(f) ? null : baseElement.call(gr, f); };
    gr.update = function () { if (!aclOk(self.recTable || table, 'write', self.rec)) return null; return baseUpdate.call(gr); };
    gr.insert = function () { if (!aclOk(table, 'create', self.rec)) return null; return baseInsert.call(gr); };
    return gr;
}

/* ---------------- GlideAggregate ---------------- */
function GlideAggregate(table) {
    var gr = GlideRecord(table);
    var groupBy = null, groups = null, gi = -1, all = null;
    return {
        addQuery: function (f, op, v) { return gr.addQuery(f, op, v); },
        addEncodedQuery: function (q) { gr.addEncodedQuery(q); },
        addActiveQuery: function () { gr.addActiveQuery(); },
        addAggregate: function () {},
        groupBy: function (f) { groupBy = f; },
        orderBy: function () {}, orderByAggregate: function () {}, setLimit: function () {},
        query: function () {
            gr.query();
            all = [];
            while (gr.next()) all.push(JSON.parse(JSON.stringify(gr._self.rec)));
            if (groupBy) {
                var m = {};
                all.forEach(function (r) { var k = String(r[groupBy] || ''); (m[k] = m[k] || []).push(r); });
                groups = Object.keys(m).map(function (k) { return { key: k, rows: m[k] }; });
            } else groups = [{ key: '', rows: all }];
            gi = -1;
        },
        next: function () { gi++; return gi < groups.length; },
        getAggregate: function () { return String(groups[gi].rows.length); },
        getValue: function (f) { return f === groupBy ? groups[gi].key : null; },
        getDisplayValue: function (f) { return f === groupBy ? groups[gi].key : ''; }
    };
}

/* ---------------- gs, Class, sn_ws ---------------- */
var gs = {
    getProperty: function (k, d) { return P.PROPS.hasOwnProperty(k) ? P.PROPS[k] : d; },
    setProperty: function (k, v) { P.PROPS[k] = v; },
    getUserID: function () { return P.user.sys_id; },
    getUserName: function () { return P.user.user_name; },
    getUserDisplayName: function () { return P.user.name; },
    hasRole: function (r) { return !P.ROLES || !!P.ROLES[r] || !!P.ROLES.admin; },
    info: function (m) { P.LOG.push('info ' + m); },
    warn: function (m) { P.LOG.push('warn ' + m); },
    error: function (m) { P.LOG.push('error ' + m); },
    debug: function () {},
    nowDateTime: function () { return fmtUtc(P.now); },
    nowNoTZ: function () { return fmtUtc(P.now); },
    now: function () { return fmtUtc(P.now).substring(0, 10); },
    generateGUID: function () { return newId(); },
    getMessage: function (m) { return m; },
    eventQueue: function () {},
    getSession: function () { return { getTimeZoneName: function () { return 'UTC'; } }; },
    daysAgoStart: function (n) { return fmtUtc(P.now - n * 86400000); },
    include: function () {}
};

var Class = { create: function () { return function () { if (this.initialize) this.initialize.apply(this, arguments); }; } };

var sn_ws = {
    RESTMessageV2: function () {
        var req = { headers: {}, body: null, endpoint: '', method: 'get' };
        return {
            setEndpoint: function (u) { req.endpoint = u; }, setHttpMethod: function (m) { req.method = m; },
            setRequestHeader: function (k, v) { req.headers[k] = v; }, setRequestBody: function (b) { req.body = b; },
            setHttpTimeout: function () {}, setEccParameter: function () {},
            execute: function () {
                var r = P.HTTP ? P.HTTP(req) : { status: 0, body: '' };
                return { getStatusCode: function () { return r.status; }, getBody: function () { return r.body; },
                         haveError: function () { return r.status === 0; }, getErrorMessage: function () { return r.status ? '' : 'no network in tests'; } };
            },
            executeAsync: function () { return this.execute(); }
        };
    }
};

var DEFAULT_CHOICES = {
    '*.state': { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' },
    '*.priority': { '1': '1 - Critical', '2': '2 - High', '3': '3 - Moderate', '4': '4 - Low', '5': '5 - Planning' },
    '*.impact': { '1': '1 - High', '2': '2 - Medium', '3': '3 - Low' },
    '*.urgency': { '1': '1 - High', '2': '2 - Medium', '3': '3 - Low' },
    '*.operational_status': { '1': 'Operational', '2': 'Non-Operational', '3': 'Repair in Progress', '6': 'Retired' },
    '*.install_status': { '1': 'Installed', '3': 'In Maintenance', '6': 'In Stock', '7': 'Retired' },
    'change_request.risk': { '1': 'Very High', '2': 'High', '3': 'Moderate', '4': 'Low' },
    'change_request.type': { normal: 'Normal', standard: 'Standard', emergency: 'Emergency' },
    'change_request.close_code': { successful: 'Successful', successful_issues: 'Successful with issues', unsuccessful: 'Unsuccessful' },
    'sysapproval_approver.state': { requested: 'Requested', approved: 'Approved', rejected: 'Rejected' }
};
function reset() {
    P.STORE = {}; P.PROPS = {}; P.DISPLAY = {}; P.CHOICES = JSON.parse(JSON.stringify(DEFAULT_CHOICES)); P.INVALID_FIELDS = {}; P.UNSUPPORTED = []; P.LOG = [];
    P.HTTP = null; P.now = Date.UTC(2026, 8, 23, 20, 0, 0); P.guid = 0; P.tzOffsetMs = 0;
    P.user = { sys_id: 'u_admin', name: 'System Administrator', user_name: 'admin' };
    P.ROLES = null; P.ACL = null;
    GlideRecord.onUpdate = {}; GlideRecord.onInsert = {}; GlideRecord.refuseDelete = {}; GlideRecord.refuseInsert = {}; GlideRecord.refuseUpdate = {};
}

// put a record in the store (returns its sys_id)
function put(table, rec) {
    P.STORE[table] = P.STORE[table] || {};
    var r = {};
    for (var k in rec) if (rec.hasOwnProperty(k)) r[k] = rec[k] === null || rec[k] === undefined ? '' : String(rec[k]);
    if (!r.sys_id) r.sys_id = newId();
    if (!r.sys_class_name) r.sys_class_name = table;
    if (!r.sys_mod_count) r.sys_mod_count = '0';
    if (!r.sys_created_on) r.sys_created_on = fmtUtc(P.now);
    if (!r.sys_updated_on) r.sys_updated_on = r.sys_created_on;
    P.STORE[table][r.sys_id] = r;
    return r.sys_id;
}
function rec(table, sysId) { var rows = allRows(table); for (var i = 0; i < rows.length; i++) if (rows[i].r.sys_id === sysId) return rows[i].r; return null; }
function find(table, field, value) {
    var rows = allRows(table);
    for (var i = 0; i < rows.length; i++) if (String(rows[i].r[field]) === String(value)) return rows[i].r;
    return null;
}

function install(target) {
    target.GlideRecord = GlideRecord;
    target.GlideRecordSecure = GlideRecordSecure;
    target.GlideAggregate = GlideAggregate;
    target.GlideDateTime = GlideDateTime;
    target.gs = gs;
    target.Class = Class;
    target.sn_ws = sn_ws;
}

module.exports = { P: P, reset: reset, put: put, rec: rec, find: find, install: install, fmtUtc: fmtUtc, parseUtc: parseUtc,
                   GlideRecord: GlideRecord, GlideAggregate: GlideAggregate, GlideDateTime: GlideDateTime, gs: gs };

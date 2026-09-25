/* v7.9 - the on-device ear's files served from the instance:
 * GET /voice/ear/{model}/{file} and /voice/ear/{model}/{dir}/{file}
 * (source/scripted_rest/ear.js), run against a fake platform. */
var T = require('./lib/t.js'), N = require('./lib/netra.js');
var fs = require('fs'), path = require('path'), vm = require('vm');
var EAR = fs.readFileSync(path.join(N.SRC, 'scripted_rest', 'ear.js'), 'utf8').replace(/__NETRA_SCOPE__/g, 'x_196061_netra_v1');

// the fake instance: ear_file records and their attachments
function serve(params, records, attachments) {
    var out = { status: 0, type: '', headers: {}, body: null, streamed: [], queries: [] };
    var response = {
        setStatus: function (s) { out.status = s; }, setContentType: function (t) { out.type = t; },
        setHeader: function (k, v) { out.headers[k] = v; }, setBody: function (b) { out.body = b; },
        getStreamWriter: function () { return { writeStream: function (s) { out.streamed.push(s); }, writeString: function (s) { out.streamed.push(s); } }; }
    };
    function GlideRecord(table) {
        var rows = table === 'sys_attachment' ? attachments : (table === 'x_196061_netra_v1_ear_file' ? records : []);
        var conds = [], limit = 0, i = -1, hits = [];
        this.addQuery = function (f, op, v) { if (v === undefined) { v = op; op = '='; } conds.push([f, op, v]); };
        this.setLimit = function (n) { limit = n; };
        this.orderBy = function () {};
        this.query = function () {
            out.queries.push(table + ' ' + JSON.stringify(conds));
            hits = rows.filter(function (r) { return conds.every(function (c) { var x = String(r[c[0]] == null ? '' : r[c[0]]); return c[1] === 'STARTSWITH' ? x.indexOf(c[2]) === 0 : x === String(c[2]); }); });
            hits.sort(function (a, b) { return String(a.file_name || '').localeCompare(String(b.file_name || '')); });
            if (limit) hits = hits.slice(0, limit);
        };
        this.next = function () { i++; return i < hits.length; };
        this.getValue = function (f) { return hits[i][f] == null ? null : String(hits[i][f]); };
        this.getUniqueValue = function () { return hits[i].sys_id; };
        this.getTableName = function () { return table; };
    }
    function GlideSysAttachment() { this.getContentStream = function (id) { return 'stream:' + id; }; }
    vm.runInNewContext(EAR, { request: { pathParams: params }, response: response, GlideRecord: GlideRecord, GlideSysAttachment: GlideSysAttachment, JSON: JSON, String: String, parseInt: parseInt });
    return out;
}
var REC = [{ sys_id: 'r1', name: 'whisper-small.en' }, { sys_id: 'r2', name: 'ort' }, { sys_id: 'r3', name: 'lib' }];
function att(rec, name, size, id) { return { sys_id: id || (rec + ':' + name), table_name: 'x_196061_netra_v1_ear_file', table_sys_id: rec, file_name: name, size_bytes: size }; }
var ATT = [
    att('r1', 'config.json', 2203), att('r1', 'tokenizer.json', 2405679),
    att('r1', 'onnx__encoder_model_quantized.onnx', 92326170),
    att('r1', 'onnx__encoder_model.onnx.part1', 157286400, 'p1'), att('r1', 'onnx__encoder_model.onnx.part3', 38253070, 'p3'), att('r1', 'onnx__encoder_model.onnx.part2', 157286400, 'p2'),
    att('r1', 'onnx__encoder_model.onnx.partial-note.txt', 5, 'stray'),
    att('r2', 'ort-wasm-simd-threaded.jsep.mjs.js', 44484), att('r2', 'ort-wasm-simd-threaded.jsep.wasm', 21596019),
    att('r3', 'transformers.min.js', 870663)
];

T.test('a model file: the record by model, the attachment by path with / as __, the type by extension, a year\'s cache, the size', function () {
    var r = serve({ model: 'whisper-small.en', dir: 'onnx', file: 'encoder_model_quantized.onnx' }, REC, ATT);
    T.eq(r.status, 200); T.eq(r.type, 'application/octet-stream');
    T.eq(r.streamed, ['stream:r1:onnx__encoder_model_quantized.onnx']);
    T.eq(r.headers['Content-Length'], '92326170');
    T.match(r.headers['Cache-Control'], /max-age=31536000/); T.eq(r.headers['X-Content-Type-Options'], 'nosniff');
    T.match(r.queries[0], /x_196061_netra_v1_ear_file.*"name","=","whisper-small.en"/);
    T.match(r.queries[1], /sys_attachment.*"table_sys_id","=","r1".*"file_name","STARTSWITH","onnx__encoder_model_quantized.onnx"/);
});

T.test('the suffixes the platform reads as a response format are asked for as -json, -js, -wasm and served as .json, .js, .wasm', function () {
    var r = serve({ model: 'whisper-small.en', file: 'config-json' }, REC, ATT);
    T.eq([r.status, r.type, r.streamed[0]], [200, 'application/json', 'stream:r1:config.json']);
    r = serve({ model: 'lib', file: 'transformers.min-js' }, REC, ATT);
    T.eq([r.status, r.type, r.streamed[0]], [200, 'text/javascript', 'stream:r3:transformers.min.js']);
    r = serve({ model: 'ort', file: 'ort-wasm-simd-threaded.jsep-wasm' }, REC, ATT);
    T.eq([r.status, r.type, r.streamed[0]], [200, 'application/wasm', 'stream:r2:ort-wasm-simd-threaded.jsep.wasm']);
});

T.test('the runtime\'s .mjs module is kept as .mjs.js (the platform refuses a .mjs attachment) and served as JavaScript', function () {
    var r = serve({ model: 'ort', file: 'ort-wasm-simd-threaded.jsep.mjs' }, REC, ATT);
    T.eq([r.status, r.type, r.streamed[0]], [200, 'text/javascript', 'stream:r2:ort-wasm-simd-threaded.jsep.mjs.js']);
});

T.test('a file kept in parts (the platform refuses an upload past about 200 MB) is streamed back as one, in order, its size the sum; a stray name is not a part', function () {
    var r = serve({ model: 'whisper-small.en', dir: 'onnx', file: 'encoder_model.onnx' }, REC, ATT);
    T.eq(r.status, 200);
    T.eq(r.streamed, ['stream:p1', 'stream:p2', 'stream:p3'], 'part1, part2, part3 - never the stray');
    T.eq(r.headers['Content-Length'], String(157286400 * 2 + 38253070));
});

T.test('what is not there is a 404 with a reason, never a stream: an unknown model, a missing file, a bad name, a path with .. or /', function () {
    var r = serve({ model: 'whisper-large', file: 'config-json' }, REC, ATT);
    T.eq(r.status, 404); T.eq(r.body, { error: 'no such model on this instance' }); T.eq(r.streamed, []);
    r = serve({ model: 'whisper-small.en', file: 'nothing-json' }, REC, ATT);
    T.eq(r.status, 404); T.eq(r.body, { error: 'no such file on this instance' });
    [{ model: '..', file: 'config-json' }, { model: 'whisper-small.en', dir: '../..', file: 'x' }, { model: 'whisper-small.en', file: 'a/b' }, { model: '', file: 'config-json' }, { model: 'whisper-small.en', file: '.hidden' }, { model: 'w', file: 'x;drop' }].forEach(function (p) {
        var b = serve(p, REC, ATT);
        T.eq(b.status, 404, JSON.stringify(p)); T.eq(b.body, { error: 'no such file' }); T.eq(b.queries, [], 'no query at all for ' + JSON.stringify(p));
    });
});

T.test('the resource reads nothing but the ear_file record and its attachments', function () {
    T.notMatch(EAR, /gs\.getUser|GlideRecordSecure|sys_user|incident|getProperty/);
    T.match(EAR, /requires_authentication = false/, 'documented as public');
});

T.test('the widget hands the page the ear base, and the worker asks the instance first', function () {
    var SERVER = fs.readFileSync(path.join(N.SRC, 'widget', 'server.js'), 'utf8');
    T.match(SERVER, /data\.ear_base\s*=\s*'\/api\/' \+ SCOPE \+ '\/voice\/ear';/);
    var CLIENT = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
    T.match(CLIENT, /env\.remoteHost = e\.data\.pdi; env\.remotePathTemplate = '\{model\}\/';/);
    T.match(CLIENT, /wasmPaths = src === 'pdi' \? e\.data\.pdi \+ 'ort\/' : e\.data\.hub/);
    T.match(CLIENT, /lib\/transformers\.min-js/);
});

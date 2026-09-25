/**
 * Scripted REST resources (two, one script):
 *   GET /api/__NETRA_SCOPE__/voice/ear/{model}/{file}
 *   GET /api/__NETRA_SCOPE__/voice/ear/{model}/{dir}/{file}
 * PUBLIC (requires_authentication = false): the public Netra Live page is
 * opened by Guests, and the on-device ear fetches these before anyone logs in.
 *
 * v7.9 - the on-device ear's files, served from this instance so no visitor
 * has to reach huggingface.co or a CDN (both blocked on many corporate
 * networks): the Whisper models (whisper-small.en, whisper-base.en,
 * whisper-tiny.en: their config and tokenizer JSON and ONNX weights), the
 * ONNX runtime (ort) and transformers.js (lib). Each is a record of
 * __NETRA_SCOPE___ear_file named for it, and each file an attachment on that record with
 * '/' in its path written '__' (onnx/encoder_model.onnx is the attachment
 * onnx__encoder_model.onnx). The size is sent, so the browser shows a real
 * figure; a year's cache, since the files never change. Nothing here reads
 * or writes any other record, so a Guest learns nothing from it.
 */
(function process(request, response) {
    var p = request.pathParams || {};
    var model = String(p.model || ''), dir = String(p.dir || ''), file = String(p.file || '');
    var ok = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    var miss = function (why) { response.setStatus(404); response.setBody({ error: why }); };
    if (!ok.test(model) || !ok.test(file) || (dir && !ok.test(dir))) return miss('no such file');
    // the platform takes a trailing .json, .js or .wasm as a response format
    // and never reaches this script, so the ear's worker asks for config-json,
    // transformers.min-js and ort-wasm-simd-threaded.jsep-wasm instead
    file = file.replace(/-(json|js|wasm|map)$/, '.$1');
    var name = (dir ? dir + '__' : '') + file;

    var rec = new GlideRecord('__NETRA_SCOPE___ear_file');
    rec.addQuery('name', model);
    rec.setLimit(1);
    rec.query();
    if (!rec.next()) return miss('no such model on this instance');

    var att = new GlideRecord('sys_attachment');
    att.addQuery('table_name', rec.getTableName());
    att.addQuery('table_sys_id', rec.getUniqueValue());
    // the platform refuses a .mjs attachment, so the runtime's modules are kept
    // as .mjs.js; and it refuses an upload past about 200 MB, so a big model
    // file is kept as .part1, .part2, ... and streamed back as one
    var stored = /\.mjs$/.test(name) ? name + '.js' : name;
    att.addQuery('file_name', 'STARTSWITH', stored);
    att.orderBy('file_name');
    att.query();
    var ids = [], size = 0;
    while (att.next()) {
        var fn = String(att.getValue('file_name'));
        if (fn !== stored && !/\.part\d+$/.test(fn.substring(stored.length))) continue;
        ids.push(att.getUniqueValue()); size += parseInt(att.getValue('size_bytes'), 10) || 0;
    }
    if (!ids.length) return miss('no such file on this instance');

    var ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
    var type = { json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', map: 'application/json', wasm: 'application/wasm', onnx: 'application/octet-stream' }[ext] || 'application/octet-stream';
    response.setStatus(200);
    response.setContentType(type);
    response.setHeader('Content-Length', String(size));
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    var out = response.getStreamWriter(), sa = new GlideSysAttachment();
    for (var i = 0; i < ids.length; i++) out.writeStream(sa.getContentStream(ids[i]));
})(request, response);

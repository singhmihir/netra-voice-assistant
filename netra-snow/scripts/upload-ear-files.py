#!/usr/bin/env python3
"""Put the on-device ear's files on a ServiceNow instance (v7.9).

Netra's on-device hearing (Whisper, run in the browser by transformers.js)
fetches its files from the instance first - the public resource
GET /api/x_196061_netra_v1/voice/ear/{model}/{file} serves them - and from
huggingface.co and jsdelivr.net only when the instance has no copy. This
script downloads the files once and uploads them as attachments on the
app's ear_file records (one record per model; a '/' in a path is '__' in
the attachment's name; the platform refuses a .mjs attachment, so those
are kept as .mjs.js). The update set carries the table and the resource,
not these files (about 390 MB).

usage:  SN_URL=https://<instance>.service-now.com SN_USER=admin SN_PASS=... \
        python3 scripts/upload-ear-files.py [work-dir]

The attachment API refuses an upload past about 200 MB, so a bigger file
(the GPU pair of whisper-small.en: the fp32 encoder and the q4 decoder) is
sent in 150 MB parts named .part1, .part2, ... and the resource streams
them back as one file. Re-running skips files already there at the same
size. About 950 MB in all.
"""
import base64, json, os, ssl, sys, time, urllib.parse, urllib.request

SN = os.environ.get('SN_URL', '').rstrip('/')
USER, PASS = os.environ.get('SN_USER', 'admin'), os.environ.get('SN_PASS', '')
if not SN or not PASS:
    sys.exit('set SN_URL and SN_PASS (and SN_USER, default admin)')
AUTH = base64.b64encode((USER + ':' + PASS).encode()).decode()
CTX = ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE']) if os.environ.get('SSL_CERT_FILE') else ssl.create_default_context()
TABLE = 'x_196061_netra_v1_ear_file'
PART = 150 * 1048576
WORK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.ear-files')
HUB = 'https://huggingface.co/onnx-community/'
CDN = 'https://cdn.jsdelivr.net/npm/'
ORT = 'onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/'
LIB = '@huggingface/transformers@3.7.1/dist/'
JSONS = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']
Q8 = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
GPU = ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']
WANT = {
    'whisper-small.en': [(HUB + 'whisper-small.en/resolve/main/' + f, f) for f in JSONS + Q8 + GPU],
    'whisper-base.en': [(HUB + 'whisper-base.en/resolve/main/' + f, f) for f in JSONS + Q8],
    'whisper-tiny.en': [(HUB + 'whisper-tiny.en/resolve/main/' + f, f) for f in JSONS + Q8],
    'ort': [(CDN + ORT + f, f) for f in ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']],
    'lib': [(CDN + LIB + 'transformers.min.js', 'transformers.min.js')],
}

def api(method, path, payload=None, raw=None, ctype='application/json'):
    req = urllib.request.Request(SN + path, method=method)
    req.add_header('Authorization', 'Basic ' + AUTH); req.add_header('Accept', 'application/json')
    data = raw
    if payload is not None:
        data = json.dumps(payload).encode()
    if data is not None:
        req.add_header('Content-Type', ctype)
    with urllib.request.urlopen(req, data=data, context=CTX, timeout=1800) as r:
        b = r.read().decode()
        return json.loads(b) if b.strip() else {}

def fetch(url, out):
    if os.path.exists(out) and os.path.getsize(out) > 0: return
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with urllib.request.urlopen(url, context=CTX, timeout=1800) as r, open(out + '.part', 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk: break
            f.write(chunk)
    os.replace(out + '.part', out)

for model, files in WANT.items():
    rows = api('GET', '/api/now/table/' + TABLE + '?sysparm_query=' + urllib.parse.quote('name=' + model) + '&sysparm_fields=sys_id')['result']
    rec = rows[0]['sys_id'] if rows else api('POST', '/api/now/table/' + TABLE, {'name': model})['result']['sys_id']
    for url, rel in files:
        local = os.path.join(WORK, model, rel)
        fetch(url, local)
        size = os.path.getsize(local)
        stored = rel.replace('/', '__') + ('.js' if rel.endswith('.mjs') else '')
        parts = [(stored, 0, size)] if size <= PART else [(stored + '.part' + str(i + 1), i * PART, min(PART, size - i * PART)) for i in range((size + PART - 1) // PART)]
        for pname, off, length in parts:
            have = api('GET', '/api/now/table/sys_attachment?sysparm_query=' + urllib.parse.quote('table_name=' + TABLE + '^table_sys_id=' + rec + '^file_name=' + pname) + '&sysparm_fields=sys_id,size_bytes')['result']
            if have and int(have[0]['size_bytes']) == length:
                print(model, pname, 'already there'); continue
            for h in have: api('DELETE', '/api/now/table/sys_attachment/' + h['sys_id'])
            t0 = time.time()
            with open(local, 'rb') as f:
                f.seek(off); body = f.read(length)
            out = api('POST', '/api/now/attachment/file?table_name=' + TABLE + '&table_sys_id=' + rec + '&file_name=' + urllib.parse.quote(pname), raw=body, ctype='application/octet-stream')['result']
            print(model, pname, 'sent %.1f MB in %.0f s' % (length / 1048576, time.time() - t0), 'size', out.get('size_bytes'), flush=True)
print('done')

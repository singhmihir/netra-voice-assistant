/* v7.9 - Netra's own voice, from this instance: a neural voice (Piper, Cori)
 * run in a module worker from the instance's files; her own voice is the
 * default engine, this device's voice speaks while hers loads or if she fails. */
var T = require('./lib/t.js'), N = require('./lib/netra.js');
var fs = require('fs'), path = require('path'), vm = require('vm');
var CLIENT = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
var noop = function () {};

function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.data = { ear_base: '/api/x_196061_netra_v1/voice/ear' }; c.hasTTS = true; c.ttsEngine = 'netra'; c.speechRate = 1.0; c.voicePick = '';
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    cl.set('$window', { location: { origin: 'https://x.service-now.com' }, navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141' } });
    cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    cl.set('logEvent', function (l, m) { c.events.push(l + ': ' + m); });
    ['_readyUpdate', '_silenceCurrentAudio', 'attachOutputAnalyser', 'detachOutputAnalyser', '_clearSpeaking', 'setState', '_hushState', '_markSpeaking', '_cancelReprompt', '_keepCaption'].forEach(function (n) { cl.set(n, noop); });
    cl.set('_speakSessionId', 0); cl.set('_duckedForBarge', false); cl.set('_ctrlDestroyed', false);
    cl.set('VOICE_MODEL', 'en_GB-cori-medium'); cl.set('VOICE_NAME', 'Cori'); cl.set('VOICE_WORKER_SRC', '/* worker */');   // set by the controller body, which the harness does not run
    cl.set('_voiceWorker', null); cl.set('_voiceJobs', {}); cl.set('_voiceJobId', 0); cl.set('_voiceLoadStart', 0); cl.set('_voiceWaitSaid', false);
    return cl;
}
// a worker that answers like the real one
function fakeWorker(cl, behaviour) {
    var made = [];
    global.Worker = function (url, opts) {
        var w = this; made.push({ url: url, opts: opts, posted: [] });
        this.posted = made[made.length - 1].posted;
        this.postMessage = function (m) { w.posted.push(m); behaviour && behaviour(w, m); };
        this.terminate = noop;
    };
    global.URL = global.URL || {}; if (!global.URL.createObjectURL) global.URL.createObjectURL = function () { return 'blob:x'; };
    if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = noop;
    return made;
}

T.test('the worker: the runtime, the phonemizer and the voice from this instance (-json/-js/-wasm where the platform eats a suffix); phonemes -> the model\'s feeds -> PCM', function () {
    var at = CLIENT.indexOf('var VOICE_WORKER_SRC ='), end = CLIENT.indexOf("    c.voice = { status: 'off'", at);
    var expr = CLIENT.substring(at + 'var VOICE_WORKER_SRC ='.length, end).replace(/;\s*$/, '');
    var src = vm.runInNewContext('(' + expr + ')', {}).replace(/await import\(/g, 'await __import(');
    var fetched = [], posted = [], runs = [], created = 0, mains = [];
    var self = { postMessage: function (m) { posted.push(m); }, fetch: function (u) {
        fetched.push(String(u));
        return Promise.resolve({ json: function () { return Promise.resolve({ audio: { sample_rate: 22050 }, espeak: { voice: 'en' }, inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }, num_speakers: 1 }); },
            text: function () { return Promise.resolve('var createPiperPhonemize = function (opts) { self.__phonOpts = opts; return Promise.resolve({ callMain: function (args) { self.__mains.push(args); opts.print(JSON.stringify({ phoneme_ids: [1, 2, 3, 4] })); } }); };'); },
            arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } });
    } };
    self.__mains = mains;
    var Tensor = function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; };
    var ort = { env: { wasm: {} }, Tensor: Tensor, InferenceSession: { create: function (buf, o) { created++; return Promise.resolve({ run: function (feeds) { runs.push(feeds); return Promise.resolve({ output: { data: Float32Array.from([0.1, -0.2, 0.3]) } }); } }); } } };
    var __import = function (u) { fetched.push('import ' + u); return Promise.resolve(ort); };
    new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', src)(self, __import, setTimeout, clearTimeout, function (u, o) { return self.fetch(u, o); });
    self.onmessage({ data: { cmd: 'load', base: 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/', model: 'en_GB-cori-medium' } });
    self.onmessage({ data: { cmd: 'say', id: 7, text: 'Hello there.', lengthScale: 0.9 } });
    return new Promise(function (r) { setTimeout(r, 50); }).then(function () {
        T.eq(fetched, ['import https://x.service-now.com/api/x_196061_netra_v1/voice/ear/ort/ort.wasm.bundle.min.mjs',
            'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/voice/en_GB-cori-medium.onnx-json',
            'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/voice/piper_phonemize-js',
            'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/voice/en_GB-cori-medium.onnx'], 'every file from this instance, none from a CDN or a hub');
        T.eq(ort.env.wasm.wasmPaths, 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/ort/');
        T.eq(self.__phonOpts.locateFile('piper_phonemize.wasm'), 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/voice/piper_phonemize-wasm');
        T.eq(self.__phonOpts.locateFile('piper_phonemize.data'), 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/voice/piper_phonemize.data');
        T.eq(created, 1);
        T.eq(posted[0].ready, true); T.eq(posted[0].rate, 22050);
        T.eq(mains[0], ['-l', 'en', '--input', '[{"text":"Hello there."}]', '--espeak_data', '/espeak-ng-data']);
        var f = runs[0];
        T.eq([f.input.type, f.input.dims, Array.from(f.input.data).map(Number)], ['int64', [1, 4], [1, 2, 3, 4]]);
        T.eq([f.input_lengths.type, Array.from(f.input_lengths.data).map(Number)], ['int64', [4]]);
        T.eq(f.scales.type, 'float32'); T.ok(Math.abs(f.scales.data[1] - 0.9) < 1e-6, 'the pace is the length scale: ' + f.scales.data[1]);
        T.ok(!f.sid, 'no speaker id for a single-speaker voice');
        T.eq(posted[1].id, 7); T.eq(Array.from(posted[1].pcm).map(function (x) { return Math.round(x * 10) / 10; }), [0.1, -0.2, 0.3]); T.eq(posted[1].rate, 22050);
        // queued sentences dropped: answered as dropped, never run
        self.onmessage({ data: { cmd: 'say', id: 8, text: 'Eight.' } });
        self.onmessage({ data: { cmd: 'say', id: 9, text: 'Nine.' } });
        self.onmessage({ data: { cmd: 'drop', upTo: 9 } });
        self.onmessage({ data: { cmd: 'say', id: 10, text: 'Ten.' } });
        return new Promise(function (r) { setTimeout(r, 50); }).then(function () {
            var tail = posted.slice(2).map(function (m) { return m.id + (m.dropped ? ' dropped' : ' pcm'); });
            T.eq(tail, ['8 dropped', '9 dropped', '10 pcm'], 'eight and nine skipped (eight was already phonemized), ten made: ' + tail.join(', '));
            T.eq(runs.length, 2, 'the model ran only for seven and ten');
        });
    });
});

T.test('the page: her voice loads from this instance at boot, the gate waits for it (a while), Settings lists it first, the Lab cycles to it', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var made = fakeWorker(cl);
    f._netraVoiceLoad();
    T.eq(c.voice.status, 'loading'); T.eq(made.length, 1); T.eq(made[0].opts, { type: 'module' });
    T.eq(made[0].posted[0], { cmd: 'load', base: 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/', model: 'en_GB-cori-medium' });
    f._netraVoiceLoad(); T.eq(made.length, 1, 'loaded once');
    // the gate: waiting, then hers
    T.eq(f._voiceReady(), false); T.eq(c.gate.voiceText, 'loading my own voice from this instance…');
    T.eq(f._plainGateText(c.gate.voiceText), 'Getting her voice ready from this instance…');
    f._netraVoiceOnMessage({ data: { ready: true, ms: 2400, rate: 22050 } });
    T.eq(c.voice.status, 'ready'); T.eq(f._netraVoiceReady(), true);
    T.eq(f._voiceReady(), true); T.eq(c.gate.voiceText, 'my own voice (Cori)'); T.eq(f._plainGateText(c.gate.voiceText), 'Netra\'s own voice (Cori)');
    T.ok(c.events.some(function (e) { return /my own voice is ready \(Cori, 2\.4 s\)/.test(e); }), c.events.join(' | '));
    // Settings: her voice first, then the device's best, then the device's own
    cl.set('TTS', { getVoices: function () { return [{ name: 'Samantha', lang: 'en-US', localService: true }]; } });
    var list = f._deviceVoices();
    T.eq(list[0], { name: '__netra__', label: 'Netra\'s own voice (Cori, British English)' }); T.eq(list[1].name, ''); T.eq(list[2].name, 'Samantha');
    // picking a device voice leaves her engine; picking her again comes back
    var store = {}; global.localStorage = { setItem: function (k, v) { store[k] = v; }, getItem: function (k) { return store[k]; }, removeItem: function (k) { delete store[k]; } };
    cl.set('forcedVoiceName', ''); cl.set('chooseVoice', function () { return null; });
    f._setDeviceVoice('Samantha'); T.eq(c.ttsEngine, 'browser'); T.eq(store.netra_engine, 'browser'); T.eq(store.netra_voicePick, 'Samantha');
    f._setDeviceVoice('__netra__'); T.eq(c.ttsEngine, 'netra'); T.eq(c.voicePick, '__netra__'); T.eq(store.netra_engine, 'netra'); T.ok(!store.hasOwnProperty('netra_voicePick'));
    T.match(CLIENT, /c\.ttsEngine\s+= 'netra';/, 'her own voice is the default engine');
    T.match(CLIENT, /var seq = \['netra', 'edge', 'gemini', 'stream', 'browser'\];/, 'the Lab cycles through it');
    T.match(CLIENT, /startContinuous\(\);\n\s+_netraVoiceLoad\(\);/, 'loaded at boot, before the ear');
});

T.test('speaking: sentence groups synthesized in order and played back to back; a barge-in abandons the rest; a failed group hands the rest to this device\'s voice; while she loads the device speaks (said once)', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    var made = fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var played = [], browser = [];
    global.Audio = function (url) { var a = this; this.url = url; played.push(a); this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    // not ready yet: the device speaks, and the reason is logged once
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false;
    f.speak('Hello.'); f.speak('Again.');
    T.eq(browser, ['Hello.', 'Again.']);
    T.eq(c.events.filter(function (e) { return /this device's voice for now/.test(e); }).length, 1, 'said once');
    // ready: two groups, synthesized in order, played in order
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    var doneCalls = 0;
    f.speakNetraVoice('First sentence here. Second sentence there.', function () { doneCalls++; });
    T.eq(answers.length, 2, 'two groups asked for'); T.eq(answers[0].text, 'First sentence here.'); T.eq(answers[1].text, 'Second sentence there.');
    T.ok(Math.abs(answers[0].lengthScale - 1) < 1e-9);
    // the second answer arrives first: nothing plays out of order
    f._netraVoiceOnMessage({ data: { id: answers[1].id, pcm: Float32Array.from([0.1, 0.2]), rate: 22050 } });
    T.eq(played.length, 0, 'the first group is awaited');
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.3, 0.4]), rate: 22050 } });
    T.eq(played.length, 1, 'the first group plays');
    played[0].onended();
    T.eq(played.length, 2, 'then the second'); T.eq(doneCalls, 0);
    played[1].onended();
    T.eq(doneCalls, 1, 'done once, after the last group');
    T.eq(c.voice.said, 2, 'two groups said');
    // a barge-in: the session moves on, the queue stops
    played.length = 0; answers.length = 0;
    f.speakNetraVoice('One. Two. Three.', function () { doneCalls++; });
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(played.length, 1, 'the first of three plays');
    var postedBefore = made[0].posted.length;
    // a stop bumps the session and drops what her voice still had to make (stopSpeaking itself needs half the page)
    T.match(CLIENT, /_speakSessionId\+\+;[^\n]*\n\s+_netraVoiceDrop\(\);/, 'stopSpeaking drops her queued sentences');
    cl.set('_speakSessionId', cl.get('_speakSessionId') + 1); f._netraVoiceDrop();
    played[0].onended();
    T.eq(played.length, 1, 'nothing more plays after a barge-in'); T.eq(doneCalls, 1);
    var drop = made[0].posted.slice(postedBefore).filter(function (m) { return m.cmd === 'drop'; });
    T.eq(drop.length, 1, 'the worker is told to drop what is queued'); T.eq(drop[0].upTo, answers[2].id);
    T.eq(Object.keys(cl.get('_voiceJobs')).length, 0, 'no job left waiting');
    // a failed group: the rest goes to this device's voice
    played.length = 0; answers.length = 0; browser.length = 0;
    f.speakNetraVoice('Alpha. Beta. Gamma.', function () { doneCalls++; });
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    f._netraVoiceOnMessage({ data: { id: answers[1].id, error: 'phonemizer silent' } });
    played[0].onended();
    T.eq(browser, ['Beta. Gamma.'], 'the rest, in this device\'s voice'); T.eq(doneCalls, 2, 'done after the fallback');
    // the worker dies: pending groups are given up, the status says so, the next line is the device's
    answers.length = 0; browser.length = 0;
    f.speakNetraVoice('Delta.', function () { doneCalls++; });
    f._netraVoiceFail('worker: failed');
    T.eq(c.voice.status, 'error'); T.eq(browser, ['Delta.']);
    T.eq(f._netraVoiceReady(), false);
    f.speak('Later.'); T.eq(browser[browser.length - 1], 'Later.');
});

T.test('a WAV from PCM: 16-bit mono at the voice\'s rate, the sizes right', function () {
    var cl = page(), f = cl.fn;
    global.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; this.size = parts[0].byteLength; };
    var b = f._pcmToWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]), 22050);
    T.eq(b.type, 'audio/wav'); T.eq(b.size, 44 + 12);
    var v = new DataView(b.parts[0]);
    T.eq(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
    T.eq(v.getUint32(24, true), 22050); T.eq(v.getUint16(22, true), 1); T.eq(v.getUint16(34, true), 16); T.eq(v.getUint32(40, true), 12);
    T.eq([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true), v.getInt16(52, true), v.getInt16(54, true)], [0, 16384, -16384, 32767, -32768, 32767], 'clipped, never wrapped');
});

T.test('the loading card says where the ear\'s files come from', function () {
    var cl = page(), f = cl.fn;
    T.eq(f._plainGateText('loading my on-device ear from this instance 37% (best, about 250 MB, once)'), 'Getting speech recognition ready from this instance, one time (best, about 250 MB)');
    T.eq(f._plainGateText('loading my on-device ear 37% (best, about 250 MB, once)'), 'Downloading speech recognition, one time (best, about 250 MB)');
});

T.run(__filename);

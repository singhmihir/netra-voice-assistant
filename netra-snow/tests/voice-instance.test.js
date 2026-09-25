/* v7.9 - Netra's own voice, from this instance: a neural voice (Piper, Cori)
 * run in a module worker from the instance's files; her own voice is the
 * default engine, and once it is there it is the only one heard: a line
 * waits for her while she loads, a sentence she cannot make is left out,
 * a dead worker is started again; this device's voice only when she is not
 * on the instance at all, or would not come back. */
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
    // a timeout stub that runs at once (the page's own delays are not what is tested here)
    // short delays run at once (a restart, a cue's gap); long ones (a 30 s stall, the cues 6 s after ready) never fire here
    cl.set('$timeout', Object.assign(function (fn, delay) { if (typeof fn === 'function' && (delay || 0) <= 1500) fn(); return {}; }, { cancel: noop }));
    cl.set('logEvent', function (l, m) { c.events.push(l + ': ' + m); });
    ['_readyUpdate', '_silenceCurrentAudio', 'attachOutputAnalyser', 'detachOutputAnalyser', '_clearSpeaking', 'setState', '_hushState', '_markSpeaking', '_cancelReprompt', '_keepCaption'].forEach(function (n) { cl.set(n, noop); });
    cl.set('_speakSessionId', 0); cl.set('_duckedForBarge', false); cl.set('_ctrlDestroyed', false);
    // set by the controller body, which the harness does not run
    cl.set('VOICE_MODEL', 'en_GB-cori-medium'); cl.set('VOICE_NAME', 'Cori'); cl.set('VOICE_WORKER_SRC', '/* worker */');
    cl.set('_voiceWorker', null); cl.set('_voiceJobs', {}); cl.set('_voiceJobId', 0); cl.set('_voiceLoadStart', 0); cl.set('_voiceWaitSaid', false);
    cl.set('_voiceHeld', []); cl.set('_voiceRestarts', 0); cl.set('_voiceRestartAt', 0); cl.set('VOICE_WAIT_MS', 90000); cl.set('_voiceFirstStart', 0); cl.set('_voiceWaitTimer', null); cl.set('_voiceStallTimer', null);
    cl.set('_voiceEverReady', false); cl.set('_voiceOut', []); cl.set('_voiceHeadSince', 0); cl.set('_voiceLastMsg', 0); cl.set('_voiceLoadTimer', null);
    cl.set('VOICE_RESTART_WAIT_MS', 25000); cl.set('VOICE_RESTARTS', 4); cl.set('VOICE_LOAD_STALL_MS', 45000); cl.set('VOICE_STALL_MS', 30000); cl.set('VOICE_GROUP_MAX', 220); cl.set('_voiceReadyAt', 0); cl.set('VOICE_HEALTHY_MS', 120000);
    cl.set('VOICE_FILLERS', ['One moment, please.', 'Checking on that now.']); cl.set('_fillersPrepared', false); cl.set('fillerCache', []);
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
function workerSrc() {
    var at = CLIENT.indexOf('var VOICE_WORKER_SRC ='), end = CLIENT.indexOf("    c.voice = { status: 'off'", at);
    var expr = CLIENT.substring(at + 'var VOICE_WORKER_SRC ='.length, end).replace(/;\s*$/, '');
    return vm.runInNewContext('(' + expr + ')', {}).replace(/import\(/g, '__import(');
}

T.test('the worker: the runtime, the phonemizer and the voice from this instance, together and into Cache storage; the language data handed over; a warm-up; phonemes -> the model\'s feeds -> PCM; an empty sentence is silence', function () {
    var src = workerSrc();
    var fetched = [], posted = [], runs = [], created = 0, mains = [], putInCache = [];
    var self = {
        caches: { open: function () { return Promise.resolve({ match: function () { return Promise.resolve(undefined); }, put: function (u) { putInCache.push(String(u)); return Promise.resolve(); } }); } },
        postMessage: function (m) { posted.push(m); },
        fetch: function (u) {
            fetched.push(String(u));
            return Promise.resolve({ ok: true, clone: function () { return this; },
                json: function () { return Promise.resolve({ audio: { sample_rate: 22050 }, espeak: { voice: 'en' }, inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }, num_speakers: 1 }); },
                text: function () { return Promise.resolve('var createPiperPhonemize = function (opts) { self.__phonOpts = opts; return Promise.resolve({ callMain: function (args) { self.__mains.push(args); var t = JSON.parse(args[3])[0].text; opts.print(JSON.stringify({ phoneme_ids: t ? [1, 2, 3, 4] : [] })); } }); };'); },
                arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } });
        }
    };
    self.__mains = mains;
    var Tensor = function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; };
    var ort = { env: { wasm: {} }, Tensor: Tensor, InferenceSession: { create: function () { created++; return Promise.resolve({ run: function (feeds) { runs.push(feeds); return Promise.resolve({ output: { data: Float32Array.from([0.1, -0.2, 0.3]) } }); } }); } } };
    var __import = function (u) { fetched.push('import ' + u); return Promise.resolve(ort); };
    new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', 'caches', src)(self, __import, setTimeout, clearTimeout, function (u, o) { return self.fetch(u, o); }, self.caches);
    var B = 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/';
    self.onmessage({ data: { cmd: 'load', base: B, model: 'en_GB-cori-medium' } });
    self.onmessage({ data: { cmd: 'say', id: 7, text: 'Hello there.', lengthScale: 0.9 } });
    self.onmessage({ data: { cmd: 'say', id: 71, text: '' } });
    return new Promise(function (r) { setTimeout(r, 80); }).then(function () {
        T.eq(fetched.slice().sort(), ['import ' + B + 'ort/ort.wasm.bundle.min.mjs', B + 'voice/en_GB-cori-medium.onnx', B + 'voice/en_GB-cori-medium.onnx-json', B + 'voice/piper_phonemize-js', B + 'voice/piper_phonemize.data', B + 'ort/ort-wasm-simd-threaded-wasm', B + 'voice/piper_phonemize-wasm'].sort(), 'every file from this instance, none from a CDN or a hub: the language data and both WebAssembly binaries too, all at once');
        T.eq(putInCache.length, 6, 'the six files go into Cache storage for the next visit');
        T.eq(ort.env.wasm.wasmPaths, B + 'ort/');
        T.eq(self.__phonOpts.locateFile('piper_phonemize.wasm'), B + 'voice/piper_phonemize-wasm');
        T.ok(self.__phonOpts.getPreloadedPackage() instanceof ArrayBuffer, 'the language data handed to the phonemizer, not fetched by it');
        T.eq(created, 1);
        T.eq(posted.map(function (m) { return m.stage || (m.ready ? 'ready' : 'id' + m.id); }), ['fetching', 'starting', 'starting', 'ready', 'id7', 'id71'], 'the stages (each step of the start announced), then ready, then the sentences');
        T.eq(posted[0].mb, 0); T.eq(posted[1].step, 'engine'); T.eq(typeof posted[1].mb, 'number', 'the bytes that came down'); T.eq(posted[2].step, 'warm-up');
        T.eq(posted[3].rate, 22050);
        T.eq(mains[0], ['-l', 'en', '--input', '[{"text":"Ready."}]', '--espeak_data', '/espeak-ng-data'], 'a warm-up sentence first');
        T.eq(mains[1], ['-l', 'en', '--input', '[{"text":"Hello there."}]', '--espeak_data', '/espeak-ng-data']);
        T.eq(runs.length, 2, 'the model ran for the warm-up and the sentence; the empty one has no phonemes');
        var f = runs[1];
        T.eq([f.input.type, f.input.dims, Array.from(f.input.data).map(Number)], ['int64', [1, 4], [1, 2, 3, 4]]);
        T.eq([f.input_lengths.type, Array.from(f.input_lengths.data).map(Number)], ['int64', [4]]);
        T.eq(f.scales.type, 'float32'); T.ok(Math.abs(f.scales.data[1] - 0.9) < 1e-6, 'the pace is the length scale: ' + f.scales.data[1]);
        T.ok(!f.sid, 'no speaker id for a single-speaker voice');
        T.eq(posted[4].id, 7); T.eq(Array.from(posted[4].pcm).map(function (x) { return Math.round(x * 10) / 10; }), [0.1, -0.2, 0.3]); T.eq(posted[4].rate, 22050);
        T.eq(posted[5].id, 71); T.eq(posted[5].pcm.length, 0, 'silence for a sentence with no phonemes');
        // queued sentences dropped: answered as dropped, never run
        self.onmessage({ data: { cmd: 'say', id: 8, text: 'Eight.' } });
        self.onmessage({ data: { cmd: 'say', id: 9, text: 'Nine.' } });
        self.onmessage({ data: { cmd: 'drop', upTo: 9 } });
        self.onmessage({ data: { cmd: 'say', id: 10, text: 'Ten.' } });
        return new Promise(function (r) { setTimeout(r, 50); }).then(function () {
            var tail = posted.slice(6).map(function (m) { return m.id + (m.dropped ? ' dropped' : ' pcm'); });
            T.eq(tail, ['8 dropped', '9 dropped', '10 pcm'], 'eight and nine skipped (eight was already phonemized), ten made: ' + tail.join(', '));
            T.eq(runs.length, 3, 'the model ran for the warm-up, seven and ten');
        });
    });
});

T.test('the worker: a sentence is tried twice; the second visit reads Cache storage and fetches nothing', function () {
    var src = workerSrc();
    var fetched = [], posted = [], attempts = 0;
    var cached = {};
    var self = {
        caches: { open: function () { return Promise.resolve({ match: function (u) { return Promise.resolve(cached[u]); }, put: function (u, r) { cached[u] = r; return Promise.resolve(); } }); } },
        postMessage: function (m) { posted.push(m); },
        fetch: function (u) {
            fetched.push(String(u));
            return Promise.resolve({ ok: true, clone: function () { return this; },
                json: function () { return Promise.resolve({ audio: { sample_rate: 22050 }, espeak: { voice: 'en' }, inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }, num_speakers: 1 }); },
                text: function () { return Promise.resolve('var createPiperPhonemize = function (opts) { return Promise.resolve({ callMain: function (args) { opts.print(JSON.stringify({ phoneme_ids: [1, 2] })); } }); };'); },
                arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } });
        }
    };
    var Tensor = function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; };
    var ort = { env: { wasm: {} }, Tensor: Tensor, InferenceSession: { create: function () { return Promise.resolve({ run: function () { attempts++; if (attempts === 2) return Promise.reject(new Error('flaky once')); if (attempts === 4 || attempts === 5) return Promise.reject(new Error('broken twice')); return Promise.resolve({ output: { data: Float32Array.from([0.5]) } }); } }); } } };
    var __import = function () { return Promise.resolve(ort); };
    new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', 'caches', src)(self, __import, setTimeout, clearTimeout, function (u, o) { return self.fetch(u, o); }, self.caches);
    var B = 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/';
    self.onmessage({ data: { cmd: 'load', base: B, model: 'en_GB-cori-medium' } });
    self.onmessage({ data: { cmd: 'say', id: 1, text: 'Once more.' } });
    self.onmessage({ data: { cmd: 'say', id: 2, text: 'No luck.' } });
    return new Promise(function (r) { setTimeout(r, 80); }).then(function () {
        var got = posted.filter(function (m) { return m.id !== undefined; });
        T.eq(got[0].id, 1); T.eq(got[0].pcm.length, 1, 'the first sentence, made on the second try');
        T.eq(got[1].id, 2); T.match(got[1].error, /broken twice/, 'the second, tried twice, is reported');
        T.eq(attempts, 5, 'warm-up, then two tries, then two tries');
        T.eq(fetched.length, 6, 'six files fetched on the first visit');
        // the next visit: everything from Cache storage
        var fetched2 = fetched.length;
        var self2 = Object.assign({}, self, { postMessage: noop });
        new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', 'caches', src)(self2, __import, setTimeout, clearTimeout, function (u, o) { return self2.fetch(u, o); }, self2.caches);
        self2.onmessage({ data: { cmd: 'load', base: B, model: 'en_GB-cori-medium' } });
        return new Promise(function (r) { setTimeout(r, 60); }).then(function () { T.eq(fetched.length, fetched2, 'nothing fetched: every file came from Cache storage'); });
    });
});

T.test('the page: her voice loads from this instance at boot, the card waits for it and names the stage, Settings lists it first, the Lab cycles to it, the ear waits for her', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var made = fakeWorker(cl);
    f._netraVoiceLoad();
    T.eq(c.voice.status, 'loading'); T.eq(made.length, 1); T.eq(made[0].opts, { type: 'module' });
    T.eq(made[0].posted[0], { cmd: 'load', base: 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/', model: 'en_GB-cori-medium' });
    f._netraVoiceLoad(); T.eq(made.length, 1, 'loaded once');
    // the card: waiting, the stage named, then hers
    T.eq(f._voiceReady(), false); T.eq(c.gate.voiceText, 'loading my own voice from this instance…');
    T.eq(f._plainGateText(c.gate.voiceText), 'Getting her voice ready from this instance…');
    f._netraVoiceOnMessage({ data: { stage: 'starting' } });
    T.eq(f._voiceReady(), false); T.eq(f._plainGateText(c.gate.voiceText), 'Starting her voice…');
    cl.set('_voiceFirstStart', Date.now() - 80000); T.eq(f._voiceReady(), false, 'still waited for at 80 s');
    cl.set('_voiceFirstStart', Date.now() - 95000); T.eq(f._netraVoiceComing(), false, 'past 90 s she is no longer waited for'); f._voiceReady(); T.notMatch(c.gate.voiceText, /my own voice/, 'the device\'s voices are looked at instead: ' + c.gate.voiceText);
    cl.set('_voiceFirstStart', Date.now());
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
    T.match(CLIENT, /\$timeout\(function \(\) \{ if \(!_ctrlDestroyed\) _netraVoiceLoad\(\); \}, 0, false\);\n\};\s*$/, 'and already when the page has its data, before any tap');
    T.ok(/_afterVoice\(function \(\) \{ _earLoad\(true\); \}, 60000, true\)/.test(CLIENT), 'the standby ear waits for her whole load');
    T.ok(/_afterVoice\(function \(\) \{ if \(!_earWorker && c\.ear\.status === 'loading'\) \{ try \{ _earSpawn\(\); \}[^\n]*\}, 45000\)/.test(CLIENT), 'the needed ear waits for her files to come down (up to 45 s)');
    // _afterVoice: runs at once when she is not loading, waits while she is
    var ran = 0; c.voice.status = 'ready'; f._afterVoice(function () { ran++; }, 5000); T.eq(ran, 1);
    c.voice.status = 'loading'; c.voice.stage = 'starting'; f._afterVoice(function () { ran++; }, 5000); T.eq(ran, 2, 'once her files are down the ear may start');
    var quiet = cl.get('$timeout'); cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    c.voice.stage = 'fetching'; f._afterVoice(function () { ran++; }, 5000); T.eq(ran, 2, 'while her files come down the ear waits');
    f._afterVoice(function () { ran++; }, 5000, true); c.voice.stage = 'starting'; f._afterVoice(function () { ran++; }, 5000, true); T.eq(ran, 2, 'the standby ear waits for her whole load');
    cl.set('$timeout', quiet);
});

T.test('speaking: one sentence a group, made in order, played back to back; a line waits for her while she loads; a sentence she could not make is left out; a barge-in drops the queue; a dead worker is started again and the next line waits; the device only when she is not on the instance or would not come back', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    var made = fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var played = [], browser = [];
    global.Audio = function (url) { var a = this; this.url = url; played.push(a); this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false;
    // not on this instance at all: the device speaks, and the reason is logged once
    c.data = {};
    f.speak('Hello.'); f.speak('Again.');
    T.eq(browser, ['Hello.', 'Again.']);
    T.eq(c.events.filter(function (e) { return /this device's voice instead/.test(e); }).length, 1, 'said once');
    // loading: a line waits for her, and is said by her once she is there
    c.data = { ear_base: '/api/x_196061_netra_v1/voice/ear' }; browser.length = 0; cl.set('_voiceWaitSaid', false);
    f._netraVoiceLoad();
    var heldDone = 0;
    var sessionBefore = cl.get('_speakSessionId');
    f.speak('Wait for me.', function () { heldDone++; });
    T.eq(browser, [], 'not the device'); T.eq(cl.get('_voiceHeld').length, 1, 'held');
    T.ok(c.events.some(function (e) { return /this line waits for it/.test(e); }), c.events.join(' | '));
    T.eq(cl.get('_speakSessionId'), sessionBefore, 'a held line bumps no session and marks nothing as speaking');
    f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(cl.get('_voiceHeld').length, 0, 'flushed');
    var said = answers.filter(function (a) { return a.text === 'Wait for me.'; });
    T.eq(said.length, 1, 'the held line goes to her: ' + answers.map(function (a) { return a.text; }).join(' | '));
    f._netraVoiceOnMessage({ data: { id: said[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(played.length, 1); played[0].onended(); T.eq(heldDone, 1, 'its done ran after she said it');
    played.length = 0; answers.length = 0;
    var doneCalls = 0;
    f.speakNetraVoice('First sentence here. Second sentence there.', function () { doneCalls++; });
    T.eq(answers.length, 2, 'one sentence a group'); T.eq(answers[0].text, 'First sentence here.'); T.eq(answers[1].text, 'Second sentence there.');
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
    // a barge-in: the session moves on, the queue stops, the worker is told to drop what is queued
    played.length = 0; answers.length = 0;
    f.speakNetraVoice('One. Two. Three.', function () { doneCalls++; });
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(played.length, 1, 'the first of three plays');
    var postedBefore = made[0].posted.length;
    T.match(CLIENT, /_speakSessionId\+\+;[^\n]*\n\s+_netraVoiceDrop\(\);/, 'stopSpeaking drops her queued sentences');
    cl.set('_speakSessionId', cl.get('_speakSessionId') + 1); f._netraVoiceDrop();
    played[0].onended();
    T.eq(played.length, 1, 'nothing more plays after a barge-in'); T.eq(doneCalls, 1);
    var drop = made[0].posted.slice(postedBefore).filter(function (m) { return m.cmd === 'drop'; });
    T.eq(drop.length, 1, 'the worker is told to drop what is queued'); T.eq(drop[0].upTo, answers[2].id);
    T.eq(Object.keys(cl.get('_voiceJobs')).length, 0, 'no job left waiting');
    // a sentence she could not make (tried twice in the worker), or one with no sound: left out, the rest still hers
    played.length = 0; answers.length = 0; browser.length = 0;
    f.speakNetraVoice('Alpha. Beta. Gamma.', function () { doneCalls++; });
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    f._netraVoiceOnMessage({ data: { id: answers[1].id, error: 'phonemizer silent' } });
    f._netraVoiceOnMessage({ data: { id: answers[2].id, pcm: Float32Array.from([0.2]), rate: 22050 } });
    played[0].onended();
    T.eq(browser, [], 'never the device\'s voice for a sentence'); T.eq(played.length, 2, 'Beta left out, Gamma played'); T.eq(doneCalls, 1);
    T.ok(c.events.some(function (e) { return /"Beta\." left out/.test(e); }), c.events.join(' | '));
    played[1].onended(); T.eq(doneCalls, 2);
    // the worker dies mid-line: she is started again, the rest of that line and the next line wait for her, and she says them in order
    answers.length = 0; browser.length = 0; played.length = 0;
    f.speakNetraVoice('Delta. Epsilon.', function () { doneCalls++; });
    var madeBefore = made.length;
    f._netraVoiceFail('worker: failed');
    T.eq(browser, [], 'not the device: her restart is coming'); T.eq(cl.get('_voiceRestarts'), 1);
    T.eq(cl.get('_voiceHeld').map(function (h) { return h.text; }), ['Delta. Epsilon.'], 'the whole line waits for her');
    T.ok(c.events.some(function (e) { return /starting it again/.test(e); }), 'restarted');
    T.eq(made.length, madeBefore + 1, 'a new worker (the timeout stub runs at once)'); T.eq(c.voice.status, 'loading');
    browser.length = 0; cl.set('_voiceWaitSaid', false);
    f.speak('Later.'); T.eq(browser, [], 'the next line waits for her too'); T.eq(cl.get('_voiceHeld').length, 2);
    answers.length = 0; played.length = 0;
    f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(cl.get('_voiceHeld').length, 0);
    T.eq(answers.map(function (a) { return a.text; }), ['Delta.', 'Epsilon.'], 'the line she had begun first, whole');
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    f._netraVoiceOnMessage({ data: { id: answers[1].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    played[0].onended(); played[1].onended();
    T.eq(answers.map(function (a) { return a.text; }), ['Delta.', 'Epsilon.', 'Later.'], 'then the next held line, in order');
    // a stop while a line waits: it is not said later
    cl.set('_voiceWorker', null); c.voice.status = 'loading'; cl.set('_voiceFirstStart', Date.now());
    f.speak('Never mind.'); T.eq(cl.get('_voiceHeld').length, 1);
    T.match(CLIENT, /_netraVoiceDrop\(\);[^\n]*\n\s+_voiceHeld = \[\];/, 'stopSpeaking clears what waited');
    cl.set('_voiceHeld', []);
    // the wait window over with her still loading: what waited is said by the device, and she takes over once ready
    f.speak('Waited too long.'); T.eq(cl.get('_voiceHeld').length, 1);
    f._netraVoiceWaitOver(); T.eq(browser, [], 'not yet: she is still within the window (the timer is what ends it)');
    cl.set('_voiceFirstStart', Date.now() - 100000); f._netraVoiceWaitOver();
    T.eq(browser, ['Waited too long.'], 'the device says it once the window is over'); T.eq(cl.get('_voiceHeld').length, 0);
    // dead again past the restarts: the device for good
    cl.set('_voiceFirstStart', Date.now()); cl.set('_voiceRestarts', 4); c.voice.status = 'ready'; cl.set('_voiceWorker', { postMessage: noop, terminate: noop });
    browser.length = 0;
    f._netraVoiceFail('worker: failed again');
    T.eq(f._netraVoiceComing(), false); cl.set('_voiceWaitSaid', false);
    f.speak('Gone.'); T.eq(browser, ['Gone.'], 'the device now');
});

T.test('thinking cues: on her engine the device\'s speech synthesis is never used; her own short cues are made once she is ready and played from the cache', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    var spoken = 0; global.speechSynthesis = { speak: function () { spoken++; }, cancel: noop }; c.hasTTS = true;
    cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null); cl.set('_lastSentText', ''); cl.set('lastFillerPlayedAt', 0);
    var ended = 0;
    f._playOneFiller(function () { ended++; });
    T.eq(spoken, 0, 'no device synthesis on her engine'); T.eq(ended, 1, 'the chain keeps its pacing');
    // her cues, from the cache, once she is ready (the ready handler asks for them through the timeout stub)
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(answers.length, 0, 'not before the 6 s after ready'); f._netraFillersPrepare();
    T.eq(answers.map(function (a) { return a.text; }), ['One moment, please.'], 'one at a time');
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(answers.length, 2, 'the next follows'); f._netraVoiceOnMessage({ data: { id: answers[1].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(cl.get('fillerCache').map(function (x) { return x.text; }), ['One moment, please.', 'Checking on that now.']);
    f._netraFillersPrepare(); T.eq(answers.length, 2, 'made once');
    // a cue still being made when a line starts is not dropped with the line's leftovers
    cl.set('_fillersPrepared', false); cl.set('fillerCache', []); answers.length = 0;
    f._netraFillersPrepare(); T.eq(answers.length, 1);
    var cueId = answers[0].id;
    f._netraVoiceDrop();
    T.ok(cl.get('_voiceJobs')[cueId], 'the cue job is kept');
    f._netraVoiceOnMessage({ data: { id: cueId, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(cl.get('fillerCache').length, 1, 'and the cue lands');
    global.Audio = function (url) { this.url = url; this.play = function () { return Promise.resolve(); }; };
    f._playOneFiller(noop);
    T.eq(spoken, 0, 'a cached cue plays, the device stays silent');
    // a neural cue left in the pool by the Lab's Edge engine is never hers to play; and hers are never the neural engine's
    cl.get('fillerCache').push({ url: 'blob:edge', text: 'Neural cue.' });
    var playedUrls = []; global.Audio = function (url) { playedUrls.push(url); this.url = url; this.play = function () { return Promise.resolve(); }; };
    for (var k = 0; k < 12; k++) f._playOneFiller(noop);
    T.ok(playedUrls.length === 12 && playedUrls.every(function (u) { return u !== 'blob:edge'; }), 'only her cues on her engine: ' + playedUrls.join(','));
    c.ttsEngine = 'edge'; playedUrls.length = 0; cl.set('_edgeVoiceAvailable', function () { return true; });
    for (var k2 = 0; k2 < 6; k2++) f._playOneFiller(noop);
    T.ok(playedUrls.every(function (u) { return u === 'blob:edge'; }), 'and only the neural ones on the neural engine: ' + playedUrls.join(','));
    c.ttsEngine = 'netra';
    // the preview names her while the line waits for her
    cl.set('_voiceLoadStart', Date.now()); c.voice.status = 'loading'; cl.set('_voiceWorker', null);
    var spokenLines = []; cl.set('speak', function (t2) { spokenLines.push(t2); });
    f._previewVoice(); T.match(spokenLines[0], /This is the Cori voice/, spokenLines[0]);
    T.ok(c.events.some(function (e) { return /filler\[blob\]/.test(e); }), 'played from the cache: ' + c.events.filter(function (e) { return /filler/.test(e); }).join(' | '));
});

// a timer stub the test drives: timers are kept with their delay, and fired by hand
function drivenTimers(cl) {
    var timers = [], n = 0;
    cl.set('$timeout', Object.assign(function (fn, delay) { var t = { id: ++n, fn: fn, delay: delay || 0 }; timers.push(t); return t; }, {
        cancel: function (t) { var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); return i >= 0; }
    }));
    return { timers: timers, fire: function (pred) { var due = timers.filter(pred || function () { return true; }); due.forEach(function (t) { var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.fn(); }); return due.length; } };
}

T.test('her voice all visit long: a failure after the first minutes starts her again (a few times, with a growing pause) and lines wait 25 s for her; a load that goes quiet is started again; a stuck worker is caught while the user keeps talking', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    var made = fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var played = [], browser = [];
    global.Audio = function (url) { var a = this; this.url = url; played.push(a); this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false;
    var tm = drivenTimers(cl);
    // ready for five minutes, then the worker dies mid-visit
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    cl.set('_voiceFirstStart', Date.now() - 300000);
    T.eq(cl.get('_voiceEverReady'), true);
    f._netraVoiceFail('worker: died at minute five');
    T.eq(cl.get('_voiceRestarts'), 1, 'one restart after the mid-visit death'); T.ok(cl.get('_voiceRestartAt') > 0);
    T.eq(f._netraVoiceComing(), true, 'she is coming back: her files are cached');
    f.speak('Still hers.'); T.eq(browser, [], 'the line waits for her'); T.eq(cl.get('_voiceHeld').map(function (h) { return h.text; }), ['Still hers.'], 'held: ' + c.events.slice(-4).join(' | '));
    T.eq(tm.timers.filter(function (t) { return t.delay === 1500; }).length, 1, 'the first restart after 1.5 s');
    T.eq(tm.timers.filter(function (t) { return t.delay === 25000; }).length, 1, 'and the line waits at most 25 s');
    var madeBefore = made.length;
    tm.fire(function (t) { return t.delay === 1500; });
    T.eq(made.length, madeBefore + 1, 'a new worker'); T.eq(c.voice.status, 'loading');
    T.ok(c.events.some(function (e) { return /starting my own voice again/.test(e); }), c.events.slice(-3).join(' | '));
    answers.length = 0;
    f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(cl.get('_voiceRestartAt'), 0, 'back'); T.eq(cl.get('_voiceHeld').length, 0);
    T.eq(answers.map(function (a) { return a.text; }), ['Still hers.'], 'and she says what waited');
    T.eq(tm.timers.filter(function (t) { return t.delay === 25000; }).length, 0, 'the wait timer is cancelled once she is back');
    // she is not back within 25 s: what waited is said by the device, once; she still takes over when she comes
    f._netraVoiceFail('worker: died again'); T.eq(cl.get('_voiceRestarts'), 2);
    T.eq(tm.timers.filter(function (t) { return t.delay === 3000; }).length, 1, 'the second restart after 3 s');
    browser.length = 0; cl.set('_voiceWaitSaid', false);
    f.speak('Waiting.'); T.eq(browser, []);
    cl.set('_voiceRestartAt', Date.now() - 26000);
    T.eq(f._netraVoiceComing(), false, 'past 25 s she is no longer waited for');
    tm.fire(function (t) { return t.delay === 25000; });
    T.eq(browser, ['Still hers.', 'Waiting.'], 'the device says the line she was cut off on, then what waited'); T.eq(cl.get('_voiceHeld').length, 0);
    f.speak('Meanwhile.'); T.eq(browser, ['Still hers.', 'Waiting.', 'Meanwhile.'], 'and the next lines, while she is away');
    tm.fire(function (t) { return t.delay === 3000; }); T.eq(c.voice.status, 'loading');
    f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } }); T.eq(f._netraVoiceReady(), true, 'hers again once she is back');
    // the pause grows and is capped; after the budget the device for the rest of the visit
    var restart6 = function (t) { return t.delay === 6000 && t.fn !== f._netraFillersPrepare; };   // her cues are also asked for 6 s after each ready
    f._netraVoiceFail('x'); T.eq(cl.get('_voiceRestarts'), 3); T.eq(tm.timers.filter(restart6).length, 1, 'the third restart after 6 s');
    tm.fire(restart6); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    f._netraVoiceFail('x'); T.eq(cl.get('_voiceRestarts'), 4); T.eq(tm.timers.filter(function (t) { return t.delay === 12000; }).length, 1);
    tm.fire(function (t) { return t.delay === 12000; }); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    f._netraVoiceFail('x'); T.eq(cl.get('_voiceRestarts'), 4, 'no fifth'); T.eq(f._netraVoiceComing(), false); T.eq(c.voice.status, 'error');
    T.ok(c.events.some(function (e) { return /this device's voice instead/.test(e); }));
    // a load that says nothing for 45 s is started again; one that keeps reporting bytes is not
    cl.set('_voiceRestarts', 0); c.voice.status = 'off'; cl.set('_voiceFirstStart', 0); cl.set('_voiceEverReady', false);
    f._netraVoiceLoad(); T.eq(c.voice.status, 'loading');
    var watch = tm.timers.filter(function (t) { return t.delay === 45000; }); T.eq(watch.length, 1, 'the load watch');
    f._netraVoiceOnMessage({ data: { stage: 'fetching', mb: 40 } }); T.eq(c.voice.mb, 40);
    f._voiceReady(); T.eq(c.gate.voiceText, 'loading my own voice from this instance… 40 MB'); T.eq(f._plainGateText(c.gate.voiceText), 'Getting her voice ready from this instance… 40 MB');
    cl.set('_voiceLastMsg', Date.now() - 20000);
    tm.fire(function (t) { return t.delay === 45000; });
    T.eq(c.voice.status, 'loading', 'bytes landed 20 s ago: still waited for'); T.ok(tm.timers.some(function (t) { return t.delay >= 24000 && t.delay <= 25000; }), 'looked at again when 45 s would be up');
    cl.set('_voiceLastMsg', Date.now() - 46000);
    tm.fire(function (t) { return t.delay >= 24000 && t.delay <= 25000; });
    T.eq(cl.get('_voiceRestarts'), 1, 'quiet for 45 s: started again'); T.ok(c.events.some(function (e) { return /no progress for 45 s while loading/.test(e); }), c.events.slice(-2).join(' | '));
    tm.fire(function (t) { return t.delay === 1500; }); f._netraVoiceOnMessage({ data: { stage: 'starting', step: 'engine', mb: 82 } }); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(f._netraVoiceReady(), true);
    // a stuck worker: the sentence it owes an answer to is watched; new lines (which drop it) do not move the watch
    cl.set('_voiceRestarts', 0); answers.length = 0; browser.length = 0;
    f.speakNetraVoice('First.', noop);
    T.eq(cl.get('_voiceOut'), [answers[0].id]); var since = cl.get('_voiceHeadSince'); T.ok(Date.now() - since < 1000);
    var stallWatch = function (t) { return t.delay >= 30000 && t.delay < 31000; };   // 30 s plus 100 ms a character of the head
    T.eq(tm.timers.filter(stallWatch).length, 1, 'one stall watch');
    cl.set('_voiceHeadSince', Date.now() - 20000);
    f.speakNetraVoice('Second.', noop); f.speakNetraVoice('Third.', noop);
    T.eq(cl.get('_voiceOut').length, 3, 'the first two, dropped by the page, are still owed an answer');
    T.eq(cl.get('_voiceHeadSince'), Date.now() - 20000 > cl.get('_voiceHeadSince') - 5 ? cl.get('_voiceHeadSince') : -1, 'the watch stays on the first');
    T.eq(tm.timers.filter(stallWatch).length, 1, 'still one watch');
    cl.set('_voiceHeadSince', Date.now() - 31000);
    tm.fire(stallWatch);
    T.eq(c.voice.status, 'error'); T.ok(c.events.some(function (e) { return /no sound in 30 s for "\(a dropped sentence\)"/.test(e); }), c.events.slice(-3).join(' | '));
    T.eq(cl.get('_voiceOut'), [], 'nothing owed by a dead worker');
    tm.fire(function (t) { return t.delay === 1500; }); answers.length = 0; f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(answers.map(function (a) { return a.text; }), ['Third.'], 'the line the stall cut off waited for her and is hers again');
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } }); T.eq(cl.get('_voiceOut'), []);
    // a live worker that answers in time: the watch moves to the next sentence and ends when nothing is owed
    answers.length = 0; f.speakNetraVoice('One. Two.', noop);
    T.eq(cl.get('_voiceOut').length, 2);
    cl.set('_voiceHeadSince', Date.now() - 29000);
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.ok(Date.now() - cl.get('_voiceHeadSince') < 1000, 'the second sentence is watched from now');
    tm.fire(stallWatch);
    T.eq(c.voice.status, 'ready', 'not stuck'); T.ok(tm.timers.some(function (t) { return t.delay >= 29000 && t.delay < 31000; }), 'watched on');
    f._netraVoiceOnMessage({ data: { id: answers[1].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(cl.get('_voiceOut'), []); T.eq(tm.timers.filter(function (t) { return t.delay >= 29000 && t.delay < 31000; }).length, 0, 'the watch ends');
    // the page goes: the worker with it, nothing waits, nothing polls
    var terminated = 0; cl.get('_voiceWorker').terminate = function () { terminated++; };
    cl.set('_voiceHeld', [{ text: 'x' }]);
    f._netraVoiceStop();
    T.eq(terminated, 1, 'the worker is terminated on stop'); T.eq(cl.get('_voiceWorker'), null); T.eq(c.voice.status, 'off'); T.eq(cl.get('_voiceHeld'), []);
    T.match(CLIENT, /_silenceCurrentAudio\(\);\n\s+try \{ _netraVoiceStop\(\); \}/, 'called when the controller is destroyed');
    cl.set('_ctrlDestroyed', true);
    var ran = 0; c.voice.status = 'loading'; c.voice.stage = 'fetching'; f._afterVoice(function () { ran++; }, 5000); T.eq(ran, 0); T.eq(tm.timers.filter(function (t) { return t.delay === 400; }).length, 0, 'no poll after destroy');
    var before = made.length; c.voice.status = 'off'; f._netraVoiceLoad(); T.eq(made.length, before, 'no worker for a destroyed page');
    cl.set('_ctrlDestroyed', false);
    // a clip of hers cut short lets its blob URL go
    var revoked = []; global.URL.revokeObjectURL = function (u) { revoked.push(u); };
    var audio = { _netraUrl: 'blob:cut', pause: noop }; cl.set('currentAudio', audio);
    f._silenceCurrentAudio(); T.eq(revoked, ['blob:cut']); T.eq(audio._netraUrl, null);
    T.match(CLIENT, /audio\._netraUrl = url;/, 'every clip of hers carries its URL for that');
    T.match(CLIENT, /'phonemizer silent'\)\), 5000\)/, 'the worker gives a sentence up well inside the 30 s watch (5 s a try, four tries at most)');
});

T.test('a line cut by her restart frees the floor while it waits; a device voice picked while a line waits says it now; a stop lets her cut clip go', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var browser = [];
    global.Audio = function (url) { this.url = url; this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false; c.alert = true;
    var cleared = 0; cl.set('_clearSpeaking', function () { cleared++; }); cl.set('setState', function (st) { c.state = st; });
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    f.speakNetraVoice('Delta. Epsilon.', noop);
    T.eq(c.state, 'speaking'); cleared = 0;
    f._netraVoiceFail('worker: died mid-line');
    T.eq(cl.get('_voiceHeld').map(function (h) { return h.text; }), ['Delta. Epsilon.'], 'the line waits for her restart');
    T.eq(cleared, 1, 'the floor is free while it waits'); T.eq(c.state, 'idle', 'the stage is not left on Speaking with nothing playing');
    // a device voice picked in Settings while a line waits for her: the line is said now, by that voice
    cl.set('forcedVoiceName', ''); cl.set('chooseVoice', function () { return null; }); browser.length = 0;
    f._setDeviceVoice('Samantha');
    T.eq(c.ttsEngine, 'browser'); T.eq(browser, ['Delta. Epsilon.'], 'said by the device at once'); T.eq(cl.get('_voiceHeld'), []);
    T.match(CLIENT, /c\.ttsEngine = seq\[\(idx \+ 1\) % seq\.length\];[^\n]*\n[^\n]*\n\s+if \(idx === 0\) _netraVoiceLeft\(\);/, 'the Lab\'s engine cycle away from her does the same');
    // a stop goes through the one silencer, which lets a cut clip of hers go
    var stop = CLIENT.slice(CLIENT.indexOf('function stopSpeaking('), CLIENT.indexOf('function stopSpeaking(') + 3000);
    T.match(stop, /_silenceCurrentAudio\(\);/, 'stopSpeaking silences through the helper'); T.notMatch(stop, /currentAudio\.onended = null;/, 'no inline copy that forgets the URL');
    var live = CLIENT.slice(CLIENT.indexOf('function speakEdgeLive('), CLIENT.indexOf('function speakEdgeLive(') + 6000);
    T.match(live, /Never overlap[^\n]*\n[^\n]*\n\s+_silenceCurrentAudio\(\);/, 'and so does the live engine before it plays');
});

T.test('the worker: the phonemizer is built from the small files while the model is still coming down, with its WebAssembly handed over', function () {
    var src = workerSrc();
    var posted = [];
    var releaseModel; var modelGate = new Promise(function (r) { releaseModel = r; });
    var modelRes = { ok: true, clone: function () { return this; }, body: { getReader: function () { var sent = false; return { read: function () { return modelGate.then(function () { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array([9, 9]) }; }); } }; } } };
    var wasmBuf = new ArrayBuffer(4);
    var plain = function (u) { return { ok: true, clone: function () { return this; },
        json: function () { return Promise.resolve({ audio: { sample_rate: 22050 }, espeak: { voice: 'en' }, inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }, num_speakers: 1 }); },
        text: function () { return Promise.resolve('var createPiperPhonemize = function (opts) { self.__phonOpts = opts; self.__phonAt = self.__tick++; return Promise.resolve({ callMain: function (args) { opts.print(JSON.stringify({ phoneme_ids: [1] })); } }); };'); },
        arrayBuffer: function () { return Promise.resolve(/piper_phonemize-wasm$/.test(u) ? wasmBuf : new ArrayBuffer(8)); } }; };
    var self = { caches: null, __tick: 0, postMessage: function (m) { posted.push(m); }, fetch: function (u) { return Promise.resolve(/\.onnx$/.test(String(u)) ? modelRes : plain(String(u))); } };
    var ort = { env: { wasm: {} }, Tensor: function () {}, InferenceSession: { create: function () { self.__sessionAt = self.__tick++; return Promise.resolve({ run: function () { return Promise.resolve({ output: { data: Float32Array.from([0.1]) } }); } }); } } };
    new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', 'caches', src)(self, function () { return Promise.resolve(ort); }, setTimeout, clearTimeout, function (u, o) { return self.fetch(u, o); }, self.caches);
    self.onmessage({ data: { cmd: 'load', base: 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/', model: 'en_GB-cori-medium' } });
    return new Promise(function (r) { setTimeout(r, 40); }).then(function () {
        T.ok(self.__phonOpts, 'the phonemizer is being built before the model has landed');
        T.eq(self.__phonOpts.wasmBinary, wasmBuf, 'its WebAssembly handed over, not fetched by its own loader');
        T.ok(!posted.some(function (m) { return m.stage === 'starting'; }), 'still fetching as far as the page knows (the ear keeps waiting)');
        releaseModel();
        return new Promise(function (r2) { setTimeout(r2, 40); });
    }).then(function () {
        T.ok(self.__sessionAt > self.__phonAt, 'the session is created once the model is in, after the phonemizer began');
        T.eq(ort.env.wasm.wasmBinary instanceof ArrayBuffer, true, 'the runtime\'s WebAssembly handed over too');
        T.ok(posted.some(function (m) { return m.ready; }), 'ready');
    });
});

T.test('the rest of a cut line is hers again if she is back in time; a file the instance lacks is not retried; a first load keeps its window through a restart; a run-on group is cut; a long sentence is allowed longer; a device line still going is cut before her clip; an interjection waits while a line waits for her', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    var made = fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var played = [], browser = [];
    global.Audio = function (url) { var a = this; this.url = url; played.push(a); this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false; c.alert = true;
    var tm = drivenTimers(cl);
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    // she dies while clip 1 plays and is back before it ends: clip 2 is hers, not the device's
    f.speakNetraVoice('Alpha. Beta.', noop);
    f._netraVoiceOnMessage({ data: { id: answers[0].id, pcm: Float32Array.from([0.1]), rate: 22050 } });
    T.eq(played.length, 1, 'Alpha playing');
    f._netraVoiceFail('worker: died under Alpha');
    tm.fire(function (t) { return t.delay === 1500; }); answers.length = 0;
    f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(cl.get('_voiceHeld'), [], 'nothing held: the line is still playing');
    played[0].onended();
    T.eq(browser, [], 'never the device'); T.eq(answers.map(function (a) { return a.text; }), ['Beta.'], 'the rest is asked of her again');
    T.ok(c.events.some(function (e) { return /my own voice is back - the rest of the line is hers/.test(e); }), c.events.slice(-3).join(' | '));
    // an instance without her files: the worker's HTTP 404 is final - no restart, the device at once, the card moves on
    cl.set('_voiceRestarts', 0); cl.set('_voiceEverReady', false); cl.set('_voiceFirstStart', 0); c.voice.status = 'off'; cl.set('_voiceWorker', null);
    var before = made.length; f._netraVoiceLoad(); T.eq(made.length, before + 1);
    f._netraVoiceOnMessage({ data: { error: 'HTTP 404', fatal: true } });
    T.eq(cl.get('_voiceRestarts'), 0, 'not retried'); T.eq(f._netraVoiceComing(), false); T.eq(c.voice.status, 'error');
    T.ok(c.events.some(function (e) { return /my own voice is not on this instance \(HTTP 404\) - this device's voice instead/.test(e); }), c.events.slice(-2).join(' | '));
    f._voiceReady(); T.notMatch(c.gate.voiceText, /my own voice/, 'the card looks at the device\'s voices: ' + c.gate.voiceText);
    T.match(CLIENT, /fatal: \/\^HTTP 4\\\\d\\\\d\/\.test\(m\)/, 'the worker marks a 4xx as final');
    T.match(CLIENT, /catch \(e\) \{ _netraVoiceFail\(String\(e && e\.message \|\| e\), true\); \}/, 'a worker that cannot be made is not made again');
    // a transient failure 10 s into a first load: lines keep the rest of the 90 s window, not just 25 s
    cl.set('_voiceRestarts', 0); c.voice.status = 'off';
    f._netraVoiceLoad(); cl.set('_voiceFirstStart', Date.now() - 10000);
    f._netraVoiceFail('network blip');
    T.eq(cl.get('_voiceRestarts'), 1);
    var w = tm.timers.filter(function (t) { return t.delay > 25000; }); T.eq(w.length, 1, 'the wait timer'); T.ok(w[0].delay >= 79000 && w[0].delay <= 80000, 'the rest of the first window: ' + w[0].delay);
    cl.set('_voiceRestartAt', Date.now() - 30000); T.eq(f._netraVoiceComing(), true, 'still coming 30 s after the restart, inside the first window');
    cl.set('_voiceFirstStart', Date.now() - 95000); T.eq(f._netraVoiceComing(), false, 'and not past it');
    // a run-on reply with no full stop is cut into pieces the worker can make in a few seconds each
    cl.set('_voiceRestarts', 0); cl.set('_voiceEverReady', true); cl.set('_voiceFirstStart', Date.now()); cl.set('_voiceRestartAt', 0); c.voice.status = 'off';
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } }); T.eq(f._netraVoiceReady(), true);
    var words = []; for (var i = 0; i < 90; i++) words.push('INC00' + (1000 + i) + (i % 7 === 6 ? ',' : '')); var runOn = words.join(' ');
    T.ok(runOn.length > 600 && runOn.indexOf('.') < 0, 'one 600+ char group without a full stop');
    answers.length = 0; f.speakNetraVoice(runOn, noop);
    T.ok(answers.length >= 3, 'cut into pieces: ' + answers.length);
    T.ok(answers.every(function (a) { return a.text.length <= 220; }), 'none over 220 chars: ' + answers.map(function (a) { return a.text.length; }).join(','));
    T.eq(answers.map(function (a) { return a.text; }).join(' ').replace(/,/g, ''), runOn.replace(/,/g, ''), 'nothing lost, nothing doubled');
    T.eq(f._splitLongGroup('a b c', 220), ['a b c']); T.eq(f._splitLongGroup('one, two, three', 9), ['one', 'two', 'three'], 'cut at the commas');
    // a long sentence at the head of the queue is allowed 100 ms a character on top of the 30 s
    cl.set('_voiceStallTimer', null); cl.set('_voiceHeadSince', Date.now() - 40000);
    f._netraVoiceWatch(); T.eq(c.voice.status, 'ready', 'a 220-char sentence 40 s in is busy, not stuck');
    cl.set('_voiceStallTimer', null); cl.set('_voiceHeadSince', Date.now() - 53000);
    f._netraVoiceWatch(); T.eq(c.voice.status, 'error', 'past 30 s + 22 s it is stuck'); T.ok(c.events.some(function (e) { return /no sound in 5[0-2] s/.test(e); }), c.events.slice(-2).join(' | '));
    // a device line still going when hers starts is cut first
    tm.fire(function (t) { return t.delay === 1500; }); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    var cancelled = 0; cl.set('TTS', { speaking: true, pending: false, cancel: function () { cancelled++; }, getVoices: function () { return []; } });
    f.speakNetraVoice('Hers now.', noop); T.eq(cancelled, 1, 'the device utterance is cancelled');
    // an interjection (a reminder, a polled notification) waits while a line waits for her, so it is not said twice
    cl.set('_speakingNow', false); cl.set('_chatInFlight', false); cl.set('_queuedUtterance', null); cl.set('_fillerChainActive', false); cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null);
    c.state = 'idle'; c.interim = ''; cl.set('_lastInterimAt', 0); c.labCalib = null; cl.set('_stillAwaiting', function () { return false; });
    cl.set('_voiceHeld', []); T.eq(f._floorFree(), true);
    cl.set('_voiceHeld', [{ text: 'Reminder: stand-up.' }]); T.eq(f._floorFree(), false, 'the floor is not free while a line waits for her');
});

T.test('a healthy run earns a fresh restart budget; her engine picked again while she loads still releases what waits; a missing config file is final; the sentence that stalled is left out of the restarted line', function () {
    var cl = page(), c = cl.c, f = cl.fn;
    var answers = [];
    fakeWorker(cl, function (w, m) { if (m.cmd === 'say') answers.push(m); });
    var played = [], browser = [];
    global.Audio = function (url) { var a = this; this.url = url; played.push(a); this.play = function () { return Promise.resolve(); }; };
    global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
    cl.set('speakBrowser', function (text, done) { browser.push(text); if (done) done(); });
    cl.set('_humanizeReply', function (t) { return t; }); cl.set('_afterTTS', function (d) { if (d) d(); }); c.labMute = false; c.alert = true;
    var tm = drivenTimers(cl);
    // the budget spent on a flaky first load, then twenty healthy minutes: a later stall still restarts her
    f._netraVoiceLoad(); cl.set('_voiceRestarts', 4); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.ok(cl.get('_voiceReadyAt') > 0);
    cl.set('_voiceReadyAt', Date.now() - 20 * 60000);
    f._netraVoiceFail('stuck twenty minutes later');
    T.eq(cl.get('_voiceRestarts'), 1, 'the budget was whole again'); T.eq(f._netraVoiceComing(), true, 'she is coming back');
    // but flapping right after a ready spends it
    tm.fire(function (t) { return t.delay === 1500; }); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    f._netraVoiceFail('died again at once'); T.eq(cl.get('_voiceRestarts'), 2, 'a ready seconds ago earns nothing');
    // her engine left while she loads, then picked again: the wait timer still releases what waits
    cl.set('_voiceRestarts', 0); cl.set('_voiceRestartAt', 0); cl.set('_voiceEverReady', false); cl.set('_voiceFirstStart', 0); cl.set('_voiceWorker', null); c.voice.status = 'off'; cl.set('_voiceWaitTimer', null);
    f._netraVoiceLoad(); T.eq(tm.timers.filter(function (t) { return t.delay === 90000; }).length, 1, 'the first-load wait');
    cl.set('_voiceWaitSaid', false); f.speak('Early.'); T.eq(cl.get('_voiceHeld').length, 1);
    cl.set('forcedVoiceName', ''); cl.set('chooseVoice', function () { return null; }); browser.length = 0;
    f._setDeviceVoice('Samantha'); T.eq(browser, ['Early.'], 'said at once by the device'); T.eq(cl.get('_voiceHeld'), []);
    T.eq(tm.timers.filter(function (t) { return t.delay === 90000; }).length, 1, 'the wait timer is not cancelled');
    f._setDeviceVoice('__netra__'); T.eq(c.ttsEngine, 'netra');
    f.speak('Later.'); T.eq(cl.get('_voiceHeld').length, 1, 'held again for her');
    cl.set('_voiceFirstStart', Date.now() - 95000); browser.length = 0;
    tm.fire(function (t) { return t.delay === 90000; });
    T.eq(browser, ['Later.'], 'and the window still ends it'); T.eq(cl.get('_voiceHeld'), []);
    // the sentence that stalled is left out: the restarted line begins with the next one
    cl.set('_voiceRestarts', 0); cl.set('_voiceEverReady', true); cl.set('_voiceFirstStart', Date.now()); cl.set('_voiceRestartAt', 0); cl.set('_voiceWorker', null); c.voice.status = 'off';
    f._netraVoiceLoad(); f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } }); answers.length = 0; played.length = 0;
    f.speakNetraVoice('Stuck one. Next one.', noop);
    T.eq(answers.map(function (a) { return a.text; }), ['Stuck one.', 'Next one.']);
    cl.set('_voiceStallTimer', null); cl.set('_voiceHeadSince', Date.now() - 32000);
    f._netraVoiceWatch(); T.eq(c.voice.status, 'error');
    T.eq(cl.get('_voiceHeld').map(function (h) { return h.text; }), ['Next one.'], 'the stuck sentence is left out, the rest waits for her');
    tm.fire(function (t) { return t.delay === 1500; }); answers.length = 0; f._netraVoiceOnMessage({ data: { ready: true, ms: 100 } });
    T.eq(answers.map(function (a) { return a.text; }), ['Next one.'], 'she goes on from the next sentence'); T.eq(browser, ['Later.'], 'never the device');
    T.match(CLIENT, /fetch\(pdiBase \+ 'voice\/' \+ d\.model \+ '\.onnx-json'\)\.then\(okR\), fetch\(pdiBase \+ 'voice\/piper_phonemize-js'\)\.then\(okR\)/, 'a missing config or glue file is an HTTP error (final), not a parse error retried four times');
});

T.test('the worker: the bytes are told as they land, from a streamed body or a cached one', function () {
    var src = workerSrc();
    var posted = [];
    var chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    var streamed = function () { var i = 0; return { ok: true, clone: function () { return this; }, body: { getReader: function () { return { read: function () { return Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }); } }; } } }; };
    var plain = { ok: true, clone: function () { return this; },
        json: function () { return Promise.resolve({ audio: { sample_rate: 22050 }, espeak: { voice: 'en' }, inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }, num_speakers: 1 }); },
        text: function () { return Promise.resolve('var createPiperPhonemize = function (opts) { self.__phonOpts = opts; return Promise.resolve({ callMain: function (args) { opts.print(JSON.stringify({ phoneme_ids: [1] })); } }); };'); },
        arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } };
    var self = { caches: null, postMessage: function (m) { posted.push(m); }, fetch: function (u) { return Promise.resolve(/\.onnx$/.test(String(u)) ? streamed() : plain); } };
    var ort = { env: { wasm: {} }, Tensor: function () {}, InferenceSession: { create: function (model) { self.__model = model; return Promise.resolve({ run: function () { return Promise.resolve({ output: { data: Float32Array.from([0.1]) } }); } }); } } };
    new Function('self', '__import', 'setTimeout', 'clearTimeout', 'fetch', 'caches', src)(self, function () { return Promise.resolve(ort); }, setTimeout, clearTimeout, function (u, o) { return self.fetch(u, o); }, self.caches);
    self.onmessage({ data: { cmd: 'load', base: 'https://x.service-now.com/api/x_196061_netra_v1/voice/ear/', model: 'en_GB-cori-medium' } });
    return new Promise(function (r) { setTimeout(r, 60); }).then(function () {
        T.eq(Array.from(new Uint8Array(self.__model)), [1, 2, 3, 4, 5], 'the streamed pieces make the model, whole and in order');
        T.ok(posted.some(function (m) { return m.stage === 'fetching' && m.mb === 0; }), 'the bytes so far are told as they land: ' + JSON.stringify(posted.filter(function (m) { return m.stage; })));
        var starting = posted.filter(function (m) { return m.stage === 'starting'; });
        T.eq(starting.map(function (m) { return m.step; }), ['engine', 'warm-up']); T.eq(starting[0].mb, 0, '5 + 8 + 8 + 8 bytes round to 0 MB');
        T.ok(posted.some(function (m) { return m.ready; }), 'ready');
        T.ok(self.__phonOpts.getPreloadedPackage() instanceof ArrayBuffer, 'the language data (read the plain way when a body cannot be streamed) still handed over');
    });
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

/**
 * Netra Mic widget - CLIENT CONTROLLER (R9 "Prism")
 *
 * ok so this file is basically Netra's whole front-end brain. quick tour
 * of the big stuff so future-me doesnt have to re-read 5k lines:
 *
 * R9 adds the stuff I kept wishing for while testing:
 *   - mic calibration runs on every page refresh now, fully interactive
 *     (read the sentence, get a % score, skip/retry buttons or just say
 *     skip). sensitivity slider feeds the mic gain node directly.
 *   - Netra Lab got language + voice selectors, a typed command box (no
 *     mic needed) and an NLP dry-run tester that keeps the TTS quiet.
 *   - pastel mesh gradient enviroment blooms in while she talks.
 *
 * R7/R8 recap (the "live" era):
 *   - Ava Multilingual Edge neural voice at 96kbps, SSML prosody pace
 *   - MediaSource-streamed synthesis: audio starts on the first chunk,
 *     prosody unbroken across the whole reply, no segment gaps
 *   - INSTANT yield: two non-echo words on the LIVE interim transcript
 *     stop her mid-syllable (~0.3-0.5s), no waiting for finals
 *   - liquid blob orb: smooth spline (60fps rAF, DOM-direct), breathing
 *     on idle, surging with speech; prism hue engine colours everything
 *     from her own voice spectrum
 *   - dev console: chat transcript tab, Voice Lab, routing telemetry
 *   - server auto-routes flash-lite vs 2.5-flash by turn complexity
 *
 * R6 adds true two-way interruption, like talking to a person:
 *   - BARGE-IN: the mic stays hot while Netra speaks; her own voice is
 *     rejected by token-overlap echo scoring, genuine user speech stops
 *     her audio in ~100ms ("stop"/"wait" yield instantly, any sentence
 *     interrupts). Interim speech ducks her volume so she audibly gives
 *     way before you even finish.
 *   - INTERJECTIONS: soft listener backchannels ("mm-hmm") during long
 *     user turns, a single gentle nudge when her question goes
 *     unanswered, and a polite "sorry to cut in" preface when a
 *     notification lands mid-conversation.
 *   - TURN EPOCHS: a reply that arrives after you interrupted its
 *     question is kept in history but never spoken over you.
 *   - PIPELINED EDGE TTS: long replies stream sentence-by-sentence, so
 *     speech starts ~2-4x sooner and can be interrupted mid-stream.
 *   - Humanized delivery: automatic contractions, adaptive command
 *     debounce (short commands fire ~0.5s faster), expanded transcript
 *     and history limits, universal Escape/stop silencer.
 *
 * R5 adds: spoken VIT / CVE number normalization ("v i t two three four
 *   five" -> VIT0002345, "cve 2021 44228" -> CVE-2021-44228),
 *   vulnerability + instance-health vocabulary in the JSGF recognition
 *   grammar, and VR-flavored thinking fillers.
 *
 * R2 adds: web search via DuckDuckGo + Wikipedia, in-SP-tab navigation,
 *   in-SP-tab button click by label, faster Gemini round-trips through
 *   history pruning + smaller max-tokens, parallel functionCalling.
 *   R1 stays untouched on the release-1 branch and Netra_V1 update set.
 *
 * R1.4 adds: persistent conversation memory across page loads,
 *   visible spoken-response card with model+latency badge, last-turn
 *   tool-call trace in dev panel, screen capture via getDisplayMedia
 *   for Gemini multimodal vision, list_capabilities introspection,
 *   smarter proactive briefing with highlighted top items.
 *
 * Architecture:
 *   ONE continuous speech-recognition session that NEVER stops. The
 *   mic stays open as long as the page is open. Two "alert" modes:
 *
 *     - ALERT  (default): every final transcript is checked. If it
 *       starts with the wake word "Netra" (or any of its common
 *       mishearings), the rest of the utterance is treated as a
 *       command. If it stands alone, the next utterance within 8s
 *       is treated as a command.
 *
 *     - DORMANT: triggered by saying "stop listening" / "go to sleep"
 *       / "sleep mode". The mic stays open but final transcripts are
 *       only inspected for the wake word - everything else is ignored.
 *       Saying "Netra listen" / "Netra wake up" / just "Netra" wakes
 *       her back up.
 *
 * NLP layers (free / built-in):
 *   1. SpeechGrammarList domain vocabulary - biases the recognizer
 *      toward Netra-relevant words (Netra, ticket, incident, INC,
 *      approve, resolve, etc.) for better recognition.
 *   2. Fuzzy wake matching - regex bank for "Netra" / "Neetra" /
 *      "Naitra" / "Mitra" / "Mantra" / "Hey Netra" / etc.
 *   3. Local intent shortcuts - common commands (time, date, hello,
 *      thanks, who are you, help, sleep, wake) handled locally
 *      without round-tripping Gemini. Fast + works offline.
 *   4. Spoken-number normalization - "I N C zero zero zero one two
 *      three four" -> "INC0001234" before sending to the server,
 *      reducing Gemini's lift.
 *   5. Confidence threshold - if Web Speech confidence < 0.3, ask
 *      for clarification instead of sending garbage to Gemini.
 *   6. Gemini function-calling (server side) - the heavy lifting.
 *
 * To switch to blind-only mode for production: flip DEV_DEFAULT_ON
 * to false (or just press Alt+D in the live widget).
 */
api.controller = function ($scope, $timeout, $window) {
    var c = this;

    var DEV_DEFAULT_ON      = false;  // R3 - dev panel hidden by default; Alt+Shift+D toggles for admins
    var ALWAYS_LISTEN       = true;   // v12 - no wake word ever; sleep with "stop listening"
    var WAKE_TIMEOUT_MS     = 8000;   // legacy wake-armed window (only used if ALWAYS_LISTEN is false)
    var MIN_CONFIDENCE      = 0.35;   // below this, ignore as chatter
    var MIN_LENGTH          = 3;      // ignore utterances shorter than this many chars
    var RESTART_DELAY       = 250;    // ms before reopening recognition after onend
    var TTS_GUARD_MS        = 350;    // ignore mic finals this long after TTS ends
    // R6 - human turn-taking. While Netra speaks the mic stays HOT: finals
    // are no longer blanket-dropped for 15s; instead each one is scored
    // against what she is saying (echo) vs genuine user speech (barge-in).
    var BARGE_GUARD_MS      = 450;    // settle time after TTS starts before barge-in arms
    var BARGE_MIN_CHARS     = 8;      // substantive interrupt needs at least this much text
    var BARGE_MIN_CONF      = 0.30;   // reject noise-floor "speech" as interrupts
    var ECHO_OVERLAP_RATIO  = 0.72;   // >= this token overlap with her own words = echo
    var BACKCHANNEL_GAP_MS  = 15000;  // at most one "mm-hmm" per this window
    var REPROMPT_AFTER_MS   = 9000;   // gentle nudge if her question goes unanswered
    var REMOTE_TTS_DEFAULT  = true;   // free StreamElements Raveena by default
    var REMOTE_TTS_VOICE    = 'Raveena';  // Indian English female (free, no API key)

    /* ============================================================
     *  STATE
     * ============================================================ */
    c.state       = 'idle';
    c.stateLabel  = 'getting ready';
    c.lastHeard   = '';
    c.spoken      = '';
    c.needsTap    = true;
    c.alert       = true;        // false = dormant
    c.recRunning  = false;
    c.devOn       = DEV_DEFAULT_ON;
    c.devTab      = 'voice';   // R2.12 - VS Code-style tabbed dev panel
    c.devSetTab   = function (t) { c.devTab = t; };

    c.events      = [];
    c.interim     = '';
    c.confidence  = '';
    c.voiceName   = '(picking...)';
    c.permission  = '(unknown)';
    c.voices      = [];
    c.voicePick   = '';
    c.devText     = '';
    c.hasSR       = false;
    c.hasTTS      = false;
    c.conversationOpen = false;     // follow-up window open?
    c.useRemoteTTS = REMOTE_TTS_DEFAULT;
    c.remoteVoice  = REMOTE_TTS_VOICE;
    c.ttsEngine    = 'edge';   // R1.5 - default to Microsoft Edge Neural (free, natural)

    // R1 - Stats + Charts
    var BOOT_TIME = Date.now();
    c.stats = {
        uptimeLabel:   '0s',
        utterances:    0,
        toolsCalled:   0,
        errors:        0,
        lastModel:     '-',
        lastLatencyMs: 0
    };
    // R1.4 - last-turn tool-call trace (so you can actually see what she did)
    c.lastTrace = [];   // [{name, ts}, ...]
    // R7 - live conversation transcript for the dev panel Chat tab
    c.convo = [];       // [{who:'you'|'netra'|'sys', text, t}]
    function _convoPush(who, text) {
        if (!text) return;
        c.convo.push({ who: who, text: String(text).substring(0, 600), t: new Date().toTimeString().slice(0, 8) });
        if (c.convo.length > 60) c.convo.splice(0, c.convo.length - 60);
        $scope.$applyAsync();
    }
    c.pendingScreenshot = null;
    c.pendingOpenUrl    = null;   // R2.4 - clickable fallback when popup blocked
    // R2.8 - unified audio level (0-100) for the voice bars around the orb.
    // Driven by mic input when listening; driven by playback amplitude when speaking.
    c.audioLevel = 0;

    // R8 - NETRA LIVE: the dedicated portal page (/sp?id=netra_live)
    // renders the full-screen live voice stage instead of just
    // the floating orb. Same controller, same features - bigger canvas.
    c.liveMode = false;
    c.liveStatus = 'Waking up…';
    try {
        c.liveMode = /[?&]id=netra_live(&|$)/.test(String($window.location.search || $window.location.href || ''));
        if (c.liveMode) document.body.classList.add('netra-live-body');
    } catch (eLM) { c.liveMode = false; }
    c.liveExit = function () {
        _stage3dOn = false;
        try { if (window.NetraStage3D) window.NetraStage3D.unmount(); } catch (e3d) {}
        try {
            if ($window.history && $window.history.length > 1) $window.history.back();
            else $window.location.assign('/sp');
        } catch (e) { $window.location.assign('/sp'); }
    };

    /* ============================================================
     *  R10 - REAL 3D STAGE (three.js, embedded as a widget dependency)
     *  Mounts the WebGL scene behind the stage UI; on success the 2D
     *  SVG blob + CSS starfield hide (class netra-3d-on) and the
     *  bloom-lit glass orb takes over. Any failure -> silent fallback
     *  to the 2D blob, nothing else changes.
     * ============================================================ */
    function _init3D(attempt) {
        if (!c.liveMode) return;
        var hostEl = document.querySelector('.netra-stage-3d');
        var stageEl = document.querySelector('.netra-stage');
        if (!hostEl || !stageEl || !window.NetraStage3D || !window.THREE) {
            if (attempt < 24) $timeout(function () { _init3D(attempt + 1); }, 250);
            else logEvent('warn', '3D stage unavailable (three.js dependency not loaded) - keeping 2D blob');
            return;
        }
        var ok = false;
        try { ok = window.NetraStage3D.mount(hostEl); } catch (e3) { ok = false; }
        if (ok) {
            stageEl.classList.add('netra-3d-on');
            _stage3dOn = true;
            logEvent('lab', '3D stage online: WebGL glass orb + sunrise + bloom');
        } else {
            logEvent('warn', 'WebGL not available - keeping the 2D blob');
        }
    }
    var _stage3dOn = false;
    if (c.liveMode) $timeout(function () { _init3D(0); }, 400);

    /* ============================================================
     *  R8.1 - NETRA LAB (advanced diagnostics console on the Live
     *  stage) + FIRST-RUN CALIBRATION
     *
     *  A glass side panel with: a real-time mic spectrum scope
     *  painted from the analyser, recognition-health telemetry from
     *  the Sentinel layer, a record/playback mic test, an STT
     *  accuracy calibration (Netra asks you to read a sentence and
     *  scores the transcript word-by-word), TTS/brain stats and the
     *  live prism-hue readout. The calibration also runs once
     *  automatically on the very first boot in this browser.
     * ============================================================ */
    c.labOn = false;
    c.labToggle = function () {
        c.labOn = !c.labOn;
        if (c.labOn) {
            _labScopeEl = null;   // re-query canvas on open
            $timeout(_labRestorePos, 30);   // put the window back where it was
        }
        logEvent('lab', c.labOn ? 'Netra Lab opened' : 'Netra Lab closed');
    };
    c.labRestartMic = function () { _fullMicRecycle('manual (Netra Lab)'); };

    /* ============================================================
     *  R9 - LAB PREFERENCES: recognition language, TTS mute, mic
     *  sensitivity, typed commands and NLP dry-run tests. All the
     *  knobs persist in localStorage so devs keep their setup.
     * ============================================================ */
    var _micGainNode = null;
    c.labMute = false;
    c.recLangs = ['en-IN', 'en-US', 'en-GB', 'en-AU', 'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP'];
    c.recLang = 'en-IN';
    c.micGain = 1.0;
    try {
        c.recLang = localStorage.getItem('netra_lang') || 'en-IN';
        var g = parseFloat(localStorage.getItem('netra_mic_gain'));
        if (g >= 0.5 && g <= 3) c.micGain = g;
        c.labMute = localStorage.getItem('netra_lab_mute') === '1';
    } catch (ePref) {}
    c.labSetLang = function () {
        try { localStorage.setItem('netra_lang', c.recLang); } catch (e) {}
        logEvent('lab', 'recognition language -> ' + c.recLang);
        _fullMicRecycle('language change');
    };
    c.labSetGain = function () {
        try { localStorage.setItem('netra_mic_gain', String(c.micGain)); } catch (e) {}
        if (_micGainNode) { try { _micGainNode.gain.value = c.micGain; } catch (e2) {} }
    };
    c.labSetMute = function () {
        try { localStorage.setItem('netra_lab_mute', c.labMute ? '1' : '0'); } catch (e) {}
        logEvent('lab', 'TTS ' + (c.labMute ? 'muted' : 'unmuted'));
    };

    // typed commands - same pipeline as voice, minus the microphone
    c.labCmd = '';
    c.labSendCmd = function () {
        var t = String(c.labCmd || '').trim();
        if (!t) return;
        c.labCmd = '';
        logEvent('lab', 'typed command: "' + t + '"');
        processCommand(t, 1.0);
    };
    c.labCmdKey = function (ev) { if (ev && ev.keyCode === 13) c.labSendCmd(); };

    // NLP dry-run: full brain round-trip, TTS muted, result panel in the Lab
    var _labNlpArm = false, _labNlpPrevMute = false, _labNlpSent = '';
    c.labNlpText = '';
    c.labNlp = null;   // { sent, reply, tools, ms }
    c.labRunNlp = function () {
        var t = String(c.labNlpText || '').trim();
        if (!t) return;
        _labNlpArm = true;
        _labNlpSent = t;
        _labNlpPrevMute = c.labMute;
        c.labMute = true;
        c.labNlp = { sent: t, reply: '…', tools: [], ms: null };
        logEvent('lab', 'NLP test: "' + t + '"');
        processCommand(t, 1.0);
    };
    c.labNlpKey = function (ev) { if (ev && ev.keyCode === 13) c.labRunNlp(); };
    function _labNlpCapture(reply, tools, ms) {
        if (!_labNlpArm) return;
        _labNlpArm = false;
        c.labMute = _labNlpPrevMute;
        c.labNlp = { sent: _labNlpSent, reply: String(reply || ''), tools: tools || [], ms: ms };
        $scope.$applyAsync();
    }

    // R8.1 - the Lab is a floating window: drag it anywhere by its header
    // (same interaction as the dev console). Position survives via
    // sessionStorage so it stays where you put it across reloads.
    var _labDrag = null;
    c.labDragStart = function (ev) {
        if (!ev || (ev.button !== undefined && ev.button !== 0)) return;
        if (ev.target && ev.target.classList && ev.target.classList.contains('netra-lab-x')) return;
        var el = document.querySelector('.netra-lab');
        if (!el) return;
        var rect = el.getBoundingClientRect();
        _labDrag = { startX: ev.clientX, startY: ev.clientY, origX: rect.left, origY: rect.top, moved: false };
        document.addEventListener('mousemove', _onLabDragMove);
        document.addEventListener('mouseup',   _onLabDragEnd);
        ev.preventDefault();
    };
    function _onLabDragMove(ev) {
        if (!_labDrag) return;
        var dx = ev.clientX - _labDrag.startX;
        var dy = ev.clientY - _labDrag.startY;
        if (!_labDrag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            _labDrag.moved = true;
            document.body.style.userSelect = 'none';
        }
        if (_labDrag.moved) {
            var el = document.querySelector('.netra-lab');
            if (!el) return;
            var vw = window.innerWidth, vh = window.innerHeight;
            var nx = Math.max(0, Math.min(vw - 60, _labDrag.origX + dx));
            var ny = Math.max(0, Math.min(vh - 40, _labDrag.origY + dy));
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
    }
    function _onLabDragEnd() {
        document.removeEventListener('mousemove', _onLabDragMove);
        document.removeEventListener('mouseup', _onLabDragEnd);
        document.body.style.userSelect = '';
        if (_labDrag && _labDrag.moved) {
            var el = document.querySelector('.netra-lab');
            if (el) {
                try {
                    sessionStorage.setItem('netra_lab_pos', JSON.stringify({ left: el.style.left, top: el.style.top }));
                } catch (eLP) {}
            }
        }
        _labDrag = null;
    }
    function _labRestorePos() {
        try {
            var pos = JSON.parse(sessionStorage.getItem('netra_lab_pos') || 'null');
            if (!pos || !pos.left) return;
            var el = document.querySelector('.netra-lab');
            if (!el) return;
            el.style.left = pos.left;
            el.style.top = pos.top;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } catch (eLR) {}
    }
    c.labSessionAgeS   = function () { return recLastStartTime ? Math.round((Date.now() - recLastStartTime) / 1000) : 0; };
    c.labLastFinalAgo  = function () { return _lastFinalAt ? Math.round((Date.now() - _lastFinalAt) / 1000) + 's' : 'never'; };
    c.labLastInterimAgo = function () { return c.micHealth.lastInterimAt ? Math.round((Date.now() - c.micHealth.lastInterimAt) / 1000) + 's' : 'never'; };
    c.labHue = function () { return Math.round(_prismHue); };
    c.labAmp = function () { return Math.round(_prismAmp * 100); };

    // ---- live mic spectrum scope (canvas, painted from the mic rAF loop) ----
    var _labScopeEl = null, _labScopeCtx = null;
    function _labDrawScope(freqData, level) {
        if (!_labScopeEl || !_labScopeEl.isConnected) {
            _labScopeEl = document.querySelector('.netra-lab-scope');
            if (!_labScopeEl) return;
            _labScopeCtx = _labScopeEl.getContext('2d');
        }
        var w = _labScopeEl.width, h = _labScopeEl.height;
        var g = _labScopeCtx;
        g.clearRect(0, 0, w, h);
        var n = 96;                       // draw the first 96 bins (speech range)
        var bw = w / n;
        var hue = Math.round(_prismHue);
        for (var i = 0; i < n; i++) {
            var v = (freqData[i + 2] || 0) / 255;
            var bh = Math.max(1, v * (h - 4));
            g.fillStyle = 'hsla(' + ((hue + i * 1.2) % 360) + ',90%,' + (45 + v * 30) + '%,' + (0.35 + v * 0.65) + ')';
            g.fillRect(i * bw, h - bh, bw - 1, bh);
        }
        // level needle along the bottom
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillRect(0, h - 2, (level / 100) * w, 2);
    }

    // ---- STT accuracy calibration ----
    var CALIB_SENTENCE = 'The quick brown fox jumps over the lazy dog near the big green screen';
    var _calibActive = false, _calibTimer = null, _calibListenStart = 0, _calibFirstRun = false;
    c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
    try {
        var _savedCalib = JSON.parse(localStorage.getItem('netra_calib') || 'null');
        if (_savedCalib && typeof _savedCalib.score === 'number') {
            c.labCalib = { stage: 'saved', heard: '', score: _savedCalib.score, verdict: 'last run ' + (_savedCalib.at || '') };
        }
    } catch (eCS) {}
    c.labCalibSentence = CALIB_SENTENCE;
    c.labStartCalibration = function () { startCalibration(false, ''); };

    function _wordAccuracy(expected, heard) {
        var e = _normTokens(expected), hd = _normTokens(heard);
        if (!e.length) return 0;
        var m = e.length, n2 = hd.length, dp = [], i, j;
        for (i = 0; i <= m; i++) dp[i] = [i];
        for (j = 1; j <= n2; j++) dp[0][j] = j;
        for (i = 1; i <= m; i++)
            for (j = 1; j <= n2; j++)
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                                    dp[i - 1][j - 1] + (e[i - 1] === hd[j - 1] ? 0 : 1));
        return Math.max(0, Math.round((1 - dp[m][n2] / m) * 100));
    }

    function startCalibration(firstRun, preamble) {
        if (_calibActive) return;
        _calibActive = true;
        _calibFirstRun = !!firstRun;
        c.labCalib = { stage: 'prompt', heard: '', score: null, verdict: '' };
        $scope.$applyAsync();
        speak((preamble || '') + 'Quick mic calibration. After the tone, please read this sentence aloud: ' +
              CALIB_SENTENCE + '.', function () {
            cue('wake');
            _calibListenStart = Date.now();
            c.labCalib.stage = 'listening';
            $scope.$applyAsync();
            if (_calibTimer) $timeout.cancel(_calibTimer);
            _calibTimer = $timeout(function () {
                if (!_calibActive) return;
                _calibActive = false;
                c.labCalib.stage = 'timeout';
                c.labCalib.verdict = 'Nothing captured in 25s - check the mic, then retry from the Lab.';
                logEvent('lab', 'calibration timed out (no speech captured)');
                speak('I did not catch anything that time. The mic test lives in the Netra Lab whenever you want to retry.');
                $scope.$applyAsync();
            }, 25000);
        });
    }

    // Consumes a final transcript while calibration is listening.
    // Returns true when the final was the calibration read-back.
    function _calibConsume(clean) {
        if (!_calibActive || c.labCalib.stage !== 'listening') return false;
        // Ignore finals landing suspiciously fast after her own prompt -
        // those are echo tails of Netra reading the sentence herself.
        if (Date.now() - _calibListenStart < 1200) return true;
        // R9 - voice escape hatch: "skip" / "not now" bails out instantly
        if (/^(skip( it)?|cancel|not now|later|no thanks?)[.!,\s]*$/i.test(clean)) {
            c.calibSkip();
            return true;
        }
        _calibActive = false;
        if (_calibTimer) { $timeout.cancel(_calibTimer); _calibTimer = null; }
        var score = _wordAccuracy(CALIB_SENTENCE, clean);
        c.labCalib = {
            stage: 'done', heard: clean, score: score,
            verdict: score >= 90 ? 'Excellent - crystal clear.' :
                     score >= 75 ? 'Good - fully usable.' :
                     score >= 50 ? 'Fair - move closer to the mic or cut background noise.' :
                                   'Poor - check the input device and tab permission.'
        };
        c.micHealth.lastCalibScore = score;
        try { localStorage.setItem('netra_calib', JSON.stringify({ score: score, at: new Date().toISOString() })); } catch (eLS) {}
        logEvent('lab', 'calibration ' + score + '% - heard: "' + clean + '"');
        speak('Mic check complete. Word accuracy ' + score + ' percent. ' + c.labCalib.verdict +
              (_calibFirstRun ? ' You are all set. I am listening - just speak.' : ''));
        $scope.$applyAsync();
        return true;
    }

    // ---- R8.2 - local reminders (to-the-minute while the tab is open) ----
    var _localReminderTimers = [];
    var _recentReminderTexts = {};   // dedupe vs the scanner-promoted copy
    function _scheduleLocalReminder(delayMs, text) {
        var d = Math.max(1000, Math.min(12 * 3600 * 1000, delayMs || 0));
        logEvent('lab', 'local reminder armed in ' + Math.round(d / 60000) + ' min: ' + text);
        _localReminderTimers.push($timeout(function () {
            _recentReminderTexts[String(text)] = Date.now();
            cue('wake');
            speak(text || 'Reminder.');
            _convoPush('sys', '· reminder fired ·');
        }, d));
    }
    // called from the notification announce path: skip a scanner-promoted
    // reminder we already spoke locally in the last 10 minutes
    function _reminderAlreadySpoken(msg) {
        var t = _recentReminderTexts[String(msg)];
        return !!t && (Date.now() - t) < 10 * 60 * 1000;
    }

    // ---- boot self check (UI + animations + mic + calibration) ----
    // R9 - runs on every page load. First-ever boot narrates the full
    // check; returning boots keep it quick. Interactive: Skip / Try again
    // buttons on the stage card, or just say "skip".
    function _firstRunPending() {
        try { return !localStorage.getItem('netra_firstrun_done'); } catch (eFR) { return false; }
    }
    function _firstRunCheck() {
        var firstEver = _firstRunPending();
        try { localStorage.setItem('netra_firstrun_done', '1'); } catch (eFS) {}
        var uiOk   = !!document.querySelector('.netra-orb, .netra-stage-svg');
        var animOk = !!_blobRafId;
        var micOk  = !!c.micStreamActive;
        logEvent('lab', 'boot self check: ui=' + uiOk + ' anim=' + animOk + ' mic=' + micOk + (firstEver ? ' (first ever)' : ''));
        var uiLine = firstEver
            ? ('Running my first-time self check. Interface ' + (uiOk ? 'rendered' : 'failed to render') +
               ', animations ' + (animOk ? 'running' : 'stopped') +
               ', microphone stream ' + (micOk ? 'live. All good.' : 'not detected - voice may not work.') + ' ')
            : (micOk ? 'Quick mic check - say skip to jump straight in. '
                     : 'Heads up, I am not seeing a microphone stream. ');
        startCalibration(firstEver, uiLine);
    }
    c.calibSkip = function () {
        if (!_calibActive) return;
        _calibActive = false;
        if (_calibTimer) { $timeout.cancel(_calibTimer); _calibTimer = null; }
        c.labCalib.stage = 'skipped';
        logEvent('lab', 'calibration skipped');
        stopSpeaking('calibration skipped');
        speak('Skipped. I am listening - just speak.');
        $scope.$applyAsync();
    };
    c.calibRetry = function () {
        c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
        startCalibration(false, '');
    };
    c.calibDismiss = function () {
        c.labCalib.stage = 'idle';
        $scope.$applyAsync();
    };

    // Per-bar multiplier; jitter so the ring feels alive rather than uniform.
    // R2.12.3 - calibrated for viewBox 120×120 with hard distance cap.
    // The previous R2.12.2 values (0.55-0.85, spike 2.4) produced polygon
    // vertices at dist=278 which exploded past the viewBox and rendered
    // as ugly yellow blobs offscreen.
    var VOICE_RING_MULTIPLIERS = [
        0.42, 0.50, 0.40, 0.56, 0.44, 0.48, 0.42, 0.54,
        0.40, 0.58, 0.44, 0.48, 0.42, 0.50, 0.40, 0.55,
        0.44, 0.46, 0.42, 0.52, 0.40, 0.58, 0.44, 0.50
    ];
    // R8 - the blob IS the orb now (one soft clay splat), not a ring
    // around an eye. Radii sized for a standalone organic shape in the
    // 120x120 viewBox: ~34 at rest, breathing to ~54 on loud speech.
    var VOICE_RING_BASE_IDLE      = 34;
    var VOICE_RING_BASE_SPEAKING  = 38;
    var VOICE_RING_SPIKE_SPEAKING = 0.34;   // speaking amplitude gain
    var VOICE_RING_GAIN_IDLE      = 0.10;   // listening ripple gain (mic-driven)
    var VOICE_RING_DIST_MAX = 54;
    // R7 - LIQUID BLOB (GPT-Live style). The spiky 24-vertex polygon is
    // replaced by a smooth closed spline through the same 24 amplitude
    // points, with per-vertex temporal smoothing (lerp) and a slow
    // travelling wobble - the aura reads as breathing plasma, not a
    // graph. Two layers: outer aura + counter-phased inner core.
    var _blobLevels = new Array(24);
    for (var _bi = 0; _bi < 24; _bi++) _blobLevels[_bi] = 0;
    var _blobPhase = 0;
    function _smoothClosedPath(px, py) {
        // Catmull-Rom -> cubic Bezier, closed loop. Any non-finite point
        // snaps to center first - one bad frame must never poison the whole
        // path string (the browser logs a console error for every NaN).
        var n = px.length, k;
        for (k = 0; k < n; k++) {
            if (!isFinite(px[k])) px[k] = 60;
            if (!isFinite(py[k])) py[k] = 60;
        }
        var d = 'M' + px[0].toFixed(1) + ',' + py[0].toFixed(1);
        for (var i = 0; i < n; i++) {
            var i0 = (i - 1 + n) % n, i1 = i, i2 = (i + 1) % n, i3 = (i + 2) % n;
            var c1x = px[i1] + (px[i2] - px[i0]) / 6, c1y = py[i1] + (py[i2] - py[i0]) / 6;
            var c2x = px[i2] - (px[i3] - px[i1]) / 6, c2y = py[i2] - (py[i3] - py[i1]) / 6;
            d += 'C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' '
                     + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' '
                     + px[i2].toFixed(1) + ',' + py[i2].toFixed(1);
        }
        return d + 'Z';
    }
    var VOICE_RING_SIN = new Array(24);
    var VOICE_RING_COS = new Array(24);
    for (var _vi = 0; _vi < 24; _vi++) {
        var _va = _vi * 15 * Math.PI / 180;
        VOICE_RING_SIN[_vi] = Math.sin(_va);
        VOICE_RING_COS[_vi] = Math.cos(_va);
    }
    var _lastVoiceRingLevel = -1;
    var _lastVoiceRingState = '';
    var _lastVoiceRingHash  = '';
    // R2.12.2 - speaker-cone pulse: writes a 0..1 CSS variable on the
    // orb root so the SVG transform: scale(1 + var * 0.18) breathes.
    var _orbRootEl = null;
    var _lastOrbPulse = -1;
    function _setOrbPulse(v) {
        var pulse = Math.max(0, Math.min(1, v));
        if (Math.abs(pulse - _lastOrbPulse) < 0.02) return;   // skip imperceptible updates
        _lastOrbPulse = pulse;
        if (!_orbRootEl) {
            _orbRootEl = document.querySelector('.netra-root');
            if (!_orbRootEl) return;
        }
        _orbRootEl.style.setProperty('--orb-pulse', pulse.toFixed(3));
    }

    /* ============================================================
     *  R8.1 - PRISM HUE ENGINE
     *
     *  A living colour system computed at 60fps alongside the blob
     *  geometry. Each state owns a base hue; while Netra SPEAKS the
     *  hue is continuously modulated by the voice itself - the
     *  spectral centroid of the 24 analyser bands swings the tone
     *  between deep indigo (bass-heavy moments) and warm magenta /
     *  rose (bright sibilant moments), while overall amplitude
     *  drives saturation, glow strength and the aurora intensity.
     *  Everything is written as CSS custom properties on .netra-root
     *  (full colour strings, so the SCSS layer stays dumb) and
     *  cascades to the orb, the Live stage, and the dev console.
     * ============================================================ */
    // R10.1 - Gemini palette: azure #4285F4 (~217deg) -> lavender #9B72CB
    // (~262deg) -> rose #D96570 (~355deg); speaking sweeps the gradient.
    var PRISM_STATE_HUE = {
        boot: 230, idle: 217, awaiting: 202, listening: 202,
        thinking: 262, speaking: 258, dormant: 250, error: 8, paused: 220
    };
    var PRISM_STATE_SAT = { dormant: 55, paused: 14, boot: 70 };
    var _prismHue  = 152;    // smoothed hue (deg)
    var _prismAmp  = 0;      // smoothed 0..1 loudness
    var _prismTime = 0;      // slow drift clock
    var _prismLastWriteHue = -999, _prismLastWriteAmp = -1, _prismLastState = '';
    function _hueLerpAngle(a, b, t) {
        var d = ((b - a + 540) % 360) - 180;   // shortest arc
        return (a + d * t + 360) % 360;
    }
    function _prismTick() {
        var st = c.state || 'idle';
        _prismTime += 0.016;
        var target = PRISM_STATE_HUE[st] !== undefined ? PRISM_STATE_HUE[st] : 152;
        var levelNow = 0;
        if (st === 'speaking') {
            // spectral centroid 0..1 across the 24 log bands
            var bands = c.audioLevels, num = 0, den = 0;
            if (bands) {
                for (var i = 0; i < 24; i++) { num += bands[i] * i; den += bands[i]; }
            }
            var centroid = den > 1 ? (num / den) / 23 : 0.42;
            var swing = (centroid - 0.42) * 130;
            if (swing >  55) swing =  55;
            if (swing < -55) swing = -55;
            // slow ambient drift keeps the colour alive between words
            target += swing + 14 * Math.sin(_prismTime * 0.35);
            levelNow = (c.audioLevel || 0) / 100;
        } else if (st === 'thinking') {
            // churning magenta<->violet - visibly "working on it"
            target += 26 * Math.sin(_prismTime * 1.9);
            levelNow = 0.30 + 0.12 * Math.sin(_prismTime * 3.1);
        } else if (st === 'awaiting' || st === 'listening') {
            // cyan capture state shimmers with the user's own mic level
            levelNow = (c.micLevel || 0) / 100;
            target += levelNow * 18 + 6 * Math.sin(_prismTime * 0.8);
        } else if (st === 'idle') {
            // gentle emerald<->teal patrol so idle never looks frozen
            target += 10 * Math.sin(_prismTime * 0.22);
        }
        _prismHue = _hueLerpAngle(_prismHue, target, 0.055);
        _prismAmp += (levelNow - _prismAmp) * 0.18;
        if (_prismAmp < 0) _prismAmp = 0;
        if (_prismAmp > 1) _prismAmp = 1;
        // R10 - feed the 3D stage every tick (plain globals, no digests)
        window.__netraPrism = { h: _prismHue, amp: _prismAmp };
        // throttle DOM writes to perceptible changes
        var stateChanged = st !== _prismLastState;
        if (!stateChanged &&
            Math.abs(_prismHue - _prismLastWriteHue) < 0.4 &&
            Math.abs(_prismAmp - _prismLastWriteAmp) < 0.015) return;
        _prismLastState = st; _prismLastWriteHue = _prismHue; _prismLastWriteAmp = _prismAmp;
        if (!_orbRootEl || !_orbRootEl.isConnected) {
            _orbRootEl = document.querySelector('.netra-root');
            if (!_orbRootEl) return;
        }
        var h   = Math.round(_prismHue * 10) / 10;
        var amp = Math.round(_prismAmp * 1000) / 1000;
        var sat = PRISM_STATE_SAT[st] !== undefined ? PRISM_STATE_SAT[st] : 90;
        var S = _orbRootEl.style;
        function hsl(dh, s, l)     { return 'hsl(' + (((h + dh) % 360 + 360) % 360) + ',' + s + '%,' + l + '%)'; }
        function hsla(dh, s, l, a) { return 'hsla(' + (((h + dh) % 360 + 360) % 360) + ',' + s + '%,' + l + '%,' + a + ')'; }
        S.setProperty('--netra-hue', String(h));
        S.setProperty('--netra-amp', String(amp));
        // orb iris family (consumed by the SVG gradient stops)
        S.setProperty('--iris-bright', hsl(4,  sat, 84));
        S.setProperty('--iris-mid',    hsl(0,  Math.round(sat * 0.86), 46));
        S.setProperty('--iris-dark',   hsl(-4, Math.round(sat * 0.9),  20));
        S.setProperty('--iris-deep',   hsl(-6, sat, 7));
        S.setProperty('--core-mid',    hsl(8,  Math.round(sat * 0.75), 75));
        S.setProperty('--eye-glow',    hsla(0, sat, 66, (0.45 + amp * 0.45).toFixed(3)));
        S.setProperty('--netra-glow-soft', hsla(0, sat, 66, (0.16 + amp * 0.30).toFixed(3)));
        // Live-stage blob gradient stops
        S.setProperty('--nsg-0', hsl(6, 100, 96));
        S.setProperty('--nsg-1', hsl(3,  sat, 74));
        S.setProperty('--nsg-2', hsl(0,  Math.round(sat * 0.88), 46));
        S.setProperty('--nsg-3', hsl(-8, Math.round(sat * 0.92), 12));
        // aurora ribbons - offset hues so the room is a duotone of the voice
        S.setProperty('--netra-aura1', hsla(42,  sat, 60, (0.14 + amp * 0.16).toFixed(3)));
        S.setProperty('--netra-aura2', hsla(-48, sat, 58, (0.11 + amp * 0.14).toFixed(3)));
        // voice-blob fill / stroke family (violet-amber duotone follows hue)
        S.setProperty('--nvg-core', hsla(14, 92, 62, 0.95));
        S.setProperty('--nvg-mid',  hsla(2,  88, 64, 0.80));
        S.setProperty('--nvg-hot',  hsla(66, 96, 62, (0.40 + amp * 0.25).toFixed(3)));
        S.setProperty('--nvg-edge', hsla(-12, 85, 55, 0.35));
        S.setProperty('--nvs-a', hsl(-16, 84, 42));
        S.setProperty('--nvs-b', hsl(6,   92, 62));
        S.setProperty('--nvs-c', hsl(62,  98, 64));
        S.setProperty('--nvs-d', hsl(-24, 82, 36));
        // SVG feFlood glow tints
        S.setProperty('--nfl-1', hsl(6,  85, 63));
        S.setProperty('--nfl-2', hsl(18, 78, 64));
        S.setProperty('--nfl-3', hsl(64, 100, 66));
        S.setProperty('--nfl-4', hsl(0,  80, 59));
    }

    /* R8.1 - word-onset ripples on the Live stage: when the speech
     * amplitude jumps above its rolling mean, emit one expanding ring
     * from the blob edge. Pure DOM + CSS animation; capped and
     * self-cleaning, so cost is negligible. */
    var _rippleHost = null, _rippleLast = 0, _rippleMean = 0, _rippleCount = 0;
    function _maybeRipple() {
        if (!c.liveMode || c.state !== 'speaking') return;
        var amp = _prismAmp;
        _rippleMean += (amp - _rippleMean) * 0.06;
        var now = Date.now();
        if (amp - _rippleMean < 0.12 || now - _rippleLast < 300 || _rippleCount >= 5) return;
        if (!_rippleHost || !_rippleHost.isConnected) {
            _rippleHost = document.querySelector('.netra-stage-ripples');
            if (!_rippleHost) return;
        }
        _rippleLast = now;
        _rippleCount++;
        var el = document.createElement('div');
        el.className = 'netra-ripple';
        el.addEventListener('animationend', function () {
            _rippleCount--;
            if (el.parentNode) el.parentNode.removeChild(el);
        });
        _rippleHost.appendChild(el);
    }

    function _recomputeVoiceRing() {
        var lvlAvg = c.audioLevel || 0;
        var st     = c.state || '';
        // R10.1b - when the WebGL orb owns the stage the SVG blob is
        // invisible, so skip the whole path build (it was pure wasted CPU
        // and the only thing still able to throw NaN path errors). The
        // prism engine, ripples and the 3D globals keep running.
        if (_stage3dOn) {
            _lastVoiceRingLevel = lvlAvg;
            _lastVoiceRingState = st;
            _prismTick();
            _maybeRipple();
            window.__netraBands = c.audioLevels || null;
            window.__netraLevel = c.audioLevel || 0;
            return;
        }
        // R2.12 - per-band frequency levels (24-element array). When present,
        // each vertex reads its own band. R7: no more static-frame skip -
        // the wobble phase advances every tick so the blob breathes even
        // over steady audio (the lerp keeps per-frame work trivial).
        var bands  = c.audioLevels;
        _lastVoiceRingLevel = lvlAvg;
        _lastVoiceRingState = st;
        var speaking = (st === 'speaking');
        var thinking = (st === 'thinking');
        var base  = speaking ? VOICE_RING_BASE_SPEAKING : VOICE_RING_BASE_IDLE;
        var gain  = speaking ? VOICE_RING_SPIKE_SPEAKING : VOICE_RING_GAIN_IDLE;
        // thinking gets a quicker, tighter churn - "working on it"
        _blobPhase += thinking ? 0.085 : (speaking ? 0.055 : 0.022);
        var ox = new Array(24), oy = new Array(24);
        var ix = new Array(24), iy = new Array(24);
        for (var i = 0; i < 24; i++) {
            var bandLvl = (bands && bands[i] !== undefined) ? bands[i] : lvlAvg;
            var target = base + bandLvl * VOICE_RING_MULTIPLIERS[i] * gain;
            // travelling wobble: two slow sine waves moving in opposite
            // directions give the liquid surface-tension look
            target += 2.2 * Math.sin(_blobPhase + i * 0.82)
                    + 1.3 * Math.sin(-_blobPhase * 1.7 + i * 0.35);
            if (target > VOICE_RING_DIST_MAX) target = VOICE_RING_DIST_MAX;
            // temporal smoothing - the blob flows toward the audio rather
            // than snapping to it
            _blobLevels[i] += (target - _blobLevels[i]) * 0.30;
            var dist = _blobLevels[i];
            if (!isFinite(dist)) { dist = base; _blobLevels[i] = base; }
            ox[i] = 60 + dist * VOICE_RING_SIN[i];
            oy[i] = 60 - dist * VOICE_RING_COS[i];
            // inner sheen: 78% radius, counter-phased wobble
            var di = dist * 0.78 + 1.5 * Math.sin(_blobPhase * 1.3 + i * 0.6 + 2.1);
            ix[i] = 60 + di * VOICE_RING_SIN[i];
            iy[i] = 60 - di * VOICE_RING_COS[i];
        }
        var dOuter = _smoothClosedPath(ox, oy);
        var dInner = _smoothClosedPath(ix, iy);
        // R7 - write straight to the DOM. The blob animates at 60fps from
        // its own rAF ticker; routing that through Angular bindings would
        // digest the whole scope every frame for zero benefit.
        if (!_blobOuterEl || !_blobOuterEl.isConnected) {
            _blobOuterEl  = document.querySelector('.netra-voice-blob-outer');
            _blobInnerEl  = document.querySelector('.netra-voice-blob-inner');
            _blobStrokeEl = document.querySelector('.netra-voice-blob-stroke');
        }
        if (_blobOuterEl)  _blobOuterEl.setAttribute('d', dOuter);
        if (_blobStrokeEl) _blobStrokeEl.setAttribute('d', dOuter);
        if (_blobInnerEl)  _blobInnerEl.setAttribute('d', dInner);
        // R8 - the Live stage renders its own big blob from the same paths
        if (c.liveMode) {
            if (!_stageOuterEl || !_stageOuterEl.isConnected) {
                _stageOuterEl = document.querySelector('.netra-stage-blob-outer');
                _stageInnerEl = document.querySelector('.netra-stage-blob-inner');
            }
            if (_stageOuterEl) _stageOuterEl.setAttribute('d', dOuter);
            if (_stageInnerEl) _stageInnerEl.setAttribute('d', dInner);
        }
        // R8.1 - prism hue engine + word-onset ripples ride the same ticker
        _prismTick();
        _maybeRipple();
        // R10 - raw audio for the 3D blob's displacement shader
        window.__netraBands = c.audioLevels || null;
        window.__netraLevel = c.audioLevel || 0;
    }
    var _stageOuterEl = null, _stageInnerEl = null;
    var _blobOuterEl = null, _blobInnerEl = null, _blobStrokeEl = null;
    var _blobRafId = null;
    function _startBlobTicker() {
        if (_blobRafId) return;
        var tick = function () {
            if (_ctrlDestroyed) { _blobRafId = null; return; }
            _recomputeVoiceRing();
            _blobRafId = requestAnimationFrame(tick);
        };
        _blobRafId = requestAnimationFrame(tick);
    }
    _recomputeVoiceRing();

    /* ============================================================
     *  R2.2 - VOICE TRAINING (personal vocab + aliases)
     *
     *  Chrome's Web Speech API can't be retrained directly, but we can:
     *  (1) Get top-5 alternatives per utterance (maxAlternatives=5)
     *  (2) Score each alternative against the user's personal vocab
     *      and pick the highest scorer instead of just the first
     *  (3) Pre-process the chosen text through an alias map to fix
     *      known mis-hearings ("net rah" -> "Netra", "agar" -> "Adam")
     *  (4) Auto-learn: every word in a successful command goes into
     *      vocab, so frequently-used names self-reinforce
     *  (5) Manual UI in dev panel to add words + map aliases
     * ============================================================ */
    c.personalVocab = {};      // { wordLower: { count, lastSeen } }
    c.aliases       = {};      // { mishearLower: intendedString }
    c.trainText      = '';
    c.aliasMisheard  = '';
    c.aliasIntended  = '';
    c.aliasList      = [];     // computed view for the dev panel
    c.vocabCount     = 0;
    c.aliasCount     = 0;

    // R2.3 - voice training lives in ServiceNow (Netra Context row).
    // The widget's initial data load (c.data.training) populates these
    // on boot from server truth, and we save back via a c.server.update()
    // round-trip with action='save_training'.
    function loadTrainingData() {
        try {
            // c.data is populated by the Service Portal widget framework
            // BEFORE the controller runs - so this is already there
            var t = (c.data && c.data.training) || null;
            var srvVocab   = (t && t.vocab)   || {};
            var srvAliases = (t && t.aliases) || {};
            // R2.3 migration: if server is empty but localStorage from R2.2
            // has data, lift it up to the server.
            var migrated = false;
            try {
                if (Object.keys(srvVocab).length === 0 && Object.keys(srvAliases).length === 0) {
                    var localVocab   = JSON.parse(localStorage.getItem('netra.vocab')   || '{}') || {};
                    var localAliases = JSON.parse(localStorage.getItem('netra.aliases') || '{}') || {};
                    if (Object.keys(localVocab).length || Object.keys(localAliases).length) {
                        srvVocab   = localVocab;
                        srvAliases = localAliases;
                        migrated = true;
                    }
                }
            } catch (e) {}
            c.personalVocab = srvVocab;
            c.aliases       = srvAliases;
            logEvent('train', 'loaded from ServiceNow: ' +
                     Object.keys(c.personalVocab).length + ' words, ' +
                     Object.keys(c.aliases).length       + ' aliases' +
                     (migrated ? ' (migrated from R2.2 localStorage)' : ''));
            if (migrated) {
                // Push the migrated data up to the server immediately so it
                // doesn't get lost, then wipe the local copy.
                $timeout(function () {
                    saveTrainingData();
                    try {
                        localStorage.removeItem('netra.vocab');
                        localStorage.removeItem('netra.aliases');
                    } catch (e) {}
                }, 1000);
            }
        } catch (e) {
            c.personalVocab = {}; c.aliases = {};
            logEvent('warn', 'loadTrainingData: ' + e.message);
        }
        _refreshTrainingViews();
    }
    var _saveDebounceTimer = null;
    var _saveInflight = false;
    function saveTrainingData() {
        if (_saveDebounceTimer) $timeout.cancel(_saveDebounceTimer);
        _saveDebounceTimer = $timeout(function () {
            _refreshTrainingViews();
            if (_saveInflight) {
                // another save already going - reschedule
                saveTrainingData();
                return;
            }
            _saveInflight = true;
            // Snapshot so we don't lose changes that happen during the round-trip
            var vocabSnap   = JSON.parse(JSON.stringify(c.personalVocab));
            var aliasesSnap = JSON.parse(JSON.stringify(c.aliases));
            c.data.action  = 'save_training';
            c.data.vocab   = vocabSnap;
            c.data.aliases = aliasesSnap;
            c.server.update().then(
                function () {
                    _saveInflight = false;
                    if (c.data && c.data.training_result && c.data.training_result.ok) {
                        logEvent('train', 'saved to ServiceNow: ' +
                                 c.data.training_result.vocab_count + ' words, ' +
                                 c.data.training_result.aliases_count + ' aliases');
                    } else {
                        logEvent('warn', 'save_training failed: ' +
                                 ((c.data && c.data.training_result && c.data.training_result.error) || 'unknown'));
                    }
                },
                function (err) {
                    _saveInflight = false;
                    logEvent('err', 'save_training transport error: ' + (err && err.message || err));
                }
            );
        }, 2500);   // 2.5s debounce so rapid edits coalesce
    }
    function _refreshTrainingViews() {
        c.vocabCount  = Object.keys(c.personalVocab).length;
        c.aliasCount  = Object.keys(c.aliases).length;
        var list = [];
        for (var k in c.aliases) {
            if (c.aliases.hasOwnProperty(k)) list.push({ misheard: k, intended: c.aliases[k] });
        }
        c.aliasList = list.slice(-8);   // last 8
        $scope.$applyAsync();
    }

    // Apply alias map to a transcript before sending to Gemini.
    function applyAliases(text) {
        if (!text) return text;
        var out = text;
        for (var misheard in c.aliases) {
            if (!c.aliases.hasOwnProperty(misheard)) continue;
            // Word-boundary case-insensitive replace
            var safe = misheard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                var re = new RegExp('\\b' + safe + '\\b', 'gi');
                out = out.replace(re, c.aliases[misheard]);
            } catch (e) {}
        }
        return out;
    }

    // Add every successful word to personal vocab (auto-learning).
    function learnFromTranscript(transcript) {
        if (!transcript) return;
        var words = transcript.toLowerCase().split(/[^a-z']+/);
        var dirty = false;
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (w.length < 3) continue;
            if (!c.personalVocab[w]) c.personalVocab[w] = { count: 0, lastSeen: 0 };
            c.personalVocab[w].count++;
            c.personalVocab[w].lastSeen = Date.now();
            dirty = true;
        }
        if (dirty) saveTrainingData();
    }

    // Score an alternative against personal vocab. Higher = better match.
    function _scoreAlternative(transcript, confidence) {
        var lc = (transcript || '').toLowerCase();
        var score = (confidence || 0) * 1.0;
        var words = lc.split(/\s+/);
        var hits = 0;
        for (var i = 0; i < words.length; i++) {
            var w = words[i].replace(/[^a-z']/g, '');
            if (w.length >= 3 && c.personalVocab[w]) {
                hits++;
                score += 0.12;   // each known word adds 0.12 score
            }
        }
        // Bonus if the entire utterance looks like a known alias key
        if (c.aliases[lc.trim()]) score += 0.30;
        return { score: score, vocabHits: hits };
    }

    // Pick the best of Chrome's top-5 alternatives based on vocab match.
    function pickBestAlternative(altObj) {
        // altObj is the SpeechRecognitionResult, alternatives accessible as altObj[i]
        if (!altObj || altObj.length === 0) return null;
        var best = { transcript: altObj[0].transcript, confidence: altObj[0].confidence || 0, vocabHits: 0 };
        var bestScore = _scoreAlternative(best.transcript, best.confidence).score;
        for (var i = 0; i < altObj.length && i < 5; i++) {
            var alt = altObj[i];
            var sc = _scoreAlternative(alt.transcript, alt.confidence || 0);
            if (sc.score > bestScore) {
                bestScore = sc.score;
                best = { transcript: alt.transcript, confidence: alt.confidence || 0, vocabHits: sc.vocabHits };
            }
        }
        return best;
    }

    // Dev UI handlers
    c.addTrainingWord = function () {
        var w = (c.trainText || '').toLowerCase().trim();
        if (!w) return;
        // Split phrases into words so each token is recognised
        w.split(/\s+/).forEach(function (token) {
            if (token.length < 2) return;
            c.personalVocab[token] = c.personalVocab[token] || { count: 0, lastSeen: 0 };
            c.personalVocab[token].count += 5;   // manual entries get a head-start
            c.personalVocab[token].lastSeen = Date.now();
        });
        c.trainText = '';
        saveTrainingData();
        // Re-attach grammar so the recognizer also gets it as a hint
        if (contRec) attachGrammar(contRec);
        logEvent('train', 'added word(s): ' + w);
    };
    c.addAlias = function () {
        var m = (c.aliasMisheard || '').toLowerCase().trim();
        var n = (c.aliasIntended || '').trim();
        if (!m || !n) return;
        c.aliases[m] = n;
        // Also add the intended phrase to vocab so future matches prefer it
        n.toLowerCase().split(/\s+/).forEach(function (token) {
            if (token.length < 2) return;
            c.personalVocab[token] = c.personalVocab[token] || { count: 0, lastSeen: 0 };
            c.personalVocab[token].count += 3;
            c.personalVocab[token].lastSeen = Date.now();
        });
        c.aliasMisheard = '';
        c.aliasIntended = '';
        saveTrainingData();
        if (contRec) attachGrammar(contRec);
        logEvent('train', 'alias: "' + m + '" -> "' + n + '"');
    };
    c.clearTraining = function () {
        if (!confirm('Clear all training data? This wipes the server-side copy too.')) return;
        c.personalVocab = {};
        c.aliases = {};
        _refreshTrainingViews();
        // Server-side wipe via dedicated action (faster than save with empty)
        c.data.action = 'clear_training';
        c.server.update().then(function () {
            logEvent('train', 'cleared all training (local + ServiceNow)');
        });
    };

    // Load on boot
    loadTrainingData();
    c.charts = {
        confSeries: [],   // numbers 0-100
        latSeries:  [],   // numbers (ms)
        confPath:   '',
        latPath:    '',
        toolCounts: {},   // name -> count
        toolBars:   [],
        toolTotal:  0
    };
    // R4.5 - destroyed flag gates all recursive watchdogs so they stop
    // rescheduling after $onDestroy. Without this, navigating between SP
    // pages leaves N parallel chains running in stale controllers.
    var _ctrlDestroyed = false;
    var _statsTickTimer = null;
    function _statsTick() {
        if (_ctrlDestroyed) return;
        var sec = Math.floor((Date.now() - BOOT_TIME) / 1000);
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        c.stats.uptimeLabel = (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
        $scope.$applyAsync();
        _statsTickTimer = $timeout(_statsTick, 1000);
    }
    _statsTickTimer = $timeout(_statsTick, 1000);

    // Build SVG polyline path from a number series
    function _seriesToPath(series, scale) {
        if (!series || !series.length) return '';
        var max = scale || Math.max.apply(null, series.concat([1]));
        var pts = [];
        for (var i = 0; i < series.length; i++) {
            var x = (i / Math.max(1, series.length - 1)) * 200;
            var y = 48 - (series[i] / max) * 44;
            pts.push(x.toFixed(1) + ',' + y.toFixed(1));
        }
        return pts.join(' ');
    }
    function _pushConfidence(conf) {
        if (typeof conf !== 'number' || !isFinite(conf)) return;
        var v = Math.round(conf * 100);
        c.charts.confSeries.push(v);
        if (c.charts.confSeries.length > 30) c.charts.confSeries.shift();
        c.charts.confPath = _seriesToPath(c.charts.confSeries, 100);
        // R2.8 - graph numbers
        c.charts.confLast = v;
        c.charts.confMin  = Math.min.apply(null, c.charts.confSeries);
        c.charts.confMax  = Math.max.apply(null, c.charts.confSeries);
    }
    function _pushLatency(ms) {
        if (typeof ms !== 'number' || !isFinite(ms)) return;
        var v = Math.round(ms);
        c.charts.latSeries.push(v);
        if (c.charts.latSeries.length > 30) c.charts.latSeries.shift();
        c.charts.latPath = _seriesToPath(c.charts.latSeries);
        // R2.8 - graph numbers
        c.charts.latLast = v;
        c.charts.latMin  = Math.min.apply(null, c.charts.latSeries);
        c.charts.latMax  = Math.max.apply(null, c.charts.latSeries);
        var sum = 0;
        for (var i = 0; i < c.charts.latSeries.length; i++) sum += c.charts.latSeries[i];
        c.charts.latAvg  = Math.round(sum / c.charts.latSeries.length);
    }
    function _countTool(name) {
        c.charts.toolCounts[name] = (c.charts.toolCounts[name] || 0) + 1;
        c.charts.toolTotal = 0;
        var rows = [];
        for (var k in c.charts.toolCounts) {
            if (c.charts.toolCounts.hasOwnProperty(k)) {
                rows.push({ name: k, count: c.charts.toolCounts[k] });
                c.charts.toolTotal += c.charts.toolCounts[k];
            }
        }
        rows.sort(function (a, b) { return b.count - a.count; });
        var top = rows[0] ? rows[0].count : 1;
        rows.forEach(function (r) { r.pct = Math.round((r.count / top) * 100); });
        c.charts.toolBars = rows;
    }

    var STATE_LABEL = {
        idle:      'alert - listening for "Netra"',
        awaiting:  'just heard wake word, listening for your command',
        thinking:  'thinking',
        speaking:  'speaking',
        dormant:   'asleep - say "Netra" or "Netra wake up" to resume',
        error:     'error - check the event log',
        boot:      'getting ready'
    };

    /* ============================================================
     *  ENGINES
     * ============================================================ */
    var SR     = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var SGL    = $window.SpeechGrammarList || $window.webkitSpeechGrammarList;
    var TTS    = $window.speechSynthesis;
    c.hasSR    = !!SR;
    c.hasTTS   = !!TTS;
    var audioCtx = null;

    var contRec     = null;
    var pollTimer   = null;
    var seenIds     = {};
    var geminiHistory = [];
    var booted      = false;
    var lastReply   = '';
    var forcedVoiceName = '';
    var ignoreFinalsUntil = 0;
    var commandMode = false;
    var commandTimer = null;
    var conversationTimer = null;
    var currentAudio = null;        // remote TTS audio element

    /* ----- conversation window -----
     * In ALWAYS_LISTEN mode (v12) the window opens at boot and stays open
     * until the user says "stop listening". No 20s timeout.
     */
    function openConversation(reason) {
        c.conversationOpen = true;
        if (conversationTimer) { $timeout.cancel(conversationTimer); conversationTimer = null; }
        // ALWAYS_LISTEN: never time out
        logEvent('conv', 'open' + (reason ? ' (' + reason + ')' : '') + ' - just speak, no wake word needed');
        $scope.$applyAsync();
    }
    function closeConversation() {
        c.conversationOpen = false;
        if (conversationTimer) { $timeout.cancel(conversationTimer); conversationTimer = null; }
        $scope.$applyAsync();
    }

    /* ============================================================
     *  FUZZY WAKE WORD - the gallery
     *
     *  Three layers:
     *    1. WAKE_WORDS - 60+ exact-match variants for "Netra"
     *    2. Salutation prefix - "hey/ok/hi/hello/yo + <netra-variant>"
     *    3. Levenshtein <=1 for n-/m- starting words length 4-8
     *
     *  The recognizer also gets these as grammar hints (see
     *  attachGrammar) so it's biased to produce these spellings
     *  in the first place.
     * ============================================================ */
    var WAKE_WORDS = [
        // direct
        'netra','neetra','naitra','naytra','naetra','neetraa','netraa','netaa','netraah',
        // vowel variations
        'nitra','natra','neatra','neutra','noitra','nutra','natraa','neitra','noetra',
        // soft consonant (Hindi dh/th influence)
        'nedra','netha','nethra','nedhra','nettra','neddra','nethraa','nadhra',
        // n -> m confusion
        'metra','mehra','mantra','mitra','meera','maitra','matra','meetra','mintra','metraa',
        // missing r
        'neta','neeta','naita','natta','natha','meetha',
        // h-insertion
        'nehtra','nahtra','nehra','nahatra','nehatra','nahetra','nehraa',
        // common ASR mishearings of "netra"
        'centra','intra','netwra','nektra','nyatra','neyatra','nair','knee','near','nitra',
        // pronunciations with additional letters
        'naeetra','natera','neetaa','naitraa','naytraa','netraaa',
        // n+long vowel
        'nidra','niddra','nidhra','nidhraa','neidra','needra',
        // sometimes recognized as Indian names
        'neha','nira','neeraj','natraj','nitrah','neeti','niti'
    ];
    // Words that, before a Netra-variant, are salutations not commands
    var SALUTATION_PREFIXES = ['hey','ok','okay','hi','hello','yo','listen','dear','arre','arrey','accha','acha'];

    function levenshtein(a, b) {
        if (a === b) return 0;
        var la = a.length, lb = b.length;
        if (!la) return lb;
        if (!lb) return la;
        var prev = new Array(lb + 1);
        var curr = new Array(lb + 1);
        for (var j = 0; j <= lb; j++) prev[j] = j;
        for (var i = 1; i <= la; i++) {
            curr[0] = i;
            for (var j = 1; j <= lb; j++) {
                var cost = a.charAt(i-1) === b.charAt(j-1) ? 0 : 1;
                curr[j] = Math.min(curr[j-1] + 1, prev[j] + 1, prev[j-1] + cost);
            }
            var tmp = prev; prev = curr; curr = tmp;
        }
        return prev[lb];
    }

    function isWakeWord(w) {
        if (!w || w.length < 3) return false;
        var lw = w.toLowerCase();
        if (WAKE_WORDS.indexOf(lw) >= 0) return true;
        // Levenshtein-1 fallback for n-/m-/ne-/me- starting words 4-8 chars
        if (/^[nm][aeiouhy]/.test(lw) && lw.length >= 4 && lw.length <= 8) {
            if (levenshtein(lw, 'netra') <= 1) return true;
            if (levenshtein(lw, 'neetra') <= 1) return true;
            if (levenshtein(lw, 'mitra') <= 1) return true;
            if (levenshtein(lw, 'nidra') <= 1) return true;
        }
        return false;
    }

    function matchesWake(text) {
        if (!text) return null;
        var words = text.toLowerCase().split(/[\s,\.!?;:\-]+/).filter(Boolean);
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            // direct hit
            if (isWakeWord(w)) {
                // skip a leading salutation if it appeared just before
                return words.slice(i + 1).join(' ').trim();
            }
            // "hey netra" / "ok netra" - check pairs
            if (SALUTATION_PREFIXES.indexOf(w) >= 0 && i + 1 < words.length && isWakeWord(words[i + 1])) {
                return words.slice(i + 2).join(' ').trim();
            }
        }
        return null;
    }

    /* ============================================================
     *  VOICE COMMANDS (sleep / wake)
     * ============================================================ */
    function matchSleep(s) {
        if (!s) return false;
        return /\b(stop listening|go to sleep|sleep mode|sleep now|pause listening|be quiet|stop now|that['s ]?s all|go away|goodbye|good night)\b/i.test(s)
            || /^stop$/i.test(s.trim());
    }
    function matchExplicitWakeUp(s) {
        if (!s) return false;
        // Used in dormant mode. Even a bare "Netra" should wake.
        // We rely on matchesWake which is already permissive.
        return matchesWake(s) !== null;
    }

    /* ============================================================
     *  LOCAL INTENT SHORTCUTS  (free, no API call)
     * ============================================================ */
    function matchLocal(s) {
        if (!s) return null;
        var lc = s.toLowerCase().trim();

        // R2.2 - voice-correction: "no, I meant X" / "I said X" / "the word is X"
        // Auto-learn an alias from the previously-heard transcript to X.
        var corrMatch = lc.match(/^(?:no,?\s+)?(?:i\s+(?:said|meant)|the\s+word\s+is)\s+(.+)$/i);
        if (corrMatch) {
            var intended = corrMatch[1].trim();
            var misheard = (c.lastHeard || '').toLowerCase().trim();
            if (misheard && intended && misheard !== intended.toLowerCase()) {
                c.aliases[misheard] = intended;
                intended.toLowerCase().split(/\s+/).forEach(function (tk) {
                    if (tk.length < 2) return;
                    c.personalVocab[tk] = c.personalVocab[tk] || { count: 0, lastSeen: 0 };
                    c.personalVocab[tk].count += 3;
                    c.personalVocab[tk].lastSeen = Date.now();
                });
                saveTrainingData();
                if (contRec) attachGrammar(contRec);
                return { intent: 'correction',
                         reply: 'Noted — I will hear "' + intended + '" from now on.' };
            }
        }

        // greetings (English + Indian)
        if (/^(hi|hello|hey|hiya|namaste|namaskar|salaam|salam|good\s*(morning|afternoon|evening|day)|shubh\s*prabhat|shubh\s*ratri)\b/.test(lc) && lc.length < 40) {
            var h = new Date().getHours();
            var greet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
            return { intent: 'greet', reply: greet + ', how may I help you today?' };
        }
        // thanks
        if (/\b(thanks|thank you|thanks a lot|much appreciated|dhanyavaad|shukriya|thank ya)\b/.test(lc) && lc.length < 40) {
            return { intent: 'thanks', reply: 'You are most welcome. Do let me know if anything else is required.' };
        }
        // farewell (no sleep)
        if (/^(bye|goodbye|see you|see ya|catch you later|alvida)$/i.test(lc.replace(/[!.,]/g,''))) {
            return { intent: 'bye', reply: 'Goodbye. I will be here whenever you need me.' };
        }
        // identity
        if (/\b(who are you|what are you|your name|introduce yourself|tell me about yourself|aap kaun ho)\b/.test(lc)) {
            return { intent: 'identity', reply: 'I am Netra, your voice assistant for ServiceNow. I can open tickets, list your open issues, resolve them, search the knowledge base, and handle approvals - all by voice.' };
        }
        // capabilities / help
        if (/\b(what can you do|help me|your capabilities|commands|what do you do|how to use|how can i use)\b/.test(lc)) {
            return { intent: 'help', reply: 'You can ask me things like: open a ticket about my VPN, list my open tickets, resolve I N C zero zero zero one two three four, what are my pending approvals, search knowledge for password reset. Just speak naturally.' };
        }
        // time
        if (/\b(what(\s+is|\'s)?(\s+the)?\s+(current\s+)?time|tell\s+me\s+the\s+time|current\s+time|samay\s+kya\s+hai)\b/.test(lc)) {
            var t = new Date();
            var hh = t.getHours(), mm = t.getMinutes();
            var ampm = hh < 12 ? 'A M' : 'P M';
            var h12 = hh % 12; if (h12 === 0) h12 = 12;
            return { intent: 'time', reply: 'The time is ' + h12 + ' ' + (mm < 10 ? 'oh ' + mm : mm) + ' ' + ampm + '.' };
        }
        // date
        if (/\b(what(\s+is|\'s)?(\s+the|today\'?s)?\s+date|today\'?s\s+date|what day is|aaj\s+kya\s+tareekh|tareekh)\b/.test(lc)) {
            var d = new Date();
            var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            return { intent: 'date', reply: 'Today is ' + days[d.getDay()] + ', the ' + d.getDate() + 'th of ' + months[d.getMonth()] + '.' };
        }
        // small talk
        if (/\b(how are you|how\'?s it going|how do you do|kaise ho|kya haal|sab theek|kaisa hai)\b/.test(lc)) {
            return { intent: 'smalltalk', reply: 'I am doing well, thank you for asking. Ready to help whenever you are.' };
        }
        // affirmations - skip server roundtrip
        if (/^(ok|okay|alright|fine|cool|got it|understood|theek hai|haan|haanji|yes)\.?\s*$/i.test(lc) && lc.length < 15) {
            return { intent: 'ack', reply: 'Anything else I can do?' };
        }
        // joke / fun
        if (/\b(tell me a joke|crack a joke|make me laugh|joke please)\b/.test(lc)) {
            return { intent: 'joke', reply: 'Why did the developer go broke? Because he used up all his cache. Anything else?' };
        }
        // version
        if (/\b(version|build|which version|kaunsa version)\b/.test(lc)) {
            return { intent: 'version', reply: 'I am running Netra version nine, with always-on listening and Indian English voice.' };
        }
        // R2.9.1 - repeat / say again
        if (/^(repeat|repeat that|say (it|that) again|come again|once more|kya bola)\.?$/i.test(lc)) {
            return { intent: 'repeat', reply: c.lastSpoken || 'I have not said anything yet.' };
        }
        // R2.9.1 - "where am I" - return current Service Portal route
        if (/\b(where am i|which page|what page|current page|kahaan hoon)\b/.test(lc)) {
            var pageId = '';
            try {
                var qp = new URLSearchParams(window.location.search);
                pageId = qp.get('id') || 'index';
            } catch (e) { pageId = 'unknown'; }
            return { intent: 'where', reply: 'You are on the ' + pageId.replace(/_/g,' ') + ' page of the Service Portal.' };
        }
        // R2.9.1 - quiet / silence (without sleeping)
        if (/^(quiet|silence|hush|be quiet|chup|chup ho)\.?$/i.test(lc)) {
            return { intent: 'quiet', reply: 'Of course. I will stay silent until you speak to me again.' };
        }
        // R2.9.1 - speed up / slow down playback
        if (/\b(speak (faster|quicker)|talk faster|hurry up|jaldi)\b/.test(lc)) {
            return { intent: 'pace', reply: 'I will speak a bit quicker from now on.' };
        }
        if (/\b(speak (slower|slowly)|talk slower|slow down|dheere)\b/.test(lc)) {
            return { intent: 'pace', reply: 'I will slow down a touch.' };
        }
        // R2.9.1 - acknowledgement variants
        if (/^(cool|nice|great|awesome|perfect|wonderful|bahut khoob|wah)\.?$/i.test(lc) && lc.length < 25) {
            return { intent: 'praise', reply: 'Thank you. Happy to help.' };
        }
        // R2.10 - conversational repair: rewind / undo last
        if (/^(scratch that|forget that|undo( that)?|rewind|go back|cancel that|never mind|chod do)\.?$/i.test(lc)) {
            return { intent: 'rewind', _action: 'rewind_mem',
                     reply: 'Undone. We are back to before that. What would you like to do?' };
        }
        return null;
    }

    /* ============================================================
     *  SPOKEN NUMBER NORMALIZATION
     *  "I N C zero zero zero one two three four" -> "INC0001234"
     * ============================================================ */
    function normalizeNumbers(s) {
        if (!s) return s;
        var out = ' ' + s + ' ';

        // spoken digits to digits
        var digitMap = {
            zero:'0', oh:'0', 'o':'0',
            one:'1', two:'2', three:'3', four:'4', five:'5',
            six:'6', seven:'7', eight:'8', nine:'9',
            ten:'10', eleven:'11', twelve:'12',
            'double zero':'00', 'triple zero':'000'
        };
        Object.keys(digitMap).forEach(function (w) {
            var re = new RegExp('\\b' + w + '\\b', 'gi');
            out = out.replace(re, digitMap[w]);
        });

        // ServiceNow prefixes spoken letter-by-letter
        out = out.replace(/\b[iI][\s.,]+[nN][\s.,]+[cC]\b/g, 'INC');
        out = out.replace(/\b[cC][\s.,]+[hH][\s.,]+[gG]\b/g, 'CHG');
        out = out.replace(/\b[rR][\s.,]+[iI][\s.,]+[tT][\s.,]+[mM]\b/g, 'RITM');
        out = out.replace(/\b[sS][\s.,]+[cC][\s.,]+[tT][\s.,]+[aA][\s.,]+[sS][\s.,]+[kK]\b/g, 'SCTASK');
        out = out.replace(/\b[pP][\s.,]+[rR][\s.,]+[bB]\b/g, 'PRB');
        out = out.replace(/\b[kK][\s.,]+[bB]\b/g, 'KB');
        // R5 - Vulnerability Response prefixes spoken letter-by-letter
        out = out.replace(/\b[vV][\s.,]+[iI][\s.,]+[tT]\b/g, 'VIT');
        out = out.replace(/\b[cC][\s.,]+[vV][\s.,]+[eE]\b/g, 'CVE');

        // common misheard prefixes
        out = out.replace(/\bink\b/gi, 'INC');
        out = out.replace(/\bI\s*and\s*C\b/gi, 'INC');

        // R3.6 - English-word -> ServiceNow prefix mapping (was missing)
        //   "incident 8001"   -> "INC0008001"
        //   "change 8001"     -> "CHG0008001"
        //   "problem 8001"    -> "PRB0008001"
        //   "request 8001"    -> "REQ0008001"
        //   "task 8001"       -> "TASK0008001"
        //   "knowledge 8001"  -> "KB0008001"
        out = out.replace(/\bincident\s+(\d+)\b/gi, function(_,d){return 'INC' + d;});
        out = out.replace(/\bchange\s+(?:request\s+)?(\d+)\b/gi, function(_,d){return 'CHG' + d;});
        out = out.replace(/\bproblem\s+(\d+)\b/gi, function(_,d){return 'PRB' + d;});
        out = out.replace(/\brequest\s+(\d+)\b/gi, function(_,d){return 'REQ' + d;});
        out = out.replace(/\b(?:knowledge|article|kbase)\s+(\d+)\b/gi, function(_,d){return 'KB' + d;});
        // R5 - "vulnerable item 2345" / "vit 2345" -> VIT0002345
        out = out.replace(/\b(?:vulnerable\s+item|vulnerability\s+item|vit)\s+(\d+)\b/gi, function(_,d){return 'VIT' + d;});

        // coalesce PREFIX + digits possibly separated by spaces
        out = out.replace(/\b(INC|CHG|RITM|SCTASK|PRB|KB|REQ|TASK|VIT)\s*([\d\s]+)/g, function (_, prefix, digits) {
            var cleaned = digits.replace(/\s+/g,'');
            // pad to 7 digits for ticket-like prefixes
            if (cleaned.length > 0 && cleaned.length < 7 && /^(INC|CHG|RITM|SCTASK|PRB|REQ|TASK|VIT)$/.test(prefix)) {
                while (cleaned.length < 7) cleaned = '0' + cleaned;
            }
            return prefix + cleaned;
        });

        // R5 - CVE identifiers: "CVE 2021 44228" / "cve-2021-44228" -> CVE-2021-44228
        out = out.replace(/\bCVE[\s\-.]*(\d{4})[\s\-.]+(\d{3,7})\b/gi, function (_, y, n) {
            return 'CVE-' + y + '-' + n;
        });

        return out.trim();
    }

    /* ============================================================
     *  LOGGING
     * ============================================================ */
    function logEvent(level, msg) {
        var d = new Date();
        var ts = String(d.getHours()).padStart(2,'0') + ':' +
                 String(d.getMinutes()).padStart(2,'0') + ':' +
                 String(d.getSeconds()).padStart(2,'0');
        c.events.unshift({ t: ts, l: level, m: String(msg) });
        if (c.events.length > 120) c.events.length = 120;
        if ($window.console && $window.console.log) {
            $window.console.log('[Netra ' + level + '] ' + msg);
        }
        $scope.$applyAsync();
    }

    /* ============================================================
     *  R3.3 - PWA installer. Injects a web manifest + apple-touch-icon
     *  so iOS Safari and Android Chrome treat the Service Portal as
     *  an installable app. Icon is fetched from a ServiceNow
     *  sys_attachment (no base64 bloat in client.js).
     * ============================================================ */
    // R4.2 - manifest URLs MUST be absolute. The manifest is served from
    // a blob: URL whose origin is opaque, so relative paths like
    // "/sp?id=index" cannot resolve and the browser drops them silently
    // (log line "Manifest: property 'start_url' ignored, URL is invalid").
    // Build all URLs against window.location.origin.
    var _PWA_ORIGIN   = (window.location.origin || '');
    // R5 - refreshed to the on-brand violet Netra app-tile (green iris + violet voice-ring)
    var PWA_ICON_URL  = _PWA_ORIGIN + '/sys_attachment.do?sys_id=81b10af0930ecb10e3aef0aefaba1073';
    var PWA_BADGE_URL = _PWA_ORIGIN + '/sys_attachment.do?sys_id=edb1c634930ecb10e3aef0aefaba10de';
    // R5 - self-contained browser favicon (the Service Portal tab otherwise
    // shows the generic ServiceNow globe). Inline SVG data URI, no attachment
    // dependency: the violet voice-ring + green Netra eye, matching the orb.
    function _installFavicon() {
        try {
            // R8.1 - prism favicon: iridescent full-spectrum ring around the eye
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
                '<defs>' +
                '<radialGradient id="fi" cx="38%" cy="34%" r="66%">' +
                '<stop offset="0%" stop-color="#f4ecff"/><stop offset="18%" stop-color="#c7a6ff"/>' +
                '<stop offset="55%" stop-color="#7a3df0"/><stop offset="100%" stop-color="#12041f"/>' +
                '</radialGradient>' +
                '<linearGradient id="fr" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0%" stop-color="#37e6a8"/><stop offset="30%" stop-color="#41c6ff"/>' +
                '<stop offset="55%" stop-color="#c660ff"/><stop offset="78%" stop-color="#ffb84d"/>' +
                '<stop offset="100%" stop-color="#ff5f9e"/>' +
                '</linearGradient>' +
                '<radialGradient id="fg" cx="50%" cy="50%" r="50%">' +
                '<stop offset="55%" stop-color="rgba(140,80,255,0)"/>' +
                '<stop offset="100%" stop-color="rgba(140,80,255,0.35)"/>' +
                '</radialGradient></defs>' +
                '<rect width="64" height="64" rx="15" fill="#0b0416"/>' +
                '<rect width="64" height="64" rx="15" fill="url(#fg)"/>' +
                '<g fill="none" stroke="url(#fr)" stroke-width="3.4" stroke-linecap="round" opacity="0.95">' +
                '<path d="M12 32 A20 20 0 0 1 32 12"/><path d="M52 32 A20 20 0 0 1 32 52"/></g>' +
                '<path d="M14 32 Q32 16 50 32 Q32 48 14 32 Z" fill="#0a0614" stroke="#d8c8ff" stroke-width="2.4" stroke-linejoin="round"/>' +
                '<circle cx="32" cy="32" r="11.5" fill="url(#fi)"/>' +
                '<circle cx="32" cy="32" r="4.6" fill="#07001a"/>' +
                '<circle cx="28.5" cy="28.5" r="1.9" fill="#fff" opacity="0.9"/></svg>';
            var href = 'data:image/svg+xml,' + encodeURIComponent(svg);
            var prior = document.querySelectorAll('link[rel~="icon"], link[data-netra-fav]');
            for (var i = 0; i < prior.length; i++) prior[i].parentNode.removeChild(prior[i]);
            var link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            link.href = href;
            link.setAttribute('data-netra-fav', '1');
            document.head.appendChild(link);
        } catch (e) {
            logEvent('pwa', 'favicon install failed: ' + (e && e.message ? e.message : e));
        }
    }

    function _installPWA() {
        try {
            if (document.querySelector('link[data-netra-pwa]')) return;
            var manifest = {
                name: 'Netra - Voice for ServiceNow',
                short_name: 'Netra',
                description: 'Voice-first ServiceNow assistant for blind and low-vision users.',
                start_url: _PWA_ORIGIN + '/sp?id=index',
                scope: _PWA_ORIGIN + '/sp',
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#0a0a14',
                theme_color: '#b48af0',
                lang: 'en-IN',
                categories: ['productivity', 'business', 'accessibility'],
                icons: [
                    { src: PWA_ICON_URL,  sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
                    { src: PWA_BADGE_URL, sizes: '192x192', type: 'image/png', purpose: 'any' }
                ]
            };
            var blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
            var manifestUrl = URL.createObjectURL(blob);
            var link = document.createElement('link');
            link.rel  = 'manifest';
            link.href = manifestUrl;
            link.setAttribute('data-netra-pwa', '1');
            document.head.appendChild(link);

            // iOS Safari respects apple-touch-icon + apple-mobile-web-app-* meta tags
            var apple = document.createElement('link');
            apple.rel  = 'apple-touch-icon';
            apple.href = PWA_ICON_URL;
            apple.setAttribute('data-netra-pwa', '1');
            document.head.appendChild(apple);

            var metas = [
                ['apple-mobile-web-app-capable', 'yes'],
                ['apple-mobile-web-app-status-bar-style', 'black-translucent'],
                ['apple-mobile-web-app-title', 'Netra'],
                ['theme-color', '#b48af0'],
                ['mobile-web-app-capable', 'yes']
            ];
            metas.forEach(function (pair) {
                var m = document.createElement('meta');
                m.name    = pair[0];
                m.content = pair[1];
                m.setAttribute('data-netra-pwa', '1');
                document.head.appendChild(m);
            });

            logEvent('pwa', 'manifest injected via blob URL; icon=' + PWA_ICON_URL);
        } catch (e) {
            logEvent('pwa', 'install failed: ' + (e && e.message ? e.message : e));
        }
    }

    /* ============================================================
     *  LIFECYCLE
     * ============================================================ */
    c.$onInit = function () {
        setState('boot');
        logEvent('init', 'controller v8 booting, SR=' + c.hasSR + ' TTS=' + c.hasTTS + ' GrammarList=' + !!SGL);
        _installFavicon();
        _installPWA();

        if (c.hasTTS) {
            TTS.getVoices();
            try {
                TTS.addEventListener('voiceschanged', function () {
                    populateVoices();
                    pickFemaleVoice();
                });
            } catch (e) {}
        }

        checkMicPermission();
        bindHotkeys();
        $timeout(populateVoices, 400);
        $timeout(populateVoices, 1500);
        $timeout(tryBoot, 600);
        $timeout(startMicLevelMeter, 1000);   // R1.2 - mic-level live VU
        $timeout(preloadFillers, 2500);       // R1.6 - thinking-cue cache
        $timeout(preloadBackchannels, 3600);  // R6 - listener acknowledgements
        _startBlobTicker();                   // R7 - liquid aura animation
    };

    c.$onDestroy = function () {
        // R4.5 - mark destroyed so recursive watchdogs stop rescheduling.
        // The _ctrlDestroyed flag is checked at the top of _statsTick,
        // _srActivityWatchdog, __micHealthTick, and the listening tick.
        _ctrlDestroyed = true;
        c.recRunning = false;
        try { if (contRec) contRec.stop(); } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (commandTimer) $timeout.cancel(commandTimer);
        if (_statsTickTimer) $timeout.cancel(_statsTickTimer);
        try { stopFillerChain(); } catch (e) {}
        try { stopMicLevelMeter(); } catch (e) {}
        if (TTS) TTS.cancel();
        if (audioCtx) try { audioCtx.close(); } catch (e) {}
    };

    function checkMicPermission() {
        try {
            if ($window.navigator && $window.navigator.permissions && $window.navigator.permissions.query) {
                $window.navigator.permissions.query({ name: 'microphone' }).then(function (p) {
                    c.permission = p.state;
                    logEvent('perm', 'mic permission = ' + p.state);
                    $scope.$applyAsync();
                    p.onchange = function () {
                        c.permission = p.state;
                        logEvent('perm', 'mic permission changed to ' + p.state);
                        $scope.$applyAsync();
                    };
                }, function () {
                    c.permission = '(query unsupported)';
                });
            } else {
                c.permission = '(no permissions API)';
            }
        } catch (e) {
            c.permission = '(error)';
        }
    }

    /* ============================================================
     *  R1.2 - LIVE MIC LEVEL METER + TEST MIC RECORDER
     *
     *  Uses getUserMedia + Web Audio API to compute a real-time
     *  RMS level (0-100) shown in the dev panel. This DEFINITIVELY
     *  tells the user if audio is reaching the browser.
     *
     *  Separate from SpeechRecognition - so even if SpeechRec is
     *  silently dead, the level meter still works.
     * ============================================================ */
    c.micLevel = 0;         // 0-100, smoothed
    c.micLevelPeak = 0;     // session peak
    c.micStreamActive = false;
    var _micStream = null;
    var _micAnalyser = null;
    var _micCtx = null;
    var _micRafId = null;

    function startMicLevelMeter() {
        if (_micStream) return;   // already running
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            logEvent('warn', 'mic-meter: getUserMedia not supported');
            return;
        }
        // R3.5 - autoGainControl=true. The previous off-by-default caused
        // quiet mics (Bluetooth headsets, laptop integrated mics at arm's
        // length) to produce audioLevel ~2/100, which then fell below the
        // noise gate AND was too soft for SpeechRecognition. AGC on lets
        // Chrome auto-boost quiet inputs. The earlier R2.7 attenuation
        // concern only applied to loud mics over long sessions; quiet
        // inputs are unaffected. Combined with the +6dB GainNode below
        // we now boost analysis ~2x even before AGC kicks in.
        navigator.mediaDevices.getUserMedia({ audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            channelCount: 1, sampleRate: 48000
        } }).then(function (stream) {
            _micStream = stream;
            c.micStreamActive = true;
            $scope.$applyAsync();
            _micCtx = new (window.AudioContext || window.webkitAudioContext)();
            var source = _micCtx.createMediaStreamSource(stream);
            // R3.5.1 - GainNode set to 1.0 (no extra boost). AGC already
            // normalises the stream; doubling on top made the ring dance
            // for ambient room noise. The mic stream itself stays clean
            // for SpeechRecognition; we only boost if AGC is OFF later.
            var gainNode = _micCtx.createGain();
            gainNode.gain.value = c.micGain || 1.0;   // R9 - mic sensitivity slider
            _micGainNode = gainNode;
            _micAnalyser = _micCtx.createAnalyser();
            _micAnalyser.fftSize = 1024;
            _micAnalyser.smoothingTimeConstant = 0.75;   // R3.5.1 - 0.5 -> 0.75 damp brief noise transients
            source.connect(gainNode);
            gainNode.connect(_micAnalyser);
            var data = new Uint8Array(_micAnalyser.frequencyBinCount);

            var lastMicLevel = -1;
            var freqData = new Uint8Array(_micAnalyser.frequencyBinCount);   // R2.12.2
            var loop = function () {
                // R2.12.2 - run BOTH passes per frame:
                //  1. time-domain RMS  -> mic-level meter (single 0..100)
                //  2. frequency-domain -> 24-band ripple on the voice ring
                _micAnalyser.getByteTimeDomainData(data);
                var sum = 0;
                for (var i = 0; i < data.length; i++) {
                    var vv = (data[i] - 128) / 128;
                    sum += vv * vv;
                }
                var rms = Math.sqrt(sum / data.length);
                var level = Math.min(100, Math.round(rms * 360));   // R3.5.1 - back to 360 (500 amplified noise floor)

                if (level !== lastMicLevel) {
                    lastMicLevel = level;
                    c.micLevel = level;
                    if (level > c.micLevelPeak) c.micLevelPeak = level;
                    // R8.2 - prosody sampling while the user holds a turn
                    if (_prosFirstAt && c.interim) {
                        _prosSum += level; _prosN++;
                        if (level > _prosPeak) _prosPeak = level;
                    }
                    if (c.state !== 'speaking') {
                        c.audioLevel = level;
                        // R2.12.4 - NOISE GATE.  Below the threshold, snap the
                        // ring back to a smooth idle circle (no bands data ->
                        // _recomputeVoiceRing uses the single audioLevel=0).
                        // Otherwise persistent ambient hum produces stuck
                        // spikes that never decay.
                        if (level < 8) {   // R3.5.1 - 2 -> 8, damp ambient/typing noise
                            c.audioLevels = null;
                            _setOrbPulse(0);
                        } else {
                            // Real signal — run the FFT band pass
                            _micAnalyser.getByteFrequencyData(freqData);
                            var bands = new Array(24);
                            for (var b = 0; b < 24; b++) {
                                var lo = VOICE_RING_BAND_BOUNDS[b];
                                var hi = VOICE_RING_BAND_BOUNDS[b + 1];
                                if (hi <= lo) hi = lo + 1;
                                var s2 = 0, n2 = 0;
                                for (var k = lo; k < hi && k < freqData.length; k++) { s2 += freqData[k]; n2++; }
                                var raw = n2 ? (s2 / n2) / 255 * 260 : 0;
                                // R2.12.4 - per-band noise gate: kill quiet
                                // frequencies so ambient room tone doesn't
                                // create visible jitter.
                                bands[b] = (raw < 18) ? 0 : Math.min(100, raw);   // R3.5.1 - 6 -> 18, kill jitter from ambient bands
                            }
                            c.audioLevels = bands;
                            _setOrbPulse(((bands[0] + bands[1] + bands[2]) / 3) / 100);
                        }
                        // R7 - blob redraw handled by its own rAF ticker
                    }
                    $scope.$applyAsync();
                }
                // R8.1 - Netra Lab spectrum scope rides the same rAF loop
                if (c.labOn) {
                    _micAnalyser.getByteFrequencyData(freqData);
                    _labDrawScope(freqData, level);
                }
                _micRafId = requestAnimationFrame(loop);
            };
            loop();
            logEvent('mic', 'live level meter started (audio is flowing)');

            // R2.7 - mic-stream health watchdog. Every 20s check:
            //  1. AudioContext is not suspended (Chrome auto-suspends in
            //     background tabs; resume() unsuspends).
            //  2. The MediaStream track is still live. If "ended" or
            //     "muted", tear down and re-acquire.
            var __micHealthTick = function () {
                if (_ctrlDestroyed) return;   // R4.5
                try {
                    if (_micCtx && _micCtx.state === 'suspended') {
                        logEvent('mic', 'AudioContext was suspended - resuming');
                        _micCtx.resume();
                    }
                    var tracks = _micStream ? _micStream.getAudioTracks() : [];
                    var live = tracks.filter(function (t) { return t.readyState === 'live' && !t.muted; });
                    if (tracks.length && !live.length) {
                        logEvent('warn', 'mic stream tracks died - reacquiring');
                        try { stopMicLevelMeter(); } catch (e) {}
                        $timeout(startMicLevelMeter, 500);
                        return;   // dont reschedule; new instance will
                    }
                } catch (eH) { logEvent('warn', 'mic health: ' + eH.message); }
                $timeout(__micHealthTick, 20000);
            };
            $timeout(__micHealthTick, 20000);
        }, function (err) {
            logEvent('err', 'mic-meter getUserMedia failed: ' + (err && err.name) + ' ' + (err && err.message));
            c.micStreamActive = false;
            $scope.$applyAsync();
        });
    }

    function stopMicLevelMeter() {
        if (_micRafId) cancelAnimationFrame(_micRafId);
        if (_micStream) _micStream.getTracks().forEach(function (t) { t.stop(); });
        if (_micCtx) try { _micCtx.close(); } catch (e) {}
        _micStream = null;
        _micCtx = null;
        _micAnalyser = null;
        c.micStreamActive = false;
    }

    // Test Mic: records 3 sec via MediaRecorder, plays it back via <audio>.
    // This proves to the user beyond any doubt that the mic is reaching the
    // browser. If they can hear themselves, the mic works. The problem (if
    // any) is then in SpeechRecognition transcription, not audio capture.
    c.micRecording = false;
    c.micTestResult = '';
    /* ============================================================
     *  R2 - IN-TAB BUTTON CLICK
     *  Find a button on the current SP page by label substring and
     *  click it. Searches button, [role=button], a[href], input[type=button|submit]
     *  by visible text + aria-label. Refuses to click outside the SP root
     *  container so we never interact with non-ServiceNow elements.
     * ============================================================ */
    function _findAndClickButton(labelSub) {
        if (!labelSub) return false;
        var sub = labelSub.toLowerCase().trim();
        // Scope to the page itself, NOT including our own widget (no clicking our own dev panel)
        var scope = document.querySelector('main, .sp-page-root, body');
        if (!scope) return false;
        var candidates = scope.querySelectorAll('button, [role="button"], a.btn, input[type="button"], input[type="submit"], [ng-click]');
        var match = null, matchScore = 999;
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            // Skip our own widget's buttons
            if (el.closest && el.closest('.netra-root')) continue;
            // Skip invisible / disabled
            var rect = el.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) continue;
            if (el.disabled) continue;
            var txt   = (el.textContent || '').toLowerCase().trim();
            var aria  = (el.getAttribute('aria-label') || '').toLowerCase();
            var title = (el.getAttribute('title') || '').toLowerCase();
            var blob  = (txt + ' ' + aria + ' ' + title).trim();
            if (!blob) continue;
            if (blob.indexOf(sub) < 0) continue;
            // Prefer shorter button text (exact match wins)
            var score = Math.abs(txt.length - sub.length);
            if (score < matchScore) {
                matchScore = score;
                match = el;
            }
        }
        if (!match) {
            logEvent('click', 'no button found matching "' + labelSub + '"');
            return false;
        }
        try {
            match.click();
            var label = (match.textContent || match.getAttribute('aria-label') || labelSub).trim().substring(0, 40);
            logEvent('click', 'clicked: "' + label + '"');
            return true;
        } catch (e) {
            logEvent('err', 'click failed: ' + e.message);
            return false;
        }
    }

    /* ============================================================
     *  R1.4 - Screen capture for vision input
     *
     *  Uses getDisplayMedia (Chrome native) - user is prompted to
     *  share their tab once. We grab one frame, encode to PNG base64,
     *  and send to the server as the next user message's inlineData.
     * ============================================================ */
    c.devCaptureScreen = function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            logEvent('err', 'getDisplayMedia not supported in this browser');
            return;
        }
        logEvent('dev', 'requesting screen capture...');
        navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' } }).then(function (stream) {
            var track = stream.getVideoTracks()[0];
            var imageCapture = new ImageCapture(track);
            imageCapture.grabFrame().then(function (bitmap) {
                var canvas = document.createElement('canvas');
                canvas.width  = Math.min(bitmap.width,  1280);
                canvas.height = Math.min(bitmap.height, 800);
                var ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                var b64 = canvas.toDataURL('image/png').split(',')[1];
                track.stop();
                logEvent('dev', 'screenshot captured: ' + Math.round(b64.length / 1024) + ' KB');
                c.pendingScreenshot = b64;
                c.spoken = 'Screenshot ready. Now ask me what to look for.';
                $scope.$applyAsync();
            }).catch(function (e) {
                logEvent('err', 'grabFrame: ' + (e && e.message));
                track.stop();
            });
        }).catch(function (err) {
            logEvent('err', 'getDisplayMedia: ' + (err && err.message));
        });
    };

    c.devTestMic = function () {
        if (c.micRecording) return;
        if (!_micStream) {
            c.micTestResult = 'level meter not running - check mic permission';
            return;
        }
        try {
            var rec = new MediaRecorder(_micStream);
            var chunks = [];
            rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
            rec.onstop = function () {
                var blob = new Blob(chunks, { type: 'audio/webm' });
                var url = URL.createObjectURL(blob);
                var a = new Audio(url);
                a.onended = function () {
                    URL.revokeObjectURL(url);
                    c.micRecording = false;
                    c.micTestResult = 'playback finished (heard yourself? mic is working)';
                    $scope.$applyAsync();
                };
                a.play();
                c.micTestResult = 'playing back... (peak level was ' + c.micLevelPeak + ')';
                $scope.$applyAsync();
            };
            c.micRecording = true;
            c.micLevelPeak = 0;
            c.micTestResult = 'recording for 3 seconds - speak now...';
            $scope.$applyAsync();
            rec.start();
            logEvent('mic', 'test-mic: recording 3s');
            $timeout(function () { rec.stop(); }, 3000);
        } catch (e) {
            c.micTestResult = 'recorder failed: ' + e.message;
            c.micRecording = false;
            $scope.$applyAsync();
        }
    };

    c.tap = function () {
        if (!booted) { tryBoot(true); return; }
        // If the user just finished dragging, swallow the click.
        if (orbDragJustMoved) { orbDragJustMoved = false; return; }
        // toggle sleep/wake by tap as a convenience for sighted helpers
        if (c.alert) {
            c.alert = false;
            setState('dormant');
            speak('Going to sleep. Say Netra to wake me.');
        } else {
            c.alert = true;
            setState('idle');
            cue('resume');
            // R1.1 - ALSO force a recognition restart on wake, in case mic
            // silently died while sleeping. Clears any stale TTS guard too.
            ignoreFinalsUntil = Date.now();
            if (!c.recRunning || (Date.now() - recLastActivityAt) > 15000) {
                logEvent('rec', 'wake: forcing recognition restart');
                recRestartCount = 0;
                try { if (contRec) contRec.stop(); } catch (e) {}
                $timeout(startContinuous, 150);
            }
            speak('Yes, I am back.');
        }
    };

    /* ============================================================
     *  R1 - DRAGGABLE FLOATING EYE
     *
     *  Click  - toggle sleep/wake (existing behaviour)
     *  Drag   - reposition the eye anywhere on screen, edge-snap
     *  Dbl-click - shrink/expand (mini bubble vs full eye)
     *  Position + size persist in localStorage so the eye remembers
     *  where the user prefers it.
     * ============================================================ */
    var orbDragJustMoved = false;
    var dragState = null;       // { startX, startY, origLeft, origTop, moved, dblClickTimer }
    var DRAG_THRESHOLD = 4;     // px before drag is recognised

    c.orbShrunk = false;
    c.orbX = null;              // pixel offset, null = use CSS default (bottom-right)
    c.orbY = null;

    // Restore saved position + shrunk state from localStorage
    try {
        var saved = JSON.parse(localStorage.getItem('netra.orb.pos') || 'null');
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
            c.orbX = saved.x;
            c.orbY = saved.y;
            c.orbShrunk = !!saved.shrunk;
        }
    } catch (e) {}

    function _applyOrbPosition() {
        var root = document.querySelector('.netra-root');
        if (!root) return;
        if (c.orbX !== null && c.orbY !== null) {
            root.style.left   = c.orbX + 'px';
            root.style.top    = c.orbY + 'px';
            root.style.right  = 'auto';
            root.style.bottom = 'auto';
        }
        if (c.orbShrunk) {
            root.classList.add('netra-shrunk');
        } else {
            root.classList.remove('netra-shrunk');
        }
    }
    function _saveOrbPosition() {
        try {
            localStorage.setItem('netra.orb.pos', JSON.stringify({
                x: c.orbX, y: c.orbY, shrunk: c.orbShrunk
            }));
        } catch (e) {}
    }
    // Apply saved position after Angular has rendered the DOM
    $timeout(_applyOrbPosition, 200);

    c.dragStart = function (ev) {
        if (!ev) return;
        // Right-click etc. - ignore
        if (ev.button !== undefined && ev.button !== 0) return;

        // Detect double-click manually (for shrink/expand)
        var now = Date.now();
        if (dragState && dragState.lastClickAt && (now - dragState.lastClickAt < 350)) {
            ev.preventDefault();
            c.orbShrunk = !c.orbShrunk;
            _applyOrbPosition();
            _saveOrbPosition();
            logEvent('dev', c.orbShrunk ? 'orb shrunk' : 'orb expanded');
            dragState = null;
            orbDragJustMoved = true;  // prevent tap()
            return;
        }

        var root = document.querySelector('.netra-root');
        if (!root) return;
        var rect = root.getBoundingClientRect();
        dragState = {
            startX:  ev.clientX,
            startY:  ev.clientY,
            origX:   rect.left,
            origY:   rect.top,
            moved:   false,
            lastClickAt: now
        };
        document.addEventListener('mousemove', _onDragMove);
        document.addEventListener('mouseup',   _onDragEnd);
    };

    function _onDragMove(ev) {
        if (!dragState) return;
        var dx = ev.clientX - dragState.startX;
        var dy = ev.clientY - dragState.startY;
        if (!dragState.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            dragState.moved = true;
            document.body.style.userSelect = 'none';
        }
        if (dragState.moved) {
            var newX = dragState.origX + dx;
            var newY = dragState.origY + dy;
            // Clamp to viewport
            var vw = window.innerWidth, vh = window.innerHeight;
            newX = Math.max(8, Math.min(vw - 60, newX));
            newY = Math.max(8, Math.min(vh - 40, newY));
            var root = document.querySelector('.netra-root');
            root.style.left   = newX + 'px';
            root.style.top    = newY + 'px';
            root.style.right  = 'auto';
            root.style.bottom = 'auto';
            ev.preventDefault();
        }
    }

    function _onDragEnd(ev) {
        document.removeEventListener('mousemove', _onDragMove);
        document.removeEventListener('mouseup',   _onDragEnd);
        document.body.style.userSelect = '';
        if (!dragState) return;
        if (dragState.moved) {
            // Snap to nearest edge horizontally (Apple AssistiveTouch style)
            var root = document.querySelector('.netra-root');
            var rect = root.getBoundingClientRect();
            var vw   = window.innerWidth;
            var centerX = rect.left + rect.width / 2;
            var snapX = centerX < vw / 2 ? 8 : (vw - rect.width - 8);
            // Smooth snap via CSS transition
            root.style.transition = 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
            root.style.left = snapX + 'px';
            $timeout(function () { root.style.transition = ''; }, 280);
            c.orbX = snapX;
            c.orbY = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top));
            _saveOrbPosition();
            orbDragJustMoved = true;
            logEvent('dev', 'orb moved to (' + Math.round(c.orbX) + ', ' + Math.round(c.orbY) + ')');
        }
        dragState = null;
    }

    /* ============================================================
     *  R1.3 - DRAGGABLE DEV CONSOLE
     *  Drag the header bar to reposition. Persists in localStorage.
     * ============================================================ */
    var devDrag = null;

    try {
        var devSaved = JSON.parse(localStorage.getItem('netra.dev.pos') || 'null');
        if (devSaved && typeof devSaved.x === 'number') {
            $timeout(function () {
                var devEl = document.querySelector('.netra-dev');
                if (devEl) {
                    devEl.style.left = devSaved.x + 'px';
                    devEl.style.top  = devSaved.y + 'px';
                    devEl.style.right = 'auto';
                    devEl.style.bottom = 'auto';
                }
            }, 300);
        }
    } catch (e) {}

    c.devDragStart = function (ev) {
        if (!ev || (ev.button !== undefined && ev.button !== 0)) return;
        if (ev.target && ev.target.classList && ev.target.classList.contains('netra-dev-x')) return;
        var devEl = document.querySelector('.netra-dev');
        if (!devEl) return;
        var rect = devEl.getBoundingClientRect();
        devDrag = { startX: ev.clientX, startY: ev.clientY, origX: rect.left, origY: rect.top, moved: false };
        document.addEventListener('mousemove', _onDevDragMove);
        document.addEventListener('mouseup',   _onDevDragEnd);
        ev.preventDefault();
    };

    function _onDevDragMove(ev) {
        if (!devDrag) return;
        var dx = ev.clientX - devDrag.startX;
        var dy = ev.clientY - devDrag.startY;
        if (!devDrag.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            devDrag.moved = true;
            document.body.style.userSelect = 'none';
        }
        if (devDrag.moved) {
            var devEl = document.querySelector('.netra-dev');
            var vw = window.innerWidth, vh = window.innerHeight;
            var newX = Math.max(0, Math.min(vw - 50, devDrag.origX + dx));
            var newY = Math.max(0, Math.min(vh - 30, devDrag.origY + dy));
            devEl.style.left = newX + 'px';
            devEl.style.top  = newY + 'px';
            devEl.style.right = 'auto';
            devEl.style.bottom = 'auto';
        }
    }

    function _onDevDragEnd() {
        document.removeEventListener('mousemove', _onDevDragMove);
        document.removeEventListener('mouseup',   _onDevDragEnd);
        document.body.style.userSelect = '';
        if (!devDrag || !devDrag.moved) { devDrag = null; return; }
        var devEl = document.querySelector('.netra-dev');
        var rect = devEl.getBoundingClientRect();
        try { localStorage.setItem('netra.dev.pos', JSON.stringify({ x: rect.left, y: rect.top })); } catch (e) {}
        logEvent('dev', 'dev panel moved to (' + Math.round(rect.left) + ', ' + Math.round(rect.top) + ')');
        devDrag = null;
    }

    /* ============================================================
     *  BOOT
     * ============================================================ */
    function tryBoot(fromTap) {
        if (booted) return;
        if (!c.hasSR) {
            setState('error');
            logEvent('err', 'no SpeechRecognition in this browser');
            speak('Your browser does not support voice. Kindly use Chrome or Edge.');
            return;
        }
        if (!c.data.has_api_key) {
            setState('error');
            logEvent('err', 'Gemini API key not configured');
            speak('Sorry, the Gemini API key has not been configured on the server.');
            return;
        }

        unlockAudio();
        populateVoices();

        try {
            startContinuous();
            startListeningWatchdog();   // R1: aggressive mic-health watchdog
            startVisibilityRecovery();  // R1: tab-visibility recovery
            booted     = true;
            c.needsTap = false;
            startNotificationPolling();
            setState('idle');
            if (ALWAYS_LISTEN) openConversation('boot - always listening');
            logEvent('boot', 'continuous recognition started (' + (ALWAYS_LISTEN ? 'always-listening, no wake word' : 'wake-word mode') + ')');

            var name = (c.data && c.data.user_name) ? c.data.user_name : 'there';
            var firstName = name.split(' ')[0];
            // Time-of-day greeting
            var h = new Date().getHours();
            var todGreet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
            var greet = ALWAYS_LISTEN
                ? todGreet + ', ' + firstName + '. I am Netra, your sentinel. I am listening, just speak. Say stop listening any time to pause.'
                : todGreet + ', ' + firstName + '. I am Netra, your sentinel. Whenever you need me, just say my name.';
            $timeout(function () {
                // R9 - the UI + mic self-check now runs on EVERY page load
                // (user preference). First-ever boot gets the long intro;
                // later boots get a quick "mic check" pass. Say "skip" or
                // tap Skip on the stage card to jump straight in.
                speak(todGreet + ', ' + firstName + '. I am Netra.', function () {
                    _firstRunCheck();
                });
                // Once per session, auto-offer a daily briefing 4 seconds after greeting
                $timeout(function () {
                    if (c.alert && c.conversationOpen && !c.briefingOffered) {
                        c.briefingOffered = true;
                        // Send a synthetic command to invoke daily_briefing
                        // Disabled by default - the user can ask "morning briefing" any time
                        logEvent('boot', 'briefing offer skipped - user can request "morning briefing"');
                    }
                }, 4000);
            }, fromTap ? 200 : 800);
        } catch (e) {
            logEvent('err', 'boot failed: ' + e);
            c.needsTap = true;
            $scope.$applyAsync();
        }
    }

    /* ============================================================
     *  ALWAYS-ON CONTINUOUS RECOGNITION
     *  One session, restarted in onend forever.
     * ============================================================ */
    var recRestartCount  = 0;   // consecutive rapid-end count for backoff
    var recLastStartTime = 0;   // track session start time
    var recLastActivityAt = 0;  // R1.1 - last interim or final result timestamp
    var recRunningDebounceTimer = null;   // R1.3.1 - debounce live-indicator off
    // R8.1 "Sentinel" - mic reliability telemetry + zombie-session tracking.
    // Chrome's network recognizer has a failure mode where interim results
    // keep arriving but finals never do ("hears but doesn't register"); we
    // track the interim/final timeline to detect and heal it.
    var _lastInterimAt = 0, _lastInterimText = '', _lastFinalAt = 0;
    var _notAllowedStrikes = 0;
    var _lastLowConfNudgeAt = 0;
    var _floorStuckStrikes = 0;
    // R8.2 - prosody capture (speech-delivery sentiment hints for the brain)
    var _prosFirstAt = 0, _prosSum = 0, _prosN = 0, _prosPeak = 0;
    c.micHealth = {
        srRestarts: 0,          // onend->restart cycles
        fullRecycles: 0,        // full mic+SR teardown/rebuilds
        preventiveRecycles: 0,  // proactive session refreshes (age > 4 min)
        syntheticFinals: 0,     // interims promoted to finals (zombie heal)
        floorClears: 0,         // stuck speaking-floor releases
        notAllowedRecoveries: 0,// transient not-allowed errors survived
        deniedRecoveries: 0,    // permission restored without page refresh
        lastFinalAt: 0,
        lastInterimAt: 0
    };

    function startContinuous() {
        if (!c.hasSR) return;
        try { if (contRec) contRec.stop(); } catch (e) {}

        contRec = new SR();
        contRec.continuous     = true;
        contRec.interimResults = true;
        contRec.lang           = c.recLang || 'en-IN';   // R9 - Lab language selector
        contRec.maxAlternatives = 5;   // R2.2 - get top 5 guesses to re-rank against personal vocab
        attachGrammar(contRec);
        recLastStartTime = Date.now();

        contRec.onstart = function () {
            // R1.3.1 - Cancel any pending "set false" so the indicator stays
            // continuously on through quick restart cycles.
            if (recRunningDebounceTimer) {
                $timeout.cancel(recRunningDebounceTimer);
                recRunningDebounceTimer = null;
            }
            c.recRunning = true;
            recRestartCount = 0;   // successful start - reset backoff counter
            $scope.$applyAsync();
        };

        contRec.onresult = function (ev) {
            recLastActivityAt = Date.now();   // R1.1 - silent-rec heartbeat
            _notAllowedStrikes = 0;           // R8.1 - real results = mic healthy
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                var conf = (res[0] && res[0].confidence) || 0;
                if (!res.isFinal) {
                    // R8.1 - zombie-session heartbeat: remember the interim so
                    // the watchdog can promote it if a final never arrives.
                    _lastInterimAt = Date.now();
                    if (t && t.trim()) _lastInterimText = t.trim();
                    c.micHealth.lastInterimAt = _lastInterimAt;
                    // R8.2 - prosody clock starts on the first interim of a turn
                    if (!_prosFirstAt && !_speakingNow) _prosFirstAt = Date.now();
                    c.interim = t;
                    // R7 - INSTANT YIELD: while Netra holds the floor, the
                    // moment the LIVE transcript shows two non-echo words
                    // she stops - roughly 0.3-0.5s after you start talking,
                    // no waiting for the recognizer to finalize. One-word
                    // interims still duck her volume as an early tell.
                    var floorHeld = _speakingNow || _fillerChainActive || currentFillerAudio || currentFillerUtter;
                    if (floorHeld) {
                        var itrim = t.trim();
                        var iwords = itrim ? itrim.split(/\s+/).length : 0;
                        var pastRamp = (Date.now() - _speakingSince) > BARGE_GUARD_MS;
                        if (pastRamp && iwords >= 2 && !_looksLikeEcho(itrim)) {
                            stopSpeaking('instant interim barge: "' + itrim.substring(0, 48) + '"');
                        } else if (itrim.length >= 8 && !_looksLikeEcho(itrim)) {
                            _duckForInterim();
                        }
                    }
                    if (!_speakingNow) {
                        if (!_interimSpeechStart) _interimSpeechStart = Date.now();
                        else if (Date.now() - _interimSpeechStart > 4000) {
                            _maybeBackchannel();
                            _interimSpeechStart = Date.now();   // rearm window
                        }
                    }
                    _cancelReprompt();   // user is talking - no nudge needed
                    $scope.$applyAsync();
                    continue;
                }
                c.interim = '';
                _interimSpeechStart = 0;
                // R8.1 - the recognizer IS finalizing; zombie heal not needed
                _lastFinalAt = Date.now();
                _lastInterimAt = 0;
                _lastInterimText = '';
                c.micHealth.lastFinalAt = _lastFinalAt;
                // R6 - hard guard only for the first ~450ms of TTS (audio
                // ramp / AEC settle). Beyond that the mic stays HOT and
                // every final is echo-scored instead of blanket-dropped.
                if (Date.now() < ignoreFinalsUntil) {
                    logEvent('rec.echo', '"' + t.trim() + '" (ignored - within TTS guard)');
                    continue;
                }
                // R7 - echo tail after an instant yield: her audio stopped
                // mid-word, but a final containing HER last words can still
                // arrive for ~1.2s. Score it against what she was saying
                // and drop pure echo, while the user's real command passes.
                if (Date.now() - _lastYieldAt < 1200 && _looksLikeEcho(t)) {
                    logEvent('rec.echo', '"' + t.trim() + '" (post-yield echo tail)');
                    continue;
                }
                // R6 - BARGE-IN: Netra currently holds the floor (speaking,
                // or filler chain running while she thinks). Score this
                // final: her own echo is dropped; a reflex "stop" yields
                // instantly; substantive user speech stops her audio and
                // falls through to be processed as the next command.
                if (_speakingNow || _fillerChainActive || currentFillerAudio || currentFillerUtter) {
                    if (_handleFinalWhileSpeaking(t, conf)) continue;
                }
                // R2.2 - pick the best alternative against personal vocab
                var picked = pickBestAlternative(res);
                if (picked && picked.transcript !== t) {
                    logEvent('train', 'reranked: "' + t + '" -> "' + picked.transcript + '" (vocab hits: ' + picked.vocabHits + ')');
                    t = picked.transcript;
                    conf = picked.confidence;
                }
                // R2.2 - apply alias map (e.g. "agar" -> "Adam")
                var aliasedT = applyAliases(t);
                if (aliasedT !== t) {
                    logEvent('train', 'alias-rewrite: "' + t + '" -> "' + aliasedT + '"');
                    t = aliasedT;
                }
                _enqueueFinalTranscript(t, conf);
            }
        };

        contRec.onerror = function (ev) {
            // R1.3.1 - These are all ROUTINE lifecycle events, not errors:
            //   'no-speech'     = user was just quiet
            //   'audio-capture' = mic device hiccup, will recover
            //   'aborted'       = deliberate stop OR Chrome's 5-min session limit
            //   'network'       = transient network blip (also self-recovers)
            // Silently ignore so they do not pollute the dev log.
            if (ev.error === 'no-speech' ||
                ev.error === 'audio-capture' ||
                ev.error === 'aborted' ||
                ev.error === 'network') {
                return;
            }
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
                _handleNotAllowed(ev.error);
                return;
            }
            logEvent('err', 'recognition error: ' + ev.error);
        };

        contRec.onend = function () {
            // R1.3.1 - Don't flip recRunning false IMMEDIATELY if a restart
            // is coming. The "off" period of the live indicator is just the
            // 250 ms restart gap, which looks like rapid flicker to the user.
            // Instead: stay-on for 600 ms; if start hasn't happened by then,
            // actually report stopped.
            if (recRunningDebounceTimer) $timeout.cancel(recRunningDebounceTimer);
            recRunningDebounceTimer = $timeout(function () {
                c.recRunning = false;
                $scope.$applyAsync();
            }, 600);

            // Always restart unless permission was denied
            if (c.permission === 'denied') return;
            // Exponential backoff if recognition is ending rapidly (<2s sessions)
            var sessionDuration = Date.now() - recLastStartTime;
            if (sessionDuration < 2000) {
                recRestartCount++;
            } else {
                recRestartCount = 0;
            }
            // Cap backoff at 8s to avoid long silences when mic is eventually granted
            var delay = recRestartCount > 1
                ? Math.min(500 * Math.pow(1.8, recRestartCount - 1), 8000)
                : RESTART_DELAY;
            c.micHealth.srRestarts++;
            $timeout(startContinuous, delay);
        };

        try { contRec.start(); }
        catch (e) {
            logEvent('err', 'contRec.start failed: ' + e);
            // common cause: already started
            $timeout(startContinuous, 1000);
        }
    }

    /* R8.1 "Sentinel" - not-allowed triage. Chrome throws a spurious
     * not-allowed when the OS audio device switches or the tab thaws
     * from suspension; treating every one as a permanent denial used
     * to brick Netra until a page refresh ("stops responding after a
     * while"). Now the Permissions API is consulted: if the mic is in
     * fact still granted, restart with backoff (up to 3 strikes). */
    function _handleNotAllowed(kind) {
        var declareDenied = function () {
            logEvent('err', 'mic permission DENIED (' + kind + ') - recognition stopped');
            c.recRunning = false;
            setState('error');
            c.permission = 'denied';
            $scope.$applyAsync();
        };
        try {
            if (navigator.permissions && navigator.permissions.query) {
                navigator.permissions.query({ name: 'microphone' }).then(function (st) {
                    if (st.state === 'granted' && _notAllowedStrikes < 3) {
                        _notAllowedStrikes++;
                        c.micHealth.notAllowedRecoveries++;
                        logEvent('warn', kind + ' but mic still granted - transient, restart ' + _notAllowedStrikes + '/3');
                        $timeout(startContinuous, 1500 * _notAllowedStrikes);
                    } else {
                        declareDenied();
                    }
                }, declareDenied);
                return;
            }
        } catch (eP) {}
        declareDenied();
    }

    /* R3.6 - SR activity watchdog with FULL recycle.
     * Chrome's SpeechRecognition silently dies on some builds (no onend,
     * no onerror). The R3.5 watchdog tried to restart SR alone, but
     * sometimes the underlying audio pipeline is also stuck - the user
     * was having to refresh the page. Now we tear down the SR instance
     * AND the getUserMedia stream AND the AudioContext on every silent
     * stall, then rebuild from scratch with a 600 ms gap so the OS can
     * fully release the device.
     */
    var SR_IDLE_RESTART_MS = 60000;   // tightened 90s -> 60s
    var _recyclingMic = false;
    function _fullMicRecycle(reason) {
        if (_recyclingMic) return;
        _recyclingMic = true;
        c.micHealth.fullRecycles++;
        logEvent('rec', 'full mic+SR recycle (' + reason + ')');
        recLastActivityAt = Date.now();   // reset to avoid retrigger
        try { if (contRec) contRec.stop(); } catch (e) {}
        try { if (contRec) contRec.abort(); } catch (e) {}
        contRec = null;
        try { stopMicLevelMeter(); } catch (e) {}
        $timeout(function () {
            try { startMicLevelMeter(); } catch (e) { logEvent('warn', 'meter restart: ' + e.message); }
            $timeout(function () {
                try { startContinuous(); } catch (e) { logEvent('warn', 'SR restart: ' + e.message); }
                _recyclingMic = false;
            }, 300);
        }, 600);
    }
    function _srActivityWatchdog() {
        if (_ctrlDestroyed) return;   // R4.5 - don't reschedule after destroy
        try {
            if (c.recRunning && c.alert && c.state !== 'speaking' && recLastActivityAt > 0) {
                var silentFor = Date.now() - recLastActivityAt;
                if (silentFor > SR_IDLE_RESTART_MS) {
                    _fullMicRecycle('idle ' + Math.round(silentFor/1000) + 's');
                }
            } else if (c.recRunning && recLastActivityAt === 0) {
                recLastActivityAt = Date.now();
            }
        } catch (eW) { logEvent('warn', 'SR watchdog: ' + eW.message); }
        $timeout(_srActivityWatchdog, 20000);
    }
    $timeout(_srActivityWatchdog, 20000);

    /* ============================================================
     *  R1 - LISTENING WATCHDOG
     *
     *  Every 10 seconds verify recognition is actually running. If
     *  recRunning has been false for 3+ checks, force-restart.
     *  Also detects "stuck in speaking" state and recovers.
     * ============================================================ */
    var watchdogStrikes = 0;
    var watchdogLastSpeakingStart = 0;
    var _permProbeCounter = 0;
    function startListeningWatchdog() {
        var tick = function () {
            var now = Date.now();
            // Stuck-in-speaking detection: if state has been "speaking"
            // for more than 30s without progress, force a FULL floor
            // release (R8.1: setState alone left _speakingNow true, so
            // every later utterance was echo-scored and short commands
            // were eaten forever - "hears but does not register").
            if (c.state === 'speaking') {
                if (!watchdogLastSpeakingStart) {
                    watchdogLastSpeakingStart = now;
                } else if (now - watchdogLastSpeakingStart > 30000) {
                    logEvent('warn', 'watchdog: stuck in speaking >30s - full floor release');
                    watchdogLastSpeakingStart = 0;
                    stopSpeaking('watchdog stuck-speaking');
                    ignoreFinalsUntil = now;
                }
            } else {
                watchdogLastSpeakingStart = 0;
            }

            // R8.1 - FLOOR SANITY: _speakingNow claims Netra holds the
            // floor, but no audio element is actually playing and no TTS
            // engine is active. Two consecutive strikes (~20s) means a
            // completion callback was lost (MediaSource stall, engine
            // exception) - release the floor so the mic gate reopens.
            var audioLive = false;
            try { audioLive = !!(currentAudio && !currentAudio.paused && !currentAudio.ended); } catch (eAL) {}
            var ttsLive = !!(TTS && (TTS.speaking || TTS.pending));
            if (_speakingNow && !audioLive && !ttsLive && !_edgeLiveWs &&
                (now - _speakingSince) > 8000) {
                _floorStuckStrikes++;
                if (_floorStuckStrikes >= 2) {
                    _floorStuckStrikes = 0;
                    c.micHealth.floorClears++;
                    logEvent('warn', 'watchdog: speaking floor stuck with no audio - releasing');
                    stopFillerChain();
                    _clearSpeaking();
                    ignoreFinalsUntil = now;
                    if (c.state === 'speaking') setState(c.alert ? 'idle' : 'dormant');
                }
            } else {
                _floorStuckStrikes = 0;
            }

            // R8.1 - ZOMBIE-SESSION HEAL: interims arrived (user spoke,
            // Netra "heard") but the recognizer never produced a final in
            // 8s+. Promote the last interim to a synthetic final so the
            // command still registers, then rebuild the mic stack - this
            // session's finalizer is gone and won't come back.
            if (!_speakingNow && c.alert && _lastInterimAt > 0 &&
                _lastFinalAt < _lastInterimAt &&
                (now - _lastInterimAt) > 8000 &&
                _lastInterimText && _lastInterimText.length >= MIN_LENGTH) {
                var ghost = _lastInterimText;
                _lastInterimAt = 0;
                _lastInterimText = '';
                c.interim = '';
                c.micHealth.syntheticFinals++;
                logEvent('warn', 'watchdog: interim never finalized - promoting "' + ghost.substring(0, 60) + '"');
                _enqueueFinalTranscript(ghost, 0.5);
                _fullMicRecycle('zombie session: interim without final');
            }

            // R8.1 - PERMISSION-RESTORE PROBE (every ~30s): if we declared
            // the mic denied, keep checking the Permissions API; the user
            // can re-allow from the padlock without a refresh.
            _permProbeCounter++;
            if (c.permission === 'denied' && _permProbeCounter % 3 === 0) {
                try {
                    if (navigator.permissions && navigator.permissions.query) {
                        navigator.permissions.query({ name: 'microphone' }).then(function (st) {
                            if (st.state === 'granted') {
                                logEvent('rec', 'mic permission restored - restarting recognition');
                                c.permission = 'granted';
                                c.micHealth.deniedRecoveries++;
                                _notAllowedStrikes = 0;
                                if (c.state === 'error') setState(c.alert ? 'idle' : 'dormant');
                                startContinuous();
                            }
                        }, function () {});
                    }
                } catch (ePr) {}
            }

            // R8.1 - PREVENTIVE SESSION RECYCLE: Chrome's network recognizer
            // degrades on very long continuous sessions. Refresh it every
            // ~4 minutes, but only in a quiet idle moment so the user never
            // notices (onend auto-restarts in 250ms).
            if (c.recRunning && c.alert && !_speakingNow && c.state === 'idle' &&
                !String(c.interim || '').trim() &&
                (now - recLastStartTime) > 240000 &&
                (now - recLastActivityAt) > 8000) {
                c.micHealth.preventiveRecycles++;
                logEvent('rec', 'preventive session recycle (age ' + Math.round((now - recLastStartTime) / 60000) + ' min)');
                recLastStartTime = now;   // don't refire before restart lands
                try { contRec.stop(); } catch (ePS) {}
            }

            // Recognition health: if mic permission is granted but recognition
            // is not running for 3 consecutive checks (~15s), force a restart.
            if (c.permission === 'granted' && !c.recRunning) {
                watchdogStrikes++;
                if (watchdogStrikes >= 3) {
                    logEvent('warn', 'watchdog: recognition down for ~15s - force restart');
                    watchdogStrikes = 0;
                    recRestartCount = 0;
                    startContinuous();
                }
            } else {
                watchdogStrikes = 0;
            }

            // R1.3 - SILENT-REC HEARTBEAT REMOVED
            // The previous "if quiet for 25s, force restart" logic was firing
            // every time the user was naturally silent, which made Chrome
            // re-acquire the mic stream constantly and caused the tab's red
            // recording dot to blink rapidly. We now TRUST c.recRunning: if
            // Chrome fires onend or onerror, we restart. Otherwise we leave
            // the session alone, even during long quiet stretches.

            // Stale ignoreFinalsUntil guard - if it is more than 5s in the
            // future and we are not actually speaking, clear it.
            if (ignoreFinalsUntil > now + 5000 && c.state !== 'speaking') {
                logEvent('warn', 'watchdog: stale TTS guard cleared');
                ignoreFinalsUntil = now;
            }

            $timeout(tick, 10000);   // R1.3 - back to 10s (was 5s, too noisy)
        };
        $timeout(tick, 10000);
    }

    /* ============================================================
     *  R1 - VISIBILITY RECOVERY
     *
     *  When the tab becomes visible again (user came back), make
     *  sure recognition is alive. Chrome can suspend mic in
     *  background tabs for power-saving.
     * ============================================================ */
    function startVisibilityRecovery() {
        $window.document.addEventListener('visibilitychange', function () {
            if (!document.hidden && c.permission === 'granted' && c.alert) {
                if (!c.recRunning) {
                    logEvent('rec', 'visibility: tab visible - restarting rec');
                    recRestartCount = 0;
                    startContinuous();
                }
                // R2.7 - resume the AudioContext (Chrome suspends it on
                // background; mic meter would silently die without this).
                try {
                    if (_micCtx && _micCtx.state === 'suspended') {
                        logEvent('mic', 'visibility: resuming AudioContext');
                        _micCtx.resume();
                    }
                } catch (eC) {}
                // Also reset stuck speaking state on tab return
                if (c.state === 'speaking' && (!TTS || !TTS.speaking)) {
                    if (!currentAudio || currentAudio.paused) {
                        logEvent('warn', 'visibility: stale speaking state - resetting');
                        setState(c.alert ? 'idle' : 'dormant');
                    }
                }
                $scope.$applyAsync();
            }
        });
    }

    function sanitizeForGrammar(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function compactList(arr, limit) {
        var seen = {}, out = [];
        (arr || []).forEach(function (raw) {
            var w = sanitizeForGrammar(raw);
            if (!w || w.length < 2 || w.length > 40) return;
            if (seen[w]) return;
            seen[w] = true;
            out.push(w);
            if (out.length >= limit) return;
        });
        return out;
    }

    var grammarLoggedOnce = false;  // only log grammar details once (not every restart)

    // R4.7 - PERF: the server now sends data.vocab ONLY on the initial widget
    // load (not on every poll/chat), so grammar rebuilds after a poll must not
    // depend on it still being on c.data. Snapshot it the first time we see it
    // and reuse the snapshot on later recognizer restarts.
    var _vocabSnapshot = null;

    function attachGrammar(rec) {
        if (!SGL) return;
        try {
            var wakeOptions = WAKE_WORDS.join(' | ');
            if (c.data && c.data.vocab && Object.keys(c.data.vocab).length) {
                _vocabSnapshot = c.data.vocab;   // freshest server truth (boot)
            }
            var v = _vocabSnapshot || (c.data && c.data.vocab) || {};
            var dynGroups   = compactList(v.groups, 60);
            var dynApps     = compactList(v.apps, 50);
            var dynCats     = compactList(v.categories, 25);
            var dynKb       = compactList(v.kb_titles, 30);
            var dynCatItems = compactList(v.catalog_items, 25);
            var dynCommon   = compactList(v.common, 120);   // R2.9.1 - SN/IT corpus
            var domain = '#JSGF V1.0; grammar netra;\n' +
                'public <wake> = ' + wakeOptions + ' | hey netra | ok netra | hello netra | listen netra ;\n' +
                'public <verb> = open | create | log | file | raise | report | new | start | ' +
                    'list | show | tell | read | display | give | give me | what is | what are | which | who | ' +
                    'resolve | close | mark | fix | complete | finished | done | ' +
                    'update | comment | add | note | reply | append | ' +
                    'search | find | lookup | look up | check | ' +
                    'approve | reject | decline | accept | deny | confirm | pass | ' +
                    'pause | resume | stop | sleep | wake | wake up | listen | restart | repeat | again ;\n' +
                'public <noun> = ticket | tickets | incident | incidents | issue | issues | problem | ' +
                    'request | change | approval | approvals | task | knowledge | base | article | articles | ' +
                    'KB | INC | CHG | RITM | SCTASK | PRB | VIT | CVE | ' +
                    'vulnerability | vulnerabilities | vulnerable item | vulnerable items | ' +
                    'risk | risk score | exposure | remediation | patch | asset | assets | ' +
                    'false positive | triage | queue | aging | scheduled job | scheduled jobs | integration | integrations | ' +
                    'status | state | priority | impact | severity | urgency | assignee | watcher | ' +
                    'VPN | email | password | network | computer | laptop | monitor | keyboard | wifi | server | ' +
                    'account | access | login | reset | unlock | enable | disable ;\n' +
                'public <modifier> = urgent | critical | high | medium | low | normal | ' +
                    'P1 | P2 | P3 | P4 | priority one | priority two | priority three | ' +
                    'open | closed | resolved | pending | new | in progress | assigned | ' +
                    'deferred | overdue | remediate | remediated | defer | investigate | ' +
                    'today | yesterday | this week | last week ;\n' +
                'public <digit> = zero | one | two | three | four | five | six | seven | eight | nine | ' +
                    'ten | eleven | twelve | thirteen | fourteen | fifteen | sixteen | seventeen | eighteen | nineteen | ' +
                    'twenty | thirty | forty | fifty | sixty | seventy | eighty | ninety | hundred | thousand ;\n' +
                'public <courtesy> = please | kindly | thanks | thank you | sorry | excuse me | ' +
                    'hi | hello | hey | namaste | salaam | good morning | good afternoon | good evening ;\n' +
                'public <question> = what | which | how | when | who | where | why | ' +
                    'tell me | show me | give me | can you | could you | would you | will you ;';
            // Append dynamic vocab pulled from ServiceNow tables (cached 6h server-side)
            if (dynGroups.length) {
                domain += '\npublic <group> = ' + dynGroups.join(' | ') + ' ;';
            }
            if (dynApps.length) {
                domain += '\npublic <app> = ' + dynApps.join(' | ') + ' ;';
            }
            if (dynCats.length) {
                domain += '\npublic <category> = ' + dynCats.join(' | ') + ' ;';
            }
            if (dynKb.length) {
                domain += '\npublic <kbtitle> = ' + dynKb.join(' | ') + ' ;';
            }
            if (dynCatItems.length) {
                domain += '\npublic <catitem> = ' + dynCatItems.join(' | ') + ' ;';
            }
            if (dynCommon.length) {
                domain += '\npublic <common> = ' + dynCommon.join(' | ') + ' ;';
            }
            // R8.2 - analyst + developer lexicon (server-curated word vector)
            var dynLex = compactList(v.analyst_terms, 140);
            if (dynLex.length) {
                domain += '\npublic <analyst> = ' + dynLex.join(' | ') + ' ;';
            }
            // R2.2 - inject the users PERSONAL VOCAB into the grammar so
            // Chrome itself biases toward those names/words during recognition.
            var personalWords = Object.keys(c.personalVocab || {}).slice(0, 120);
            if (personalWords.length) {
                domain += '\npublic <personal> = ' + personalWords.join(' | ') + ' ;';
            }
            var list = new SGL();
            list.addFromString(domain, 0.7);
            rec.grammars = list;
            // Only log grammar details once — it's identical on every restart
            if (!grammarLoggedOnce) {
                grammarLoggedOnce = true;
                var dynTotal = dynGroups.length + dynApps.length + dynCats.length + dynKb.length + dynCatItems.length;
                logEvent('init', 'grammar attached (' + WAKE_WORDS.length + ' wake + ' + dynTotal +
                                 ' dynamic: ' + dynGroups.length + 'g/' + dynApps.length + 'a/' +
                                 dynCats.length + 'c/' + dynKb.length + 'k/' + dynCatItems.length + 'ci)');
            }
        } catch (e) {
            logEvent('warn', 'grammar not supported: ' + e);
        }
    }

    /* ============================================================
     *  FINAL TRANSCRIPT DISPATCH
     * ============================================================ */
    /* ============================================================
     *  R3.6 - FINAL-TRANSCRIPT DEBOUNCE BUFFER
     *
     *  Web Speech often fires multiple isFinal events for a single
     *  sentence (one per pause). Sending each fragment to Gemini
     *  separately means:
     *    - "change priority 2"   -> server confused
     *    - "to 1"                -> server confused again
     *  Instead we buffer finals for 1300ms; if no new final arrives,
     *  join them into one utterance and send it. If TTS starts or the
     *  user goes dormant before the timer expires, drop the buffer.
     * ============================================================ */
    var _finalBuffer  = [];
    var _finalConfs   = [];
    var _finalTimer   = null;
    var FINAL_DEBOUNCE_MS = 1300;
    // R6 - adaptive debounce: short punchy commands ("list my tickets")
    // don't deserve the full 1.3s wait for possible continuation. Flush
    // fast when the buffer looks complete; keep the long window only for
    // flowing dictation. This alone shaves ~half a second off every
    // simple voice command.
    // R8.1 - SEMANTIC END-OF-TURN. Judge whether the user is done from
    // WHAT they said, not just how long they paused: an utterance that
    // trails off mid-thought ("update INC one two three four with...")
    // earns a much longer window, while a complete-looking short answer
    // ("yes", "resolve it") flushes near-instantly. This kills both
    // premature cutoffs mid-dictation and the dead pause after "yes".
    var _TRAILING_INCOMPLETE_RE = /\b(and|but|or|to|the|a|an|with|for|of|in|on|at|is|was|it's|that|my|his|her|their|this|then|so|because|about|into|from|please|umm?|uhh?|err?)[.,]?$/i;
    var _COMPLETE_ANSWER_RE = /^(yes|yeah|yep|no|nope|correct|confirmed?|do it|go ahead|cancel|stop|okay|ok|sure|thanks|thank you|resolve it|close it|approve|reject)[.!,\s]*$/i;
    function _adaptiveDebounceMs() {
        var joined = _finalBuffer.join(' ').trim();
        var words = joined ? joined.split(/\s+/).length : 0;
        if (_COMPLETE_ANSWER_RE.test(joined)) return 280;         // done - answer now
        if (_TRAILING_INCOMPLETE_RE.test(joined)) return 2600;    // mid-thought - wait
        if (/[.!?]$/.test(joined)) return 650;      // recognizer heard a full stop
        if (words > 0 && words <= 6) return 850;    // short command shape
        return FINAL_DEBOUNCE_MS;                    // long dictation - be patient
    }
    function _enqueueFinalTranscript(text, conf) {
        if (!text || !text.trim()) return;
        _finalBuffer.push(text.trim());
        _finalConfs.push(conf || 0);
        logEvent('rec.buf', '+"' + text.trim() + '" (queue=' + _finalBuffer.length + ')');
        // Surface the running buffer as interim so the dev panel still
        // shows what's accumulating - feels live rather than stuck.
        c.interim = _finalBuffer.join(' ');
        $scope.$applyAsync();
        if (_finalTimer) $timeout.cancel(_finalTimer);
        _finalTimer = $timeout(_flushFinalBuffer, _adaptiveDebounceMs());
    }
    function _flushFinalBuffer() {
        if (_finalTimer) { $timeout.cancel(_finalTimer); _finalTimer = null; }
        if (!_finalBuffer.length) return;
        var joined = _finalBuffer.join(' ').replace(/\s+/g, ' ').trim();
        var bestConf = _finalConfs.reduce(function(a,b){return Math.max(a,b);}, 0);
        _finalBuffer = [];
        _finalConfs  = [];
        c.interim = '';
        if (joined) {
            logEvent('rec.buf', 'flush -> "' + joined + '" conf=' + bestConf.toFixed(2));
            processFinalTranscript(joined, bestConf);
        }
    }
    function _dropFinalBuffer(reason) {
        if (!_finalBuffer.length && !_finalTimer) return;
        if (_finalTimer) { $timeout.cancel(_finalTimer); _finalTimer = null; }
        logEvent('rec.buf', 'dropped (' + reason + '): "' + _finalBuffer.join(' ') + '"');
        _finalBuffer = [];
        _finalConfs  = [];
        c.interim = '';
    }

    function processFinalTranscript(text, conf) {
        // R4.5 - cap merged transcript. The debounce buffer can join many
        // isFinal fragments and each downstream regex pass scales linearly
        // with input length. R6: 4000 -> 12000 so long dictations survive
        // (the server now accepts 16000).
        var clean = (text || '').trim().substring(0, 12000);
        if (!clean) return;
        // R8.1 - calibration read-back has priority over command routing
        if (_calibConsume(clean)) return;
        var lower = clean.toLowerCase();
        c.lastHeard  = clean;
        c.confidence = conf ? conf.toFixed(2) : '-';
        if (typeof conf === 'number') _pushConfidence(conf);   // R1 chart
        logEvent('rec.f', '"' + clean + '" conf=' + c.confidence);
        // R2.2 - auto-learn: every word in a confident utterance becomes
        // part of the personal vocabulary, so frequent names/projects
        // self-reinforce over time.
        if (conf >= MIN_CONFIDENCE) learnFromTranscript(clean);
        $scope.$applyAsync();

        // ---- 1. Sleep command works in any mode ----
        if (matchSleep(lower)) {
            commandMode = false;
            if (commandTimer) $timeout.cancel(commandTimer);
            closeConversation();
            if (!c.alert) return;  // already asleep
            c.alert = false;
            setState('dormant');
            cue('pause');
            speak('Going to sleep. Say "Netra" or "Netra wake up" to bring me back.');
            return;
        }

        // ---- 2. Dormant mode: only wake commands resume ----
        if (!c.alert) {
            // Accept: any wake-word variant, or phrases like "wake up", "are you there", "hey"
            var wakePhrase = matchExplicitWakeUp(lower) ||
                /\b(wake\s*up|are\s+you\s+there|hey|listen|come\s+back|hello)\b/i.test(lower);
            if (wakePhrase) {
                c.alert = true;
                setState('idle');
                cue('resume');
                openConversation('woke from dormant');
                var restW = matchesWake(lower);
                if (restW && restW.length > 2 && !/^(listen|wake\s*up|wake|are\s+you\s+there|hello)$/i.test(restW)) {
                    speak('Yes, I am back.', function () {
                        $timeout(function () { processCommand(restW, conf); }, 200);
                    });
                } else {
                    speak('Yes, I am listening. Go ahead.');
                }
            } else {
                logEvent('rec', 'dormant - ignored');
            }
            return;
        }

        // ---- 3. ALWAYS-LISTENING / CONVERSATION MODE ----
        // No wake word required. Strip a leading "Netra" if user happens
        // to say it. Filter very short utterances and low-confidence
        // chatter so background noise does not become a command.
        if (c.conversationOpen) {
            var stripped = matchesWake(lower);
            var input = (stripped !== null) ? stripped : clean;

            // Bare "Netra" / "Netra-only" - just acknowledge with a chirp
            if (stripped !== null && (stripped.length === 0 || stripped.length < 2)) {
                cue('wake');
                logEvent('conv', 'name only heard (still listening)');
                return;
            }
            // Filter chatter
            if (input.length < MIN_LENGTH) {
                logEvent('rec', 'ignored (too short: "' + input + '")');
                return;
            }
            if (conf > 0 && conf < MIN_CONFIDENCE) {
                logEvent('rec', 'ignored (low conf ' + conf.toFixed(2) + ': "' + input + '")');
                // R8.1 - a substantial utterance heard badly used to vanish in
                // silence, which reads as "Netra stopped responding". Nudge
                // once (30s throttle) so the user knows to repeat.
                if (input.length >= 10 && !_speakingNow &&
                    Date.now() - _lastLowConfNudgeAt > 30000) {
                    _lastLowConfNudgeAt = Date.now();
                    speak('Sorry, I heard you but did not catch it clearly. Once more?');
                }
                return;
            }
            logEvent('conv', 'heard: "' + input + '"');
            processCommand(input, conf);
            return;
        }

        // ---- 4. Wake match (alert + no conversation open) ----
        var afterWake = matchesWake(lower);
        if (afterWake !== null) {
            cue('wake');
            if (afterWake.length > 2) {
                processCommand(afterWake, conf);
            } else {
                commandMode = true;
                setState('awaiting');
                logEvent('wake', 'armed - waiting for next utterance (' + WAKE_TIMEOUT_MS + 'ms)');
                if (commandTimer) $timeout.cancel(commandTimer);
                commandTimer = $timeout(function () {
                    if (commandMode) {
                        commandMode = false;
                        logEvent('wake', 'timed out without command');
                        setState('idle');
                    }
                }, WAKE_TIMEOUT_MS);
            }
            return;
        }

        // ---- 5. Command-armed mode after bare "Netra" ----
        if (commandMode) {
            commandMode = false;
            if (commandTimer) $timeout.cancel(commandTimer);
            processCommand(clean, conf);
            return;
        }

        // ---- 6. Otherwise - background chatter, ignore ----
        logEvent('rec', 'ignored (not addressed to Netra)');
    }

    function processCommand(text, conf) {
        var lower = (text || '').toLowerCase();

        // Re-check sleep / wake locally
        if (matchSleep(lower)) {
            c.alert = false;
            setState('dormant');
            cue('pause');
            speak('Going to sleep. Say "Netra" to bring me back.');
            return;
        }

        // Local intent shortcut
        var local = matchLocal(lower);
        if (local) {
            logEvent('local', 'intent=' + local.intent);
            // R2.10 - intent may carry a server-side _action (e.g. rewind_mem)
            // Pop the last 2 turns from local geminiHistory (user + model)
            // and ping the server to drop the last mem entry.
            if (local._action === 'rewind_mem') {
                if (geminiHistory.length >= 2) {
                    geminiHistory.splice(geminiHistory.length - 2, 2);
                    logEvent('local', 'popped 2 history turns');
                }
                try {
                    c.data.action = 'rewind_mem';
                    c.server.update();   // fire-and-forget
                } catch (eR) { logEvent('warn', 'rewind_mem server call failed: ' + eR.message); }
            }
            setState('speaking');
            speak(local.reply, function () {
                if (c.alert) {
                    setState('idle');
                    openConversation('after local reply');
                }
            });
            return;
        }

        // Confidence check - if too low, ask for repetition
        if (conf > 0 && conf < MIN_CONFIDENCE) {
            logEvent('warn', 'low confidence ' + conf.toFixed(2) + ' - asking for repeat');
            speak('Sorry, I did not catch that clearly. Kindly say it once more.', function () {
                setState('idle');
            });
            return;
        }

        // Normalize spoken numbers and send to server
        var normalized = normalizeNumbers(text);
        if (normalized !== text) {
            logEvent('nlp', 'normalized: "' + text + '" -> "' + normalized + '"');
        }
        handleHeard(normalized);
    }

    /* ============================================================
     *  SERVER ROUND-TRIP
     * ============================================================ */
    function handleHeard(transcript) {
        // R6 - one chat on the wire at a time. If the user barged in while
        // the previous turn was still thinking, hold the newest utterance
        // and fire it the moment the in-flight call settles (its reply is
        // already stale via the turn epoch, so it won't be spoken).
        if (_chatInFlight) {
            _queuedUtterance = transcript;
            logEvent('srv', 'queued (chat in flight): "' + transcript + '"');
            tone([620], 0.05);   // soft tick: "got it, one moment"
            return;
        }
        _chatInFlight = true;
        var myEpoch = ++_turnEpoch;
        _cancelReprompt();

        setState('thinking');
        cue('think');
        logEvent('srv', 'sending: "' + transcript + '"');
        _convoPush('you', transcript);   // R7 - chat tab

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;
        // R8.2 - live-stage flag (server strips navigation tools) + prosody
        c.data.live_mode = !!c.liveMode;
        var prosOut = null;
        if (_prosFirstAt) {
            var durMin = (Date.now() - _prosFirstAt) / 60000;
            var pwords = transcript.split(/\s+/).length;
            var wpm = durMin > 0.005 ? Math.round(pwords / durMin) : 0;
            var lvlAvg = _prosN ? Math.round(_prosSum / _prosN) : 0;
            var dyn = _prosPeak - lvlAvg;
            prosOut = {
                wpm: (wpm > 20 && wpm < 400) ? wpm : 0,
                level: lvlAvg,
                variance: dyn > 30 ? 'high' : (dyn > 14 ? 'medium' : 'low')
            };
        }
        _prosFirstAt = 0; _prosSum = 0; _prosN = 0; _prosPeak = 0;
        c.data.prosody = prosOut;
        // R1.4 - attach screenshot if one was just captured
        if (c.pendingScreenshot) {
            c.data.image_b64 = c.pendingScreenshot;
            c.data.image_mime = 'image/png';
            logEvent('srv', 'attaching screenshot (' + Math.round(c.pendingScreenshot.length / 1024) + ' KB)');
            c.pendingScreenshot = null;
        }

        var hung = $timeout(function () {
            // R6 - release the turn on a hung transport. _chatInFlight would
            // otherwise gate every new utterance into the queue forever
            // (SP's server.update() has no client timeout). If the promise
            // settles later its reply is epoch-stale only if the user has
            // spoken again - otherwise it still speaks, same as pre-R6.
            logEvent('warn', 'server >18s, may be hung - releasing turn so new commands flow');
            _chatInFlight = false;
            _drainQueuedUtterance();
        }, 18000);

        var startedAt = Date.now();   // R1 - latency tracking
        c.stats.utterances++;

        // R3.7 - start the filler chain in parallel with the server call so
        // the conversation does not have dead air. The chain self-terminates
        // when deliverServerReply or stopFillerChain is invoked below.
        startFillerChain();

        c.server.update().then(
            function () {
                $timeout.cancel(hung);
                _chatInFlight = false;
                // R6 - a barge-in after this call went out makes the reply
                // stale: keep its history + stats, but never speak it over
                // the user's newer request.
                var stale = (myEpoch !== _turnEpoch);
                // R1 - record latency + model + tools used
                var elapsed = Date.now() - startedAt;
                c.stats.lastLatencyMs = elapsed;
                _pushLatency(elapsed);
                var r = c.data.response;
                // R9 - NLP dry-run result panel in the Lab
                if (r) _labNlpCapture(r.message, r.tools_called, elapsed);
                else   _labNlpCapture('(empty server response)', [], elapsed);
                if (r) {
                    if (r.model_used) c.stats.lastModel = r.model_used;
                    if (r.route_reason) c.stats.lastRoute = r.route_reason;   // R7 - auto-routing telemetry
                    // R4.5 - defensive Array.isArray; a future server can't
                    // accidentally send a scalar and crash the client.
                    if (Array.isArray(r.tools_called)) {
                        c.stats.toolsCalled += r.tools_called.length || 0;
                        r.tools_called.forEach(function (name) { _countTool(name); });
                        // R1.4 - record the last turn's tool trace
                        c.lastTrace = r.tools_called.map(function (name, i) {
                            return { name: name, order: i + 1 };
                        });
                    }
                    // R2.7 - server told us payload was too large, reset
                    if (r.force_history_reset) {
                        logEvent('warn', 'server requested history reset (payload too large)');
                        geminiHistory = [];
                    }
                    // R2 - act on client directives from tools
                    // R6 - never act on directives from a barged (stale) turn
                    if (r.directives && !stale) {
                        // R8.2 - reminders schedule locally for to-the-minute
                        // announcements while the tab stays open (the scanner
                        // covers closed-tab delivery at ~5 min granularity).
                        if (r.directives.reminder_at_ms) {
                            _scheduleLocalReminder(r.directives.reminder_at_ms, r.directives.reminder_text);
                        }
                        // R8.2 - HARD NAV LOCK on the Live stage: even if a
                        // stale prompt or history slips a directive through,
                        // this page never navigates away.
                        if (c.liveMode && (r.directives.navigate_url || r.directives.open_url || r.directives.click_button_label)) {
                            logEvent('nav', 'live stage - navigation/click directive suppressed');
                        } else {
                        if (r.directives.navigate_url) {
                            logEvent('nav', 'navigating to ' + r.directives.navigate_url);
                            $timeout(function () {
                                try { $window.location.assign(r.directives.navigate_url); } catch (e) {
                                    logEvent('err', 'navigation failed: ' + e.message);
                                }
                            }, 1500);
                        }
                        // R2.4 - open external URL. window.open may be blocked
                        // by Chrome's popup blocker (no user-gesture context).
                        // Show a clickable link in the spoken-response card as
                        // a fallback so the sighted helper can complete the
                        // open with one click - this counts as a user gesture.
                        if (r.directives.open_url) {
                            logEvent('nav', 'opening: ' + r.directives.open_url);
                            $timeout(function () {
                                var win = null;
                                try { win = $window.open(r.directives.open_url, '_blank', 'noopener,noreferrer'); }
                                catch (e) { logEvent('err', 'window.open threw: ' + e.message); }
                                if (!win) {
                                    // Blocked - put a clickable link in c.pendingOpenUrl
                                    // (rendered in the response card)
                                    c.pendingOpenUrl = r.directives.open_url;
                                    logEvent('warn', 'popup blocked - showing clickable link in card');
                                    $scope.$applyAsync();
                                }
                            }, 1500);
                        }
                        if (r.directives.click_button_label) {
                            logEvent('click', 'clicking button: ' + r.directives.click_button_label);
                            $timeout(function () {
                                _findAndClickButton(r.directives.click_button_label);
                            }, 800);
                        }
                        }   // end live-stage nav lock
                    }
                }
                if (!r) {
                    logEvent('err', 'server returned but no response object');
                    c.stats.errors++;
                    setState('error');
                    stopFillerChain();
                    speak('Sorry, the server returned an empty response.', function () {
                        _drainQueuedUtterance();   // R6 - don't drop a barged request
                    });
                    return;
                }
                if (Array.isArray(r.history)) geminiHistory = r.history;
                if (stale) {
                    logEvent('barge', 'reply arrived after barge-in - kept in history, not spoken');
                    lastReply = r.message || lastReply;
                    _drainQueuedUtterance();
                    return;
                }
                if (r.ok) {
                    lastReply = r.message || '';
                    logEvent('srv', 'reply ok (' + lastReply.length + ' chars, ' + elapsed + ' ms)' + (r.model_used ? ' via ' + r.model_used : ''));
                    _convoPush('netra', r.message);   // R7 - chat tab
                    setState('speaking');
                    deliverServerReply(r.message, function () {
                        if (c.alert) {
                            setState('idle');
                            openConversation('after server reply');
                        }
                        // R6 - if she asked a question, wait then nudge once
                        _armReprompt(r.message);
                        _drainQueuedUtterance();
                    });
                } else {
                    logEvent('err', 'server says: ' + (r.message || 'unknown error'));
                    c.stats.errors++;
                    setState('error');
                    cue('error');
                    deliverServerReply(r.message || 'Sorry, something went wrong.', function () {
                        if (c.alert) setState('idle');
                        _drainQueuedUtterance();
                    });
                }
            },
            function (err) {
                $timeout.cancel(hung);
                _chatInFlight = false;
                _labNlpCapture('(transport error)', [], null);
                c.stats.errors++;
                setState('error');
                cue('error');
                logEvent('err', 'transport error: ' + (err && (err.message || err.status) || err));
                stopFillerChain();
                speak('Sorry, I could not reach the server.', function () {
                    if (c.alert) setState('idle');
                    _drainQueuedUtterance();
                });
            }
        );
    }

    // R6 - fire the utterance that was queued while a chat was in flight.
    function _drainQueuedUtterance() {
        if (!_queuedUtterance) return;
        var q = _queuedUtterance;
        _queuedUtterance = null;
        logEvent('srv', 'draining queued utterance: "' + q + '"');
        $timeout(function () { handleHeard(q); }, 80);
    }

    /* ============================================================
     *  R6 - HUMAN TURN-TAKING ENGINE
     *
     *  Three behaviours that make the conversation feel human:
     *
     *  1. BARGE-IN (user interrupts Netra). The old design deafened
     *     the mic for 15s whenever TTS played. Now the mic stays hot:
     *     every final that arrives while Netra is speaking is scored
     *     for token overlap against her own current sentence(s). High
     *     overlap = her own echo -> dropped. Low overlap = the user
     *     talking over her -> her audio stops within ~100ms and the
     *     utterance is processed as the next command. Short reflex
     *     words ("stop", "wait", "hold on") yield instantly even at
     *     one word. Interim (non-final) speech ducks her volume so
     *     she audibly "gives way" while you're still mid-sentence.
     *
     *  2. INTERJECTION (Netra interrupts you, politely). While you
     *     hold the floor for a long stretch she drops soft
     *     backchannels ("mm-hmm", "right") like a human listener.
     *     If she asked a question and hears nothing for a while she
     *     nudges once, gently. Urgent notifications get a courteous
     *     "sorry to cut in" preface instead of barging cold.
     *
     *  3. TURN EPOCHS. Every user turn bumps an epoch counter; a
     *     barge-in bumps it again. A server reply that lands with a
     *     stale epoch is applied to history but never spoken - so
     *     answering an interrupted question never talks over the new
     *     one.
     * ============================================================ */
    var _speakingNow    = false;   // any Netra audio actually playing
    var _speakingSince  = 0;
    var _speakingText   = '';      // what she is saying (for echo scoring)
    var _fillerEchoText = '';      // last filler/backchannel line (also echo-scored)
    var _turnEpoch      = 0;       // bumped per user turn AND per barge-in
    var _chatInFlight   = false;
    var _queuedUtterance = null;   // barge-in that arrived while a chat was in flight
    var _speakSessionId = 0;       // aborts the pipelined-TTS queue on stop
    var _duckedForBarge = false;
    var _duckRestoreTimer = null;
    var _lastBackchannelAt = 0;
    var _interimSpeechStart = 0;
    var _repromptTimer  = null;
    var _repromptArmed  = false;
    var _lastYieldAt    = 0;   // R7 - echo-tail window after an instant yield

    // Reflex interrupts - yield immediately even on a single word.
    var HARD_INTERRUPT_RE = /^(netra[,!.\s]*)?(stop|wait|hold on|hang on|one sec(ond)?|shut up|be quiet|quiet|silence|pause|enough|okay okay|ok ok|no no|never ?mind|ruko|chup|bas)[.!,?\s]*$/i;

    function _normTokens(s) {
        return String(s || '').toLowerCase()
            .replace(/[^a-z0-9\s']/g, ' ')
            .split(/\s+/)
            .filter(function (w) { return w.length > 1; });
    }

    // Score a heard final against what Netra is currently saying (plus the
    // last filler line). High overlap means the mic picked up her own voice.
    function _looksLikeEcho(heard) {
        var heardToks = _normTokens(heard);
        if (!heardToks.length) return true;   // nothing substantive
        var own = {};
        _normTokens(_speakingText).forEach(function (w) { own[w] = 1; });
        _normTokens(_fillerEchoText).forEach(function (w) { own[w] = 1; });
        var hits = 0;
        for (var i = 0; i < heardToks.length; i++) if (own[heardToks[i]]) hits++;
        var ratio = hits / heardToks.length;
        // 1-2 word fragments that all appear in her sentence are echo
        if (heardToks.length <= 2 && ratio >= 0.99) return true;
        return ratio >= ECHO_OVERLAP_RATIO;
    }

    function _markSpeaking(text) {
        _speakingNow   = true;
        _speakingSince = Date.now();
        if (text) _speakingText = String(text);
        // Brief absolute guard while the audio ramps + AEC converges;
        // after this the echo-scorer takes over (mic stays hot).
        ignoreFinalsUntil = Date.now() + BARGE_GUARD_MS;
    }

    function _clearSpeaking() {
        _speakingNow = false;
        ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
        _restoreDuck();
    }

    // Universal silencer - every engine, every filler, the pipeline queue.
    function stopSpeaking(reason) {
        _speakSessionId++;                      // aborts pipelined sentence queue
        _turnEpoch++;                           // any in-flight reply is now stale
        stopFillerChain();
        // R7 - kill the live synthesis socket so streamed audio stops
        // being produced, not just played.
        if (_edgeLiveWs) {
            try {
                _edgeLiveWs.onopen = _edgeLiveWs.onmessage = _edgeLiveWs.onerror = _edgeLiveWs.onclose = null;
                _edgeLiveWs.close();
            } catch (e) {}
            _edgeLiveWs = null;
        }
        if (currentAudio) {
            // Detach the engine's handlers FIRST: setting src='' fires an
            // async 'error' event, and the classic engines' onerror is
            // their fallback-RESPEAK path - without this, every barge on a
            // short reply re-spoke the stale text via the next engine and
            // incremented the persisted circuit breaker.
            try {
                currentAudio.onended = null;
                currentAudio.onerror = null;
                currentAudio.onplaying = null;
                currentAudio.pause();
                currentAudio.src = '';
            } catch (e) {}
            try { detachOutputAnalyser(currentAudio); } catch (e) {}
            currentAudio = null;
        }
        if (TTS && (TTS.speaking || TTS.pending)) {
            try { TTS.cancel(); } catch (e) {}
        }
        _clearSpeaking();
        // R7 - the user is mid-sentence when we yield: do NOT arm even the
        // short 350ms guard, or their own barge final (arriving ~100-300ms
        // later) gets eaten. Echo tails are handled by _lastYieldAt below.
        ignoreFinalsUntil = 0;
        _lastYieldAt = Date.now();
        _cancelReprompt();
        c.stats.barges = (c.stats.barges || 0) + 1;
        // R6 - orb feedback: quick violet flash so a sighted helper sees
        // the yield too (the falling tone covers the blind user).
        c.bargeFlash = true;
        $timeout(function () { c.bargeFlash = false; }, 700);
        logEvent('barge', 'yielded (' + reason + ')');
        _convoPush('sys', '· you interrupted — Netra yielded ·');
        tone([440, 330], 0.07);                 // tiny falling blip: "go ahead" (dur is SECONDS)
        if (c.state === 'speaking' || c.state === 'thinking') {
            setState(c.alert ? 'idle' : 'dormant');
        }
        if (c.alert && !c.conversationOpen) openConversation('post barge-in');
        $scope.$applyAsync();
    }

    // Interim speech while Netra talks -> duck her voice so she audibly
    // gives way. Restored if the final turns out to be her own echo.
    function _duckForInterim() {
        if (!_speakingNow || _duckedForBarge) return;
        if (currentAudio) {
            _duckedForBarge = true;
            try { currentAudio.volume = 0.25; } catch (e) {}
            logEvent('barge', 'ducking - user speaking over me');
        }
        if (_duckRestoreTimer) $timeout.cancel(_duckRestoreTimer);
        _duckRestoreTimer = $timeout(_restoreDuck, 1600);
    }
    function _restoreDuck() {
        if (_duckRestoreTimer) { $timeout.cancel(_duckRestoreTimer); _duckRestoreTimer = null; }
        if (!_duckedForBarge) return;
        _duckedForBarge = false;
        if (currentAudio) { try { currentAudio.volume = 1.0; } catch (e) {} }
    }

    // Decide what to do with a FINAL that arrived while Netra holds the
    // floor (speaking, or filler chain running). Returns true when the
    // final was consumed (echo or reflex-stop); false = process normally.
    function _handleFinalWhileSpeaking(t, conf) {
        var trimmed = String(t || '').trim();
        if (!trimmed) return true;
        if (_looksLikeEcho(trimmed)) {
            logEvent('rec.echo', '"' + trimmed + '" (my own voice, overlap-matched)');
            _restoreDuck();
            return true;
        }
        if (HARD_INTERRUPT_RE.test(trimmed)) {
            stopSpeaking('reflex "' + trimmed + '"');
            _dropFinalBuffer('reflex interrupt');
            return true;
        }
        var words = trimmed.split(/\s+/).length;
        if (trimmed.length < BARGE_MIN_CHARS || words < 2 || (conf > 0 && conf < BARGE_MIN_CONF)) {
            logEvent('rec.echo', '"' + trimmed + '" (too weak to barge: conf=' + (conf || 0).toFixed(2) + ')');
            return true;
        }
        // Genuine barge-in: yield the floor, let the utterance flow on
        // into the normal pipeline as the next command.
        stopSpeaking('user barge-in');
        return false;
    }

    /* ---- Netra-side interjections ---------------------------------- */
    var BACKCHANNEL_PHRASES = ['Mm-hmm.', 'Right.', 'Okay...', 'Hmm.', 'Got it.'];
    var backchannelCache = [];   // [{url, text}]
    function preloadBackchannels() {
        if (typeof WebSocket === 'undefined') return;
        if (_edgeFails >= REMOTE_FAIL_LIMIT) return;
        BACKCHANNEL_PHRASES.forEach(function (p) {
            _edgeBlob(p, c.edgeVoice, function (blob) {
                if (blob) backchannelCache.push({ url: URL.createObjectURL(blob), text: p });
            });
        });
    }
    // Soft listener acknowledgement while the user holds a long turn.
    // Never fires while Netra speaks or thinks; throttled hard.
    function _maybeBackchannel() {
        if (!c.alert) return;
        if (_speakingNow || c.state === 'thinking' || c.state === 'speaking') return;
        if (!backchannelCache.length) return;
        if (Date.now() - _lastBackchannelAt < BACKCHANNEL_GAP_MS) return;
        _lastBackchannelAt = Date.now();
        var pick = backchannelCache[Math.floor(Math.random() * backchannelCache.length)];
        _fillerEchoText = pick.text;
        var a = new Audio(pick.url);
        a.volume = 0.38;   // an aside, not a statement
        c.stats.backchannels = (c.stats.backchannels || 0) + 1;
        logEvent('barge', 'backchannel: "' + pick.text + '"');
        a.play().catch(function () {});
    }

    // If Netra asked a question and the user goes quiet, nudge ONCE.
    function _repromptPhrases() {
        var first = String(c.data && c.data.user_name || '').split(' ')[0];
        return [
            'Take your time... I am listening.',
            'Still here whenever you are ready.',
            first ? ('No rush, ' + first + '... I am with you.') : 'No rush... I am with you.'
        ];
    }
    function _armReprompt(replyText) {
        _cancelReprompt();
        if (!/\?\s*$/.test(String(replyText || '').trim())) return;
        _repromptArmed = true;
        _repromptTimer = $timeout(function () {
            if (!_repromptArmed || !c.alert) return;
            if (_speakingNow || c.state === 'thinking' || c.state === 'speaking') return;
            _repromptArmed = false;
            var bank = _repromptPhrases();
            var line = bank[Math.floor(Math.random() * bank.length)];
            logEvent('barge', 'reprompt nudge');
            speak(line);
        }, REPROMPT_AFTER_MS);
    }
    function _cancelReprompt() {
        _repromptArmed = false;
        if (_repromptTimer) { $timeout.cancel(_repromptTimer); _repromptTimer = null; }
    }

    /* ---- R6 - text humanizer (contractions before TTS) -------------- */
    // The prompt asks the model for contractions, but tool-generated and
    // fallback strings still arrive stiff. Contract them just before
    // synthesis so every engine (edge/gemini/stream/browser) benefits.
    var _CONTRACTION_PAIRS = [
        // [pattern, replacement, guardTail]  guardTail=true only contracts
        // when a word follows (avoids "yes, it's." at clause end).
        ['cannot', "can't", false],       ['can not', "can't", false],
        ['will not', "won't", false],     ['do not', "don't", false],
        ['does not', "doesn't", false],   ['did not', "didn't", false],
        ['would not', "wouldn't", false], ['should not', "shouldn't", false],
        ['could not', "couldn't", false], ['is not', "isn't", false],
        ['are not', "aren't", false],     ['was not', "wasn't", false],
        ['were not', "weren't", false],   ['has not', "hasn't", false],
        ['have not', "haven't", false],   ['let us', "let's", false],
        ['I will', "I'll", false],        ['I am', "I'm", true],
        ['I have', "I've", true],         ['I would', "I'd", true],
        ['you will', "you'll", false],    ['you are', "you're", true],
        ['you have', "you've", true],     ['we will', "we'll", false],
        ['we are', "we're", true],        ['we have', "we've", true],
        ['they are', "they're", true],    ['it is', "it's", true],
        ['that is', "that's", true],      ['there is', "there's", true]
    ];
    function _humanizeReply(text) {
        var out = String(text || '');
        for (var i = 0; i < _CONTRACTION_PAIRS.length; i++) {
            var p = _CONTRACTION_PAIRS[i];
            var re = new RegExp('\\b' + p[0].replace(/ /g, '\\s+') + '\\b' + (p[2] ? '(?=\\s+\\w)' : ''), 'gi');
            out = out.replace(re, function (m) {
                // preserve leading capitalization of the original match
                return m.charAt(0) === m.charAt(0).toUpperCase()
                    ? p[1].charAt(0).toUpperCase() + p[1].slice(1)
                    : p[1];
            });
        }
        return out;
    }

    /* ============================================================
     *  TTS  (remote StreamElements + browser fallback)
     *
     *  Default = remote (StreamElements Raveena, free, no API key,
     *  Indian female voice). On any failure, falls back to browser
     *  SpeechSynthesis (Heera / Neerja / OS voices).
     * ============================================================ */
    function speak(text, done) {
        if (!text) {
            // Even with no text, fire callback + reset state to keep the
            // state machine consistent.
            _afterTTS(done);
            return;
        }
        // R9 - Lab mute: captions still update, no audio (used for NLP
        // dry-runs and quiet dev sessions).
        if (c.labMute) {
            c.spoken = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
            logEvent('tts', 'muted (lab): "' + c.spoken.substring(0, 60) + '"');
            $scope.$applyAsync();
            $timeout(function () { _afterTTS(done); }, 60);
            return;
        }

        // R3.8 - preserve **word** markdown (used for SSML emphasis on Edge
        // TTS) but strip everything else. The c.spoken display still gets
        // the fully-cleaned version so the dev panel reads naturally.
        // R6 - _humanizeReply first: contractions make every engine less stiff.
        var clean = _humanizeReply(String(text))
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[_`#>]/g, '')           // strip _ ` # > only - keep *
            .replace(/\s+/g, ' ')
            .trim();
        c.spoken = clean.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*/g, '');
        $scope.$applyAsync();

        // R6 - register what she is about to say for the echo-scorer and
        // clear any pending question-nudge (she is taking the floor).
        _markSpeaking(c.spoken);
        _cancelReprompt();

        // R1: wrap the done callback so state ALWAYS resets to idle/dormant
        // after TTS finishes - prevents "stuck in speaking" bug.
        var wrappedDone = function () { _afterTTS(done); };

        // R2.8 - engine selection. 'gemini' uses Gemini-native TTS
        // (same key as chat, costs a Gemini-quota credit per turn,
        // sounds most like Gemini chat). Otherwise fall through to
        // Edge / StreamElements / browser as before.
        var engine = c.ttsEngine || (c.useRemoteTTS ? 'edge' : 'browser');
        if (engine === 'gemini') {
            speakGemini(clean, wrappedDone);
        } else if (engine === 'edge') {
            // R7 - live-streamed synthesis (MediaSource): audio starts on
            // the first chunk, prosody flows unbroken across the whole
            // reply, and a barge-in cuts it mid-syllable. Falls back to
            // the pipelined/blob paths when MSE is unavailable.
            speakEdgeLive(clean, wrappedDone);
        } else if (engine === 'stream') {
            speakStreamElements(clean, wrappedDone);
        } else {
            speakBrowser(clean, wrappedDone);
        }
    }

    /* ============================================================
     *  R6 - PIPELINED EDGE TTS (sentence-streamed speech)
     *
     *  Splits the reply into sentence groups (~<=200 chars), synthesizes
     *  group 1 immediately and starts playing it while group 2 renders in
     *  the background - so long answers begin in the time it takes to
     *  synthesize ONE sentence. Prosody stays natural because breaks land
     *  on real sentence boundaries. A bumped _speakSessionId (barge-in /
     *  stop) abandons the queue instantly. Any synth failure falls back
     *  to the classic single-shot path for the remaining text.
     * ============================================================ */
    function _splitSentenceGroups(text, maxLen) {
        var sentences = String(text || '').match(/[^.!?]+[.!?]+["']?\s*|[^.!?]+$/g) || [String(text || '')];
        var groups = [], cur = '';
        for (var i = 0; i < sentences.length; i++) {
            var s = sentences[i];
            if (cur && (cur.length + s.length) > maxLen) { groups.push(cur.trim()); cur = s; }
            else cur += s;
        }
        if (cur.trim()) groups.push(cur.trim());
        return groups;
    }

    function speakEdgePipelined(text, done) {
        if (_edgeFails >= REMOTE_FAIL_LIMIT || typeof WebSocket === 'undefined') {
            return speakEdgeTTS(text, done);
        }
        var session = ++_speakSessionId;
        var groups = _splitSentenceGroups(text, 200);
        if (groups.length <= 1) return speakEdgeTTS(text, done);

        setState('speaking');
        var blobs = new Array(groups.length);   // null=pending, false=failed, Blob=ready
        var waiters = new Array(groups.length);
        groups.forEach(function (g, i) {
            blobs[i] = null;
            _edgeSsmlBlob(g, c.edgeVoice, function (blob) {
                blobs[i] = blob || false;
                if (waiters[i]) { var w = waiters[i]; waiters[i] = null; w(); }
            });
        });
        logEvent('tts', 'edge-pipeline: ' + groups.length + ' segments (' + text.length + ' chars)');

        var idx = 0;
        function playNext() {
            if (session !== _speakSessionId) return;                 // barged / stopped
            if (idx >= groups.length) { _clearSpeaking(); if (done) done(); return; }
            var i = idx++;
            var ready = function () {
                if (session !== _speakSessionId) return;
                if (blobs[i] === false) {
                    // synth failed - speak the rest via the classic path
                    var rest = groups.slice(i).join(' ');
                    logEvent('warn', 'edge-pipeline segment ' + (i + 1) + ' failed - single-shot fallback for rest');
                    return speakEdgeTTS(rest, done);
                }
                var url = URL.createObjectURL(blobs[i]);
                var audio = new Audio(url);
                audio.playbackRate = 1.0;   // R7 - pace lives in SSML prosody
                audio.volume = _duckedForBarge ? 0.25 : 1.0;
                currentAudio = audio;
                attachOutputAnalyser(audio);
                // NOTE: _speakingText deliberately stays the FULL reply
                // (set by speak() -> _markSpeaking). Recognizer finals lag
                // real audio by 0.5-2s, so at segment boundaries the echo
                // of the PREVIOUS segment must still score as echo -
                // scoring against only the current segment made her
                // interrupt herself mid-reply.
                _speakingNow = true;
                // One advance per segment, no matter how many of ended /
                // error / play()-rejection fire (a bad blob fires both
                // error AND the rejection - unguarded, that double-walked
                // the queue and double-fired done()).
                var segSettled = false;
                var advanceOnce = function () {
                    if (segSettled) return;
                    segSettled = true;
                    detachOutputAnalyser(audio);
                    URL.revokeObjectURL(url);
                    if (currentAudio === audio) currentAudio = null;
                    playNext();
                };
                audio.onended = advanceOnce;
                audio.onerror = advanceOnce;
                audio.play().catch(advanceOnce);
            };
            if (blobs[i] !== null) ready();
            else waiters[i] = ready;
        }
        playNext();
    }

    /* ============================================================
     *  R7 - LIVE STREAMED EDGE TTS (MediaSource)
     *
     *  One WSS request for the whole reply; MP3 chunks are appended to
     *  a MediaSource SourceBuffer as they arrive and playback starts on
     *  the FIRST chunk. Compared to the blob/pipelined paths:
     *    - time-to-first-audio ~= synthesis latency of the opening
     *      words, regardless of reply length
     *    - prosody is continuous across the whole reply (no segment
     *      boundaries, no walkie-talkie gaps)
     *    - a barge-in cuts the stream mid-syllable (stopSpeaking also
     *      closes the socket via _edgeLiveWs)
     *  Falls back to the pipelined/blob paths when MSE is unavailable,
     *  and to the usual engine chain on any pre-audio failure.
     * ============================================================ */
    var _edgeLiveWs = null;
    function speakEdgeLive(text, done) {
        if (_edgeFails >= REMOTE_FAIL_LIMIT) return speakStreamElements(text, done);
        if (typeof WebSocket === 'undefined') return speakStreamElements(text, done);
        if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported('audio/mpeg')) {
            return (text.length > 220 ? speakEdgePipelined(text, done) : speakEdgeTTS(text, done));
        }
        var session = ++_speakSessionId;
        var settled = false, audioStarted = false, playRequested = false;
        var gotAnyAudio = false, wsEnded = false;
        var ws = null, sb = null, audio = null, url = null;
        var pendingChunks = [];
        var msrc = new MediaSource();

        function cleanup() {
            if (ws) {
                if (_edgeLiveWs === ws) _edgeLiveWs = null;
                try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch (e) {}
            }
            if (audio) {
                try { audio.onended = audio.onerror = audio.onplaying = null; } catch (e) {}
                try { detachOutputAnalyser(audio); } catch (e) {}
                if (currentAudio === audio) currentAudio = null;
            }
            if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        }
        function finish() {
            if (settled) return;
            settled = true;
            $timeout.cancel(watchdog);
            cleanup();
            _clearSpeaking();
            if (done) { try { done(); } catch (e) {} }
        }
        function bail(reason) {
            if (settled) return;
            // Once real audio has played, never fall back (it would respeak
            // the reply from the top) - just end the turn cleanly.
            if (audioStarted) {
                logEvent('warn', 'edge-live mid-play issue (' + reason + ') - ending turn');
                return finish();
            }
            settled = true;
            $timeout.cancel(watchdog);
            cleanup();
            if (session !== _speakSessionId) return;   // user barged - stay silent
            logEvent('warn', 'edge-live: ' + reason + ' - falling back');
            _edgeFallback(text, done);
        }
        var watchdog = $timeout(function () { if (!audioStarted) bail('no audio in 6s'); }, 6000);

        function pump() {
            if (settled || !sb) return;
            if (!sb.updating && pendingChunks.length) {
                var chunk = pendingChunks.shift();
                try { sb.appendBuffer(chunk); } catch (e) { bail('appendBuffer: ' + (e.message || e)); }
                return;
            }
            if (wsEnded && !sb.updating && !pendingChunks.length && msrc.readyState === 'open') {
                try { msrc.endOfStream(); } catch (e) {}
            }
        }
        function requestPlay() {
            if (playRequested || settled) return;
            playRequested = true;
            audio.play().catch(function (e) { bail('play() rejected: ' + (e && e.message || e)); });
        }

        // Never overlap: silence whatever is already playing (handlers
        // detached first so their fallback paths don't fire).
        if (currentAudio) {
            try { currentAudio.onended = currentAudio.onerror = currentAudio.onplaying = null; currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
            currentAudio = null;
        }
        if (TTS && (TTS.speaking || TTS.pending)) { try { TTS.cancel(); } catch (e) {} }
        try {
            audio = new Audio();
            url = URL.createObjectURL(msrc);
            audio.src = url;
            audio.playbackRate = 1.0;
            audio.volume = _duckedForBarge ? 0.25 : 1.0;
            currentAudio = audio;
            msrc.addEventListener('sourceopen', function () {
                if (settled || sb) return;
                try { sb = msrc.addSourceBuffer('audio/mpeg'); } catch (e) { return bail('addSourceBuffer: ' + (e.message || e)); }
                sb.addEventListener('updateend', pump);
                pump();
            });
            setState('speaking');
            attachOutputAnalyser(audio);
            audio.onplaying = function () {
                audioStarted = true;
                $timeout.cancel(watchdog);
                _edgeFails = 0;
                _ssSet('netra_edgeFails', 0);
                logEvent('tts', 'edge-live playing: ' + c.edgeVoice + ' (streamed, ' + text.length + ' chars)');
            };
            audio.onended = finish;
            audio.onerror = function () {
                if (audioStarted) finish();   // mid-play glitch: never respeak
                else bail('audio element error');
            };

            _edgeWssUrl(function (wssUrl, requestId) {
            if (settled) return;
            try { ws = new WebSocket(wssUrl); }
            catch (eW) { return bail('ws ctor: ' + (eW.message || eW)); }
            _edgeLiveWs = ws;
            ws.binaryType = 'arraybuffer';
            ws.onopen = function () {
                if (settled) return;
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"' + EDGE_AUDIO_FORMAT + '"}}}}';
                ws.send('X-Timestamp:' + new Date().toISOString() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                var ssml = _buildHumanSSML(text, c.edgeVoice);
                ws.send('X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' + ssml);
                _markSpeaking(text);
            };
            ws.onmessage = function (ev) {
                if (settled) return;
                if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('Path:turn.end') >= 0) {
                        wsEnded = true;
                        try { ws.close(); } catch (e) {}
                        if (!gotAnyAudio) return bail('no audio returned');
                        pump();
                        requestPlay();   // very short replies may end before first play
                    }
                    return;
                }
                var d = new Uint8Array(ev.data);
                if (d.length < 2) return;
                var hl = (d[0] << 8) | d[1];
                if (d.length > 2 + hl) {
                    gotAnyAudio = true;
                    pendingChunks.push(d.slice(2 + hl));
                    pump();
                    requestPlay();
                }
            };
            ws.onerror = function () {
                if (!audioStarted) bail('ws error');
                else { wsEnded = true; pump(); }
            };
            ws.onclose = function () { wsEnded = true; pump(); };
            });   // _edgeWssUrl
        } catch (e) {
            bail('threw: ' + (e.message || e));
        }
    }

    // SSML-aware variant of _edgeBlob: same WSS transport, but runs the
    // text through _buildHumanSSML so pipelined segments keep the stress /
    // breath / hesitation prosody of the single-shot path.
    function _edgeSsmlBlob(text, voice, cb) {
        _edgeWssUrl(function (wssUrl, requestId) {
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var settled = false;
            var watchdog = $timeout(function () {
                if (!settled) { settled = true; try { ws.close(); } catch (e) {} cb(null); }
            }, 6000);
            ws.onopen = function () {
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"' + EDGE_AUDIO_FORMAT + '"}}}}';
                ws.send('X-Timestamp:' + new Date().toISOString() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                var ssml = _buildHumanSSML(text, voice || c.edgeVoice);
                ws.send('X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' + ssml);
            };
            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('Path:turn.end') >= 0) {
                        try { ws.close(); } catch (e) {}
                        if (settled) return;
                        settled = true;
                        $timeout.cancel(watchdog);
                        cb(chunks.length ? new Blob(chunks, { type: 'audio/mp3' }) : null);
                    }
                } else {
                    var data = new Uint8Array(ev.data);
                    if (data.length < 2) return;
                    var headerLen = (data[0] << 8) | data[1];
                    if (data.length > 2 + headerLen) chunks.push(data.slice(2 + headerLen));
                }
            };
            ws.onerror = function () { if (!settled) { settled = true; $timeout.cancel(watchdog); cb(null); } };
            ws.onclose = function () { if (!settled) { settled = true; $timeout.cancel(watchdog); cb(null); } };
        } catch (e) { cb(null); }
        });   // _edgeWssUrl
    }

    // Build SSML body with natural breath breaks between sentences.
    // Splits on .!? boundaries and inserts <break time="180ms"/>.
    function _buildHumanSSML(text, voice) {
        // R3.8 - human prosody: stress emphasis, longer breaths, ellipsis
        // pauses, and pitch-dip on natural verbal fillers. Order matters:
        // we replace markdown markers with placeholder sentinels first so
        // they survive the XML escape pass, then insert breaks, then expand
        // sentinels into real SSML tags.
        // R4.5 - cap input length. Edge TTS hard-limits SSML to ~4 KB and
        // each replace() copies the string, so 50 KB input does ~400 KB
        // garbage. Real LLM replies are <2 KB; anything bigger is an
        // error path leaking a stack trace.
        var t = String(text || '').substring(0, 6000);
        // R4 - if Gemini emitted an odd number of "**" markers, the last
        // emphasis block never closes. Heuristic: close it at the next
        // sentence boundary so we keep the stress instead of losing it.
        var doubleCount = (t.match(/\*\*/g) || []).length;
        if (doubleCount % 2 === 1) {
            t = t.replace(/\*\*([^*]*)$/, function(_, tail) {
                var idx = tail.search(/[.!?]/);
                return idx >= 0 ? '**' + tail.substring(0, idx) + '**' + tail.substring(idx)
                                : '**' + tail + '**';
            });
        }
        // Step 1: collapse runs of asterisks. **word** -> emphasis sentinel.
        t = t.replace(/\*\*([^*]+)\*\*/g, '\uE000EM\uE000$1\uE000/EM\uE000');
        // Strip any leftover lone asterisks so they don't leak in.
        t = t.replace(/\*/g, '');
        // Step 2: ellipsis = thinking pause (~350ms)
        t = t.replace(/\.{3,}/g, '\uE000LP\uE000');
        // Step 3: XML escape everything else
        t = t.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&apos;');
        // Step 4: sentence / comma / em-dash breath breaks (lengthened)
        // R6 - vary the sentence breath with the sentence that FOLLOWS
        // was implicit; instead vary by simple alternation so back-to-back
        // sentences never get the identical metronome gap (280/340/300ms).
        var _breathSeq = [280, 340, 300], _breathIx = 0;
        t = t.replace(/([.!?]+)(\s|$)/g, function (_, p, sp) {
            var ms = _breathSeq[_breathIx++ % _breathSeq.length];
            return p + '<break time="' + ms + 'ms"/>' + sp;
        });
        t = t.replace(/(,)(\s)/g, '$1<break time="150ms"/>$2');
        t = t.replace(/( - | -- | — )/g, '<break time="240ms"/>$1');
        // Step 5: pitch-dip on natural verbal fillers so umm/uh/ah sound
        // like real human hesitation, not flat words.
        t = t.replace(/\b(umm+|uhh*|ahh+|hmm+|mm+|well)\b(?=,)/gi,
                      '<prosody pitch="-2st" rate="-15%" volume="-2dB">$1</prosody>');
        // Step 6: expand sentinels
        t = t.replace(/\uE000EM\uE000/g, '<emphasis level="strong">');
        t = t.replace(/\uE000\/EM\uE000/g, '</emphasis>');
        t = t.replace(/\uE000LP\uE000/g, '<break time="380ms"/>');
        // R7 - pace from the user-tunable c.speechRate rendered natively by
        // the vocoder; pitch stays neutral (the multilingual voices handle
        // their own intonation far better than a blanket +1st shift did).
        var ratePct = Math.round(((c.speechRate || 1.06) - 1) * 100);
        var rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
        return '<speak version=\'1.0\' xml:lang=\'en-US\'>' +
               '<voice name=\'' + voice + '\'>' +
               '<prosody rate=\'' + rateStr + '\' pitch=\'+0st\'>' + t + '</prosody>' +
               '</voice></speak>';
    }

    // Output FREQUENCY analyser (R2.12): each of the 24 voice-ring vertices
    // is driven by a separate logarithmic frequency band, so the ring
    // ripples like a music-visualiser — bass bins move the bottom-left
    // bars, treble bins move the top-right bars. Reads getByteFrequencyData
    // (FFT spectrum) instead of getByteTimeDomainData (amplitude RMS).
    //
    // fftSize 1024 -> 512 frequency bins.  Bucket those into 24 log-spaced
    // bands so each ring vertex hears a different slice of the spectrum.
    var _outRafId = null;
    // Precomputed band boundaries (bin indices) for 24 log-spaced bands
    var VOICE_RING_BAND_BOUNDS = (function () {
        var nBins  = 512;            // matches fftSize=1024
        var bottom = 2;              // skip the DC + first bin (rumble)
        var top    = 256;            // ignore the very-top half (mostly noise)
        var bands  = new Array(24 + 1);
        for (var b = 0; b <= 24; b++) {
            bands[b] = Math.floor(bottom * Math.pow(top / bottom, b / 24));
        }
        return bands;
    })();

    function attachOutputAnalyser(audioEl) {
        if (!audioEl || !window.AudioContext) return;
        try {
            var ctx = _micCtx || new (window.AudioContext || window.webkitAudioContext)();
            var analyser;
            if (audioEl.__netraSrc) {
                analyser = audioEl.__netraSrc.netraAnalyser;
            } else {
                var src = ctx.createMediaElementSource(audioEl);
                analyser = ctx.createAnalyser();
                analyser.fftSize = 1024;                   // 512 frequency bins
                analyser.smoothingTimeConstant = 0.65;     // a bit of decay so bars don't snap
                src.connect(analyser);
                analyser.connect(ctx.destination);
                audioEl.__netraSrc = src;
                src.netraAnalyser = analyser;
            }
            if (_outRafId) cancelAnimationFrame(_outRafId);
            var data = new Uint8Array(analyser.frequencyBinCount);
            var lastLevel = -1;
            var tick = function () {
                if (audioEl.paused || audioEl.ended) {
                    if (c.audioLevel !== 0) {
                        c.audioLevel = 0;
                        c.audioLevels = null;              // clear per-band when silent
                        _setOrbPulse(0);                   // collapse the speaker cone
                        $scope.$applyAsync();
                    }
                    return;
                }
                // FREQUENCY-DOMAIN: getByteFrequencyData fills `data` with
                // a normalised spectrum (0..255 per bin).  Aggregate into
                // the 24 log-spaced bands.
                analyser.getByteFrequencyData(data);
                var bands = new Array(24);
                var bandSum = 0;
                for (var b = 0; b < 24; b++) {
                    var lo = VOICE_RING_BAND_BOUNDS[b];
                    var hi = VOICE_RING_BAND_BOUNDS[b + 1];
                    if (hi <= lo) hi = lo + 1;
                    var s = 0, n = 0;
                    for (var k = lo; k < hi && k < data.length; k++) { s += data[k]; n++; }
                    var raw = n ? (s / n) / 255 * 220 : 0;
                    // R2.12.4 - per-band noise gate: zero out quiet
                    // frequencies (< 15) so brief gaps in speech don't
                    // produce stuck spikes from ambient PCM noise.
                    var v = (raw < 15) ? 0 : Math.min(100, raw);
                    bands[b] = v;
                    bandSum += v;
                }
                // R2.12.4 - if the overall band sum is tiny (audio is in a
                // pause between words), null out the bands so the ring
                // snaps to a smooth circle instead of holding the last
                // spike pattern.
                if (bandSum < 30) {
                    c.audioLevels = null;
                    _setOrbPulse(0);
                } else {
                    c.audioLevels = bands;
                    var bass = (bands[0] + bands[1] + bands[2]) / 3;
                    _setOrbPulse(bass / 100);
                }
                var level = Math.round(bandSum / 24);
                if (level !== lastLevel) {
                    lastLevel = level;
                    c.audioLevel = level;
                    $scope.$applyAsync();
                }
                _outRafId = requestAnimationFrame(tick);
            };
            tick();
        } catch (e) {
            logEvent('warn', 'output analyser: ' + (e.message || e));
        }
    }

    // Web Audio nodes are otherwise retained by the AudioContext for the
    // lifetime of the page, so each utterance would leak a source+analyser.
    function detachOutputAnalyser(audioEl) {
        if (!audioEl || !audioEl.__netraSrc) return;
        var src = audioEl.__netraSrc;
        var a = src.netraAnalyser;
        try { if (a) a.disconnect(); } catch (e) {}
        try { src.disconnect(); } catch (e) {}
        audioEl.__netraSrc = null;
    }

    // Unified post-TTS handler: reset state, ensure mic is open, fire user callback.
    function _afterTTS(userDone) {
        // R6 - whatever path got us here, the floor is free again.
        _speakingNow = false;
        _restoreDuck();
        // Reset state if we're still in "speaking" - some callbacks may have
        // already moved us forward (e.g. thinking -> speaking -> idle).
        if (c.state === 'speaking') {
            setState(c.alert ? 'idle' : 'dormant');
        }
        // Always make sure the conversation is open after Netra speaks - she
        // should be ready to hear the user's next utterance.
        if (c.alert && !c.conversationOpen) {
            openConversation('post-TTS auto');
        }
        // If recognition somehow stopped, kick it back up.
        if (c.hasSR && !c.recRunning && c.permission !== 'denied') {
            logEvent('rec', 'auto-restart after TTS (was not running)');
            $timeout(startContinuous, 200);
        }
        if (userDone) { try { userDone(); } catch (e) { logEvent('err', 'done callback threw: ' + e); } }
    }

    /* ============================================================
     *  R1.5 - EDGE TTS (Microsoft Neural voices, free, no key)
     *
     *  Connects to wss://speech.platform.bing.com/.../edge/v1
     *  with a hardcoded TrustedClientToken that all Edge browsers
     *  use. Streams MP3 chunks back, assembled into a Blob and
     *  played through an <audio> element at default playbackRate (1.0).
     *
     *  Voices: en-IN-NeerjaNeural (default - warm Indian female),
     *  en-IN-AashiNeural, en-IN-AnanyaNeural, hi-IN-SwaraNeural.
     *
     *  Falls back to speakStreamElements -> speakBrowser on error.
     * ============================================================ */
    var EDGE_WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    // R7 - default voice: Ava Multilingual, Microsoft's newest-generation
    // neural voice on the free Edge channel. Dramatically more fluent and
    // expressive than the older en-IN voices (closest free match to the
    // "GPT Live" sound) and handles Hinglish code-switching natively.
    // User's pick persists in localStorage via the dev-panel voice picker.
    c.edgeVoice = 'en-US-AvaMultilingualNeural';
    var EDGE_VOICES = [
        'en-US-AvaMultilingualNeural',   // newest gen, most human (default)
        'en-US-EmmaMultilingualNeural',  // newest gen, brighter
        'en-US-AndrewMultilingualNeural',// newest gen, male
        'en-US-BrianMultilingualNeural', // newest gen, male casual
        'en-US-JennyNeural', 'en-US-AriaNeural',
        'en-IN-NeerjaNeural', 'en-IN-AashiNeural', 'en-IN-AnanyaNeural',
        'hi-IN-SwaraNeural', 'en-GB-SoniaNeural'
    ];
    // R7 - Edge audio: 48 -> 96 kbps. The low bitrate was a big part of
    // the "tin box" sound; 96k MP3 at 24kHz is transparent for speech.
    var EDGE_AUDIO_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
    // R7 - speech pace via SSML prosody (natural vocoder timing) instead
    // of HTMLAudio playbackRate (which added the phasey chipmunk artifact).
    c.speechRate = 1.06;   // 1.0 = Ava's natural pace; slider in dev panel
    try {
        var _pv = localStorage.getItem('netra_edgeVoice');
        if (_pv && EDGE_VOICES.indexOf(_pv) >= 0) c.edgeVoice = _pv;
        var _pr = parseFloat(localStorage.getItem('netra_speechRate'));
        if (_pr >= 0.85 && _pr <= 1.3) c.speechRate = _pr;
    } catch (e) {}

    function _edgeConnectId() {
        // 32-hex random
        var chars = '0123456789abcdef';
        var s = '';
        for (var i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * 16)];
        return s;
    }

    // R8 - Sec-MS-GEC anti-abuse token. Microsoft now 403s the readaloud
    // WSS unless the URL carries a SHA-256 of (current 5-minute window in
    // Windows 100ns ticks + the trusted client token) - the same scheme
    // the edge-tts library implements. Without this EVERY Edge synthesis
    // fails and Netra falls back to the robotic voices, or silence.
    var EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    var EDGE_GEC_VERSION = '1-130.0.2849.68';
    var _gecCache = { win: 0, val: '' };
    function _edgeSecMsGec(cb) {
        var win = Math.floor((Date.now() / 1000 + 11644473600) / 300) * 300;
        if (_gecCache.win === win && _gecCache.val) return cb(_gecCache.val);
        // ticks = seconds * 1e7 exceeds 2^53, so build the digits as a
        // string: integer seconds followed by seven zeros.
        var str = String(win) + '0000000' + EDGE_TRUSTED_TOKEN;
        if (!(window.crypto && window.crypto.subtle && window.TextEncoder)) return cb('');
        try {
            window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
                var b = new Uint8Array(buf), hex = '';
                for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
                _gecCache = { win: win, val: hex.toUpperCase() };
                cb(_gecCache.val);
            }, function () { cb(''); });
        } catch (e) { cb(''); }
    }
    function _edgeWssUrl(cb) {
        _edgeSecMsGec(function (gec) {
            var id = _edgeConnectId();
            var url = EDGE_WSS_URL +
                (gec ? '&Sec-MS-GEC=' + gec + '&Sec-MS-GEC-Version=' + EDGE_GEC_VERSION : '') +
                '&ConnectionId=' + id;
            cb(url, id);
        });
    }

    /* ============================================================
     *  R2.8 - GEMINI-NATIVE TTS (opt-in)
     *  Hits the same Gemini API the chat uses, but the speech model.
     *  Returns base64 PCM 24kHz mono. We wrap it in a WAV header
     *  client-side and play via <audio>. Quality matches what Gemini
     *  itself sounds like, since it IS Gemini's voice.
     *  Cost: each speak = 1 Gemini quota credit (same as chat call).
     *  Falls back to Edge TTS if the model is unavailable.
     * ============================================================ */
    c.geminiVoice = 'Kore';   // warm female; alternatives: Puck, Charon, Aoede, Fenrir
    var GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

    function _pcmToWavBlob(b64, sampleRate) {
        // Decode base64 PCM16 -> ArrayBuffer
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        // PCM data length
        var pcmLen = bytes.byteLength;
        // Build a WAV header: 44 bytes + PCM
        var buf = new ArrayBuffer(44 + pcmLen);
        var view = new DataView(buf);
        function writeStr(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + pcmLen, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);          // PCM subchunk size
        view.setUint16(20, 1, true);           // PCM format
        view.setUint16(22, 1, true);           // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // byte rate
        view.setUint16(32, 2, true);           // block align
        view.setUint16(34, 16, true);          // bits per sample
        writeStr(36, 'data');
        view.setUint32(40, pcmLen, true);
        new Uint8Array(buf, 44).set(bytes);
        return new Blob([buf], { type: 'audio/wav' });
    }

    function speakGemini(text, done) {
        if (!text) { _afterTTS(done); return; }
        c.data.action = 'gemini_tts';
        c.data.text   = text;
        c.data.voice  = c.geminiVoice;
        _markSpeaking(text);   // R6 - hot mic: echo-scored, not deafened
        var resolved = false;
        var watchdog = $timeout(function () {
            if (!resolved) { resolved = true;
                logEvent('warn', 'gemini-tts no response in 12s - fallback edge');
                speakEdgeTTS(text, done);
            }
        }, 12000);
        c.server.update().then(function () {
            if (resolved) return;
            $timeout.cancel(watchdog);
            var r = c.data.gemini_tts;
            if (!r || !r.ok || !r.b64) {
                resolved = true;
                logEvent('warn', 'gemini-tts failed: ' + (r && r.error || 'no data') + ' - fallback edge');
                speakEdgeTTS(text, done);
                return;
            }
            // mime is "audio/L16;rate=24000" - extract rate
            var rate = 24000;
            var m = String(r.mime).match(/rate=(\d+)/);
            if (m) rate = parseInt(m[1], 10) || 24000;
            try {
                var blob = _pcmToWavBlob(r.b64, rate);
                var url = URL.createObjectURL(blob);
                var audio = new Audio(url);
                audio.playbackRate = 1.0;   // R7 - pace lives in SSML prosody (playbackRate sounded phasey)
                audio.volume = 1.0;
                currentAudio = audio;
                logEvent('tts', 'gemini: ' + r.voice + ' (' + Math.round(r.b64.length / 1024) + ' KB)');
                setState('speaking');
                // Hook the Web Audio analyser BEFORE play() so MediaElementSource
                // is in place before audio starts streaming - otherwise the analyser
                // reads silence and the aura never expands while Netra speaks.
                attachOutputAnalyser(audio);
                audio.onplaying = function () {
                    logEvent('tts', 'gemini playing');
                };
                audio.onended = function () {
                    if (resolved) return;
                    resolved = true;
                    detachOutputAnalyser(audio);
                    URL.revokeObjectURL(url);
                    if (currentAudio === audio) currentAudio = null;
                    _clearSpeaking();   // R6
                    if (done) try { done(); } catch (e) {}
                };
                audio.onerror = function () {
                    if (resolved) return;
                    resolved = true;
                    detachOutputAnalyser(audio);
                    URL.revokeObjectURL(url);
                    logEvent('warn', 'gemini audio playback error - fallback edge');
                    speakEdgeTTS(text, done);
                };
                audio.play().catch(function (e) {
                    if (resolved) return;
                    resolved = true;
                    logEvent('warn', 'gemini play() rejected: ' + (e && e.message || e));
                    speakEdgeTTS(text, done);
                });
            } catch (eW) {
                resolved = true;
                logEvent('err', 'gemini WAV wrap failed: ' + (eW.message || eW));
                speakEdgeTTS(text, done);
            }
        }, function () {
            if (resolved) return;
            resolved = true;
            $timeout.cancel(watchdog);
            logEvent('warn', 'gemini-tts transport error - fallback edge');
            speakEdgeTTS(text, done);
        });
    }

    // R4.3 - circuit breaker now persists in localStorage so it survives
    // tab closes, browser restarts, and machine reboots. Without this,
    // every fresh tab paid 5-10s waiting for Edge + Stream timeouts on
    // networks that permanently block them. Counter is auto-cleared on
    // any successful play(), so if the user moves to a working network
    // the very next remote success resets the breaker. Falls back to
    // sessionStorage if localStorage is unavailable (privacy mode etc).
    var REMOTE_FAIL_LIMIT = 2;
    var _store = (function () {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('__netra_ls_probe', '1');
                localStorage.removeItem('__netra_ls_probe');
                return localStorage;
            }
        } catch (e) {}
        try { if (typeof sessionStorage !== 'undefined') return sessionStorage; } catch (e) {}
        return null;
    })();
    var _ssGet = function (k, def) {
        if (!_store) return def;
        try { var v = _store.getItem(k); return v === null ? def : parseInt(v, 10) || 0; }
        catch (e) { return def; }
    };
    var _ssSet = function (k, v) {
        if (!_store) return;
        try { _store.setItem(k, String(v)); } catch (e) {}
    };
    // R8 - reset the persisted circuit breaker whenever the widget code
    // changes (build tag bump). Without this, a breaker that opened during
    // a genuinely-broken build (e.g. the pre-GEC Edge 403 storm) stayed
    // open in localStorage across every future session, permanently
    // pinning Netra to the robotic fallback even after the fix shipped.
    var NETRA_BUILD = 'R8-gec-1';
    try {
        if (_store && _store.getItem('netra_build') !== NETRA_BUILD) {
            _store.removeItem('netra_edgeFails');
            _store.removeItem('netra_streamFails');
            _store.setItem('netra_build', NETRA_BUILD);
            logEvent('tts', 'new build ' + NETRA_BUILD + ' - cleared TTS circuit breakers');
        }
    } catch (e) {}
    var _edgeFails = _ssGet('netra_edgeFails', 0);
    var _streamFails = _ssGet('netra_streamFails', 0);
    if (_edgeFails >= REMOTE_FAIL_LIMIT) logEvent('tts', 'edge circuit was open from previous session (' + _edgeFails + ' fails) - skipping Edge');
    if (_streamFails >= REMOTE_FAIL_LIMIT) logEvent('tts', 'stream circuit was open from previous session (' + _streamFails + ' fails) - skipping Stream');

    function _edgeFallback(text, done) {
        _edgeFails++;
        _ssSet('netra_edgeFails', _edgeFails);
        if (_edgeFails === REMOTE_FAIL_LIMIT) {
            logEvent('tts', 'edge circuit open - skipping for this session');
        }
        speakStreamElements(text, done);
    }
    function _streamFallback(text, done, reason) {
        _streamFails++;
        _ssSet('netra_streamFails', _streamFails);
        if (_streamFails === REMOTE_FAIL_LIMIT) {
            logEvent('tts', 'stream circuit open - skipping for this session');
        }
        logEvent('warn', 'remote -> browser fallback: ' + reason);
        speakBrowser(text, done);
    }

    function speakEdgeTTS(text, done) {
        if (!text) { _afterTTS(done); return; }
        // R3.5.2 - skip if circuit is open
        if (_edgeFails >= REMOTE_FAIL_LIMIT) {
            return speakStreamElements(text, done);
        }
        // Some networks/CSPs forbid arbitrary WSS - fall back fast if blocked.
        if (typeof WebSocket === 'undefined') {
            return speakStreamElements(text, done);
        }
        _edgeWssUrl(function (wssUrl, requestId) {
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var resolved = false;
            var watchdog = $timeout(function () {
                if (!resolved) { resolved = true; try { ws.close(); } catch (e) {}
                    logEvent('warn', 'edge TTS no audio in 6s - fallback');
                    _edgeFallback(text, done);
                }
            }, 6000);

            ws.onopen = function () {
                logEvent('tts', 'edge: ' + c.edgeVoice + ' (' + text.length + ' chars)');
                var now = new Date().toISOString();
                // 1. Speech config
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"' + EDGE_AUDIO_FORMAT + '"}}}}';
                ws.send('X-Timestamp:' + now + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                // 2. SSML body with sentence/comma/em-dash breath breaks.
                //    R1.6 - one continuous audio stream with natural pacing
                //    inside, rather than multiple TTS calls per sentence.
                var ssml = _buildHumanSSML(text, c.edgeVoice);
                ws.send('X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' + ssml);
                _markSpeaking(text);   // R6 - hot mic: echo-scored, not deafened
                setState('speaking');
            };

            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('Path:turn.end') >= 0) {
                        try { ws.close(); } catch (e) {}
                        // Assemble MP3 chunks and play
                        if (chunks.length === 0) {
                            logEvent('warn', 'edge returned no audio - fallback');
                            if (!resolved) { resolved = true; $timeout.cancel(watchdog); _edgeFallback(text, done); }
                            return;
                        }
                        var blob = new Blob(chunks, { type: 'audio/mp3' });
                        var url = URL.createObjectURL(blob);
                        var audio = new Audio(url);
                        audio.playbackRate = 1.0;   // R7 - pace lives in SSML prosody (playbackRate sounded phasey)
                        audio.volume = 1.0;
                        currentAudio = audio;
                        // R2.9.1 - attach BEFORE play() so MediaElementSource binds in time
                        attachOutputAnalyser(audio);
                        audio.onplaying = function () {
                            if (resolved) return;
                            $timeout.cancel(watchdog);
                            _edgeFails = 0;
                            _ssSet('netra_edgeFails', 0);   // R4.2 - clear persisted breaker on recovery
                            logEvent('tts', 'edge playing @1.15x');
                        };
                        audio.onended = function () {
                            if (resolved) return;
                            resolved = true;
                            detachOutputAnalyser(audio);
                            URL.revokeObjectURL(url);
                            if (currentAudio === audio) currentAudio = null;
                            _clearSpeaking();   // R6
                            if (done) try { done(); } catch (e) {}
                        };
                        audio.onerror = function () {
                            if (resolved) return;
                            resolved = true;
                            detachOutputAnalyser(audio);
                            URL.revokeObjectURL(url);
                            logEvent('warn', 'edge audio playback error - fallback');
                            _edgeFallback(text, done);
                        };
                        audio.play().catch(function (e) {
                            if (resolved) return;
                            resolved = true;
                            logEvent('warn', 'edge play() rejected: ' + e.message);
                            _edgeFallback(text, done);
                        });
                    }
                } else {
                    // Binary frame. The first 2 bytes are a big-endian uint16
                    // of the header length, then the header, then the audio bytes.
                    var data = new Uint8Array(ev.data);
                    if (data.length < 2) return;
                    var headerLen = (data[0] << 8) | data[1];
                    if (data.length > 2 + headerLen) {
                        chunks.push(data.slice(2 + headerLen));
                    }
                }
            };

            ws.onerror = function () {
                if (resolved) return;
                resolved = true;
                $timeout.cancel(watchdog);
                logEvent('warn', 'edge ws error - fallback to StreamElements');
                _edgeFallback(text, done);
            };

            ws.onclose = function () {
                if (!resolved) {
                    resolved = true;
                    $timeout.cancel(watchdog);
                    logEvent('warn', 'edge ws closed early - fallback');
                    _edgeFallback(text, done);
                }
            };
        } catch (e) {
            logEvent('err', 'edge TTS threw: ' + e.message);
            _edgeFallback(text, done);
        }
        });   // _edgeWssUrl
    }

    /* ============================================================
     *  R1.6 - THINKING-CUE FILLERS
     *
     *  Pre-generate short "hmm.", "let me see.", "okay so.", "right."
     *  clips via the Edge TTS pipeline on boot. Cache them as Blob URLs.
     *  When state transitions to 'thinking' (user said something, Gemini
     *  is now thinking), randomly play one to eliminate dead air.
     *
     *  Falls back silently if Edge TTS is unavailable - no filler is OK,
     *  the existing audio cue from cue('think') stays.
     * ============================================================ */
    // R3.7 - conversational filler bank, three length tiers so the chain
    // can choose what fits the remaining wait time. Plays during the
    // Gemini round-trip; interrupted or queued when the real reply lands.
    // Lines written in warm Indian-English help-desk register.
    var FILLER_PHRASES = [
        // SHORT (~1s)
        'One moment, please.',
        'Just a sec, looking that up.',
        'Checking on that now.',
        'Let me pull that up.',
        'Hold on, fetching it.',
        'Right, looking into it.',
        'Give me a moment, Mihir.',
        'One second, please.',
        'Pulling that up for you.',
        // MEDIUM (~2s)
        'Just a moment, I am checking on that.',
        'Hold on, let me pull that up for you.',
        'Okay, fetching that information right now.',
        'One moment please, I am looking into it.',
        'Bear with me, just pulling the details.',
        'Got it, checking the system now.',
        'Let me see what I can find.',
        'Hang on a second, almost there.',
        'Alright Mihir, looking that up now.',
        'Just checking the records, one moment.',
        // LONG (~3s)
        'Give me a moment, I am pulling that information from the system now.',
        'Bear with me for a second, I am just looking into the details.',
        'One moment please, I am checking that on my end for you.',
        'Hold on Mihir, I am fetching the latest information for you right now.',
        'Let me check on that quickly, should only take a moment.',
        'Just a moment please, I am getting that sorted out for you.',
        'Hang on for a second, I am cross-checking the details right now.',
        'Alright, looking into that for you, should have it shortly.',
        // R5 - VR analyst flavored (MEDIUM)
        'Checking the vulnerability queue now.',
        'Scanning the risk data, one moment.',
        'Let me pull the exposure numbers.',
        'Digging into the security backlog for you.',
        // R7 - witty companion flavor
        'Ooh, good one. Digging in.',
        'On it... pretend I am typing furiously.',
        'Let me snoop around for a second.',
        'Hmm, hold that thought... almost there.',
        'Interesting... give me a beat.',
        'One sec, working my magic.'
    ];
    var fillerCache = [];   // [{url, text}]
    var lastFillerPlayedAt = 0;
    var currentFillerAudio = null;
    // R3.7 - filler chain state. While _fillerChainActive is true, fillers
    // auto-loop until the server replies. _pendingReply queues the real
    // response if it arrives in the second half of a filler. _currentFillerEst
    // is the estimated total ms of the currently-playing filler audio.
    var _fillerChainActive = false;
    var _pendingReply       = null;   // {text, done, queuedAt}
    var _currentFillerStart = 0;
    var _currentFillerEst   = 0;

    function _edgeBlob(text, voice, cb) {
        _edgeWssUrl(function (wssUrl, requestId) {
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var done = false;
            var watchdog = $timeout(function () {
                if (!done) { done = true; try { ws.close(); } catch (e) {} cb(null); }
            }, 5000);
            ws.onopen = function () {
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"' + EDGE_AUDIO_FORMAT + '"}}}}';
                ws.send('X-Timestamp:' + new Date().toISOString() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                var safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var ssml = '<speak version=\'1.0\' xml:lang=\'en-US\'><voice name=\'' + (voice || c.edgeVoice) + '\'>' +
                           '<prosody rate=\'+6%\' pitch=\'+0Hz\'>' + safe + '</prosody></voice></speak>';
                ws.send('X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' + ssml);
            };
            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('Path:turn.end') >= 0) {
                        try { ws.close(); } catch (e) {}
                        if (done) return;
                        done = true;
                        $timeout.cancel(watchdog);
                        if (!chunks.length) { cb(null); return; }
                        cb(new Blob(chunks, { type: 'audio/mp3' }));
                    }
                } else {
                    var data = new Uint8Array(ev.data);
                    if (data.length < 2) return;
                    var headerLen = (data[0] << 8) | data[1];
                    if (data.length > 2 + headerLen) chunks.push(data.slice(2 + headerLen));
                }
            };
            ws.onerror = function () { if (!done) { done = true; $timeout.cancel(watchdog); cb(null); } };
            ws.onclose = function () { if (!done) { done = true; $timeout.cancel(watchdog); cb(null); } };
        } catch (e) { cb(null); }
        });   // _edgeWssUrl
    }

    function preloadFillers() {
        if (typeof WebSocket === 'undefined') return;
        // R4.3 - respect the persisted circuit breaker. If Edge has already
        // failed >=REMOTE_FAIL_LIMIT times across previous sessions, don't
        // spam 27 more failed WSS connections at boot - they all fail
        // identically. The filler chain (R4.1) will use live browser TTS
        // instead.
        if (_edgeFails >= REMOTE_FAIL_LIMIT) {
            logEvent('tts', 'skipping filler preload - edge circuit open (' + _edgeFails + ' prior fails); chain will use live browser TTS');
            return;
        }
        logEvent('tts', 'pre-loading thinking-cue fillers...');
        var pending = FILLER_PHRASES.length;
        FILLER_PHRASES.forEach(function (phrase) {
            _edgeBlob(phrase, c.edgeVoice, function (blob) {
                if (blob) {
                    var url = URL.createObjectURL(blob);
                    fillerCache.push({ url: url, text: phrase });
                }
                if (--pending === 0) {
                    logEvent('tts', 'filler cache ready (' + fillerCache.length + '/' + FILLER_PHRASES.length + ')');
                }
            });
        });
    }

    function playThinkingFiller() {
        // R3.7 - one-shot fallback used only by setState transitions.
        // The main flow uses startFillerChain / stopFillerChain.
        if (!fillerCache.length || _fillerChainActive) return;
        if (Date.now() - lastFillerPlayedAt < 4000) return;
        _playOneFiller(null);
    }

    /* ============================================================
     *  R3.7 - FILLER CHAIN
     *
     *  startFillerChain():  begin auto-looping fillers while waiting
     *                       for the server response.
     *  deliverServerReply(text, done):
     *      Real reply arrived. If a filler is currently playing:
     *        - <50% spoken -> interrupt with "Oh wait, ..." + reply
     *        - >=50% spoken -> queue reply for after current filler ends
     *      If no filler playing -> speak the reply directly.
     *  stopFillerChain():   abort the chain (used on errors).
     * ============================================================ */
    function _estimateFillerMs(text) {
        // ~330 ms per word at 1.15x rate, min 1.2s, max 5s
        var words = (text || '').split(/\s+/).length;
        return Math.max(1200, Math.min(5000, words * 330));
    }
    // R4.1 - track the active filler utterance so we can cancel it on
    // interrupt or stop. currentFillerAudio handles the Edge blob path;
    // currentFillerUtter handles the browser-TTS runtime path.
    var currentFillerUtter = null;
    function _playFillerLive(text, onDone) {
        // Synthesize a filler at runtime via SpeechSynthesis. Used when
        // the Edge pre-cache is empty (Edge WSS blocked) so fillers
        // still play instead of silence.
        if (typeof speechSynthesis === 'undefined' || !c.hasTTS) {
            if (onDone) onDone();
            return null;
        }
        try {
            // Don't cancel the existing utterance queue here - that would
            // also stop the real reply if it's already speaking. Filler
            // chain interrupt path calls speechSynthesis.cancel separately.
            var u = new SpeechSynthesisUtterance(text);
            u.rate   = 1.0;
            u.pitch  = 0.98;
            u.volume = 0.9;
            u.lang   = 'en-IN';
            var v = chooseVoice();
            if (v) { u.voice = v; }
            var fired = false;
            var fire = function () { if (fired) return; fired = true; if (onDone) onDone(); };
            u.onend = fire;
            u.onerror = fire;
            speechSynthesis.speak(u);
            return u;
        } catch (e) {
            logEvent('warn', 'filler live failed: ' + e.message);
            if (onDone) onDone();
            return null;
        }
    }
    function _playOneFiller(onEndedExtra) {
        // Clear any in-flight filler before starting a new one
        if (currentFillerAudio) {
            try { currentFillerAudio.pause(); } catch (e) {}
            currentFillerAudio = null;
        }
        if (currentFillerUtter && typeof speechSynthesis !== 'undefined') {
            try { speechSynthesis.cancel(); } catch (e) {}
            currentFillerUtter = null;
        }
        // R4.1 - Path A: Edge cache populated -> play pre-rendered blob (best quality)
        if (fillerCache.length) {
            var f = fillerCache[Math.floor(Math.random() * fillerCache.length)];
            var a = new Audio(f.url);
            a.volume = 0.85;
            a.playbackRate = 1.0;
            currentFillerAudio = a;
            _fillerEchoText = f.text;   // R6 - echo-scorer must know this line
            _currentFillerStart = Date.now();
            _currentFillerEst = _estimateFillerMs(f.text);
            lastFillerPlayedAt = Date.now();
            logEvent('tts', 'filler[blob]: "' + f.text + '" (~' + _currentFillerEst + 'ms)');
            a.onended = function () {
                if (currentFillerAudio === a) currentFillerAudio = null;
                if (onEndedExtra) onEndedExtra();
            };
            a.onerror = function () {
                if (currentFillerAudio === a) currentFillerAudio = null;
                if (onEndedExtra) onEndedExtra();
            };
            a.play().catch(function () {
                if (currentFillerAudio === a) currentFillerAudio = null;
                if (onEndedExtra) onEndedExtra();
            });
            return;
        }
        // R4.1 - Path B: no cache (Edge blocked) -> synthesize live via
        // browser TTS. Slightly less natural than Aria/Raveena but always
        // works on networks where Edge WSS and StreamElements are blocked.
        var phrase = FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
        _fillerEchoText = phrase;   // R6 - echo-scorer must know this line
        _currentFillerStart = Date.now();
        _currentFillerEst = _estimateFillerMs(phrase);
        lastFillerPlayedAt = Date.now();
        logEvent('tts', 'filler[live]: "' + phrase + '" (~' + _currentFillerEst + 'ms)');
        currentFillerUtter = _playFillerLive(phrase, function () {
            currentFillerUtter = null;
            if (onEndedExtra) onEndedExtra();
        });
        if (!currentFillerUtter) {
            // synthesis unavailable - skip ahead so the chain keeps moving
            $timeout(function () { if (onEndedExtra) onEndedExtra(); }, 50);
        }
    }
    function startFillerChain() {
        if (_fillerChainActive) return;
        // R4.1 - removed the "no cache -> skip" guard. We can now synthesize
        // live, so the chain always starts. fillerCache acts as an optimisation
        // when Edge WSS works; runtime browser TTS is the fallback.
        _fillerChainActive = true;
        _pendingReply = null;
        logEvent('tts', 'filler chain start (cache=' + fillerCache.length + ')');
        var advance = function () {
            // If a real reply was queued, deliver it now.
            if (_pendingReply) {
                var p = _pendingReply;
                _pendingReply = null;
                _fillerChainActive = false;
                logEvent('tts', 'filler chain -> queued reply');
                speak(p.text, p.done);
                return;
            }
            if (!_fillerChainActive) return;   // stopped externally
            // Short gap, then next filler. The gap is small enough that the
            // pause feels like a breath, not a stop.
            $timeout(function () {
                if (!_fillerChainActive) return;
                _playOneFiller(advance);
            }, 250);
        };
        _playOneFiller(advance);
    }
    function stopFillerChain() {
        if (!_fillerChainActive && !currentFillerAudio && !currentFillerUtter) return;
        _fillerChainActive = false;
        _pendingReply = null;
        // R4.1 - also cancel any live browser-TTS filler utterance
        if (currentFillerUtter && typeof speechSynthesis !== 'undefined') {
            try { speechSynthesis.cancel(); } catch (e) {}
            currentFillerUtter = null;
        }
        if (currentFillerAudio) {
            try { currentFillerAudio.pause(); } catch (e) {}
            currentFillerAudio = null;
        }
        logEvent('tts', 'filler chain stop');
    }
    function deliverServerReply(text, done) {
        // Server reply arrived. Decide: interrupt, queue, or just speak.
        if (!_fillerChainActive && !currentFillerAudio && !currentFillerUtter) {
            // No filler running - normal speak
            speak(text, done);
            return;
        }
        // R4.1 - support both blob fillers (currentFillerAudio) and live
        // browser-TTS fillers (currentFillerUtter). Compute ratio against
        // whichever is active.
        var elapsed = Date.now() - _currentFillerStart;
        var realMs = _currentFillerEst;
        if (currentFillerAudio && currentFillerAudio.duration && isFinite(currentFillerAudio.duration)) {
            realMs = currentFillerAudio.duration * 1000 / (currentFillerAudio.playbackRate || 1);
        }
        var ratio = realMs > 0 ? elapsed / realMs : 1;
        if (currentFillerAudio || currentFillerUtter) {
            if (ratio < 0.5) {
                logEvent('tts', 'reply interrupts filler at ' + Math.round(ratio*100) + '% -> "Oh wait..."');
                if (currentFillerAudio) { try { currentFillerAudio.pause(); } catch (e) {} currentFillerAudio = null; }
                if (currentFillerUtter && typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (e) {} currentFillerUtter = null; }
                _fillerChainActive = false;
                _pendingReply = null;
                var prefixed = 'Oh wait, I have it. ' + text;
                speak(prefixed, done);
            } else {
                logEvent('tts', 'reply queued behind filler at ' + Math.round(ratio*100) + '%');
                _pendingReply = { text: text, done: done, queuedAt: Date.now() };
            }
        } else {
            // Chain active but between fillers - just speak immediately
            _fillerChainActive = false;
            speak(text, done);
        }
    }

    function speakStreamElements(text, done) {
        // R3.5.2 - skip remote entirely if circuit is open
        if (_streamFails >= REMOTE_FAIL_LIMIT) {
            return speakBrowser(text, done);
        }
        // Stop any currently playing remote audio
        if (currentAudio) {
            try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
            currentAudio = null;
        }
        // Also stop browser TTS so we never overlap
        if (TTS && (TTS.speaking || TTS.pending)) {
            try { TTS.cancel(); } catch (e) {}
        }
        var voice = c.remoteVoice || REMOTE_TTS_VOICE;
        var url = 'https://api.streamelements.com/kappa/v2/speech?voice=' +
                  encodeURIComponent(voice) + '&text=' + encodeURIComponent(text);
        logEvent('tts', 'remote: ' + voice + ' (' + text.length + ' chars)');

        // R1.1 - cap to 15s. If TTS hangs, mic stays blocked for at most 15s
        // instead of a full minute. onended/onerror normally fires <10s.
        _markSpeaking(text);   // R6 - hot mic: echo-scored, not deafened

        var audio = new Audio();
        audio.src = url;
        audio.volume = 1.0;
        audio.playbackRate = 1.05;   // R7 - StreamElements voices are slow; mild lift only
        currentAudio = audio;

        // Single fallback guard - whichever signal fires first wins
        var resolved = false;
        var fallback = function (reason) {
            if (resolved) return;
            resolved = true;
            $timeout.cancel(watchdog);
            try { audio.pause(); audio.src = ''; } catch (e) {}
            detachOutputAnalyser(audio);
            if (currentAudio === audio) currentAudio = null;
            _streamFallback(text, done, reason);   // R3.5.2 - bumps circuit + logs
        };
        var finish = function () {
            if (resolved) return;
            resolved = true;
            $timeout.cancel(watchdog);
            detachOutputAnalyser(audio);
            _clearSpeaking();   // R6
            if (currentAudio === audio) currentAudio = null;
            if (done) done();
        };

        var watchdog = $timeout(function () { fallback('no playback in 4s'); }, 4000);

        // R2.9.1 - state must flip to speaking BEFORE the analyser ticks so the
        // recompute picks up VOICE_RING_BASE_SPEAKING + spike. Then attach.
        setState('speaking');
        attachOutputAnalyser(audio);
        audio.onplaying = function () {
            if (resolved) return;
            $timeout.cancel(watchdog);
            _streamFails = 0;
            _ssSet('netra_streamFails', 0);   // R4.2 - clear persisted breaker on recovery
            logEvent('tts', 'remote playing');
        };
        audio.onended = function () { if (!resolved) { logEvent('tts', 'remote ended'); finish(); } };
        audio.onerror = function () { fallback('audio.onerror'); };

        var playPromise = audio.play();
        if (playPromise && playPromise.then) {
            playPromise.then(
                function () { /* onplaying will fire */ },
                function (err) { fallback('play() rejected: ' + (err && err.message || err)); }
            );
        }
    }

    function speakBrowser(text, done) {
        // Stop any remote audio first - critical to avoid overlap when called as fallback
        if (currentAudio) {
            try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
            currentAudio = null;
        }
        if (!c.hasTTS) {
            logEvent('err', 'no browser TTS available');
            if (done) done();
            return;
        }
        if (!text) { if (done) done(); return; }

        // R1.1 - 15s cap (was 60s). Watchdog also clears stale guards.
        _markSpeaking(text);   // R6 - hot mic: echo-scored, not deafened

        if (TTS.speaking || TTS.pending) {
            TTS.cancel();
        }

        // R3.8 - Web Speech API has no SSML support, so strip the markdown
        // emphasis + ellipsis markers we kept around for the SSML path.
        // SpeechSynthesisUtterance also has no break-time tag, so we just
        // rely on natural punctuation pauses.
        // R4.5 - hard cap on plain to Chrome's ~32KB utterance limit,
        // with a safe margin. Long text silently stalls otherwise.
        var plain = String(text || '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*/g, '')
            .replace(/\.{3,}/g, ',');   // ellipsis -> short pause via comma
        if (plain.length > 28000) plain = plain.substring(0, 28000) + '...';
        var u = new SpeechSynthesisUtterance(plain);
        u.rate  = 1.06;   // R7 - closer to natural; 1.15 sounded rushed
        u.pitch = 1.05;
        u.volume = 1.0;
        var v = chooseVoice();
        if (v) {
            u.voice = v;
            u.lang  = v.lang || 'en-IN';
            logEvent('tts', 'browser: ' + v.name + ' / ' + (v.lang || 'en-IN') + ' (' + text.length + ' chars)');
        } else {
            u.lang = 'en-IN';
            logEvent('tts', 'browser DEFAULT voice (no en-IN found) (' + text.length + ' chars)');
        }

        var startedAt = Date.now();
        var startWatchdog = $timeout(function () {
            if (Date.now() - startedAt > 1800 && !TTS.speaking) {
                logEvent('warn', 'TTS never fired onstart in 1.8s - voice may be silent or autoplay blocked');
            }
        }, 2000);

        u.onstart = function () {
            $timeout.cancel(startWatchdog);
            setState('speaking');
            logEvent('tts', 'onstart');
        };
        u.onend = function () {
            $timeout.cancel(startWatchdog);
            _clearSpeaking();   // R6
            logEvent('tts', 'onend');
            if (done) done();
        };
        u.onerror = function (ev) {
            $timeout.cancel(startWatchdog);
            _clearSpeaking();   // R6
            logEvent('err', 'TTS error: ' + (ev && ev.error));
            if (done) done();
        };

        try {
            // Small delay helps Chrome after cancel()
            $timeout(function () { TTS.speak(u); }, 60);
        } catch (e) {
            logEvent('err', 'TTS.speak threw: ' + e);
            if (done) done();
        }
    }

    function chooseVoice() {
        if (!c.hasTTS) return null;
        var voices = TTS.getVoices() || [];
        if (!voices.length) return null;
        if (forcedVoiceName) {
            var fv = voices.find(function (vv) { return vv.name === forcedVoiceName; });
            if (fv) return fv;
        }
        return pickFemaleVoice();
    }

    // R8 - browser TTS is the ALWAYS-AVAILABLE fallback, so its quality
    // matters. Modern OSes ship genuinely good neural voices (Edge/Chrome
    // "Natural", macOS "Samantha"/"Ava", Google voices). The old picker
    // hunted only for en-IN names and dropped to a robotic default when it
    // found none - which is exactly what happens on a US/EU Windows box.
    // New order: best NEURAL English voice first (any region), a good
    // female name second, then any English, then anything. Quality beats
    // accent for the fallback.
    function pickFemaleVoice() {
        if (!c.hasTTS) return null;
        var voices = TTS.getVoices() || [];
        if (!voices.length) return null;

        var isEng = function (v) { return /^en([-_]|$)/i.test(v.lang || ''); };
        var find = function (pred) { for (var i = 0; i < voices.length; i++) if (pred(voices[i])) return voices[i]; return null; };

        // Tier 1: top-shelf neural voices by exact name, best first.
        var premium = [
            'Ava', 'Aria', 'Emma', 'Jenny', 'Michelle', 'Sonia', 'Libby',
            'Google US English', 'Google UK English Female',
            'Samantha', 'Karen', 'Moira', 'Tessa', 'Neerja', 'Heera'
        ];
        var pick = null;
        for (var i = 0; i < premium.length && !pick; i++) {
            (function (nm) {
                pick = find(function (v) { return isEng(v) && v.name.indexOf(nm) >= 0 && /Natural|Neural|Online|Google/i.test(v.name); })
                    || find(function (v) { return isEng(v) && v.name.indexOf(nm) >= 0; });
            })(premium[i]);
        }
        // Tier 2: ANY English voice tagged Natural/Neural/Online (these are
        // the modern high-quality engines regardless of the speaker name).
        if (!pick) pick = find(function (v) { return isEng(v) && /Natural|Neural|Online/i.test(v.name); });
        // Tier 3: prefer a non-"default"/non-eSpeak English voice.
        if (!pick) pick = find(function (v) { return isEng(v) && !/espeak|default/i.test(v.name); });
        // Tier 4: any English at all, then whatever exists.
        if (!pick) pick = find(isEng) || voices[0];

        if (pick) c.voiceName = pick.name + ' (' + pick.lang + ')';
        return pick;
    }

    function populateVoices() {
        if (!c.hasTTS) return;
        var vs = TTS.getVoices() || [];
        c.voices = vs.map(function (v) { return { name: v.name, lang: v.lang }; });
        if (vs.length && c.voiceName === '(picking...)') pickFemaleVoice();
        $scope.$applyAsync();
    }

    /* ============================================================
     *  AUDIO CUES
     * ============================================================ */
    function unlockAudio() {
        if (audioCtx) return;
        try {
            var Ctor = $window.AudioContext || $window.webkitAudioContext;
            audioCtx = new Ctor();
        } catch (e) {}
    }

    function cue(kind) {
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) {}
        }
        switch (kind) {
            case 'wake':   tone([660, 880], 0.06); break;
            case 'think':  tone([440],      0.04); break;
            case 'error':  tone([440, 220], 0.10); break;
            case 'pause':  tone([330],      0.12); break;
            case 'resume': tone([440, 660], 0.08); break;
        }
    }

    function tone(freqs, dur) {
        try {
            var now = audioCtx.currentTime;
            freqs.forEach(function (f, idx) {
                var osc = audioCtx.createOscillator();
                var g   = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = f;
                osc.connect(g);
                g.connect(audioCtx.destination);
                var start = now + idx * dur;
                g.gain.setValueAtTime(0.0001, start);
                g.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
                osc.start(start);
                osc.stop(start + dur + 0.02);
            });
        } catch (e) {}
    }

    /* ============================================================
     *  HOTKEYS
     * ============================================================ */
    function bindHotkeys() {
        $window.addEventListener('keydown', function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.tap();
                $scope.$applyAsync();
            }
            if (e.altKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
                // R2.7 - Alt+Shift+R = NUCLEAR reset (history, mic, rec, AudioContext)
                e.preventDefault();
                logEvent('warn', 'Alt+Shift+R: nuclear reset of everything');
                geminiHistory = [];
                recRestartCount = 0;
                ignoreFinalsUntil = Date.now();
                try { if (contRec) contRec.stop(); } catch (er) {}
                try { stopMicLevelMeter(); } catch (e2) {}
                $timeout(function () {
                    startContinuous();
                    startMicLevelMeter();
                }, 300);
                $scope.$applyAsync();
                return;
            }
            if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                // R1.1 - Alt+R = force restart recognition (escape hatch)
                e.preventDefault();
                logEvent('dev', 'Alt+R: force restart recognition');
                recRestartCount = 0;
                ignoreFinalsUntil = Date.now();
                try { if (contRec) contRec.stop(); } catch (er) {}
                $timeout(startContinuous, 200);
                $scope.$applyAsync();
            }
            if (e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                c.toggleDev();
                $scope.$applyAsync();
            }
            if (e.key === 'Escape') {
                // R6 - Escape now silences EVERYTHING (remote audio, browser
                // TTS, filler chain, pipeline queue) via the universal stopper.
                // The old handler only cancelled browser TTS, so Escape did
                // nothing during Edge/Gemini/Stream playback.
                stopSpeaking('Escape key');
                $scope.$applyAsync();
            }
        });
    }

    /* ============================================================
     *  NOTIFICATION POLLING
     * ============================================================ */
    function startNotificationPolling() {
        var POLL_MS_ACTIVE  = 9000;
        var POLL_MS_DORMANT = 30000;   // R4.7 - back off when paused/dormant
        var tick = function () {
            // R4.7 - PERF: keep the poll payload minimal. handleHeard leaves the
            // full conversation history, the last response, and any screenshot
            // on c.data; without clearing them, every 9s poll re-POSTed all of
            // that upstream. Null them so the poll round-trip stays tiny. The
            // next chat re-sets history/message before it sends.
            c.data.action    = 'poll';
            c.data.message   = null;
            c.data.history   = null;
            c.data.image_b64 = null;
            c.data.response  = null;
            c.server.update().then(
                function () {
                    var list = c.data.notifications || [];
                    if (list.length) logEvent('poll', list.length + ' new');
                    list.forEach(function (n) {
                        if (seenIds[n.id]) return;
                        seenIds[n.id] = true;
                        // R4.5 - cap seenIds to last 500 keys so long-lived
                        // PWA sessions don't accumulate thousands of sys_ids.
                        var _seenKeys = Object.keys(seenIds);
                        if (_seenKeys.length > 500) {
                            for (var _si = 0; _si < _seenKeys.length - 500; _si++) {
                                delete seenIds[_seenKeys[_si]];
                            }
                        }
                        if (c.state === 'listening' || c.state === 'speaking' || c.state === 'awaiting' || c.state === 'thinking') return;
                        if (!c.alert) return;  // don't disturb when dormant
                        // R8.2 - skip a scanner-promoted reminder that the local
                        // timer already announced to the minute.
                        if (n.kind === 'reminder' && _reminderAlreadySpoken(n.message)) {
                            logEvent('poll', 'reminder already spoken locally - skipped');
                            return;
                        }
                        // R6 - interjection etiquette: if we are mid-conversation
                        // (user spoke within the last 45s), Netra excuses herself
                        // before delivering, like a colleague leaning in.
                        var msg = n.message;
                        var recentlyTalking = c.conversationOpen && (Date.now() - (recLastActivityAt || 0) < 45000);
                        if (recentlyTalking) {
                            var lead = ['Sorry to cut in - ', 'Oh - one quick thing - ', 'Pardon the interruption - '];
                            msg = lead[Math.floor(Math.random() * lead.length)] + msg;
                        }
                        c.spoken = msg;
                        $scope.$applyAsync();
                        speak(msg);
                    });
                },
                function () { /* silent */ }
            ).finally(function () {
                // R4.7 - poll slower while paused or dormant: the server has
                // nothing to deliver then, so a 9s cadence was wasted chatter.
                var dormant = (c.data && c.data.paused) || !c.alert;
                pollTimer = $timeout(tick, dormant ? POLL_MS_DORMANT : POLL_MS_ACTIVE);
            });
        };
        pollTimer = $timeout(tick, 3000);
    }

    /* ============================================================
     *  DEV PANEL ACTIONS
     * ============================================================ */
    c.toggleDev = function () {
        c.devOn = !c.devOn;
        logEvent('dev', 'panel ' + (c.devOn ? 'shown' : 'hidden'));
    };

    c.devKey = function (e) {
        if (e && e.keyCode === 13) {
            e.preventDefault();
            c.devSendText();
        }
    };

    c.devSendText = function () {
        var t = (c.devText || '').trim();
        if (!t) return;
        c.devText = '';
        logEvent('dev', 'manual send: "' + t + '"');
        unlockAudio();
        // Run through the same pipeline as a voice command
        processCommand(t, 1.0);
    };

    c.devListenNow = function () {
        unlockAudio();
        logEvent('dev', 'manual arm - next utterance is the command');
        commandMode = true;
        setState('awaiting');
        cue('wake');
        if (commandTimer) $timeout.cancel(commandTimer);
        commandTimer = $timeout(function () {
            if (commandMode) {
                commandMode = false;
                logEvent('wake', 'manual arm timed out');
                setState(c.alert ? 'idle' : 'dormant');
            }
        }, WAKE_TIMEOUT_MS);
    };

    c.devTestTTS = function () {
        unlockAudio();
        logEvent('dev', 'TEST TTS using ' + c.voiceName);
        speak('This is a test of the voice. Kindly let me know if you can hear me clearly. I am Netra, speaking in Indian English.');
    };

    c.devGreet = function () {
        unlockAudio();
        var name = (c.data && c.data.user_name) ? c.data.user_name : 'there';
        speak('Hello ' + name + '. I am Netra, ready to help.');
    };

    c.devReplayLast = function () {
        if (!lastReply) { logEvent('dev', 'no last reply to replay'); return; }
        speak(lastReply);
    };

    c.devToggleSleep = function () {
        c.tap();
    };

    c.devRestartRec = function () {
        logEvent('dev', 'restarting recognition session');
        try { if (contRec) contRec.stop(); } catch (e) {}
        // onend will restart automatically
    };

    c.devClearLog = function () {
        c.events = [];
    };

    // R2.7 - exposes Alt+Shift+R as a button click for sighted helpers
    c.devNuclearReset = function () {
        logEvent('warn', 'Reset all clicked - nuclear reset');
        geminiHistory = [];
        recRestartCount = 0;
        ignoreFinalsUntil = Date.now();
        try { if (contRec) contRec.stop(); } catch (e) {}
        try { stopMicLevelMeter(); } catch (e) {}
        $timeout(function () {
            startContinuous();
            startMicLevelMeter();
        }, 300);
    };

    c.devPickVoice = function () {
        forcedVoiceName = c.voicePick || '';
        if (forcedVoiceName) {
            c.voiceName = forcedVoiceName + ' (forced)';
            logEvent('dev', 'voice forced to ' + forcedVoiceName);
        } else {
            logEvent('dev', 'voice auto - re-picking');
            pickFemaleVoice();
        }
    };

    c.devPingServer = function () {
        logEvent('dev', 'pinging server...');
        c.data.action = 'debug';
        c.server.update().then(
            function () {
                var d = c.data.debug || {};
                logEvent('srv', 'ping ok: model=' + d.model + ' key=' + d.api_key_status +
                                ' tools=' + (d.tool_count || '?'));
                if (d.tools && d.tools.length) {
                    logEvent('srv', 'available tools: ' + d.tools.join(', '));
                }
            },
            function (err) {
                logEvent('err', 'ping failed: ' + err);
            }
        );
    };

    // R7 - voice picker + pace slider (persisted; used by the Edge SSML path)
    c.devSetEdgeVoice = function () {
        try { localStorage.setItem('netra_edgeVoice', c.edgeVoice); } catch (e) {}
        logEvent('dev', 'edge voice -> ' + c.edgeVoice);
    };
    c.devSetRate = function () {
        var r = parseFloat(c.speechRate);
        if (!(r >= 0.85 && r <= 1.3)) { c.speechRate = 1.06; r = 1.06; }
        try { localStorage.setItem('netra_speechRate', String(r)); } catch (e) {}
    };
    c.devPreviewVoice = function () {
        var first = String(c.data && c.data.user_name || '').split(' ')[0] || 'there';
        var nice = String(c.edgeVoice).replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/Neural$/, '');
        speak('Hey ' + first + '... this is my ' + nice + ' voice at ' +
              (Math.round((c.speechRate - 1) * 100) || 'natural') + ' percent pace. **Pretty smooth**, right?');
    };
    c.devClearConvo = function () { c.convo = []; };

    c.devToggleTTS = function () {
        // R2.8 - cycle: edge -> gemini -> stream -> browser -> edge
        var seq = ['edge', 'gemini', 'stream', 'browser'];
        var idx = seq.indexOf(c.ttsEngine || 'edge');
        c.ttsEngine = seq[(idx + 1) % seq.length];
        c.useRemoteTTS = (c.ttsEngine !== 'browser');
        logEvent('dev', 'TTS engine -> ' + c.ttsEngine +
                 (c.ttsEngine === 'edge'   ? ' (' + c.edgeVoice + ', Microsoft Neural, free)' :
                  c.ttsEngine === 'gemini' ? ' (' + c.geminiVoice + ', Gemini native, ~1 Gemini quota / turn)' :
                  c.ttsEngine === 'stream' ? ' (StreamElements ' + c.remoteVoice + ')' :
                                             ' (browser ' + c.voiceName + ')'));
    };

    c.devCycleRemoteVoice = function () {
        // R2.8 - cycle voices for the active engine
        if (c.ttsEngine === 'edge') {
            var ei = EDGE_VOICES.indexOf(c.edgeVoice);
            c.edgeVoice = EDGE_VOICES[(ei + 1) % EDGE_VOICES.length];
            logEvent('dev', 'Edge voice -> ' + c.edgeVoice);
            return;
        }
        if (c.ttsEngine === 'gemini') {
            var gi = GEMINI_VOICES.indexOf(c.geminiVoice);
            c.geminiVoice = GEMINI_VOICES[(gi + 1) % GEMINI_VOICES.length];
            logEvent('dev', 'Gemini voice -> ' + c.geminiVoice);
            return;
        }
        var voices = ['Raveena','Aditi','Joanna','Salli','Kimberly','Amy','Emma','Brian','Russell','Nicole','Joey','Matthew'];
        var idx = voices.indexOf(c.remoteVoice);
        c.remoteVoice = voices[(idx + 1) % voices.length];
        logEvent('dev', 'remote voice -> ' + c.remoteVoice);
    };

    c.devCloseConversation = function () {
        closeConversation();
        logEvent('dev', 'conversation manually closed');
    };

    c.devDiagnose = function () {
        logEvent('dev', '=== diagnostics ===');
        logEvent('dev', 'SR=' + c.hasSR + ' TTS=' + c.hasTTS + ' Grammars=' + !!SGL);
        logEvent('dev', 'rec running=' + c.recRunning + ' state=' + c.state + ' alert=' + c.alert + ' conv=' + c.conversationOpen);
        logEvent('dev', 'mic permission=' + c.permission);
        logEvent('dev', 'voice=' + (c.useRemoteTTS ? 'remote ' + c.remoteVoice : c.voiceName));
        var enIn = c.voices.filter(function(v){ return /en[-_]IN/i.test(v.lang); });
        logEvent('dev', 'en-IN voices: ' + (enIn.length ? enIn.map(function(v){return v.name;}).join(', ') : 'NONE'));
        logEvent('dev', 'total browser voices: ' + c.voices.length);
        var v = (c.data && c.data.vocab) || {};
        logEvent('dev', 'mined vocab: ' + (v.groups||[]).length + ' groups, ' +
                                          (v.apps||[]).length + ' apps, ' +
                                          (v.categories||[]).length + ' categories, ' +
                                          (v.kb_titles||[]).length + ' KB titles, ' +
                                          (v.catalog_items||[]).length + ' catalog items');
        if (v.built_at) logEvent('dev', 'vocab built at: ' + v.built_at);
    };

    /* ============================================================
     *  STATE
     * ============================================================ */
    // R8 - friendly status line for the Live stage
    var LIVE_STATUS = {
        idle:     'Listening',
        awaiting: 'Listening',
        thinking: 'Thinking…',
        speaking: 'Speaking — just talk to interrupt',
        dormant:  'Muted — tap the blob to wake me',
        error:    'Hmm, hit a snag — say that again?',
        boot:     'Waking up…'
    };
    function setState(s) {
        var prev = c.state;
        c.state = s;
        window.__netraState = s;   // R10 - 3D stage reads this per frame
        c.stateLabel = STATE_LABEL[s] || s;
        c.liveStatus = LIVE_STATUS[s] || 'Listening';
        $scope.$applyAsync();
        // R3.7 - filler chain is now started explicitly from handleHeard()
        // when the server call is dispatched. setState no longer triggers
        // a one-shot filler so we don't double-play.
    }
};

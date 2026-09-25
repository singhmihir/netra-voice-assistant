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
    var REMOTE_TTS_DEFAULT  = false;  // the browser's own local voice: instant, offline, works for guests
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
    c.heard       = [];   // last finals: {t, text, conf, fate} - the Lab shows them live
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
    c.ttsEngine    = 'browser';   // R20 - the quickest voice there is; the Lab can pick the neural one

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
    c.agency = (c.data && c.data.agency) || { orders: [], corrections: 0, facts: 0, addendum: '', plan: null };   // R17
    c.brain = (c.data && c.data.brain) || { models: [], calls: 0, mode: 'full', alive: 0 };   // R18
    // the last thing Netra ANSWERED (server or local reply) - unlike
    // c.lastSpoken, reprompt nudges and notifications never overwrite it,
    // so "is she waiting on an answer" and "repeat" stay about the reply
    c.lastAnswer = '';
    c._awaitingConfirm = false;   // server: a read-back is parked, waiting for yes
    c.brainUntil = function (ms) {
        if (!ms) return '';
        var mins = Math.round((ms - Date.now()) / 60000);
        return mins <= 0 ? 'any moment' : (mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h');
    };
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
    c.liveStatus = 'Getting ready…';
    try {
        c.liveMode = /[?&]id=netra_live(&|$)/.test(String($window.location.search || $window.location.href || ''));
        if (c.liveMode) document.body.classList.add('netra-live-body');
    } catch (eLM) { c.liveMode = false; }
    /* ============================================================
     *  R23 - NETRA AS AN APP (a Progressive Web App)
     *  The live page carries a web app manifest and a service worker,
     *  so Android Chrome installs Netra as a real app (in the app
     *  drawer, full screen, its own icon) and iOS Safari adds her to
     *  the Home Screen. The install button shows only where it works;
     *  on iOS it explains Share > Add to Home Screen instead.
     * ============================================================ */
    c.app = { canInstall: false, standalone: false, ios: false, showHelp: false, installed: false, fromApp: false, shareWhere: 'Safari\'s toolbar' };
    var _installEvt = null;
    function _appShell() {
        if (!c.liveMode) return;
        var base = (c.data && c.data.app_base) || '';
        try {
            var nav = $window.navigator || {}, ua = String(nav.userAgent || '');
            c.app.ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
            c.app.standalone = !!(($window.matchMedia && $window.matchMedia('(display-mode: standalone)').matches) || nav.standalone);
            var head = document.head;
            var put = function (tag, key, val, attrs) {
                var el = head.querySelector(tag + '[' + key + '="' + val + '"]');
                if (!el) { el = document.createElement(tag); el.setAttribute(key, val); head.appendChild(el); }
                for (var a in attrs) if (attrs.hasOwnProperty(a)) el.setAttribute(a, attrs[a]);
            };
            if (base) put('link', 'rel', 'manifest', { href: base + '/manifest' });
            put('meta', 'name', 'theme-color', { content: '#0e0e10' });
            put('meta', 'name', 'mobile-web-app-capable', { content: 'yes' });
            put('meta', 'name', 'apple-mobile-web-app-capable', { content: 'yes' });
            put('meta', 'name', 'apple-mobile-web-app-status-bar-style', { content: 'black-translucent' });
            put('meta', 'name', 'apple-mobile-web-app-title', { content: 'Netra' });
            put('link', 'rel', 'apple-touch-icon', { href: '/netra-app-180.png' });
            // pinch-zoom stays on: the theme's meta turns it off, and a low-vision
            // user must be able to zoom. viewport-fit lets the stage reach the
            // notch and the home bar (the controls keep clear: env(safe-area-inset-*))
            put('meta', 'name', 'viewport', {});
            Array.prototype.forEach.call(document.querySelectorAll('meta[name="viewport"]'), function (vp) {
                vp.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
            });
            c.app.fromApp = /[?&]netra_app=1(&|$)/.test(String(($window.location && $window.location.search) || ''));
            c.app.shareWhere = _shareWhere(ua);
            if (base && nav.serviceWorker && $window.isSecureContext !== false) {
                nav.serviceWorker.register(base + '/sw', { scope: '/sp' }).then(function () { logEvent('app', 'app service worker ready'); },
                    function (eR) { logEvent('warn', 'app service worker not registered: ' + (eR && eR.message || eR)); });
            }
        } catch (eA) { logEvent('warn', 'app shell: ' + (eA && eA.message || eA)); }
        var onPrompt = function (e) { e.preventDefault(); _installEvt = e; c.app.canInstall = true; logEvent('app', 'Netra can be installed as an app here'); $scope.$applyAsync(); };
        var onInstalled = function () { _installEvt = null; c.app.canInstall = false; c.app.installed = true; c.app.showHelp = false; logEvent('app', 'installed as an app'); $scope.$applyAsync(); };
        $window.addEventListener('beforeinstallprompt', onPrompt);
        $window.addEventListener('appinstalled', onInstalled);
        $scope.$on('$destroy', function () { $window.removeEventListener('beforeinstallprompt', onPrompt); $window.removeEventListener('appinstalled', onInstalled); });
        if (c.app.standalone) logEvent('app', 'running as the installed app');
    }
    // where the Share button is in the iOS browser in use
    function _shareWhere(ua) {
        if (/CriOS/.test(ua)) return 'Chrome\'s address bar';
        if (/FxiOS|EdgiOS|OPiOS/.test(ua)) return 'the browser\'s menu';
        return 'Safari\'s toolbar';
    }
    c.installApp = function () { _installApp(); };
    c.appHelpClose = function () { _appHelpClose(); };
    var _appHelpOpener = null;
    // R28 - the iOS steps sit inside Settings > More: VoiceOver lands on
    // their title, Got it closes them and focus goes back to the button
    // that opened them (Escape closes the whole sheet)
    function _appHelpOpen() {
        c.app.showHelp = true;
        try { _appHelpOpener = document.activeElement; } catch (eF) { _appHelpOpener = null; }
        $timeout(function () { _focusEl('#netra-app-help-title'); }, 30);
    }
    function _appHelpClose() {
        if (!c.app.showHelp) return;
        c.app.showHelp = false;
        var back = _appHelpOpener; _appHelpOpener = null;
        $timeout(function () {
            if (back && back.isConnected && back.focus) back.focus(); else _focusEl('.netra-set-install');
        }, 30);
    }
    function _focusEl(sel) {
        try { var el = document.querySelector(sel); if (el && el.focus) el.focus(); } catch (eF) {}
    }
    function _installApp() {
        if (_installEvt) {
            var ev = _installEvt;
            _installEvt = null; c.app.canInstall = false;
            try {
                ev.prompt();
                ev.userChoice.then(function (ch) {
                    logEvent('app', 'install ' + (ch && ch.outcome || 'answered'));
                    if (ch && ch.outcome !== 'accepted') { _installEvt = null; }
                    $scope.$applyAsync();
                });
            } catch (eP) { logEvent('warn', 'install prompt: ' + (eP && eP.message || eP)); }
            return;
        }
        // iOS: Share > Add to Home Screen
        if (c.app.showHelp) _appHelpClose(); else _appHelpOpen();
    }
    _appShell();

    /* End: a signed-in desktop user goes back to the portal. A Guest, or
     * the installed app (no back button on an iOS home-screen app), would
     * land on the login page with no way back - so End puts Netra to rest
     * on this page, with a button to start her again. */
    c.ended = false;
    c.liveExit = function () { _liveExit(); };
    c.liveRestart = function () { _liveRestart(); };
    function _liveExit() {
        if ((c.data && c.data.is_guest) || (c.app && (c.app.standalone || c.app.fromApp))) { _endHere(); return; }
        _uninertChrome();   // the page we go back to keeps this header and footer
        _stage3dOn = false;
        // the portal's header and footer outlive this widget: give them back first
        _gateInertRestore();
        try { if (window.NetraStage3D) window.NetraStage3D.unmount(); } catch (e3d) {}
        try {
            if ($window.history && $window.history.length > 1) $window.history.back();
            else $window.location.assign('/sp');
        } catch (e) { $window.location.assign('/sp'); }
    }
    function _endHere() {
        c.labOn = false; c.setupOn = false; _appHelpClose();
        c.lastFailed = false; c.canRetry = false;
        // ended from the loading card: the card goes, and nothing stays inert
        _gateInertRestore();
        stopSpeaking('ended');
        _micMute(true);
        c.ended = true;
        setState('dormant');
        cue('end');
        logEvent('app', 'ended on the page (a Guest or the installed app has nowhere to go back to)');
        _hushState();
        speak('Netra ended. The mic is off.');
        // the way back in; the orb (named "Start Netra again") if the button is not there
        $timeout(function () {
            var btn = null;
            try { btn = document.querySelector('.netra-ended-btn'); } catch (eQ) {}
            _focusEl(btn ? '.netra-ended-btn' : '.netra-stage-blob-wrap');
        }, 60);
    }
    function _liveRestart() {
        if (!c.ended) return;
        c.ended = false;
        // she can not hear yet, so she does not say she is listening: the
        // status says what she waits for. Ended from the loading card (Leave),
        // the card comes back as a modal again, with the focus in it
        if (c.gate && !c.gate.open) {
            _micUnmute('', true);
            if (_gateCardUp()) {
                _gateShut = undefined;
                c.gate.statusKey = '';
                _gateUpdate();
            } else {
                $timeout(function () { _focusEl(c.typeOn ? '#netra-type-in' : '.netra-stage-blob-wrap'); }, 60);
            }
            return;
        }
        _micUnmute('Hi again \u2014 I\u2019m listening.');
        $timeout(function () { _focusEl('.netra-stage-blob-wrap'); }, 60);
    }

    /* Mute mic: she does not listen at all - the browser recognizer is
     * stopped (no audio goes to its cloud service), the on-device ear drops
     * what it was holding and the mic's audio is zeroed for the meter and
     * the ear - until the user presses Unmute (or taps her). Saying her
     * name does not wake her; that is what "stop listening" (asleep) is for. */
    c.micOff = false;
    c.toggleMic = function () { if (c.micOff) _micUnmute(); else _micMute(); };
    function _micMute(quiet) {
        c.micOff = true;
        _cancelPlanContinue();
        closeConversation();
        _dropFinalBuffer('mic muted');
        c.interim = '';
        _micGainApply();
        // startContinuous will not start it again while muted
        try { if (contRec) contRec.abort(); } catch (eA) {}
        c.recRunning = false;
        _earForget();
        c.alert = false;
        setState('dormant');
        logEvent('mic', 'muted - not listening until Unmute');
        if (!quiet) { _hushState(); speak('Mic off.'); }
    }
    function _micUnmute(say, quiet) {
        c.micOff = false;
        _micGainApply();
        _wakeUp(say || 'Mic on.', quiet);
    }
    function _micGainApply() {
        if (_micGainNode) { try { _micGainNode.gain.value = c.micOff ? 0 : c.micGain; } catch (eG) {} }
    }

    /* ============================================================
     *  R22 - THE GEMINI STAGE (the netra_stage3d UI script, a widget
     *  dependency; no three.js any more). A light renderer paints the
     *  whole stage behind the UI: a luminous orb on the tap target and
     *  Gemini Live's glow at the foot, both driven by the same voice
     *  globals. On success the SVG blob and the legacy layers hide
     *  (class netra-3d-on); it carries its own no-WebGL fallback, and
     *  if it can not mount at all the 2D blob stays.
     * ============================================================ */
    function _init3D(attempt) {
        if (!c.liveMode) return;
        var hostEl = document.querySelector('.netra-stage-3d');
        var stageEl = document.querySelector('.netra-stage');
        if (!hostEl || !stageEl || !window.NetraStage3D) {
            if (attempt < 24) $timeout(function () { _init3D(attempt + 1); }, 250);
            else logEvent('warn', 'stage renderer unavailable (netra_stage3d not loaded) - keeping the 2D blob');
            return;
        }
        var ok = false;
        try { ok = window.NetraStage3D.mount(hostEl); } catch (e3) { ok = false; }
        if (ok) {
            stageEl.classList.add('netra-3d-on');
            _stage3dOn = true;
            logEvent('lab', 'Gemini stage online');
        } else {
            logEvent('warn', 'the stage renderer could not start - keeping the 2D blob');
        }
    }
    var _stage3dOn = false;
    if (c.liveMode) $timeout(function () { _init3D(0); }, 400);

    // the live stage covers the whole page, so the portal chrome under it
    // (skip link, logo, Log in) must not take focus or be read: everything
    // outside the widget is made inert. Run again later for chrome the
    // portal renders after us. Every change is recorded, because the portal
    // is a single-page app: leaving Netra keeps the same header and footer.
    var _inertMade = [], _inertTabs = [], _inertFreed = false;
    function _inertChrome() {
        if (!c.liveMode || _inertFreed) return;
        try {
            var stage = document.querySelector('.netra-stage');
            var node = stage && stage.closest ? (stage.closest('.netra-root') || stage) : stage;
            var noInert = !('inert' in (document.body || {}));
            for (; node && node.parentNode && node !== document.body; node = node.parentNode) {
                var sibs = node.parentNode.children || [];
                for (var i = 0; i < sibs.length; i++) {
                    var el = sibs[i];
                    if (el === node || /^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/.test(el.tagName)) continue;
                    // already inert: ours from the first run, or the portal's own
                    if (el.hasAttribute('inert')) continue;
                    _inertMade.push({ el: el, hidden: el.getAttribute('aria-hidden') });
                    el.setAttribute('inert', '');
                    el.setAttribute('aria-hidden', 'true');
                    // an older browser without inert: at least take it out of the Tab order
                    if (noInert) Array.prototype.forEach.call(el.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'), function (f) {
                        _inertTabs.push({ el: f, tab: f.getAttribute('tabindex') });
                        f.setAttribute('tabindex', '-1');
                    });
                }
            }
        } catch (eI) { logEvent('warn', 'could not quiet the page under the stage: ' + (eI && eI.message || eI)); }
    }
    // gives the portal back exactly as it was, when Netra leaves the page
    function _uninertChrome() {
        _inertFreed = true;
        function put(el, k, v) { if (v === null) el.removeAttribute(k); else el.setAttribute(k, v); }
        try {
            _inertTabs.forEach(function (r) { put(r.el, 'tabindex', r.tab); });
            _inertMade.forEach(function (r) { r.el.removeAttribute('inert'); put(r.el, 'aria-hidden', r.hidden); });
        } catch (eU) {}
        _inertMade = []; _inertTabs = [];
    }
    // and once more for portal chrome that renders late
    if (c.liveMode) { $timeout(_inertChrome, 500); $timeout(_inertChrome, 4000); $timeout(_inertChrome, 12000); }
    $scope.$on('$destroy', _uninertChrome);

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
    c.labToggle = function () { _labOpen(!c.labOn); };
    c.labKey = function (ev) { _labKey(ev); };
    c.labModal = function () { return _labModal(); };
    // R28 - the Lab opens from Settings > More or Alt+D: its close button
    // takes the focus, and closing it hands the focus to the Settings button
    function _labOpen(on) {
        c.labOn = !!on;
        if (c.labOn) {
            _labScopeEl = null;   // re-query canvas on open
            $timeout(_labRestorePos, 30);   // put the window back where it was
            $timeout(function () { _focusEl('.netra-lab-x'); _labModal(); }, 40);
        } else {
            $timeout(function () { _focusEl('.netra-head-settings'); }, 30);   // focus is not lost to the page
        }
        logEvent('lab', c.labOn ? 'Netra Lab opened' : 'Netra Lab closed');
    }
    // Escape closes the Lab only: stopped here, so it does not also stop her talking
    function _labKey(ev) {
        if (!ev || !c.labOn) return;
        // on a phone the Lab covers the stage: Tab stays inside it, as in a sheet
        if (ev.key === 'Tab') { if (_labModal()) _tabWrap(ev, document.querySelector('.netra-lab')); return; }
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        _labOpen(false);
    }
    // the Lab is a modal wherever it lies over the stage - a phone, a phone
    // held sideways, a tablet - measured, not guessed from the width. The
    // answer is kept in c.labCovers for the template, so a digest never
    // measures the page: it is taken when the Lab opens and on every Tab
    function _labModal() {
        c.labCovers = false;
        if (!c.labOn) return false;
        var lab = document.querySelector('.netra-lab'), r = null;
        try { r = lab && lab.getBoundingClientRect ? lab.getBoundingClientRect() : null; } catch (eR) { r = null; }
        if (!r || !(r.width > 0)) return (c.labCovers = _narrow());
        c.labCovers = ['.netra-stage-blob-wrap', '.netra-status', '.netra-type', '.netra-try'].some(function (sel) {
            var e = document.querySelector(sel), b = null;
            try { b = e && e.getBoundingClientRect ? e.getBoundingClientRect() : null; } catch (eB) { b = null; }
            return !!(b && b.width > 0 && b.height > 0 && r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom);
        });
        return c.labCovers;
    }
    c.labRestartMic = function () { _fullMicRecycle('manual (Netra Lab)'); };
    // Alt+D by the key's place: Option+D on a Mac types '∂'
    function _altDKey(e) {
        return !!(e && e.altKey && (e.code === 'KeyD' || e.key === 'd' || e.key === 'D'));
    }
    // over an open sheet (a modal) the Lab would open behind its scrim: the
    // sheet steps aside first, as Settings > More does
    function _labKeyToggle() {
        if (!c.labOn && _openSheet()) { _labFromSettings(); return; }
        _labOpen(!c.labOn);
    }

    /* ============================================================
     *  R9 - LAB PREFERENCES: recognition language, TTS mute, mic
     *  sensitivity, typed commands and NLP dry-run tests. All the
     *  knobs persist in localStorage so devs keep their setup.
     * ============================================================ */
    var _micGainNode = null;
    c.labMute = false;
    c.recLangs = ['en-IN', 'en-US', 'en-GB', 'en-AU', 'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP'];
    // v7.9 - everyone starts in Indian English; a stored choice still wins
    // (the deaf-strike and language-not-supported fallbacks to en-US stay)
    c.recLang = 'en-IN';
    c.micGain = 1.5;   // v7.9 - the default sensitivity, for every user and Guest
    try {
        c.recLang = localStorage.getItem('netra_lang_v2') || c.recLang;
        var g = parseFloat(localStorage.getItem('netra_mic_gain'));
        if (g >= 0.5 && g <= 3) c.micGain = g;
        c.labMute = localStorage.getItem('netra_lab_mute') === '1';
    } catch (ePref) {}
    c.labSetLang = function () {
        try { localStorage.setItem('netra_lang_v2', c.recLang); } catch (e) {}
        logEvent('lab', 'recognition language -> ' + c.recLang);
        // R13 FIX - if a recycle is already mid-flight the call used to be
        // silently swallowed and the OLD language kept listening for up to
        // ~5 minutes. Now we keep retrying until our recycle actually runs.
        if (!_fullMicRecycle('language change')) {
            $timeout(function retryLang() {
                if (!_fullMicRecycle('language change (retry)')) $timeout(retryLang, 1200);
            }, 1200);
        }
    };
    c.labSetGain = function () {
        try { localStorage.setItem('netra_mic_gain', String(c.micGain)); } catch (e) {}
        _micGainApply();   // muted stays at zero
    };
    c.labSetMute = function () {
        try { localStorage.setItem('netra_lab_mute', c.labMute ? '1' : '0'); } catch (e) {}
        logEvent('lab', 'TTS ' + (c.labMute ? 'muted' : 'unmuted'));
    };

    /* ============================================================
     *  R28 - THE WAYS IN (Netra Live)
     *  One bar of labelled controls (Mute, Type, Transcript, End), a
     *  typing box above it, 'Try saying' starters on a first visit and
     *  two sheets over the stage: the Transcript and Settings. A sheet
     *  is a modal dialog: its heading takes the focus, Tab stays inside,
     *  Escape closes it and the focus goes back to what opened it.
     *  The rules live in hoisted functions (the tests reach only those);
     *  the c.* wrappers stay thin.
     * ============================================================ */
    c.sheet = null;       // 'log' | 'settings' | null
    c.setupOn = false;    // the Settings sheet is up (the header button's aria-expanded)
    var _sheetBack = '';
    c.sheetKey = function (ev) { _sheetKey(ev); };
    c.sheetClose = function () { _sheetClose(); };
    c.setupToggle = function () { _setupToggle(); };
    c.logToggle = function (on) { if (on === false) _sheetClose(); else _sheetOpen('log', '.netra-ctl-log'); };
    function _sheetOpen(name, openerSel) {
        // a sheet is a modal: the Lab (a window on a desktop) steps aside, so
        // closing it later never puts the focus behind the sheet's scrim
        if (c.labOn) { c.labOn = false; c.labCovers = false; logEvent('lab', 'Netra Lab closed (a sheet opened)'); }
        c.sheet = name;
        c.logSaid = '';   // a reopened sheet does not say 'copied' again
        c.setupOn = name === 'settings';
        _sheetBack = openerSel || '';
        $timeout(function () { _focusEl('#netra-' + name + '-h'); }, 30);
        $scope.$applyAsync();
    }
    // noFocus: the Lab takes the focus instead of the opener
    function _sheetClose(noFocus) {
        if (!c.sheet && !c.setupOn) return;
        c.sheet = null; c.setupOn = false; c.logSaid = '';
        var back = _sheetBack;
        _sheetBack = '';
        if (back && !noFocus) $timeout(function () { _focusEl(back); }, 30);
        $scope.$applyAsync();
    }
    // the sheet that is really up: End closes Settings by c.setupOn alone
    function _openSheet() {
        return (c.sheet === 'settings' && !c.setupOn) ? null : (c.sheet || null);
    }
    // the header's Settings button (package A draws it) opens and closes the sheet
    function _setupToggle() {
        if (c.setupOn) _sheetClose(); else _sheetOpen('settings', '.netra-head-settings');
        logEvent('dev', c.setupOn ? 'settings opened' : 'settings closed');
    }
    function _sheetKey(ev) {
        if (!ev || !_openSheet()) return;
        if (ev.key === 'Escape') {
            // stopped here: Escape closes the sheet, it does not also stop her talking
            ev.preventDefault();
            if (ev.stopPropagation) ev.stopPropagation();
            _sheetClose();
            return;
        }
        if (ev.key !== 'Tab') return;
        // Tab wraps inside the card instead of wandering to the stage behind it
        _tabWrap(ev, document.querySelector('.netra-sheet-card'));
    }
    function _tabWrap(ev, card) {
        if (!card) return;
        var list = Array.prototype.filter.call(card.querySelectorAll('a[href], button, select, input, textarea, [tabindex]'), function (el) {
            return !el.disabled && el.getAttribute('tabindex') !== '-1' && el.offsetParent !== null;
        });
        if (!list.length) return;
        // the heading (where the sheet puts the focus) or anything outside the
        // card counts as before the first control: Shift+Tab from it wraps too
        var i = list.indexOf(document.activeElement), first = list[0], last = list[list.length - 1];
        if (ev.shiftKey && i <= 0) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && (i < 0 || i === list.length - 1)) { ev.preventDefault(); first.focus(); }
    }

    // ---- Type: the same pipeline as voice, minus the microphone ----
    c.typeOn = false;
    c.typeText = '';
    c.typeToggle = function (on) { _typeToggle(on); };
    // the box stays open with the focus in it, ready for a follow-up
    c.typeSend = function () { if (_sendTyped(c.typeText, 'type')) c.typeText = ''; _focusEl('#netra-type-in'); };
    c.typeKey = function (ev) {
        if (!ev || ev.key !== 'Escape') return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        _typeToggle(false);
    };
    // one way in for the typing box, the starters and the Lab: false keeps
    // the text where it is (answers are not ready yet)
    function _sendTyped(text, from) {
        var t = String(text || '').trim();
        if (!t) return false;
        if (_typedRefused(t)) return false;
        // typing over her: she stops, as a spoken barge-in would
        if (c.state === 'speaking' || _speakingNow) {
            _stopTalking('typed');
        }
        // the caption shows what was typed, as it shows what was heard
        c.prevHeard = c.lastHeard; c.lastHeard = t; c.interim = '';
        logEvent(from === 'lab' ? 'lab' : 'type', 'typed (' + (from || 'type') + '): "' + t + '"');
        c._typedTurn = true;   // the server forgives mis-heard words in speech only
        processCommand(t, 1.0);
        return true;
    }
    var _vvResize = null;
    function _typeToggle(on) {
        var want = on === undefined ? !c.typeOn : !!on;
        var was = !!c.typeOn;
        c.typeOn = want;
        if (want) {
            _vvWatch(true);
            $timeout(function () { _focusEl('#netra-type-in'); }, 30);
        } else if (was) {
            _vvWatch(false);
            $timeout(function () { _focusEl('.netra-ctl-type'); }, 30);
        }
        $scope.$applyAsync();
    }
    // the on-screen keyboard shrinks the visual viewport, not the layout one:
    // the stage follows it (--vvh), so the box never sits under the keyboard
    function _vvWatch(on) {
        var vv = $window && $window.visualViewport;
        var stage = document.querySelector('.netra-stage');
        if (_vvResize && vv && vv.removeEventListener) vv.removeEventListener('resize', _vvResize);
        _vvResize = null;
        if (!on) {
            if (stage && stage.style && stage.style.removeProperty) stage.style.removeProperty('--vvh');
            if (stage && stage.removeAttribute) stage.removeAttribute('data-kbd');
            return;
        }
        if (!vv || !vv.addEventListener) return;
        _vvResize = function () {
            var s = document.querySelector('.netra-stage');
            if (s && s.style && s.style.setProperty) s.style.setProperty('--vvh', Math.round(vv.height) + 'px');
            // the keyboard is up (not a pinch-zoom): the orb's row is too small
            // to tap, so the orb steps aside while typing, as Gemini's does
            var full = +($window.innerHeight || 0), up = full > 0 && (vv.scale || 1) < 1.01 && vv.height < full - 120;
            if (s && s.setAttribute) { if (up) s.setAttribute('data-kbd', ''); else s.removeAttribute('data-kbd'); }
        };
        vv.addEventListener('resize', _vvResize);
        _vvResize();
    }
    $scope.$on('$destroy', function () { _vvWatch(false); });

    // ---- the Transcript: what was said, turn by turn, in memory only ----
    var _convoMemo = null;
    c.convoView = function () { return _convoView(); };
    c.logCopy = function () { _logCopy(); };
    c.logSaid = '';
    // the same array until c.convo changes: ng-repeat watches it every digest
    function _convoView() {
        var list = c.convo || [], last = list[list.length - 1];
        if (_convoMemo && _convoMemo.src === list && _convoMemo.n === list.length && _convoMemo.last === last) return _convoMemo.out;
        var out = [];
        list.forEach(function (m) {
            if (!m || (m.who !== 'you' && m.who !== 'netra')) return;
            out.push({ k: out.length, who: m.who, text: String(m.text || ''), t: String(m.t || '').slice(0, 5), parts: _linkParts(m.text) });
        });
        _convoMemo = { src: list, n: list.length, last: last, out: out };
        return out;
    }
    // web addresses in her words become real links; only http(s), and no
    // HTML is ever bound, so nothing in a reply can run on the page
    function _linkParts(text) {
        var s = String(text || ''), out = [], re = /https?:\/\/[^\s<>"]+/g, m, at = 0;
        while ((m = re.exec(s))) {
            var url = m[0].replace(/[.,;:!?)]+$/, '');
            if (m.index > at) out.push({ t: s.slice(at, m.index) });
            out.push({ t: url, href: url });
            at = m.index + url.length;
            re.lastIndex = at;
        }
        if (at < s.length) out.push({ t: s.slice(at) });
        return out;
    }
    function _transcriptText() {
        return _convoView().map(function (m) { return (m.who === 'you' ? 'You: ' : 'Netra: ') + m.text; }).join('\n');
    }
    function _logCopy() {
        var text = _transcriptText();
        if (!text) return;
        var done = function (ok) {
            var msg = ok ? 'Transcript copied' : 'Could not copy the transcript';
            // said in the sheet's own status line: the sheet is modal, and a screen
            // reader may not read the stage's announcer outside it (emptied first,
            // so a second Copy is said again rather than left unchanged)
            c.logSaid = ''; $timeout(function () { c.logSaid = msg; }, 50);
            logEvent('type', msg.toLowerCase());
            $scope.$applyAsync();
        };
        var byHand = function () {
            var ok = false, back = document.activeElement;
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                ok = !!document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (eT) { ok = false; }
            try { if (back && back.focus) back.focus(); } catch (eB) {}
            done(ok);
        };
        try {
            var cb = $window.navigator && $window.navigator.clipboard;
            if (cb && cb.writeText) { cb.writeText(text).then(function () { done(true); }, byHand); return; }
        } catch (eC) {}
        byHand();
    }

    // ---- 'Try saying': what works, shown until the first question ----
    c.starters = function () { return _starters(!!(c.data && c.data.is_guest)); };
    c.showStarters = function () { return _showStarters(); };
    c.tryStarter = function (s) { _tryStarter(s); };
    c.chipFocus = function (ev) { _chipInView(ev && ev.target); };
    // a Guest is never shown what only a signed-in user can do
    function _starters(guest) {
        return guest
            ? ['What can you do?', 'Tell me a joke', 'What time is it in Tokyo?', 'Search the web for today’s news']
            : ['What are my open tickets?', 'Anything waiting for my approval?', 'What can you do?', 'What time is it in Tokyo?'];
    }
    function _showStarters() {
        if (!c.gate || !c.gate.open || c.ended || c.typeOn || _openSheet()) return false;
        if (c.state !== 'idle' && c.state !== 'awaiting') return false;
        var calib = c.labCalib && c.labCalib.stage;
        if (calib === 'prompt' || calib === 'listening' || calib === 'done' || calib === 'timeout') return false;
        return !(c.convo || []).some(function (m) { return m && m.who === 'you'; });
    }
    // pure: how far the row scrolls so a chip and its focus ring (3 px + 2 px
    // offset) show whole - clear of the row's faded right edge (20 px) too
    function _chipScroll(rowL, rowR, chipL, chipR) {
        if (chipL - 5 < rowL) return Math.round(chipL - 5 - rowL);
        if (chipR + 25 > rowR) return Math.round(Math.min(chipR + 25 - rowR, chipL - 5 - rowL));
        return 0;
    }
    // a chip reached by Tab: Chrome does not scroll a partly shown one into view
    function _chipInView(chip) {
        try {
            var row = chip && chip.closest && chip.closest('.netra-try');
            if (!row || !row.getBoundingClientRect) return;
            var r = row.getBoundingClientRect(), b = chip.getBoundingClientRect();
            var d = _chipScroll(r.left, r.right, b.left, b.right);
            if (d) row.scrollLeft = Math.max(0, (row.scrollLeft || 0) + d);
        } catch (eV) {}
    }
    function _tryStarter(s) {
        var ae = document.activeElement;
        var fromChip = !!(ae && ae.getAttribute && / netra-try-chip /.test(' ' + (ae.getAttribute('class') || '') + ' '));
        _sendTyped(s, 'chip');
        // the chips go once something is asked: the focus goes to Netra, not the page
        if (fromChip) $timeout(function () { _focusEl('.netra-stage-blob-wrap'); }, 60);
    }

    // ---- Settings, in plain words ----
    var _langCache = null, _paceTimer = null;
    c.langName = function (code) { return _langName(code); };
    c.voiceLabel = function (id) { return _voiceName(id); };
    c.neuralVoices = function () { return _neuralVoices(); };
    c.deviceVoices = function () { return _deviceVoices(); };
    c.setDeviceVoice = function () { _setDeviceVoice(c.voicePick); };
    c.paceText = function () { return _paceText(c.speechRate); };
    c.setPace = function () { c.devSetRate(); _pacePreview(); };
    c.openLab = function () { _labFromSettings(); };
    c.setMicCheck = function () { _micCheckFromSettings(); };
    c.shortcutsOn = true;
    try { c.shortcutsOn = localStorage.getItem('netra_shortcuts') !== '0'; } catch (eSk) {}
    c.setShortcuts = function () {
        try { localStorage.setItem('netra_shortcuts', c.shortcutsOn ? '1' : '0'); } catch (eSk2) {}
    };
    // 'en-US' -> 'English (United States)'; the code itself where the browser can not name it
    function _langName(code) {
        var s = String(code || '');
        if (_langCache && _langCache.hasOwnProperty(s)) return _langCache[s];
        var name = s;
        try {
            if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
                var parts = s.split('-');
                var lang = new Intl.DisplayNames(['en'], { type: 'language' }).of(parts[0]);
                var reg = parts[1] ? new Intl.DisplayNames(['en'], { type: 'region' }).of(parts[1]) : '';
                if (lang && lang !== parts[0]) name = reg && reg !== parts[1] ? lang + ' (' + reg + ')' : lang;
            }
        } catch (eL) { name = s; }
        (_langCache = _langCache || {})[s] = name;
        return name;
    }
    // 'en-US-AvaMultilingualNeural' -> 'Ava (US English)'
    function _voiceName(id) {
        var s = String(id || ''), m = /^([a-z]{2}-[A-Z]{2})-([A-Za-z]+?)(Multilingual)?Neural$/.exec(s);
        var where = m && { 'en-US': 'US English', 'en-GB': 'British English', 'en-IN': 'Indian English', 'en-AU': 'Australian English', 'hi-IN': 'Hindi' }[m[1]];
        return where ? m[2] + ' (' + where + ')' : s.replace(/Neural$/, '');
    }
    // Microsoft's neural voices play only on the Edge engine in Microsoft
    // Edge; anywhere else the voice is one of this device's own, so Settings
    // offers those (a neural pick there was never heard)
    function _neuralVoices() {
        return (c.ttsEngine || 'browser') === 'edge' && !!_edgeVoiceAvailable();
    }
    // this device's voices for Settings: the language she listens for first,
    // then English, then the rest, by a plain name. The same array until the
    // list changes (ng-options reads it every digest)
    var _devVoices = null;
    function _deviceVoices() {
        var list = [];
        try { list = (c.hasTTS && TTS && TTS.getVoices) ? (TTS.getVoices() || []) : []; } catch (eV) { list = []; }
        var base = String(c.recLang || 'en').split('-')[0].toLowerCase(), pick = String(c.voicePick || '');
        var key = [base, pick, list.length, list.length && list[0].name, list.length && list[list.length - 1].name].join('|');
        if (_devVoices && _devVoices.key === key) return _devVoices.out;
        var rank = function (v) { var l = String(v.lang || '').toLowerCase().split(/[-_]/)[0]; return l === base ? 0 : (l === 'en' ? 1 : 2); };
        var out = list.map(function (v, i) { return { name: v.name, label: _deviceVoiceLabel(v), r: rank(v), i: i }; })
            .sort(function (a, b) { return a.r - b.r || a.i - b.i; });
        out.unshift({ name: '', label: 'The best voice on this device' });
        // a pick this device no longer has is said so, not shown as a blank
        if (pick && list.length && !out.some(function (v) { return v.name === pick; })) out.push({ name: pick, label: pick + ' (not on this device now)' });
        _devVoices = { key: key, out: out };
        return out;
    }
    // 'Microsoft Aria Online (Natural) - English (United States)' -> 'Aria, English (United States)'
    function _deviceVoiceLabel(v) {
        var name = String(v && v.name || '').replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '').replace(/\s+Online\s+\(Natural\)/, '').trim();
        var lang = _langName(String(v && v.lang || '').replace('_', '-'));
        return lang && name.indexOf(lang.split(' ')[0]) < 0 ? name + ', ' + lang : name;
    }
    // a voice picked in Settings: this device speaks with it from now on
    // (chooseVoice takes forcedVoiceName first), and on the next visit too
    function _setDeviceVoice(name) {
        forcedVoiceName = String(name || '');
        try {
            if (forcedVoiceName) localStorage.setItem('netra_voicePick', forcedVoiceName);
            else localStorage.removeItem('netra_voicePick');
        } catch (eP) {}
        if (forcedVoiceName) c.voiceName = forcedVoiceName;
        else chooseVoice();
        logEvent('dev', 'voice -> ' + (forcedVoiceName || 'the best on this device'));
    }
    // 'Hear this voice': the voice that really speaks, by its plain name. A
    // Guest or a read-only reviewer is not called by a name
    function _previewVoice() {
        var d = c.data || {}, first = (d.is_guest || d.read_only) ? '' : String(d.user_name || '').split(' ')[0];
        if (/^guest$/i.test(first)) first = '';
        var eng = c.ttsEngine || 'browser', who = '';
        // the neural name only while that voice really plays (a tripped read-aloud socket falls back)
        if (_neuralVoices() && !_edgeCircuitOpen()) who = String(_voiceName(c.edgeVoice)).replace(/\s*\(.*$/, '');
        else if (eng === 'browser' || eng === 'edge') { var v = chooseVoice(); who = v ? _deviceVoiceLabel(v).split(',')[0] : ''; }
        var pace = _paceText(c.speechRate);
        speak((first ? 'Hi ' + first + '. ' : 'Hi. ') + (who ? 'This is the ' + who + ' voice, ' : 'This is my voice, ') +
              (pace === 'normal' ? 'at a normal pace.' : pace + ' than normal.'));
    }
    function _paceText(rate) {
        var r = parseFloat(rate);
        return r > 1.05 ? 'a bit faster' : (r < 0.95 ? 'a bit slower' : 'normal');
    }
    // one sample line once the slider rests, not one per step
    function _pacePreview() {
        if (_paceTimer) $timeout.cancel(_paceTimer);
        _paceTimer = $timeout(function () { _paceTimer = null; speak('This is my new pace.'); }, 600);
    }
    function _labFromSettings() {
        _sheetClose(true);
        _labOpen(true);
    }
    // the mic check's card sits on the stage, under the sheet's scrim and
    // outside its Tab trap: the sheet steps aside and Skip takes the focus
    function _micCheckFromSettings() {
        _sheetClose(true);
        c.calibRetry();
        $timeout(function () { _focusEl('.netra-calib-skip'); }, 60);
    }

    // ---- single keys on the stage (Settings > Keyboard turns them off) ----
    // pure: which action a key press means, '' for none. Escape always counts
    function _stageKeyAction(key, tag, editable, mods, sheet, typeOn, keysOn, inStage, labOn) {
        if (mods) return '';
        // the Lab is on top of the stage: Escape outside it closes it before it stops her
        if (key === 'Escape') return sheet ? 'close-sheet' : (labOn ? 'close-lab' : (typeOn ? 'close-type' : 'stop'));
        // typing into a field, keys off, the portal page, or a sheet (a modal) has the focus
        if (!keysOn || !inStage || sheet || editable || /^(INPUT|SELECT|TEXTAREA)$/i.test(String(tag || ''))) return '';
        switch (key) {
            case 'm': case 'M': return 'mute';
            case '/': return 'type';
            case 't': case 'T': return 'transcript';
            case 's': case 'S': return 'settings';
            case '?': return 'help';
        }
        return '';
    }
    function _stageKey(e) {
        var t = e && e.target, inStage = false;
        // the Lab is a dialog of its own: its keys are its own (Escape closes it there)
        try { inStage = !!(t && t.closest && t.closest('.netra-stage') && !t.closest('.netra-lab')); } catch (eC) {}
        // the stage covers the page and the rest is inert: focus left on
        // <body>, or on the portal's scroller round the stage (a click on the
        // stage's background once put it there), is still on the stage
        if (!inStage && c.liveMode && t) {
            try {
                var stage = document.querySelector('.netra-stage');
                inStage = !!(stage && (t === document.body || (t.contains && t.contains(stage))));
            } catch (eS) {}
        }
        var act = _stageKeyAction(e.key, t && t.tagName, !!(t && t.isContentEditable), !!(e.ctrlKey || e.metaKey || e.altKey),
                                  _openSheet(), !!c.typeOn && !c.ended, c.shortcutsOn !== false, inStage, !!c.labOn && !_gateCardUp());
        if (!act) return false;
        // the loading card is a modal: behind it only Escape (stop her) counts
        if (_gateCardUp() && act !== 'stop') return false;
        if (c.ended && (act === 'mute' || act === 'type')) return false;
        switch (act) {
            case 'mute': c.toggleMic(); break;
            case 'type': _typeToggle(true); break;
            case 'transcript': _sheetOpen('log', '.netra-ctl-log'); break;
            case 'settings': _setupToggle(); break;
            case 'close-sheet': _sheetClose(); break;
            case 'close-type': _typeToggle(false); break;
            case 'close-lab': _labOpen(false); break;
            case 'stop':
                if (c.state === 'speaking' || _speakingNow) _stopTalking('Escape key');
                else stopSpeaking('Escape key');
                break;
            case 'help':
                speak('Shortcuts: M, mute. Slash, type. T, transcript. S, settings. Escape, stop Netra talking or close. Enter on Netra: pause or resume.');
                break;
        }
        if (e.preventDefault) e.preventDefault();
        return true;
    }
    // the loading card is on screen (the template's own ng-if)
    function _gateCardUp() { return !!(c.gate && !c.gate.open && !c.gate.typing && !c.ended); }
    function _narrow() { return ($window.innerWidth || 1024) <= 600; }

    /* ============================================================
     *  R14 - MORNING BRIEFING, AUTOMATICALLY.
     *  First visit of the day, once the calibration card is out of
     *  the way, Netra reads the daily briefing on her own - open
     *  tickets, approvals, reminders - like a good assistant should.
     *  Toggle lives in the setup panel, memory of "already briefed
     *  today" lives in localStorage.
     * ============================================================ */
    c.prefBrief = true;
    try { c.prefBrief = localStorage.getItem('netra_brief_on') !== '0'; } catch (eB0) {}
    c.setBrief = function () {
        try { localStorage.setItem('netra_brief_on', c.prefBrief ? '1' : '0'); } catch (eB1) {}
        logEvent('boot', 'morning briefing ' + (c.prefBrief ? 'on' : 'off'));
    };
    function _todayKey() {
        var d = new Date();
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
    // is an answer still owed? a parked read-back for up to the server's 10
    // minutes, a plain question for a minute - never "for the whole visit"
    function _stillAwaiting() {
        var now = Date.now();
        if (c._awaitingConfirm && now - (c._awaitingConfirmAt || 0) < 10 * 60000) return true;
        return /\?\s*["']?\s*$/.test(String(c.lastAnswer || '')) && now - (c.lastAnswerAt || 0) < 60000;
    }
    // may Netra speak up unasked (a notification, a reminder)? never over the
    // user, the mic check, a turn in flight, her own audio, or a question the
    // user still owes an answer to - a "yes" said after it would confirm the
    // read-back, not the interjection
    function _floorFree() {
        if (_speakingNow || _chatInFlight || _queuedUtterance) return false;
        if (_fillerChainActive || currentFillerAudio || currentFillerUtter) return false;
        if (c.state === 'speaking' || c.state === 'thinking' || c.state === 'awaiting') return false;
        if (String(c.interim || '').trim() || Date.now() - (_lastInterimAt || 0) < 1500) return false;
        if (c.labCalib && (c.labCalib.stage === 'listening' || c.labCalib.stage === 'prompt')) return false;
        return !_stillAwaiting();
    }
    function _maybeAutoBrief(tries) {
        if (!c.liveMode || !c.prefBrief) return;
        if (c.data && c.data.is_guest) return;   // R21 - a Guest has no queue to brief
        if (c.gate && !c.gate.open) { if (tries < 12) $timeout(function () { _maybeAutoBrief(tries + 1); }, 12000); return; }
        var last = '';
        try { last = localStorage.getItem('netra_brief_last') || ''; } catch (eB2) {}
        if (last === _todayKey()) return;   // already briefed today
        var calibBusy = c.labCalib && (c.labCalib.stage === 'listening' || c.labCalib.stage === 'prompt');
        // never talk over a question the user has not answered yet, and never
        // squeeze in while a user turn is on the wire or queued behind one
        var awaitingAnswer = _stillAwaiting();
        if (calibBusy || awaitingAnswer || _chatInFlight || _queuedUtterance || !c.alert || c._hushed || c.state === 'speaking' || c.state === 'thinking') {
            if (tries < 12) $timeout(function () { _maybeAutoBrief(tries + 1); }, 12000);
            return;
        }
        try { localStorage.setItem('netra_brief_last', _todayKey()); } catch (eB3) {}
        logEvent('boot', 'first visit today - reading the morning briefing');
        c._nextTurnAuto = 'give me my daily briefing';   // the flag rides with THIS text only
        processCommand('give me my daily briefing', 1.0);   // fast-lane phrasing: zero model calls
    }
    if (c.liveMode) $timeout(function () { _maybeAutoBrief(0); }, 14000);

    // R17 - if standing orders acted while the tab was closed, debrief
    // unprompted. Same wait-until-quiet dance as the morning briefing, but
    // gated on the server's away_pending count instead of the calendar.
    function _maybeAwayDebrief(tries) {
        if (!c.liveMode || !(c.data && c.data.away_pending > 0)) return;
        if (c.data.is_guest) return;
        if (c.gate && !c.gate.open) { if (tries < 12) $timeout(function () { _maybeAwayDebrief(tries + 1); }, 12000); return; }
        var calibBusy = c.labCalib && (c.labCalib.stage === 'listening' || c.labCalib.stage === 'prompt');
        var awaitingAnswer = _stillAwaiting();
        if (calibBusy || awaitingAnswer || _chatInFlight || _queuedUtterance || !c.alert || c._hushed || c.state === 'speaking' || c.state === 'thinking') {
            if (tries < 12) $timeout(function () { _maybeAwayDebrief(tries + 1); }, 12000);
            return;
        }
        c.data.away_pending = 0;   // once per boot
        logEvent('boot', 'standing orders acted while away - auto debrief');
        c._nextTurnAuto = 'what did you do while i was away';
        processCommand('what did you do while i was away', 1.0);   // fast-lane phrasing: zero model calls
    }
    if (c.liveMode) $timeout(function () { _maybeAwayDebrief(0); }, 9000);

    // typed commands in the Lab - the same way in as the typing box (_sendTyped)
    c.labCmd = '';
    c.labSendCmd = function () { if (_sendTyped(c.labCmd, 'lab')) c.labCmd = ''; };
    c.labCmdKey = function (ev) { if (ev && ev.keyCode === 13) c.labSendCmd(); };

    // NLP test: a real turn (its writes happen), result panel in the Lab;
    // speech is muted only until the reply or local answer comes back
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
        if (_narrow()) return;   // a phone: the Lab is a bottom sheet, never dragged
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
    c.lab3dFps = function () { return window.__netra3dFps || 0; };   // R12 - live render fps

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

    var _calibSession = 0;   // R13 - stale TTS callbacks must never revive a skipped card
    function startCalibration(firstRun, preamble) {
        if (_calibActive) return;
        _calibActive = true;
        _calibFirstRun = !!firstRun;
        var mySession = ++_calibSession;
        c.labCalib = { stage: 'prompt', heard: '', score: null, verdict: '' };
        _calibFocus();   // a re-run by voice: focus on the card's old Close goes to Skip
        $scope.$applyAsync();
        speak((preamble || '') + 'Quick mic calibration. After the tone, please read this sentence aloud: ' +
              CALIB_SENTENCE + '.', function () {
            // R13 FIX - if Skip landed while the prompt was still being
            // spoken, the cancelled speech still fires this done-callback
            // (on every engine except edge-live). It used to push the card
            // straight back into "listening" with all dismiss guards dead -
            // THE "skip does nothing at page load" bug. Stale = no-op now.
            if (!_calibActive || mySession !== _calibSession) return;
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
                _calibFocus();
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
        // R9 - voice escape hatch: "skip" / "not now" bails out instantly.
        // "Stop listening" and friends still mean sleep (routed below).
        var lcCal = clean.toLowerCase().replace(/[.!,?]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (/^((hey |ok |okay )?netra )?(please )?(skip|cancel|stop|not now|later|no thanks?)( (it|this|that|please|now|for now|thanks|thank you|netra|(the )?(mic )?(check|test|calibration)))*$/.test(lcCal) &&
            (lcCal === 'stop' || !matchSleep(lcCal))) {
            c.calibSkip();
            return true;
        }
        var score = _wordAccuracy(CALIB_SENTENCE, clean);
        // not the sentence at all: the user moved on. End the check unscored
        // and let this final run as the command it is.
        var own = {}, shared = 0;
        _normTokens(CALIB_SENTENCE).forEach(function (w) { if (w !== 'the') own[w] = 1; });
        _normTokens(clean).forEach(function (w) { if (own[w]) { shared++; own[w] = 0; } });
        if (score < 30 && shared < 2) {
            _calibActive = false;
            _calibSession++;
            if (_calibTimer) { $timeout.cancel(_calibTimer); _calibTimer = null; }
            c.labCalib.stage = 'skipped';
            _calibFocus();
            logEvent('lab', 'calibration ended unscored - "' + clean + '" is a command, not the read-back');
            $scope.$applyAsync();
            return false;
        }
        _calibActive = false;
        if (_calibTimer) { $timeout.cancel(_calibTimer); _calibTimer = null; }
        c.labCalib = {
            stage: 'done', heard: clean, score: score,
            verdict: score >= 90 ? 'Excellent - crystal clear.' :
                     score >= 75 ? 'Good - fully usable.' :
                     score >= 50 ? 'Fair - move closer to the mic or cut background noise.' :
                                   'Poor - check the input device and tab permission.'
        };
        _calibFocus();
        c.micHealth.lastCalibScore = score;
        try { localStorage.setItem('netra_calib', JSON.stringify({ score: score, at: new Date().toISOString() })); } catch (eLS) {}
        logEvent('lab', 'calibration ' + score + '% - heard: "' + clean + '"');
        speak('Mic check complete. Word accuracy ' + score + ' percent. ' + c.labCalib.verdict +
              (_calibFirstRun ? ' You are all set. I am listening - just speak.' : ''));
        $scope.$applyAsync();
        return true;
    }

    // ---- R8.2 - local reminders (to-the-minute while the tab is open) ----
    var _localReminderTimers = {};   // reminder id -> $timeout promise
    var _recentReminderTexts = {};   // dedupe vs the scanner-promoted copy
    function _scheduleLocalReminder(delayMs, text, id) {
        // beyond 12 hours the scanner delivers it; a clamped page timer would
        // fire hours early and then again at the real time
        if (!delayMs || delayMs > 12 * 3600 * 1000) return;
        var d = Math.max(1000, delayMs);
        var key = String(id || ('r' + Date.now()));
        logEvent('lab', 'local reminder armed in ' + Math.round(d / 60000) + ' min: ' + text);
        var fire = function () {
            // never cut into a read-back, a reply or the user: try again shortly
            if (!_floorFree()) { _localReminderTimers[key] = $timeout(fire, 4000); return; }
            delete _localReminderTimers[key];
            if (_reminderAlreadySpoken(text)) return;   // the polled copy got there first
            cue('wake');
            // counts as said only once it was heard, so the scanner copy still comes if not
            speak(text || 'Reminder.', function () { _recentReminderTexts[String(text)] = Date.now(); });
            _convoPush('sys', '· reminder fired ·');
        };
        _localReminderTimers[key] = $timeout(fire, d);
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
               ', microphone stream ' + (micOk ? 'live. All good.' : 'not detected - voice may not work.') +
               ' Your settings live on the left edge of the screen - pick the language you speak, my voice, and the mic level, just like setting up a brand new phone. ')
            : (micOk ? 'Quick mic check - say skip to jump straight in. '
                     : 'Heads up, I am not seeing a microphone stream. ');
        // R28 - Settings never open by themselves: a modal nobody asked for is
        // disorienting on arrival. The starters and the greeting show the way in
        // a mic that scored well recently is not checked again on every
        // load: the check read a sentence at the user each time and swallowed
        // their first command. "Mic check" or the Lab runs it any time.
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem('netra_calib') || 'null'); } catch (eSv) {}
        var recentGood = !!(saved && typeof saved.score === 'number' && saved.score >= 75 && saved.at &&
                            Date.now() - Date.parse(saved.at) < 14 * 86400000);
        // R20 - the mic check never runs at start: on a browser whose
        // recognizer is deaf it swallowed the first minute of speech and
        // announced itself every 25 seconds. "Mic check" or the Lab runs it.
        c.labCalib = recentGood
            ? { stage: 'saved', heard: '', score: saved.score, verdict: 'last run ' + String(saved.at).substring(0, 10) + ' - say "mic check" to run again' }
            : { stage: 'idle', heard: '', score: 0, verdict: 'say "mic check" or use the Lab to run it' };
        void uiLine;
        $scope.$applyAsync();
    }
    c.calibSkip = function () { _calibSkip(); };
    c.calibRetry = function () { _calibRetry(); };
    c.calibDismiss = function () { _calibDismiss(); };
    function _calibSkip() {
        // R13 - always dismissable: even if a stale state left the card
        // visible with _calibActive already false, Skip still kills it
        var wasActive = _calibActive;
        _calibActive = false;
        _calibSession++;   // invalidate any in-flight TTS done-callback
        if (_calibTimer) { $timeout.cancel(_calibTimer); _calibTimer = null; }
        c.labCalib.stage = 'skipped';
        _calibFocus();
        logEvent('lab', 'calibration skipped' + (wasActive ? '' : ' (defensive dismiss)'));
        stopSpeaking('calibration skipped');
        if (wasActive) speak('Skipped. I am listening - just speak.');
        $scope.$applyAsync();
    }
    function _calibRetry() {
        c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
        startCalibration(false, '');
        _calibFocus();
    }
    function _calibDismiss() {
        c.labCalib.stage = 'idle';
        _calibFocus();
        $scope.$applyAsync();
    }
    // the card's buttons come and go with its stage (ng-show): focus on one
    // moves to the button the new stage shows - Skip while it listens, Close
    // on a result, Try again when nothing was heard - and to the orb once
    // the card goes. Never to <body>
    function _calibFocus() {
        var a = null;
        try { a = document.activeElement; } catch (eA) {}
        if (!(a && a.closest && a.closest('.netra-calib-card'))) return;
        var st = c.labCalib && c.labCalib.stage;
        var to = (st === 'prompt' || st === 'listening') ? '.netra-calib-skip'
               : st === 'done' ? '.netra-calib-close'
               : st === 'timeout' ? '.netra-calib-retry' : '.netra-stage-blob-wrap';
        $timeout(function () { _focusEl(to); }, 30);
    }

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
        // R12 - listening went GREEN (the heart inside the 3D blob diffuses
        // green gradients from the centre while she hears you); the rest
        // stays on the gemini palette
        boot: 230, idle: 217, awaiting: 148, listening: 152,
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
        var target = PRISM_STATE_HUE[st] !== undefined ? PRISM_STATE_HUE[st] : 152;
        var levelNow = 0;
        // Calm visuals: one colour per state, no drift and no pulse with the voice
        if (!c.calm) _prismTime += 0.016;
        if (c.calm) {
            // the state's own hue, held
        } else if (st === 'speaking') {
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
        if (c.calm || !c.liveMode || c.state !== 'speaking') return;   // Calm visuals: no rings
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
        // Calm visuals: the blob settles into one still shape per state
        var still = !!c.calm;
        // thinking gets a quicker, tighter churn - "working on it"
        if (!still) _blobPhase += thinking ? 0.085 : (speaking ? 0.055 : 0.022);
        var ox = new Array(24), oy = new Array(24);
        var ix = new Array(24), iy = new Array(24);
        for (var i = 0; i < 24; i++) {
            var bandLvl = still ? 0 : ((bands && bands[i] !== undefined) ? bands[i] : lvlAvg);
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
                if (!(c.data && c.data.is_guest) && Object.keys(srvVocab).length === 0 && Object.keys(srvAliases).length === 0) {
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
        // R21 - every public visitor is the one Guest user: what a Guest
        // teaches stays in this tab, never on the shared server row
        if (c.data && c.data.is_guest) { _refreshTrainingViews(); return; }
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

    // HEARD, NOT TYPED - what the recognizer makes of Netra's command words,
    // and the word that was meant: [pattern source, replacement], applied in
    // order on word boundaries, case-insensitive, to speech only (a typed
    // word is never rewritten). One copy here and one in server.js: a test
    // keeps the two identical, so keep this body exactly the same in both.
    function _forgiveTable() {
        // a spoken number follows: "instant 13", "in c one three", "p one"
        var num = '(?= ?(?:\\d+|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\\b)';
        // a record or pronoun follows: "results it", "a sign this to", "wash inc"
        var rec = '(?= (?:it|this|that|the|to|incident|inc|ticket|change|problem|request)\\b)';
        // the start of what was said, past her name
        var lead = '^((?:(?:hey|ok|okay) )?netra[,!.]* )?';
        // three or more digits follow: a ticket number, never "ink 3 times"
        var dig = '(?:\\d|zero|oh|one|two|three|four|five|six|seven|eight|nine)';
        var num3 = '(?= ?(?:\\d{3,}|(?:' + dig + ' ){2}' + dig + ')\\b)';
        return [
            // tickets
            ['\\btickers\\b', 'tickets'],
            ['\\bticker\\b' + num, 'ticket'],
            ['\\b(my|this|that|new|open|latest|last) ticker\\b', '$1 ticket'],
            ['\\bticket[\'\u2019]s\\b', 'tickets'],
            ['\\btick its\\b', 'tickets'],
            ['\\b(?:tiket|tickit|tikit)(s?)\\b', 'ticket$1'],
            ['\\b(?:lift|least|lest|lists) my(?= (?:tickets?|approvals?|incidents?|work|queue|cases)\\b)', 'list my'],
            // incidents
            ['\\b(?:insident|in sedent|incidant)(s?)\\b', 'incident$1'],
            ['\\bincidence\\b' + num, 'incident'],
            ['\\binstant(s?)\\b' + num, 'incident$1'],
            ['\\b(?:in c|ink|i and c)\\b\\.?' + num3, 'INC'],
            // approvals
            ['\\b(my|pending|any|of) approval\\b(?! (?:request|rule|process|for|from|on|of)\\b)', '$1 approvals'],
            [lead + 'approval$', '$1approvals'],
            ['\\ba provals?\\b', 'approvals'],
            ['\\b(my|pending|any) approvers\\b', '$1 approvals'],
            ['\\ba (?:prove|proof)\\b(?= (?:it|this|that|the|them|all)\\b)', 'approve'],
            // resolve, assign, close, escalate, watch, nudge
            [lead + 'resolved\\b' + rec, '$1resolve'],
            [lead + 'resolved\\b' + num, '$1resolve'],
            ['\\bresults\\b(?= (?:it|this|that)\\b)', 'resolve'],
            ['\\b(?:re solve|dissolve)\\b' + rec, 'resolve'],
            ['\\ba sign\\b' + rec, 'assign'],
            ['\\ba sign\\b' + num, 'assign'],
            ['\\bdesign\\b(?= (?:it|this|to)\\b)', 'assign'],
            ['\\bdesign\\b' + num, 'assign'],
            ['\\b(?:a ?sign|assign) ?ee\\b', 'assignee'],
            ['\\bclothes\\b' + rec, 'close'],
            ['\\bescalade\\b', 'escalate'],
            ['\\bwash(?= (?:it|this|that|incident|inc|ticket|change|problem|request|the (?:incident|inc|ticket|change|problem|request|queue))\\b)', 'watch'],
            ['\\b(?:notch|judge)\\b(?= (?:the (?:assignee|owner|assigned|group|team|person|user|caller)|him|her|them|whoever)\\b)', 'nudge'],
            ['\\bpriorty\\b', 'priority'],
            // the fast lane's own phrases
            ['\\b(while i was) (?:awake|a way|a wake)\\b', '$1 away'],
            ['\\b(?:then meet a joke|tell me joke|tell me the joke|tell me a (?:choke|jock|jog|yoke))\\b', 'tell me a joke'],
            ['\\bwhat can (?:u|you) do for me\\b', 'what can you do'],
            ['\\bwhat can u do\\b', 'what can you do'],
            ['\\bstatus off\\b(?= (?:incident|inc|ticket|change|problem|request|my|the|that|this|it)\\b)', 'status of'],
            ['\\bstate us of\\b', 'status of'],
            ['\\b(?:de|dee|d) brief\\b', 'debrief'],
            ['\\b(daily|morning) (?:breathing|beefing|briefly)\\b', '$1 briefing'],
            ['\\bread arrest\\b', 'read the rest'],
            [lead + 'pardon me$', '$1pardon'],
            [lead + 'undue( that| it)?$', '$1undo$2'],
            [lead + 'and do (that|it)$', '$1undo $2'],
            ['\\bre index\\b', 'reindex'],
            ['\\btry age\\b', 'triage'],
            ['\\bcommission\\b(?= (?:status|report|progress)\\b)', 'mission'],
            ['\\b(pause|resume|cancel|stop|undo|the|apply) commission\\b', '$1 mission'],
            // names and codes
            // the name, not "restart the service now": one of its own nouns follows
            ['\\bservice now(?= (?:docs?|documentation|instance|portal|page|record|ticket|app|application|community|developer|store|kb|knowledge|itsm|release|releases|version|update|updates)\\b)', 'ServiceNow'],
            ['\\bservice snow\\b', 'ServiceNow'],
            ['\\b(?:a ?)?p(?:ee)? ?(?:one|1)\\b', 'P1'],
            ['\\b(?:a ?)?p(?:ee)? ?(?:two|2)\\b', 'P2'],
            ['\\b(?:a ?)?p(?:ee)? ?(?:three|3)\\b', 'P3'],
            ['\\b(?:a ?)?p(?:ee)? ?(?:four|4)\\b', 'P4'],
            ['\\bworknote(s?)\\b', 'work note$1'],
            ['\\bwork not\\b', 'work note']
        ];
    }
    var _forgiveRules = null;   // the table, compiled once
    function _forgive(text) {
        var out = String(text || '');
        if (!out) return out;
        if (!_forgiveRules) _forgiveRules = _forgiveTable().map(function (r) { return [new RegExp(r[0], 'gi'), r[1]]; });
        for (var i = 0; i < _forgiveRules.length; i++) out = out.replace(_forgiveRules[i][0], _forgiveRules[i][1]);
        return out;
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
        if (c.data && c.data.is_guest) { logEvent('train', 'cleared this tab\'s training'); return; }
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
    var _hotkeyHandler = null, _visibilityHandler = null;   // removed on destroy
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

    // R24 - what a screen reader hears for each state. This page has no wake
    // word, and while the loading screen is up she is only getting ready
    function _stateLabel(s) {
        if ((s === 'idle' || s === 'awaiting') && c.gate && !c.gate.open) return 'getting ready';
        var labels = {
            idle:      'listening - just speak',
            awaiting:  'listening - just speak',
            thinking:  'thinking',
            speaking:  'speaking',
            dormant:   'paused - say Netra or tap to resume',
            error:     'error - check the event log',
            boot:      'getting ready'
        };
        return labels[s] || s;
    }

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
    var seenIds     = {};   // notifications already spoken on this page
    var _ackIds     = [];   // spoken, not yet reported to the server
    var geminiHistory = [];
    /* ============================================================
     *  R11 - DEEP MEMORY (client side)
     *  The conversation used to live only in this closure var, so a
     *  simple page refresh wiped everything Netra knew - and since
     *  calibration reloads run all the time that felt like she had
     *  the memory of a goldfish. Now the history survives the tab:
     *  saved to sessionStorage after every turn (screenshots
     *  stripped, size-capped) and restored on boot. c.mem feeds the
     *  MEMORY card in Netra Lab.
     * ============================================================ */
    var MEM_STORE_KEY = 'netra_history_v1';
    c.mem = { prompts: 0, entries: 0, kb: 0, restored: 0 };
    function _memCountPrompts(arr) {
        var n = 0;
        for (var i = 0; i < (arr || []).length; i++) {
            var e = arr[i];
            if (!e || e.role !== 'user' || !e.parts) continue;
            for (var p = 0; p < e.parts.length; p++) {
                if (e.parts[p] && e.parts[p].text && !e.parts[p].functionResponse) { n++; break; }
            }
        }
        return n;
    }
    // history is only ever cut in front of a user prompt (not a tool
    // response, not the memory digest): a tool call cut off from its
    // response makes every later model turn fail
    function _isPromptEntry(e) {
        if (!e || e.role !== 'user' || !e.parts || !e.parts.length) return false;
        if (e.parts[0] && e.parts[0].text && String(e.parts[0].text).indexOf('[memory digest') === 0) return false;
        for (var p = 0; p < e.parts.length; p++) {
            if (e.parts[p] && e.parts[p].text && !e.parts[p].functionResponse) return true;
        }
        return false;
    }
    function _promptIndexFrom(arr, from) {
        for (var i = Math.max(0, from); i < arr.length; i++) if (_isPromptEntry(arr[i])) return i;
        // no prompt after the cut point (one long tool-heavy exchange): keep
        // from the last prompt before it - a trim must never wipe the memory
        var last = _lastPromptIndex(arr);
        return last >= 0 ? last : arr.length;
    }
    function _lastPromptIndex(arr) {
        for (var i = arr.length - 1; i >= 0; i--) if (_isPromptEntry(arr[i])) return i;
        return -1;
    }
    function _memRefreshStats() {
        c.mem.entries = geminiHistory.length;
        c.mem.prompts = _memCountPrompts(geminiHistory);
        try { c.mem.kb = Math.round(JSON.stringify(geminiHistory).length / 1024); } catch (eK) { c.mem.kb = 0; }
    }
    function _memPersist() {
        try {
            // strip binary frames before saving - a single screenshot would
            // blow the storage quota for zero benefit
            var lean = geminiHistory.map(function (e) {
                if (!e || !e.parts) return e;
                var parts = e.parts.filter(function (p) { return p && !p.inlineData; });
                return { role: e.role, parts: parts };
            }).filter(function (e) { return e && e.parts && e.parts.length; });
            var raw = JSON.stringify(lean);
            if (raw.length > 400000) {   // keep the tab snappy: persist newest ~400KB
                lean = lean.slice(_promptIndexFrom(lean, Math.floor(lean.length / 2)));
                raw = JSON.stringify(lean);
            }
            sessionStorage.setItem(MEM_STORE_KEY, raw);
        } catch (eP) {
            try { sessionStorage.removeItem(MEM_STORE_KEY); } catch (eP2) {}
            logEvent('warn', 'memory: could not persist history (' + (eP.message || 'quota') + ')');
        }
        _memRefreshStats();
    }
    function _memRestore() {
        try {
            var raw = sessionStorage.getItem(MEM_STORE_KEY);
            if (!raw) return;
            var arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) {
                geminiHistory = arr;
                c.mem.restored = _memCountPrompts(arr);
                logEvent('mem', 'memory restored: ' + arr.length + ' turns (' + c.mem.restored + ' of your prompts) survive the refresh');
            }
        } catch (eR) {
            logEvent('warn', 'memory: stored history unreadable, starting fresh');
            try { sessionStorage.removeItem(MEM_STORE_KEY); } catch (eR2) {}
        }
        _memRefreshStats();
    }
    function _memForget(why) {
        geminiHistory = [];
        try { sessionStorage.removeItem(MEM_STORE_KEY); } catch (eF) {}
        _memRefreshStats();
        logEvent('mem', 'memory cleared (' + why + ')');
    }
    c.memForget = function () { _memForget('Netra Lab button'); };
    _memRestore();   // pull the conversation back in before anything speaks
    var booted      = false;
    var lastReply   = '';
    var forcedVoiceName = '';
    // the voice picked in Settings on this device, if any
    try { forcedVoiceName = c.voicePick = String(localStorage.getItem('netra_voicePick') || ''); } catch (eFv) {}
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
        'netra','neetra','naitra','naytra','naetra','neetraa','netraa','netaa','netraah','nada','nadra','nadar',
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

    // Wake-list entries that are everyday words or common names: they may
    // strip a leading "Netra" while awake, but never wake her from sleep.
    function _isSleepWakeWord(w) {
        var lw = String(w || '').toLowerCase();
        return WAKE_WORDS.indexOf(lw) >= 0 &&
            !/^(nada|nadra|nadar|near|knee|intra|centra|mantra|matra|mitra|meera|mehra|nehra|nair|neha|nira|neeraj|natraj|neeti|niti|neta|neeta|natta|natha|meetha|nidra)$/.test(lw);
    }

    // Only a LEADING "Netra" (or "hey/ok Netra") addresses her: returns the
    // rest of the ORIGINAL text, or null. A name mid-sentence ("assign it to
    // Neha Sharma") is part of the command and is never cut at.
    function matchesWake(text, asleep) {
        if (!text) return null;
        var words = String(text).toLowerCase().split(/[\s,\.!?;:\-]+/).filter(Boolean);
        var isWake = asleep ? _isSleepWakeWord : isWakeWord;
        var lead = 0;
        if (words.length && isWake(words[0])) lead = 1;
        else if (words.length > 1 && SALUTATION_PREFIXES.indexOf(words[0]) >= 0 && isWake(words[1])) lead = 2;
        if (!lead) return null;
        return String(text).replace(new RegExp('^[\\s,.!?;:\\-]*(?:[^\\s,.!?;:\\-]+[\\s,.!?;:\\-]*){' + lead + '}'), '').trim();
    }

    /* ============================================================
     *  VOICE COMMANDS (sleep / wake)
     * ============================================================ */
    // the WHOLE utterance - "the error does not go away" is dictation, not sleep
    function matchSleep(s) {
        if (!s) return false;
        var t = String(s).trim();
        // a bare "stop" is an interruption, never sleep: she went dormant on
        // it and everything said after was ignored ("she stopped hearing me")
        return /^((ok|okay|alright|thanks|thank you)[,.!]*\s+)?((hey |ok |okay )?netra[,!.]*\s*)?(stop listening|go to sleep|sleep mode|sleep now|pause listening|be quiet|stop now|that'?s all|that is all|go away|goodbye|good ?night)([,\s]+netra)?[.!,?\s]*$/i.test(t);
    }
    function matchExplicitWakeUp(s) {
        if (!s) return false;
        // "wake up" is explicit whatever the recognizer made of her name in
        // front of it ("row wake up", "nada wake up"): one word, any word
        return matchesWake(s, true) !== null ||
            /^((hey |ok |okay )?[a-z']+[,!.\s]+)?(wake\s*up|are\s+you\s+there|come\s+back)([,\s]+[a-z']+)?[.!?\s]*$/i.test(String(s).trim());
    }

    /* ============================================================
     *  LOCAL INTENT SHORTCUTS  (free, no API call)
     * ============================================================ */
    // a time as people write it, "3:05 PM": the caption, the Transcript, a
    // screen reader and braille show it so, and the voices read it as a time
    // (the old "3 oh 5 P M" was written for the voice and shown as it was)
    function _clock(hh, mm) {
        return (hh % 12 || 12) + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (hh < 12 ? 'AM' : 'PM');
    }
    // "Tokyo" or "Japan" to its time, written the way the local time is; null
    // for a place not in the table (the question then goes on as usual)
    function _placeTime(place, nowMs) {
        var p = String(place || '').toLowerCase().replace(/^the /, '').replace(/ (right now|today|at the moment)$/, '').trim();
        var zones = {
            'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo', 'seoul': 'Asia/Seoul', 'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul',
            'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai', 'china': 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', 'taipei': 'Asia/Taipei',
            'singapore': 'Asia/Singapore', 'kuala lumpur': 'Asia/Kuala_Lumpur', 'malaysia': 'Asia/Kuala_Lumpur', 'bangkok': 'Asia/Bangkok',
            'jakarta': 'Asia/Jakarta', 'manila': 'Asia/Manila', 'philippines': 'Asia/Manila', 'hanoi': 'Asia/Bangkok', 'vietnam': 'Asia/Bangkok',
            'india': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata',
            'bengaluru': 'Asia/Kolkata', 'hyderabad': 'Asia/Kolkata', 'chennai': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata', 'pune': 'Asia/Kolkata',
            'karachi': 'Asia/Karachi', 'pakistan': 'Asia/Karachi', 'dhaka': 'Asia/Dhaka', 'bangladesh': 'Asia/Dhaka', 'kathmandu': 'Asia/Kathmandu',
            'nepal': 'Asia/Kathmandu', 'colombo': 'Asia/Colombo', 'sri lanka': 'Asia/Colombo', 'dubai': 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
            'uae': 'Asia/Dubai', 'riyadh': 'Asia/Riyadh', 'saudi arabia': 'Asia/Riyadh', 'doha': 'Asia/Qatar', 'qatar': 'Asia/Qatar',
            'tel aviv': 'Asia/Jerusalem', 'jerusalem': 'Asia/Jerusalem', 'israel': 'Asia/Jerusalem', 'istanbul': 'Europe/Istanbul', 'turkey': 'Europe/Istanbul',
            'moscow': 'Europe/Moscow', 'russia': 'Europe/Moscow', 'cairo': 'Africa/Cairo', 'egypt': 'Africa/Cairo', 'nairobi': 'Africa/Nairobi',
            'kenya': 'Africa/Nairobi', 'lagos': 'Africa/Lagos', 'nigeria': 'Africa/Lagos', 'johannesburg': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg',
            'south africa': 'Africa/Johannesburg', 'london': 'Europe/London', 'uk': 'Europe/London', 'england': 'Europe/London', 'britain': 'Europe/London',
            'dublin': 'Europe/Dublin', 'ireland': 'Europe/Dublin', 'lisbon': 'Europe/Lisbon', 'portugal': 'Europe/Lisbon', 'paris': 'Europe/Paris',
            'france': 'Europe/Paris', 'berlin': 'Europe/Berlin', 'germany': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'frankfurt': 'Europe/Berlin',
            'amsterdam': 'Europe/Amsterdam', 'netherlands': 'Europe/Amsterdam', 'brussels': 'Europe/Brussels', 'madrid': 'Europe/Madrid', 'spain': 'Europe/Madrid',
            'rome': 'Europe/Rome', 'milan': 'Europe/Rome', 'italy': 'Europe/Rome', 'zurich': 'Europe/Zurich', 'switzerland': 'Europe/Zurich',
            'vienna': 'Europe/Vienna', 'stockholm': 'Europe/Stockholm', 'sweden': 'Europe/Stockholm', 'oslo': 'Europe/Oslo', 'copenhagen': 'Europe/Copenhagen',
            'helsinki': 'Europe/Helsinki', 'warsaw': 'Europe/Warsaw', 'poland': 'Europe/Warsaw', 'athens': 'Europe/Athens', 'greece': 'Europe/Athens',
            'new york': 'America/New_York', 'nyc': 'America/New_York', 'boston': 'America/New_York', 'washington': 'America/New_York',
            'washington dc': 'America/New_York', 'miami': 'America/New_York', 'atlanta': 'America/New_York', 'toronto': 'America/Toronto',
            'montreal': 'America/Toronto', 'chicago': 'America/Chicago', 'dallas': 'America/Chicago', 'houston': 'America/Chicago',
            'denver': 'America/Denver', 'phoenix': 'America/Phoenix', 'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles',
            'san francisco': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles', 'california': 'America/Los_Angeles', 'vancouver': 'America/Vancouver',
            'anchorage': 'America/Anchorage', 'alaska': 'America/Anchorage', 'honolulu': 'Pacific/Honolulu', 'hawaii': 'Pacific/Honolulu',
            'mexico city': 'America/Mexico_City', 'mexico': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo',
            'brazil': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires', 'argentina': 'America/Argentina/Buenos_Aires',
            'bogota': 'America/Bogota', 'lima': 'America/Lima', 'santiago': 'America/Santiago', 'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne',
            'brisbane': 'Australia/Brisbane', 'perth': 'Australia/Perth', 'auckland': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
            'utc': 'UTC', 'gmt': 'UTC'
        };
        var tz = zones[p];
        if (!tz) return null;
        try {
            var parts = {};
            new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23', weekday: 'long' })
                .formatToParts(new Date(nowMs)).forEach(function (x) { parts[x.type] = x.value; });
            var hh = +parts.hour % 24, mm = +parts.minute;
            if (isNaN(hh) || isNaN(mm)) return null;
            var here = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(nowMs).getDay()];
            var name = p.length <= 3 ? p.toUpperCase() : p.replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
            return 'In ' + name + ' it is ' + _clock(hh, mm) + (parts.weekday && parts.weekday !== here ? ', on ' + parts.weekday : '') + '.';
        } catch (eTz) { return null; }
    }
    function matchLocal(s) {
        if (!s) return null;
        var lc = s.toLowerCase().trim();
        // politeness round a question is not part of it: "what time is it
        // please tell me", "can you tell me what day it is"
        lc = lc.replace(/[?.!,]+$/, '').replace(/^(please |kindly |can you |could you |would you |tell me |netra )+/, '').replace(/( please| tell me| can you tell me| kindly| now)+$/, '').trim();

        // R18 - every shortcut below matches the WHOLE utterance. The old
        // versions matched anywhere, so "hey netra, list my tickets" got a
        // greeting, "thanks, now resolve it" got "you're welcome", "what
        // time was that ticket opened" got the clock, and "what are you
        // working on" got "I am Netra". And while Netra is waiting on an
        // answer (her last line ended in a question) nothing here may
        // swallow a yes/no/ok - the old ack rule ate the bare "yes" that
        // confirms a ticket, so the ticket never got raised.
        var bare = lc.replace(/[!.,?]+$/g, '').replace(/^(hey |ok |okay )?netra[,!.]*\s*/, '').trim();
        var expecting = c._awaitingConfirm || /\?\s*["']?\s*$/.test(String(c.lastAnswer || ''));

        // R2.2 - voice-correction: "I said X" / "I meant X" / "the word is X"
        // learns an alias from the PREVIOUS transcript to X. While an answer
        // is awaited, or when it starts with "no", it is that answer: the
        // server must hear it, or the rejected read-back stays live for the
        // next "okay".
        var corrMatch = (expecting || /^no\b/.test(lc)) ? null
            : String(s).trim().match(/^(?:i\s+(?:said|meant)|the\s+word\s+is)\s+(.+)$/i);
        if (corrMatch) {
            var intended = corrMatch[1].trim();
            var misheard = (c.prevHeard || '').toLowerCase().trim();
            // only a restatement of the whole last utterance is a mishearing;
            // "I meant 14" or another ticket number is a changed request
            var restated = !!misheard && misheard !== intended.toLowerCase() &&
                           intended.split(/\s+/).length * 2 >= misheard.split(/\s+/).length &&
                           !/\d/.test(normalizeNumbers(misheard + ' ' + intended));
            var wordIs = /^the\s+word\s+is\b/.test(lc);
            if (restated) c.aliases[misheard] = intended;
            if (restated || wordIs) {
                intended.toLowerCase().split(/\s+/).forEach(function (tk) {
                    if (tk.length < 2) return;
                    c.personalVocab[tk] = c.personalVocab[tk] || { count: 0, lastSeen: 0 };
                    c.personalVocab[tk].count += 3;
                    c.personalVocab[tk].lastSeen = Date.now();
                });
                saveTrainingData();
                if (contRec) attachGrammar(contRec);
            }
            // "I said X" asks for X: run it instead of only noting it
            if (!wordIs) return { intent: 'correction', forward: intended };
            return { intent: 'correction',
                     reply: 'Noted — I will listen for "' + intended + '" from now on.' };
        }

        // greetings (English + Indian) - only when that is ALL they said
        if (/^(hi|hello|hey|hiya|namaste|namaskar|salaam|salam|good\s*(morning|afternoon|evening|day)|shubh\s*prabhat|shubh\s*ratri)( there)?( netra)?$/.test(lc.replace(/[!.,]+/g, '').trim())) {
            var h = new Date().getHours();
            var greet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
            return { intent: 'greet', reply: greet + ', how may I help you today?' };
        }
        // thanks
        if (/^(ok |okay )?(thanks|thank you|thanks a lot|thank you so much|thanks so much|much appreciated|dhanyavaad|shukriya|thank ya)( netra)?$/.test(bare)) {
            return { intent: 'thanks', reply: 'You are most welcome. Do let me know if anything else is required.' };
        }
        // farewell (no sleep)
        if (/^(bye|goodbye|see you|see ya|catch you later|alvida)$/i.test(bare)) {
            return { intent: 'bye', reply: 'Goodbye. I will be here whenever you need me.' };
        }
        // identity
        if (/^(who are you|what are you|what'?s your name|what is your name|introduce yourself|tell me about yourself|aap kaun ho)$/.test(bare)) {
            return { intent: 'identity', reply: 'I am Netra, your voice assistant for ServiceNow. I can investigate tickets, raise and update them, chase approvals, watch things while you are away, and tell you what I did - all by voice.' };
        }
        // capabilities / help
        // R28 - a Guest asking what Netra can help with gets the honest local
        // answer, not a model promising tickets it can not reach
        if (/^(help|help me|what can you do|what are your capabilities|your capabilities|commands|what do you do|how do i use you|how can i use you|how to use you|what can you help (me )?with|what can i ask( you)?|how can you help( me)?)$/.test(bare) && c.data && c.data.is_guest) {
            return { intent: 'help', reply: 'As a guest I can answer general questions and look things up on the web, tell you the time or the date, or tell a joke. Sign in to ServiceNow and reload this page, and I can work on your tickets, approvals and knowledge articles too.' };
        }
        if (/^(help|help me|what can you do|what are your capabilities|your capabilities|commands|what do you do|how do i use you|how can i use you|how to use you)$/.test(bare)) {
            return { intent: 'help', reply: 'You can ask me things like: what is the status of I N C zero zero one zero zero one three, list my tickets, what are my approvals, investigate that incident, watch it and nudge the assignee if nothing moves, what did you do while I was away, or what are you working on. Just speak naturally.' };
        }
        // R28 - the time somewhere else ("what time is it in Tokyo" is a
        // starter): the browser's own time zones answer it at once and
        // exactly, where a model can be busy and a web page is no answer
        var inPlace = bare.match(/^(?:what(?:'s| is)?(?: the)? (?:current |local )?time(?: is it)?|what time is it|time) in ([a-z .'-]+)$/);
        if (inPlace) {
            var there = _placeTime(inPlace[1], Date.now());
            if (there) return { intent: 'time', reply: there };
        }
        // time
        if (/^(what(\s+is|'s)?(\s+the)?\s+(current\s+)?time( is it)?( now)?|what time is it( now)?|tell\s+me\s+the\s+time|current\s+time|samay\s+kya\s+hai)$/.test(bare)) {
            var t = new Date();
            return { intent: 'time', reply: 'The time is ' + _clock(t.getHours(), t.getMinutes()) + '.' };
        }
        // date
        if (/^(what(\s+is|'s)?(\s+the|\s+today'?s)?\s+date( today| now)?|today'?s\s+date|(what|which) day (is|of the week is) (it|today)( today)?|what('s| is) (the )?day( today)?|aaj\s+kya\s+tareekh\s+hai|aaj\s+kaun\s+sa\s+din\s+hai|tareekh)$/.test(bare)) {
            var d = new Date();
            var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            var dn = d.getDate();
            var sfx = (dn % 100 >= 11 && dn % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[dn % 10] || 'th');
            return { intent: 'date', reply: 'Today is ' + days[d.getDay()] + ', the ' + dn + sfx + ' of ' + months[d.getMonth()] + '.' };
        }
        // small talk
        if (/^(how are you( doing)?( today)?|how'?s it going|how do you do|kaise ho|kya haal( hai)?|sab theek( hai)?)$/.test(bare)) {
            return { intent: 'smalltalk', reply: 'I am doing well, thank you for asking. Ready to help whenever you are.' };
        }
        // acknowledgements - never "yes"/"haan" (the server decides what a
        // yes confirms, for free), and never while an answer is expected
        if (!expecting && /^(ok|okay|alright|fine|got it|understood|theek hai)$/.test(bare)) {
            return { intent: 'ack', reply: 'Anything else I can do?' };
        }
        // joke / fun
        if (/^(tell me a joke|crack a joke|make me laugh|joke please|tell me something funny)$/.test(bare)) {
            return { intent: 'joke', reply: 'Why did the developer go broke? Because he used up all his cache. Anything else?' };
        }
        // version
        if (/^((what|which) version( are you( on| running)?)?|kaunsa version|version)$/.test(bare)) {
            return { intent: 'version', reply: 'I am running Netra version seven - the one that keeps working even when my reasoning models are out of quota.' };
        }
        // R2.9.1 - repeat / say again
        if (/^(repeat|repeat that|say (it|that) again|come again|once more|kya bola)$/i.test(bare)) {
            return { intent: 'repeat', reply: c.lastAnswer || 'I have not said anything yet.' };
        }
        // R2.9.1 - "where am I" - return current Service Portal route
        if (/^(where am i|which page( is this| am i on)?|what page( is this| am i on)?|current page|kahaan hoon)$/.test(bare)) {
            var pageId = '';
            try {
                var qp = new URLSearchParams(window.location.search);
                pageId = qp.get('id') || 'index';
            } catch (e) { pageId = 'unknown'; }
            return { intent: 'where', reply: 'You are on the ' + pageId.replace(/_/g,' ') + ' page of the Service Portal.' };
        }
        // R2.9.1 - quiet / silence (without sleeping)
        if (/^(quiet|silence|hush|be quiet|chup|chup ho)$/i.test(bare)) {
            return { intent: 'quiet', reply: 'Of course. I will stay silent until you speak to me again - only a reminder you set will still speak up.' };
        }
        // R2.9.1 - speed up / slow down playback
        if (/^(please )?((speak|talk) (faster|quicker)|hurry up|jaldi)( please)?$/.test(bare)) {
            return { intent: 'pace', reply: 'I will speak a bit quicker from now on.' };
        }
        if (/^(please )?((speak|talk) (slower|slowly)|slow down|dheere)( please)?$/.test(bare)) {
            return { intent: 'pace', reply: 'I will slow down a touch.' };
        }
        // R2.9.1 - acknowledgement variants
        if (!expecting && /^(cool|nice|great|awesome|perfect|wonderful|bahut khoob|wah)$/i.test(bare)) {
            return { intent: 'praise', reply: 'Thank you. Happy to help.' };
        }
        // R2.10 - conversational repair: rewind the chat memory ONLY.
        // "undo that" / "cancel that" / "never mind" are NOT here any more -
        // they go to the server, which really reverses the last write (the
        // old local version said "Undone" while the ticket still existed)
        // and which can drop a read-back that is waiting for a yes.
        if (!expecting && /^(scratch that|forget that|rewind|go back)$/i.test(bare)) {
            // it sets the talk aside - it does not reverse what was done
            return { intent: 'rewind', _action: 'rewind_mem',
                     reply: 'Okay, I have set that last exchange aside. If I changed anything in it, that still stands - say "undo that" to reverse it. What would you like to do?' };
        }
        return null;
    }

    // "speak slower/faster" moves the same pace the setup slider sets
    function _stepPace(up) {
        var r = parseFloat(c.speechRate) || 1.06;
        var next = Math.max(0.85, Math.min(1.3, Math.round((r + (up ? 0.08 : -0.08)) * 100) / 100));
        if (next === r) return up ? 'That is already my fastest pace.' : 'That is already my slowest pace.';
        c.speechRate = next;
        try { localStorage.setItem('netra_speechRate', String(next)); } catch (e) {}
        return up ? 'I will speak a bit quicker from now on.' : 'I will slow down a touch.';
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
        // Only a 4+ digit number is a ticket: "request 2 laptops" and "a
        // problem 1 of my users has" are counts, not REQ0000002 / PRB0000001.
        out = out.replace(/\bincident\s+(\d{4,})\b/gi, function(_,d){return 'INC' + d;});
        out = out.replace(/\bchange\s+(?:request\s+)?(\d{4,})\b/gi, function(_,d){return 'CHG' + d;});
        out = out.replace(/\bproblem\s+(\d{4,})\b/gi, function(_,d){return 'PRB' + d;});
        out = out.replace(/\brequest\s+(\d{4,})\b/gi, function(_,d){return 'REQ' + d;});
        out = out.replace(/\b(?:knowledge|article|kbase)\s+(\d{4,})\b/gi, function(_,d){return 'KB' + d;});
        // R5 - "vulnerable item 2345" / "vit 2345" -> VIT0002345
        out = out.replace(/\b(?:vulnerable\s+item|vulnerability\s+item|vit)\s+(\d{4,})\b/gi, function(_,d){return 'VIT' + d;});

        // coalesce PREFIX + digits possibly separated by spaces. The match
        // ends on a digit so the next word keeps its space ("INC0010013 please"),
        // and a number never takes more than 7 digits ("INC0010013 10 users").
        out = out.replace(/\b(INC|CHG|RITM|SCTASK|PRB|KB|REQ|TASK|VIT)\s*(\d(?:\s*\d)*)/g, function (_, prefix, digits) {
            var cleaned = digits.replace(/\s+/g,'');
            var rest = '';
            if (cleaned.length > 7) { rest = ' ' + cleaned.substring(7); cleaned = cleaned.substring(0, 7); }
            // pad to 7 digits for ticket-like prefixes
            if (cleaned.length > 0 && cleaned.length < 7 && /^(INC|CHG|RITM|SCTASK|PRB|REQ|TASK|VIT)$/.test(prefix)) {
                while (cleaned.length < 7) cleaned = '0' + cleaned;
            }
            return prefix + cleaned + rest;
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
        if (c.events.length > 250) c.events.length = 250;   // R11 - deeper feed for the Lab
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
        // the live page has the R23 app shell (_appShell); a second manifest,
        // icon and theme colour here would fight it
        if (c.liveMode) return;
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
        _claimPage();
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

    c.$onDestroy = _destroyController;

    // one Netra per page: a controller left behind without $onDestroy would
    // keep a second recognizer, poller and hotkey handler alive
    function _claimPage() {
        try { if ($window.__netraDestroy && $window.__netraDestroy !== _destroyController) $window.__netraDestroy(); } catch (e) {}
        $window.__netraDestroy = _destroyController;
    }

    function _destroyController() {
        if (_ctrlDestroyed) return;
        // R4.5 - mark destroyed so recursive watchdogs stop rescheduling.
        // The _ctrlDestroyed flag is checked at the top of _statsTick,
        // _srActivityWatchdog, __micHealthTick, the listening tick, the
        // poll, startContinuous and speak.
        _ctrlDestroyed = true;
        if ($window.__netraDestroy === _destroyController) $window.__netraDestroy = null;
        c.recRunning = false;
        if (contRec) {
            // onend would schedule a fresh recognizer
            try { contRec.onend = contRec.onresult = contRec.onerror = contRec.onstart = null; } catch (e) {}
            try { contRec.abort(); } catch (e) {}
            contRec = null;
        }
        if (pollTimer) $timeout.cancel(pollTimer);
        if (commandTimer) $timeout.cancel(commandTimer);
        if (_statsTickTimer) $timeout.cancel(_statsTickTimer);
        for (var rk in _localReminderTimers) {
            if (_localReminderTimers.hasOwnProperty(rk)) $timeout.cancel(_localReminderTimers[rk]);
        }
        _localReminderTimers = {};
        try { _cancelReprompt(); } catch (e) {}
        try { if (_hotkeyHandler) $window.removeEventListener('keydown', _hotkeyHandler); } catch (e) {}
        try { if (_visibilityHandler) $window.document.removeEventListener('visibilitychange', _visibilityHandler); } catch (e) {}
        _hotkeyHandler = _visibilityHandler = null;
        // silence every engine without the barge-in blip
        _speakSessionId++;
        if (_edgeLiveWs) {
            try { _edgeLiveWs.onopen = _edgeLiveWs.onmessage = _edgeLiveWs.onerror = _edgeLiveWs.onclose = null; _edgeLiveWs.close(); } catch (e) {}
            _edgeLiveWs = null;
        }
        _silenceCurrentAudio();
        try { stopFillerChain(); } catch (e) {}
        try { stopMicLevelMeter(); } catch (e) {}
        if (TTS) TTS.cancel();
        if (audioCtx) try { audioCtx.close(); } catch (e) {}
        // the portal page stays after a single-page navigation: nothing left inert
        _gateInertRestore();
    }

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
        if (_micStream || _ctrlDestroyed) return;   // already running
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
            if (_ctrlDestroyed) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            _micStream = stream;
            c.micStreamActive = true;
            $scope.$applyAsync();
            // R13 - react to track death INSTANTLY (Zoom/Teams style)
            // instead of waiting for the 20s health poll. onmute fires when
            // the OS/browser silences the device, onended when it goes away
            // (unplugged headset, revoked permission, device sleep).
            try {
                stream.getAudioTracks().forEach(function (tr) {
                    tr.onended = function () {
                        logEvent('warn', 'mic track ended (device gone?) - rebuilding the whole stack');
                        _fullMicRecycle('track ended');
                    };
                    tr.onmute = function () {
                        logEvent('warn', 'mic track muted by the system - watching for unmute');
                        $timeout(function () {
                            var still = _micStream && _micStream.getAudioTracks().some(function (t2) { return t2.muted; });
                            if (still) _fullMicRecycle('track stayed muted 3s');
                        }, 3000);
                    };
                });
            } catch (eTrk) {}
            _micCtx = _newMicContext();
            // R27 - WebKit: follow the context; a capturing page may resume it
            try {
                _micCtx.onstatechange = function () {
                    if (!_micCtx) return;
                    logEvent('mic', 'mic audio ' + _micCtx.state);
                    if (_micCtx.state !== 'running' && _micCtx.state !== 'closed') $timeout(function () { _resumeAudio('mic audio ' + (_micCtx && _micCtx.state)); }, 300);
                    else _micTapCheck();
                };
            } catch (eSC) {}
            _resumeAudio('mic started');
            var source = _micSourceFor(stream);
            // R3.5.1 - GainNode set to 1.0 (no extra boost). AGC already
            // normalises the stream; doubling on top made the ring dance
            // for ambient room noise. The mic stream itself stays clean
            // for SpeechRecognition; we only boost if AGC is OFF later.
            var gainNode = _micCtx.createGain();
            gainNode.gain.value = c.micOff ? 0 : (c.micGain || 1.0);   // R9 - mic sensitivity slider; muted stays muted across a rebuild
            _micGainNode = gainNode;
            _earProc = null; _earSink = null;
            if (c.ear.on) _earTapAttach();
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

                _deafAccumulate(level, Date.now());
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
                    if (_micCtx && _micCtx.state !== 'running' && _micCtx.state !== 'closed') _resumeAudio('health check: ' + _micCtx.state);
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

    /* R27 - iPhone (WebKit): an audio context starts "suspended" unless it
     * was made inside a tap, and speech playing or a call turns it
     * "interrupted". The mic meter and the on-device ear run on _micCtx, and
     * a context that is not running hands them silence - lvl 0, and nothing
     * heard. So both contexts are resumed on every tap, when the mic starts
     * (a page that is capturing may start audio in WebKit), when a context
     * changes state, and after she speaks. If iOS still says no, the status
     * asks for one tap instead of listening to nothing. */
    function _resumeAudio(why) {
        var need = false;
        [audioCtx, _micCtx].forEach(function (ctx) {
            if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
            need = true;
            try {
                var pr = ctx.resume();
                if (pr && pr.then) pr.then(function () { _micTapCheck(); }, function () { _micTapCheck(); });
            } catch (e) {}
        });
        if (need) logEvent('mic', 'audio resumed (' + why + ')');
        _micTapCheck();
        return need;
    }
    // the mic's context still not running once the page is active: one tap fixes it
    function _micTapCheck() {
        var stuck = !!(_micCtx && _micCtx.state !== 'running' && _micCtx.state !== 'closed');
        if (stuck === !!c.micNeedsTap) return;
        c.micNeedsTap = stuck;
        if (stuck) logEvent('warn', 'mic audio is ' + _micCtx.state + ' - asking for a tap');
        // the status model reads c.micNeedsTap: "Tap anywhere so I can hear you"
        _applyLiveStatus();
        $scope.$applyAsync();
    }
    /* R27 - what this device sees, for a developer who can not hold it: the
     * recognizer, the ear, the mic track and both audio contexts, and the
     * recent log - copied as plain text (nothing secret in it) */
    function _diagReport() {
        var L = [], nav = ($window && $window.navigator) || {};
        var st = function (ctx) { return ctx ? ctx.state + (ctx.sampleRate ? ' @' + ctx.sampleRate : '') : 'none'; };
        L.push('Netra diagnostics ' + new Date().toISOString() + ' build ' + (typeof NETRA_BUILD !== 'undefined' ? NETRA_BUILD : '?'));
        L.push('ua: ' + String(nav.userAgent || ''));
        L.push('app: ' + JSON.stringify(c.app || {}) + ' guest: ' + !!(c.data && c.data.is_guest) + ' page: ' + (c.liveMode ? 'live' : 'portal'));
        L.push('state: ' + c.state + ' speaking: ' + !!_speakingNow + ' alert: ' + !!c.alert + ' micOff: ' + !!c.micOff + ' ended: ' + !!c.ended);
        L.push('gate: ' + (c.gate ? [c.gate.open ? 'open' : 'shut', 'hearing=' + c.gate.hearingText, 'voice=' + c.gate.voiceText, 'answers=' + c.gate.brainText].join(' | ') : 'none'));
        L.push('recognizer: hasSR=' + !!c.hasSR + ' running=' + !!c.recRunning + ' lang=' + c.recLang + ' verdict=' + _nativeVerdict + ' heardWords=' + !!_nativeHeardWords + ' health=' + JSON.stringify(c.micHealth || {}));
        L.push('ear: ' + JSON.stringify({ mode: c.ear.mode, status: c.ear.status, on: c.ear.on, model: c.ear.model, device: c.ear.device, progress: c.ear.progress, error: c.ear.error, heard: c.ear.heard }));
        var tracks = [];
        try { if (_micStream) _micStream.getAudioTracks().forEach(function (t) { tracks.push(t.readyState + (t.muted ? ' muted' : '') + (t.enabled ? '' : ' disabled') + ' "' + String(t.label || '').substring(0, 40) + '"'); }); } catch (eT) {}
        L.push('mic: stream=' + !!c.micStreamActive + ' tracks=[' + tracks.join('; ') + '] micCtx=' + st(_micCtx) + ' audioCtx=' + st(audioCtx) + ' level=' + c.micLevel + ' peak=' + c.micLevelPeak + ' needsTap=' + !!c.micNeedsTap);
        var voices = 0;
        try { voices = (TTS && TTS.getVoices) ? TTS.getVoices().length : 0; } catch (eV) {}
        L.push('voice: hasTTS=' + !!c.hasTTS + ' voices=' + voices + ' ttsSpeaking=' + !!(TTS && TTS.speaking) + ' ttsPending=' + !!(TTS && TTS.pending));
        L.push('-- last events --');
        (c.events || []).slice(0, 80).forEach(function (e) { L.push(e.t + ' ' + e.l + ' ' + e.m); });
        return L.join('\n');
    }
    c.copyDiag = function () { _copyDiag(); };
    function _copyDiag() {
        var text = _diagReport();
        c.diagText = '';
        var done = function (ok) { c.diagCopied = ok; if (!ok) c.diagText = text; logEvent('lab', ok ? 'diagnostics copied' : 'diagnostics shown to copy by hand'); $scope.$applyAsync(); };
        try {
            var cb = $window.navigator && $window.navigator.clipboard;
            if (cb && cb.writeText) { cb.writeText(text).then(function () { done(true); }, function () { done(false); }); return; }
        } catch (eC) {}
        done(false);
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
    // Picks the ONE button a label means, before anything is pressed: an
    // exact text/aria-label match wins, else a whole-word partial match; two
    // different buttons ("Close Complete" / "Close Incomplete") are a
    // question, never a guess. Returns { el, name, say } - say is spoken.
    function _pickButton(labelSub) {
        function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }
        var sub = norm(labelSub);
        var none = { el: null, say: 'I could not find a "' + String(labelSub || '') + '" button on this page, so I pressed nothing.' };
        if (!sub) return none;
        // Scope to the page itself, NOT including our own widget (no clicking our own dev panel).
        // One selector list would return <body> first (document order), so each is tried in turn.
        var scope = document.querySelector('main') || document.querySelector('.sp-page-root') || document.querySelector('body');
        if (!scope) return none;
        var candidates = scope.querySelectorAll('button, [role="button"], a.btn, input[type="button"], input[type="submit"], [ng-click]');
        var word = new RegExp('(^|[^a-z0-9])' + sub.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '($|[^a-z0-9])');
        var exact = [], partial = [];
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            // Skip our own widget's buttons
            if (el.closest && el.closest('.netra-root')) continue;
            // Skip invisible / disabled
            var rect = el.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) continue;
            if (el.disabled) continue;
            var txt   = norm(el.textContent || el.value);
            var aria  = norm(el.getAttribute('aria-label'));
            var title = norm(el.getAttribute('title'));
            var hit = { el: el, name: String(el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').substring(0, 40) };
            if (txt === sub || aria === sub || title === sub) exact.push(hit);
            else if (word.test(txt) || word.test(aria) || word.test(title)) partial.push(hit);
        }
        var hits = exact.length ? exact : partial;
        if (!hits.length) return none;
        // the same button twice (form header and footer) is still one button
        var names = [];
        for (var h = 0; h < hits.length; h++) if (names.indexOf(norm(hits[h].name)) < 0) names.push(norm(hits[h].name));
        if (names.length > 1) {
            var said = [];
            for (var s = 0; s < hits.length && said.length < 3; s++) if (said.indexOf(hits[s].name) < 0) said.push(hits[s].name);
            return { el: null, say: 'I found more than one button like "' + labelSub + '": ' + said.join(', ') + (names.length > 3 ? ' and more' : '') + '. I pressed nothing - which one?' };
        }
        // ...but same-named buttons that do different things, or a row of
        // them (a Delete per attachment or list row), are never guessed at
        if (hits.length > 1) {
            var act = function (el) { return String(el.getAttribute('ng-click') || el.getAttribute('onclick') || el.getAttribute('name') || ''); };
            if (hits.length > 2 || act(hits[0].el) !== act(hits[1].el)) {
                return { el: null, say: 'I found ' + hits.length + ' "' + hits[0].name + '" buttons on this page and can not tell which one you mean, so I pressed nothing.' };
            }
        }
        return { el: hits[0].el, name: hits[0].name, say: 'Pressing "' + hits[0].name + '".' };
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
        // If the user just finished dragging, swallow the click.
        if (booted && orbDragJustMoved) { orbDragJustMoved = false; return; }
        _tapOrb();
    };
    c.orbLabel = function () { return _orbLabel(); };
    // R28 - the orb does what its name says for the state she is in: a tap
    // while she talks only stops her; it never puts her to sleep
    function _orbAction() {
        if (!booted) return 'boot';
        if (c.ended) return 'restart';
        if (c.micOff) return 'unmute';
        if (c.state === 'speaking' || _speakingNow || _fillerChainActive) return 'stop';
        // iPhone: the status asks for a tap so she can hear. The orb is what a
        // VoiceOver user double-taps, so that tap wakes the audio, not a pause
        if (c.micNeedsTap && c.alert) return 'wake';
        if (c.alert) return 'pause';
        return 'resume';
    }
    function _orbLabel() {
        switch (_orbAction()) {
            case 'boot':    return 'Netra is getting ready';
            case 'restart': return 'Start Netra again';
            case 'unmute':  return 'Turn the mic back on';
            case 'stop':    return 'Stop Netra talking';
            case 'wake':    return 'Tap so Netra can hear you';
            case 'pause':   return 'Pause Netra';
            default:        return 'Resume Netra';
        }
    }
    function _tapOrb() {
        switch (_orbAction()) {
            case 'boot':    tryBoot(true); return;
            case 'restart': _liveRestart(); return;
            case 'unmute':  _micUnmute(); return;
            case 'stop':    _stopTalking('tap'); return;
            case 'wake':    _resumeAudio('tap'); return;
            case 'pause':
                _cancelPlanContinue();
                c.alert = false;
                setState('dormant');
                _hushState();
                speak('Paused.');
                return;
            default: _wakeUp();
        }
    }
    // tap, Escape and End: she stops and goes on listening (not paused)
    function _stopTalking(reason) {
        stopSpeaking(reason || 'tap');
        c.alert = true;
        setState('idle');
    }
    function _wakeUp(say, quiet) {
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
        if (quiet) return;
        _hushState();
        speak(say || 'I\u2019m listening.');
    }

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
        if (booted || _ctrlDestroyed) return;
        if (!c.hasSR) {
            // R21 - no recognizer: the on-device ear from the start, or typing
            // only; the boot goes on so answers are probed and the loading
            // screen can finish
            var earPossible = c.ear.mode !== 'off' && typeof Worker !== 'undefined' && typeof Blob !== 'undefined';
            logEvent('warn', 'no SpeechRecognition in this browser - ' + (earPossible ? 'the on-device ear hears instead' : 'typing only'));
            if (!earPossible) speak('This browser can not listen, so I can not hear you here. Use Chrome or Edge to talk to me, or type to me once my answers are ready.');
        }
        // no key is basic mode, not a dead end: the server still reads and
        // lists tickets, raises one and gives the debrief, so the mic starts
        var noKey = !c.data.has_api_key;
        if (noKey) logEvent('warn', 'Gemini API key not configured - basic mode');

        unlockAudio();
        populateVoices();

        try {
            // R24 - no ear download holds the loading screen: it loads when the
            // browser's recognizer is missing, blocked or deaf (startContinuous,
            // onerror, _deafCheck). A desktop also keeps its ear (the same model
            // it would use) ready in the background a little later, because some recognizers start and
            // then hear nothing with no error at all (corporate networks do
            // this): the first deaf strike then swaps it in at once. A phone
            // downloads nothing up front
            startContinuous();
            _readyUpdate();
            if (!_isPhone()) $timeout(function () { if (!_nativeHeardWords && !_ctrlDestroyed) _earLoad(true); }, 15000);
            _brainProbe('boot');        // R21: the loading screen waits for a real answer from the brain
            $timeout(_gateUpdate, 4200);   // the no-voice case resolves after 4 s
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
                // R21 - the greeting is the loading screen's "ready" signal now:
                // nothing is said until Netra can hear, speak and answer
                void todGreet; void firstName; void noKey;
                _firstRunCheck();
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

    /* ============================================================
     *  R19 - THE ON-DEVICE EAR, and a recognizer that notices it is deaf
     *
     *  The browser's recognizer sends the audio to Google's or Microsoft's
     *  speech service. When that service returns no words - a blocked
     *  network, a language it will not take, a grammar it rejects, a
     *  session that died silently - the mic still shows sound and Netra
     *  hears nothing, which reads as "she is not listening to me".
     *
     *  So the page watches for exactly that: clear speech on the meter
     *  with no words back. It heals in steps (rebuild without the grammar,
     *  plain en-US), and if the recognizer stays deaf it opens its own
     *  ear: Whisper (tiny, English) running inside the browser in a
     *  worker, fed straight from the mic's audio graph, no speech service
     *  at all. Browsers without a recognizer get the ear from the start;
     *  the Lab can force it on or off.
     * ============================================================ */
    var EAR_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/transformers.min.js';
    // v7.8 - accuracy first: the ladder is tiny (a phone: its own recognizer
    // is primary), base (a desktop on WebAssembly, ~80 MB, no real errors on
    // Indian English) and small (a desktop GPU, or chosen: slow on a CPU but
    // the most accurate). Whisper has one English model per size
    var EAR_MODEL_TINY = 'onnx-community/whisper-tiny.en';    // quick anywhere: a phone's ear
    var EAR_MODEL_BASE = 'onnx-community/whisper-base.en';    // clearer: a desktop on WebAssembly
    var EAR_MODEL_SMALL = 'onnx-community/whisper-small.en';  // most accurate: a desktop GPU, or chosen
    var EAR_RATE = 16000;         // what Whisper hears; asked of the mic's own context
    var EAR_START_LEVEL = 18;     // meter level that opens a segment
    var EAR_STOP_LEVEL = 9;       // and below which silence is counted
    var EAR_SILENCE_MS = 900;     // this much silence closes the segment (v7.8: a pause mid-phrase is not the end)
    var EAR_MIN_SPEECH_MS = 300;  // shorter is a click, not a word
    var EAR_PARTIAL_MS = 1200;    // while the user still speaks, the words so far every this often
    var EAR_MAX_MS = 20000;       // a segment never runs longer
    var EAR_PREROLL_MS = 600;     // audio kept from before the meter rose (v7.8: a soft first syllable is kept whole)
    var DEAF_LOUD_LEVEL = 22;     // speech-loud on the meter
    var DEAF_WINDOW_MS = 10000;   // judged every ten seconds
    var DEAF_LOUD_MS = 1500;      // this much speech with no words is a strike
    var EAR_HALLUCINATION_RE = /^[\s\W]*$|^\[.*\]$|^\(.*\)$|^(you|thank you|thanks|thanks for watching|bye|so|the end|okay)[.!]?$/i;
    c.ear = { mode: 'auto', size: 'small', on: false, status: 'off', progress: 0, prepared: false, model: EAR_MODEL_TINY, device: 'wasm', error: '', heard: 0, why: '', lastMs: 0 };
    try { c.ear.mode = localStorage.getItem('netra_ear') || 'auto'; c.ear.size = localStorage.getItem('netra_ear_size') || 'small'; } catch (eEM) {}
    if (c.ear.mode !== 'on' && c.ear.mode !== 'off') c.ear.mode = 'auto';
    // v7.9 - Best (small) for everyone by default; a Guest is always on Best
    // and Settings offers no Hearing choice to a Guest (a phone stays tiny)
    if (!_earSizeKnown(c.ear.size) || (c.data && c.data.is_guest)) c.ear.size = 'small';
    c.earSizes = ['auto', 'tiny', 'base', 'small'];
    c.earSizeLabel = function (size) { return _earSizeLabel(size); };
    var _earWorker = null, _earBusy = false, _earQueue = [], _earNativeSeen = 0, _earSaid = false, _earEngageOnLoad = false;
    var _earAnnounce = '';                         // R21 - said once the ear really listens, not while it downloads
    var _earLastSaid = null, _earHandbackAt = 0;   // R21 - the ear's last words, and when it handed back
    /* ============================================================
     *  R21 - THE LOADING SCREEN
     *
     *  Nothing is accepted until Netra can do all three: HEAR (the browser
     *  recognizer confirmed, or the on-device ear engaged), SPEAK (a voice
     *  is loaded), and ANSWER (the server's ready_check got a real reply
     *  from a model, or one answered in the last minute). Until then the
     *  stage shows the three checks and anything said is ignored with a
     *  spoken "still getting ready". When the brain drops out mid-visit the
     *  question is held, the screen comes back, and the question is asked
     *  again the moment the brain answers - no basic-mode stand-in.
     * ============================================================ */
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: false,
               hearingText: 'checking…', voiceText: 'checking…', brainText: 'checking…' };
    var _gateHeld = null, _gateReasked = null, _brainProbeTimer = null, _brainProbeBusy = false, _gateNudgedAt = 0, _gateNudged = false, _voiceCheckStart = Date.now();
    // R21 - Chrome and Edge refuse to play any voice until the page has had
    // a key press or a tap ("not-allowed"): without one she would open the
    // gate and then say nothing at all. That press is the Voice check.
    var _activated = false, _voiceBlocked = false;
    function _needsActivation() {
        if (_voiceBlocked) return true;
        if (_activated) return false;
        // iOS drops speech without a word unless a tap came first
        if (c.app && c.app.ios) return true;
        try { var ua = $window.navigator && $window.navigator.userActivation; return !!(ua && !ua.hasBeenActive); } catch (eA) { return false; }
    }
    function _onPageActivated(ev) {
        if (_ctrlDestroyed) return;
        if (ev && ev.type === 'keydown' && /^(Shift|Control|Alt|Meta|CapsLock|Escape|Tab)$/.test(String(ev.key || ''))) return;
        // every gesture runs the unlock (it is idempotent): a pointerdown
        // may have come first, and iOS did not count that one
        _speechUnlock(ev);
        if (_activated && !_voiceBlocked) return;
        // on iOS a pointerdown is not the gesture: the touchend or click of
        // the same tap is, and a greeting started before it would be dropped
        if (ev && ev.type === 'pointerdown' && c.app && c.app.ios) return;
        _activated = true; _voiceBlocked = false;
        logEvent('gate', 'page activated (' + (ev && ev.type || 'button') + ') - my voice may play now');
        _gateUpdate();
    }
    // R24 - WebKit starts audio only from a touchend or a click, so the
    // unlock runs inside those too. Once one of them has spoken the silent
    // line it is not spoken again (until the browser refuses her voice)
    var _speechUnlocked = false;
    function _speechUnlock(ev) {
        var type = String(ev && ev.type || 'button');
        unlockAudio();
        _resumeAudio('tap');   // R27 - the mic's context too (WebKit)
        if (_speechUnlocked) return;
        // iOS unlocks speech only for a call made inside the tap itself: a
        // silent, empty line now lets every later line play
        try {
            if (c.hasTTS && TTS && typeof SpeechSynthesisUtterance !== 'undefined' && !_speakingNow) {
                var unlock = new SpeechSynthesisUtterance(' ');
                unlock.volume = 0;
                TTS.speak(unlock);
                if (/^(click|touchend|button)$/.test(type) || (type === 'keydown' && !(c.app && c.app.ios))) _speechUnlocked = true;
            }
        } catch (eU) {}
    }
    // the Start button: its own click is the gesture, so it always unlocks
    function _gateStart() { _onPageActivated({ type: 'button' }); }
    c.gateActivate = _gateStart;
    function _listenForActivation(doc) {
        var types = ['keydown', 'pointerdown', 'touchend', 'click'];
        types.forEach(function (t) { doc.addEventListener(t, _onPageActivated, true); });
        return function () { types.forEach(function (t) { try { doc.removeEventListener(t, _onPageActivated, true); } catch (eD) {} }); };
    }
    try {
        var _stopActivation = _listenForActivation($window.document);
        $scope.$on('$destroy', _stopActivation);
    } catch (eL) {}
    function _voiceReady() {
        var eng = c.ttsEngine || 'browser';
        c.gate.needsTap = false;
        if (_needsActivation()) {
            c.gate.needsTap = true;
            c.gate.voiceText = 'press Enter or tap Start - the browser plays no voice until you do';
            return false;
        }
        if (eng === 'edge' && _edgeVoiceAvailable() && !_edgeCircuitOpen()) { c.gate.voiceText = 'neural voice'; return true; }
        // no speech synthesis at all: there will never be voices to wait for
        if (!c.hasTTS) { c.gate.voiceText = 'captions only (this browser can not speak)'; return true; }
        if (!_voiceCheckStart) _voiceCheckStart = Date.now();
        var n = 0;
        try { n = (c.hasTTS && TTS && TTS.getVoices) ? (TTS.getVoices() || []).length : 0; } catch (eV) {}
        if (n) { c.gate.voiceText = (c.voiceName && c.voiceName !== '(picking...)') ? c.voiceName : n + ' voices'; return true; }
        // a browser with no voices at all still shows every word on screen
        if (Date.now() - _voiceCheckStart > 4000) { c.gate.voiceText = 'captions only (no voice installed)'; return true; }
        c.gate.voiceText = 'loading voices…';
        return false;
    }
    function _gateUpdate() {
        var g = c.gate;
        if (!g) return;
        g.hearing = !!c.ready;
        g.hearingText = c.ready ? (c.ear.on ? 'on-device ear' : 'browser recognizer')
                                : String(c.readyText || 'checking…').replace(/^Getting ready( — )?/, '').replace(/…$/, '') || 'checking';
        // no recognizer that works, and no ear to stand in: typing is what is left
        g.cantHear = !c.ready && _cantHear();
        if (g.cantHear) {
            g.hearingText = (c.hasSR ? 'the browser can not reach its speech service and my on-device ear did not load' : 'this browser can not listen') +
                            (c.ear.error ? ' (' + c.ear.error + ')' : '') + (g.brain ? ' - you can type to Netra instead' : ' - you can type to Netra once answers are ready');
        } else if (!g.hearing && g.micPrompt) {
            g.hearingText = 'Your browser will ask to use the microphone. Choose Allow.';
        } else if (!g.hearing && g.slowHear && c.ear.status !== 'loading') {
            g.hearingText = 'Taking longer than usual.' + (g.brain ? ' You can type while you wait.' : '');
        }
        var tapWas = !!g.needsTap;
        g.voice = _voiceReady();
        // R28 - words on the card, not engine names or model IDs (those go to the log)
        g.hearingText = _plainGateText(g.hearingText);
        g.voiceText = _plainGateText(g.voiceText);
        g.brainText = _plainGateText(g.brainText);
        // Start is about to go (ng-if): the focus goes to the card's title, not the page
        if (tapWas && !g.needsTap) {
            try {
                var doc = ($window && $window.document) || document, ae = doc.activeElement;
                if (ae && ae.getAttribute && / netra-ready-start /.test(' ' + (ae.getAttribute('class') || '') + ' ')) {
                    var title = doc.querySelector('#netra-ready-title');
                    if (title && title.focus) title.focus();
                }
            } catch (eSF) {}
        }
        var was = g.open;
        g.open = g.hearing && g.voice && g.brain;
        // the next closed spell is announced afresh, and is only called slow
        // once it has itself been closed for 45 s
        if (g.open) { g.typing = false; g.statusKey = ''; g.slowHear = false; }
        if (g.open && !was) _gateOpened();
        else if (!g.open && was) {
            logEvent('gate', 'closed - ' + (!g.brain ? 'brain: ' + g.brainText : !g.hearing ? 'hearing: ' + g.hearingText : 'voice'));
            _gateSlowArm();
        }
        if (c.state === 'idle' || c.state === 'awaiting') {
            _applyLiveStatus();
            c.stateLabel = _stateLabel(c.state);
        }
        _gateAnnounce();
        // R24 - the card is a modal: what is behind it goes inert and the
        // focus moves, once the card is on (or off) the page
        var shut = !g.open && !g.typing;
        if (shut !== _gateShut || (shut && !!g.needsTap !== _gateTapShown)) {
            _gateShut = shut; _gateTapShown = !!g.needsTap;
            $timeout(_gateModal, 30, false);
        }
        $scope.$applyAsync();
    }
    // R28 - what a check says, in plain words: no engine or model names, no
    // "can not". Pure, and safe to run twice on the same text
    function _plainGateText(raw) {
        var s = String(raw == null ? '' : raw);
        if (/^ready( \(.*\))?$/i.test(s)) return 'Ready';
        // the download's note: the size word and MB (v7.8), or the bare MB of an older line
        var note = (s.match(/\(([^()]*about \d+ MB[^()]*), once\)/) || [])[1];
        s = s.replace(/loading my on-device ear( \d+%)?( \([^()]*, once\))?/, 'downloading speech recognition, one time' + (note ? ' (' + note + ')' : ''))
             .replace(/preparing my on-device ear( \(the first time can take a minute\))?/, 'setting up speech recognition$1')
             .replace(/switching to my own ear/, 'switching to on-device listening')
             .replace(/my on-device ear|on-device ear/g, 'on-device listening')
             .replace(/^browser recognizer$/, 'Ready')
             .replace(/press Enter or tap Start.*$/, 'Press Start so the browser lets Netra speak')
             .replace(/^captions only.*$/, 'No voice on this device. Replies will be shown as text.')
             .replace(/\bcan not\b/g, 'can\'t').replace(/\bCan not\b/g, 'Can\'t');
        return s.replace(/^(downloading|setting up|on-device listening|the browser|this browser|loading voices)/, function (w) { return w.charAt(0).toUpperCase() + w.substring(1); });
    }
    // R24 - the browser recognizer failed or is missing, and the on-device
    // ear can not stand in (it failed, is switched off, or can not run here)
    function _cantHear() {
        // an ear that is on, loading or waiting can hear, whatever this browser lacks
        if (c.ear.on || c.ear.status === 'loading' || c.ear.status === 'standby') return false;
        var nativeGone = !c.hasSR || _nativeVerdict === 'blocked';
        return nativeGone && (c.ear.status === 'error' || c.ear.mode === 'off' || typeof Worker === 'undefined');
    }
    // R24 - the one line a screen reader hears on the loading screen. It
    // changes only when a check passes or a real problem shows up - never
    // for a download percentage
    function _gateAnnounce() {
        var g = c.gate;
        if (!g || g.open) return;
        var earLoading = !g.hearing && c.ear.status === 'loading';
        var key = [g.hearing, g.voice, g.brain, g.cantHear, g.needsTap, earLoading, !g.brain && g.brainDown, g.typing, g.micPrompt, g.slowHear].map(function (b) { return b ? 1 : 0; }).join('');
        if (key === g.statusKey) return;
        g.statusKey = key;
        if (g.typing) { g.status = TYPING_STATUS + '.'; return; }
        var ready = [], waiting = [];
        [['hearing', g.hearing], ['voice', g.voice], ['answers', g.brain]].forEach(function (k) { (k[1] ? ready : waiting).push(k[0]); });
        var say = (ready.length ? _andList(ready).replace(/^./, function (ch) { return ch.toUpperCase(); }) + ' ready. ' : '') +
                  'Waiting for ' + _andList(waiting) + '.';
        if (g.cantHear) say = 'Netra can\'t hear in this browser. ' + (g.brain ? 'Answers are ready. Press Type instead to type to Netra.' : 'You can type to Netra once answers are ready.');
        else if (earLoading) say += ' Downloading speech recognition, the ' + _earSizeName() + ' model, about ' + _earSizeMb() + ' MB, one time. This can take ' + (_earSizeMb() >= 200 ? 'a few minutes.' : 'a minute.') + (_earSlowHere() ? ' It is the most accurate, and slower on this device.' : '');
        else if (!g.hearing && g.micPrompt) say += ' Your browser will ask to use the microphone. Choose Allow.';
        else if (!g.hearing && g.slowHear) say += ' Hearing is taking longer than usual.' + (g.brain ? ' You can type while you wait.' : '');
        if (g.needsTap && !g.cantHear) say += ' Press Start so Netra can speak.';
        if (!g.brain && g.brainDown && g.brainText) say += ' Answers: ' + String(g.brainText).replace(/[.\s]+$/, '') + '.';
        g.status = say;
    }
    // where typing is, said to match what is on the screen right now
    function _typeHint() {
        var g = c.gate;
        if (!g || g.open || g.typing) return 'Press Type to type to me.';
        return g.brain ? 'Press Type instead to type to me.' : 'You can type to me once my answers are ready.';
    }
    function _andList(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
    // R28 - answers work: the card steps aside whether or not hearing ever
    // comes, and the typing box above the controls takes the focus
    var TYPING_STATUS = 'Typing — Netra can’t listen yet';
    function _gateTypeInstead() {
        var g = c.gate;
        if (!g || g.open || !g.brain) return;
        g.typing = true;
        g.typedFirst = true;   // the greeting, once she can hear, is "I can hear you now too"
        logEvent('gate', 'typing instead - ' + (g.cantHear ? 'this browser can not hear' : 'hearing is not ready yet'));
        _gateUpdate();
        _typeToggle(true);
    }
    c.gateType = _gateTypeInstead;
    // R28 - the browser's own microphone question, said before it pops up;
    // and a hearing check that hangs says so after 45 s, with Type instead
    var _micPermSt = null;
    function _micPermHint() {
        try {
            var perms = $window.navigator && $window.navigator.permissions;
            if (!perms || !perms.query) return;
            perms.query({ name: 'microphone' }).then(function (st) {
                if (_ctrlDestroyed) return;
                var set = function () { if (c.gate && !_ctrlDestroyed) { c.gate.micPrompt = st.state === 'prompt'; _gateUpdate(); } };
                set();
                _micPermSt = st;
                st.onchange = set;
            }, function () {});
        } catch (eP) {}
    }
    var _gateSlowTimer = null;
    function _gateSlowArm() {
        if (_gateSlowTimer) $timeout.cancel(_gateSlowTimer);
        _gateSlowTimer = $timeout(_gateSlowCheck, 45000);
    }
    function _gateSlowCheck() {
        _gateSlowTimer = null;
        var g = c.gate;
        if (!g || g.open || g.hearing || g.cantHear || _ctrlDestroyed) return;
        g.slowHear = true;
        logEvent('gate', 'hearing still not ready after 45 s');
        _gateUpdate();
    }
    // leaving the page: no slow-hearing timer, and a mic prompt answered
    // after leaving runs nothing on this dead controller
    function _gateHintsStop() {
        if (_gateSlowTimer) $timeout.cancel(_gateSlowTimer);
        _gateSlowTimer = null;
        if (_micPermSt) _micPermSt.onchange = null;
        _micPermSt = null;
    }
    if (c.liveMode) { _micPermHint(); _gateSlowArm(); }
    $scope.$on('$destroy', _gateHintsStop);
    // R24 - while the card is up it is a real modal: everything behind it
    // (the stage, the orb, the portal's own header and links) is inert and
    // the focus is in the card. All of it is given back when the card goes
    var _gateShut, _gateTapShown, _gateInert = [];
    function _gateModal() {
        // a late timer after destroy must not make the portal inert again
        if (_ctrlDestroyed) { _gateInertRestore(); return; }
        var g = c.gate, doc = $window && $window.document;
        if (!g || !c.liveMode || !doc || !doc.querySelector) return;
        var dlg = (!g.open && !g.typing) ? doc.querySelector('.netra-ready') : null;
        if (dlg) {
            if (!_gateInert.length) _gateInertAround(doc, dlg);
            // Start if it is there, else the title: never the page body
            var ae = doc.activeElement;
            if (!ae || !dlg.contains(ae)) {
                var to = dlg.querySelector('.netra-ready-start') || dlg.querySelector('.netra-ready-title');
                try { if (to) to.focus(); } catch (eF) {}
            }
            return;
        }
        var had = _gateInert.length;
        _gateInertRestore();
        // the card took the focus with it: Netra's own button has it next
        if (had && g.open) {
            var now = doc.activeElement;
            if (!now || now === doc.body) {
                var blob = doc.querySelector('.netra-stage-blob-wrap');
                try { if (blob) blob.focus(); } catch (eB) {}
            }
        }
    }
    function _gateInertAround(doc, dlg) {
        for (var el = dlg; el && el.parentNode && el !== doc.body; el = el.parentNode) {
            var sib = el.parentNode.children || [];
            for (var i = 0; i < sib.length; i++) {
                var s = sib[i], cls = String((s.getAttribute && s.getAttribute('class')) || '');
                // the page's spoken-words regions stay: they hold no controls
                if (s === el || /^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/i.test(String(s.tagName || '')) || /\bnetra-sr-only\b/.test(cls)) continue;
                var rec = { el: s, inert: s.hasAttribute('inert'), hidden: s.getAttribute('aria-hidden'), tabs: [] };
                s.setAttribute('inert', '');
                s.setAttribute('aria-hidden', 'true');
                // a browser without inert: at least keep Tab out of it
                if (!('inert' in s) && s.querySelectorAll) {
                    var f = s.querySelectorAll('a[href], button, input, select, textarea, [tabindex]');
                    for (var k = 0; k < f.length; k++) { rec.tabs.push([f[k], f[k].getAttribute('tabindex')]); f[k].setAttribute('tabindex', '-1'); }
                }
                _gateInert.push(rec);
            }
        }
    }
    function _gateInertRestore() {
        while (_gateInert && _gateInert.length) {
            var r = _gateInert.pop();
            try {
                if (!r.inert) r.el.removeAttribute('inert');
                if (r.hidden === null || r.hidden === undefined) r.el.removeAttribute('aria-hidden'); else r.el.setAttribute('aria-hidden', r.hidden);
                for (var k = 0; k < r.tabs.length; k++) {
                    if (r.tabs[k][1] === null || r.tabs[k][1] === undefined) r.tabs[k][0].removeAttribute('tabindex'); else r.tabs[k][0].setAttribute('tabindex', r.tabs[k][1]);
                }
            } catch (eR) {}
        }
        // _inertChrome skipped the portal chrome the card had made inert, and
        // the lines above just gave it back: quiet it again while we are here
        if (c.liveMode && !_inertFreed && !_ctrlDestroyed) _inertChrome();
    }
    function _gateOpened() {
        var g = c.gate, first = !g.everOpen;
        g.everOpen = true;
        logEvent('gate', 'open - hearing: ' + g.hearingText + ', voice: ' + g.voiceText + ', brain: ' + g.brainText);
        cue('wake');
        // R24 - every held question, oldest first
        var held = _gateHeld ? [].concat(_gateHeld) : [];
        _gateHeld = null;
        _gateNudged = false; _gateNudgedAt = 0;   // the next closed spell gets its own explanation
        // R28 - typed while she could not hear: she was already talking to them
        var typedFirst = !!g.typedFirst;
        g.typedFirst = false;
        if (typedFirst && !held.length) {
            speak('I can hear you now too.', function () { if (c.alert) setState('idle'); });
            return;
        }
        if (first && !held.length) {
            speak(_greeting(), function () { if (c.alert) setState('idle'); });
            return;
        }
        var bare = function (t) { return String(t).replace(/[.?!\s]+$/, ''); };
        // a free model is often out for longer than three minutes: a
        // question is held for ten, and never dropped without a word
        var fresh = held.filter(function (q) { return Date.now() - q.at < 10 * 60000; });
        var late = held.filter(function (q) { return fresh.indexOf(q) < 0; });
        var lateSay = late.length ? 'I could not answer "' + late.map(function (q) { return bare(q.text); }).join('" or "') + '" in time - please ask me again.' : '';
        if (fresh.length) {
            var texts = fresh.map(function (q) { return q.text; });
            logEvent('gate', 'brain is back - asking again: "' + texts.join('", "') + '"');
            // asked again ONCE: a second "busy" gives up instead of looping
            _gateReasked = { text: texts[0], texts: texts, at: Date.now() };
            speak('Back now. You asked: ' + texts.map(bare).join('. Then: ') + '.' + (lateSay ? ' ' + lateSay : ''), function () {
                handleHeard(texts[0]);
                // the rest follow one at a time, each after the answer before it
                _gateAskAfter = texts.slice(1);
                if (!_queuedUtterance && _gateAskAfter.length) _queuedUtterance = _gateAskAfter.shift();
            });
            return;
        }
        speak(lateSay ? 'I am ready again. ' + lateSay : 'I am ready again - just speak.', function () { if (c.alert) setState('idle'); });
    }
    // R28 - the first words: what a Guest can and can not do, and where
    // Type is; a signed-in user just hears that Netra is listening
    function _greeting() {
        var g = c.gate || {};
        var guest = !!(c.data && c.data.is_guest);
        var nm = String((c.data && c.data.user_name) || '').split(' ')[0];
        // a shared reviewer account's name is not a person's (the server prompts do not use it either)
        if (guest || (c.data && c.data.read_only) || /^(system|guest)$/i.test(nm)) nm = '';
        var h = new Date().getHours();
        var tod = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
        // R24 - a key or a switch is not "resting": the real reason, said plainly
        var why = String(g.brainText || '').replace(/^answers from the web only - /, '');
        var webOnly = g.brainMode !== 'web' ? ''
                    : /key|administrator/i.test(why) ? ' ' + why.charAt(0).toUpperCase() + why.substring(1) + ', so I will answer from the web for now.'
                    : ' My reasoning is resting right now, so I will answer from the web until it is back.';
        var say = guest
            ? tod + '. I\'m Netra. As a guest, I can answer questions, search the web, and tell you the time or a joke. Sign in to use your tickets. Just speak, or press Type.'
            : tod + (nm ? ', ' + nm : '') + '. I\'m Netra, and I\'m listening.';
        return say + webOnly + (_introKeysDue() ? ' Press question mark for shortcuts.' : '');
    }
    // a keyboard and mouse, the first visit in this browser: the shortcuts, once
    function _introKeysDue() {
        try {
            if (c.shortcutsOn === false || !$window || 'ontouchstart' in $window) return false;
            if (!($window.matchMedia && $window.matchMedia('(pointer: fine)').matches)) return false;
            if (localStorage.getItem('netra_intro_keys')) return false;
            localStorage.setItem('netra_intro_keys', '1');
            return true;
        } catch (eK) { return false; }
    }
    // R24 - a question the brain could not take is kept in order, never
    // replaced by the next one; three at most
    var _gateAskAfter = [];
    function _gateHold(text) {
        if (!text) return;
        var list = _gateHeld ? [].concat(_gateHeld) : [];
        if (!list.some(function (q) { return q.text === text; })) list.push({ text: text, at: Date.now() });
        _gateHeld = list.slice(-3);
    }
    // R21 - typing needs answers, not ears: a browser that can not listen
    // at all can still be typed to (and typing is the key press a voice needs)
    function _typedRefused(t) {
        if (c.gate && !c.gate.open && !c.gate.brain) { logEvent('gate', 'not ready - typed text kept in the box'); _gateRefuse(t, 1); return true; }
        _onPageActivated({ type: 'typed' });
        return false;
    }
    // said while the gate is shut: never silently lost
    function _gateRefuse(text, conf) {
        _heardLog(text, conf, 'ignored: still getting ready');
        logEvent('gate', 'not ready - ignored "' + String(text).substring(0, 60) + '"');
        // a cough or a word of background chatter is not someone asking
        if ((conf > 0 && conf < MIN_CONFIDENCE) || _normTokens(text).length < 2) return;
        if (!_gateNudged || Date.now() - _gateNudgedAt > 30000) {
            _gateNudged = true;
            _gateNudgedAt = Date.now();
            var g = c.gate;
            var why = !g.brain ? 'my answers are not ready yet' + (g.brainText && g.brainText !== 'checking…' ? ' - ' + g.brainText : '')
                    : !g.hearing ? 'I can not hear properly yet' : 'my voice is loading';
            speak('One moment - I am still getting ready, ' + why + '. I will tell you as soon as I can answer.');
        } else {
            cue('error');
        }
    }
    function _brainProbe(why) {
        if (_brainProbeBusy || _ctrlDestroyed) return;
        if (_brainProbeTimer) { $timeout.cancel(_brainProbeTimer); _brainProbeTimer = null; }
        _brainProbeBusy = true;
        var t0 = Date.now();
        var done = function (d) {
            d = d || { ready: false, say: 'no answer from the server', wait_ms: 8000 };
            if (!c.gate) { _brainProbeBusy = false; return; }
            // R24 - already answering from the web: models resting or busy
            // keep web mode - only a web search that is down (or no server)
            // closes the gate again
            if (!d.ready && (d.reason === 'all_resting' || d.reason === 'busy') && c.gate.brain && c.gate.brainMode === 'web') {
                d = { ready: true, mode: 'web', say: c.gate.brainText, wait_ms: d.wait_ms };
            }
            c.gate.brain = !!d.ready;
            c.gate.brainDown = !d.ready;
            c.gate.brainMode = d.ready ? (d.mode || 'full') : '';
            c.gate.brainText = d.ready ? (d.mode === 'web' ? String(d.say || 'answers from the web only').replace(/[.\s]+$/, '') : 'ready' + (d.model ? ' (' + d.model + ')' : ''))
                                       : String(d.say || 'not answering yet').replace(/[.\s]+$/, '');
            // the model ID is for the log; the card says 'Ready'
            logEvent('gate', 'brain ' + (d.ready ? 'ready' + (d.model ? ' (' + d.model + ')' : '') : 'not ready (' + (d.reason || '?') + ')') + ' in ' + (Date.now() - t0) + ' ms' + (why ? ' - ' + why : ''));
            if (!d.ready && !_ctrlDestroyed) {
                _brainProbeTimer = $timeout(function () { _brainProbe('retry'); }, Math.max(5000, Math.min(d.wait_ms || 10000, 30000)));
            } else if (d.mode === 'web' && !_ctrlDestroyed) {
                // answering from the web: look again now and then, for the status line
                _brainProbeTimer = $timeout(function () { _brainProbe('web mode'); }, Math.max(60000, Math.min(d.wait_ms || 120000, 300000)));
            }
            // busy until the retry is scheduled: a timer that fires at once
            // can not recurse into a second probe
            _brainProbeBusy = false;
            _gateUpdate();
        };
        if (!c.server || typeof c.server.get !== 'function') { done({ ready: true, model: '' }); return; }
        // a web-mode check keeps its line: the page is open and answering
        if (c.gate && !c.gate.brain) c.gate.brainText = 'checking…';
        try {
            var rq = { action: 'ready_check' };
            try { rq.tz_offset_min = -new Date().getTimezoneOffset(); rq.tz_name = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || ''; } catch (eTz) {}
            c.server.get(rq).then(function (resp) { done(resp && resp.data && resp.data.ready); },
                function () { done({ ready: false, say: 'I can not reach the server', wait_ms: 8000 }); });
        } catch (eP) { done({ ready: false, say: 'I can not reach the server', wait_ms: 8000 }); }
    }

    // R20 - readiness: the stage says "getting ready" until an ear can hear.
    // The browser's recognizer counts as able once it started and settled
    // without a network error, or once it returned words; the on-device ear
    // counts once it is engaged.
    var _nativeVerdict = 'unknown', _nativeVerdictTimer = null, _nativeHeardWords = false;
    var NATIVE_SETTLE_MS = 2000;   // a blocked speech service errors well inside this
    c.ready = false; c.readyText = 'Getting ready…';
    function _readyUpdate() {
        var was = c.ready;
        // R24 - a clean start is enough: waiting for words (or for the ear's
        // 40-200 MB download) kept every first visit on the loading screen
        // though the browser could hear. A recognizer that fails silently is
        // caught later by the deaf check, and the ear takes over then
        c.ready = c.ear.on || _nativeHeardWords || _nativeVerdict === 'ok';
        if (!c.ready) {
            // why the ear is loading at all, then how far: the download
            // reaches 100 % before the model is compiled and warmed up
            var why = _nativeVerdict === 'blocked' ? 'the browser can not reach its speech service - ' : (!c.hasSR ? 'this browser has no speech recognizer - ' : '');
            if (c.ear.status === 'loading') c.readyText = 'Getting ready — ' + why + (c.ear.prepared ? 'preparing my on-device ear (the first time can take a minute)…'
                                                        : 'loading my on-device ear' + (c.ear.progress ? ' ' + c.ear.progress + '%' : '') + ' (' + _earSizeNote() + ', once)…');
            else if (_nativeVerdict === 'blocked') c.readyText = 'Getting ready — the browser can not reach its speech service, switching to my own ear…';
            else if (!c.hasSR) c.readyText = 'Getting ready…';
            else c.readyText = 'Getting ready — checking the browser can hear…';
        }
        if (c.ready && !was) logEvent('rec', 'ready to hear (' + (c.ear.on ? 'on-device ear' : 'browser recognizer') + ')');
        _gateUpdate();   // R21 - the loading screen owns the status line and the ready signal
    }
    function _nativeSaw(verdict) {
        if (_nativeVerdictTimer) { $timeout.cancel(_nativeVerdictTimer); _nativeVerdictTimer = null; }
        if (verdict === 'ok' && _nativeVerdict === 'blocked') logEvent('rec', 'the browser recognizer is reachable again');
        _nativeVerdict = verdict;
        _readyUpdate();
    }
    // R24 - what the ear's download weighs, said on the loading screen: the
    // GPU build is an fp32 encoder with a q4 decoder, the CPU build is q8
    function _earSizeMb() {
        var gpu = c.ear.device === 'webgpu';
        if (/small/.test(c.ear.model)) return gpu ? 590 : 250;
        if (/base/.test(c.ear.model)) return gpu ? 200 : 80;
        return gpu ? 60 : 40;
    }
    function _earSizeKnown(size) { return size === 'auto' || size === 'tiny' || size === 'base' || size === 'small'; }
    // the size in the user's words (Settings) and the model's own (the Lab)
    function _earModelShort(model) { return /small/.test(model || c.ear.model) ? 'small' : (/base/.test(model || c.ear.model) ? 'base' : 'tiny'); }
    function _earSizeName() { return { small: 'best', base: 'balanced', tiny: 'quick' }[_earModelShort()]; }
    function _earSizeLabel(size) {
        return size === 'tiny' ? 'Quick (tiny, 40 MB)' : (size === 'base' ? 'Balanced (base, 80 MB)' : (size === 'small' ? 'Best (small, about 250 MB on CPU, slower)' : 'Auto (best for this device)'));
    }
    // the most accurate model on a CPU: right, and seconds a phrase
    function _earSlowHere() { return /small/.test(c.ear.model) && c.ear.device !== 'webgpu'; }
    function _earSizeNote() { return _earSizeName() + ', about ' + _earSizeMb() + ' MB' + (_earSlowHere() ? ', the most accurate and slower on this device' : ''); }
    // a phone: never the big model, whatever its browser offers
    function _isPhone() {
        try {
            var nav = $window.navigator || {}, ua = String(nav.userAgent || '');
            return !!(c.app && c.app.ios) || /Android|iPhone|iPad|iPod|Mobi/i.test(ua);
        } catch (e) { return false; }
    }
    // v7.8 - auto: small on a desktop GPU, base on a desktop CPU; a chosen size
    // wins on a desktop (small on a CPU is slow, and the most accurate); a
    // phone always gets tiny (its data plan and memory; its own recognizer
    // is primary), whatever is set
    function _earModelFor(size, gpu) {
        if (size === 'tiny') return EAR_MODEL_TINY;
        if (size === 'small') return EAR_MODEL_SMALL;
        if (size === 'base') return EAR_MODEL_BASE;
        return gpu ? EAR_MODEL_SMALL : EAR_MODEL_BASE;
    }
    function _earPickModel() {
        var phone = _isPhone(), gpu = false;
        try { gpu = !!($window.navigator && $window.navigator.gpu) && !phone; } catch (eG) {}
        c.ear.device = gpu ? 'webgpu' : 'wasm';
        c.ear.model = phone ? EAR_MODEL_TINY : _earModelFor(c.ear.size, gpu);
    }
    var _earProc = null, _earSink = null, _earRing = [], _earRingMs = 0, _earSeg = [], _earSegMs = 0, _earVoiceMs = 0, _earInSpeech = false, _earSilenceMs = 0, _earRate = 48000;
    var _earLastPartialAt = 0, _earPartialMs = 0, _earPartialOk = true;
    // R21 - the ear takes the mic after the echo canceller, but what is left
    // of her voice still reaches it, and a segment is transcribed a second
    // or two AFTER it was heard - by then she may have stopped, so "is she
    // speaking now" says nothing. Each segment remembers whether it
    // overlapped her voice (or its last half second) and what she was saying.
    var EAR_ECHO_TAIL_MS = 500;
    var _herVoiceLastOnAt = 0, _earSegHerMs = 0, _earSegSpoken = [], _earJobSeq = 0, _earJobMeta = {};
    function _herVoiceOn() { return !!(_speakingNow || currentFillerAudio || currentFillerUtter); }
    function _earNoteSpoken() {
        [_speakingText, _fillerEchoText].forEach(function (s) {
            if (s && _earSegSpoken.indexOf(s) < 0) { _earSegSpoken.push(s); if (_earSegSpoken.length > 4) _earSegSpoken.shift(); }
        });
    }
    var _deafStrikes = 0, _deafWinStart = 0, _deafLoudMs = 0, _deafLastFrameAt = 0, _srNoGrammar = false, _langFellBack = false;
    // the worker: transformers.js from the CDN, the model from the hub,
    // both cached by the browser after the first load
    var EAR_WORKER_SRC =
        "import { pipeline, env } from '" + EAR_LIB + "';\n" +
        "env.allowLocalModels = false;\n" +
        "let asr = null;\n" +
        "self.onmessage = async (e) => {\n" +
        "  try {\n" +
        "    if (e.data.cmd === 'load') {\n" +
        "      const dtype = e.data.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';\n" +
        // one figure for all the model files together (bytes so far over
        // bytes known), never 100 before the download is really done
        "      const files = {};\n" +
        "      asr = await pipeline('automatic-speech-recognition', e.data.model, { dtype, device: e.data.device,\n" +
        "        progress_callback: (p) => { if (p.status === 'progress' && p.file && /\\.onnx$/.test(p.file) && p.total) {\n" +
        "          files[p.file] = [p.loaded || 0, p.total]; let got = 0, all = 0;\n" +
        "          for (const k in files) { got += files[k][0]; all += files[k][1]; }\n" +
        "          self.postMessage({ progress: Math.min(99, Math.floor(got / all * 100)) }); } } });\n" +
        "      self.postMessage({ downloaded: true });\n" +
        "      const w = Date.now(); await asr(new Float32Array(16000)); self.postMessage({ loaded: true, warmMs: Date.now() - w });\n" +
        "    } else if (e.data.cmd === 'run') {\n" +
        "      const t = Date.now();\n" +
        // no decode options: transformers.js 3.7.1 has no beam search or
        // prompt, and an n-gram ban would force a repeated digit run wrong
"      const r = await asr(e.data.audio);\n" +
        "      self.postMessage({ id: e.data.id, partial: !!e.data.partial, text: String(r && r.text || ''), ms: Date.now() - t });\n" +
        "    }\n" +
        "  } catch (err) { self.postMessage({ id: e.data && e.data.id, error: String(err && err.message || err) }); }\n" +
        "};\n";
    c.earSummary = function () { return _earSummary(); };
    // what hears now, for the Lab and the Settings hint (v7.8: the size named)
    function _earSummary() {
        var e = c.ear;
        if (e.status === 'loading') return 'on-device: loading Whisper ' + e.progress + '%';
        if (e.status === 'standby') return 'browser recognizer (' + (c.recLang || 'en-US') + '); on-device Whisper (' + _earModelShort(e.model) + ', ' + _earSizeName() + ') ready in standby';
        if (e.status === 'on') return 'on-device Whisper (' + _earModelShort(e.model) + ', ' + _earSizeName() + ', English, ' + e.device + ') - ' + e.heard + ' heard' + (e.lastMs ? ', last ' + (e.lastMs / 1000).toFixed(1) + 's' : '') + (e.why ? ' - ' + e.why : '');
        if (e.status === 'error') return 'on-device failed: ' + e.error;
        return 'browser recognizer (' + (c.recLang || 'en-IN') + ')' + (c.hasSR ? '' : ' - none in this browser');
    }
    // v7.8 - the size, from Settings or the Lab: kept, and an ear that is
    // loaded (on, loading, or waiting in standby) is reloaded at the new
    // size - unless the pick is the same model (a phone stays tiny)
    function _setEarSize(size) {
        c.ear.size = _earSizeKnown(size) ? size : 'small';
        if (c.data && c.data.is_guest) c.ear.size = 'small';   // v7.9 - a Guest is always on Best
        try { localStorage.setItem('netra_ear_size', c.ear.size); } catch (e) {}
        logEvent('lab', 'ear model -> ' + c.ear.size);
        // after a failed load (a refused download, no memory for the big
        // model) a new size is the way back in: load it
        var failed = c.ear.status === 'error';
        if (!_earWorker && c.ear.status !== 'loading' && !failed) return;
        var wasModel = c.ear.model, wasDevice = c.ear.device;
        _earPickModel();
        if (failed) {
            c.ear.error = ''; c.ear.status = 'off';
            if (c.ear.why || !c.hasSR || _nativeVerdict === 'blocked') _earStart(c.ear.why || 'a new size after a failed load', true); else _earLoad(true);
            return;
        }
        if (c.ear.model === wasModel && c.ear.device === wasDevice) return;
        var engaged = c.ear.on || (c.ear.status === 'loading' && (_earEngageOnLoad || !c.ear.background)), why = c.ear.why || 'switched on in the Lab';
        try { if (_earWorker) _earWorker.terminate(); } catch (e) {}
        _earWorker = null; _earBusy = false; _earQueue = []; c.ear.on = false; c.ear.status = 'off';
        if (engaged) _earStart(why, true); else _earLoad(true);
    }
    c.labSetEarSize = function () { _setEarSize(c.ear.size); };
    c.setEarSize = c.labSetEarSize;   // the Settings sheet's "Hearing"
    c.labSetEar = function () {
        try { localStorage.setItem('netra_ear', c.ear.mode); } catch (e) {}
        logEvent('lab', 'ear -> ' + c.ear.mode);
        if (c.ear.mode === 'on') _earStart('switched on in the Lab', true);
        else if (c.ear.mode === 'off') { _earStop('switched off in the Lab'); try { if (_earWorker) _earWorker.terminate(); } catch (e) {} _earWorker = null; c.ear.status = 'off'; _readyUpdate(); }
        else {
            if (c.ear.on && /Lab/.test(c.ear.why || '')) _earStop('back to automatic');
            // R24 - automatic loads the ear only when the browser can not hear
            if (!c.hasSR) _earStart('this browser has no speech recognizer', true);
            else if (_nativeVerdict === 'blocked') _earStart('the browser can not reach its speech service', true);
        }
    };
    // load the ear without engaging it: ready in standby for the moment the
    // browser's recognizer turns out deaf. R24 - only once it has shown it
    // may be (the first deaf strike), never on every boot: the download is
    // 40-590 MB and a working recognizer never needs it. v7.8 - the
    // background copy is the very model the ear will use, so the switch
    // costs nothing later (a phone's is tiny by _earPickModel)
    function _earLoad(background) {
        if (c.ear.mode === 'off' || _earWorker || c.ear.status === 'loading') return;
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return;
        c.ear.status = 'loading'; c.ear.progress = 0; c.ear.error = ''; c.ear.background = !!background;
        logEvent('rec', 'on-device ear loading in standby' + (background ? ' (in the background)' : ''));
        try {
            _earPickModel();
            // the standby copy on a desktop that can still hear is the
            // balanced model on the CPU (80 MB, once): the best model is
            // fetched when the ear is really needed, or when it was chosen
            if (background && c.ear.size === 'auto' && !_isPhone()) { c.ear.model = EAR_MODEL_BASE; c.ear.device = 'wasm'; }
            _earSpawn();
        } catch (e) { _earFail(String(e && e.message || e)); }
        _readyUpdate();
    }
    function _earStart(why, quiet) {
        if (c.ear.mode === 'off') { logEvent('rec', 'ear wanted (' + why + ') but switched off in the Lab'); return false; }
        if (c.ear.on) return true;
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined') { c.ear.status = 'error'; c.ear.error = 'no workers in this browser'; return false; }
        c.ear.why = why; c.ear.error = ''; _earNativeSeen = 0;
        logEvent('rec', 'on-device ear engaging: ' + why);
        if (!quiet && !_earSaid) _earAnnounce = why;
        if (c.ear.status === 'standby' && _earWorker) { _earReady(); return true; }
        if (c.ear.status === 'loading' && _earWorker) { _earEngageOnLoad = true; _readyUpdate(); return true; }
        _earEngageOnLoad = true;
        c.ear.status = 'loading'; c.ear.progress = 0;
        try {
            if (!_earWorker) {
                _earPickModel();
                _earSpawn();
            } else {
                _earReady();
            }
        } catch (e) { _earFail(String(e && e.message || e)); }
        _readyUpdate();   // R24 - the loading screen says why and how big, at once
        return true;
    }
    function _earSpawn() {
        c.ear.progress = 0; c.ear.prepared = false;   // a new download counts from zero once
        _earWorker = new Worker(URL.createObjectURL(new Blob([EAR_WORKER_SRC], { type: 'text/javascript' })), { type: 'module' });
        _earWorker.onmessage = _earOnMessage;
        _earWorker.onerror = function (ev) { _earLoadFailed('worker: ' + (ev && ev.message || 'failed')); };
        logEvent('rec', 'on-device ear loading ' + c.ear.model + ' on ' + c.ear.device);
        _earWorker.postMessage({ cmd: 'load', model: c.ear.model, device: c.ear.device });
    }
    // the GPU model would not load or run: WebAssembly instead - base for
    // auto (v7.8: a desktop never drops to tiny), a chosen size as chosen
    function _earLoadFailed(msg) {
        if (c.ear.device === 'webgpu') {
            var next = _earModelFor(c.ear.size, false);
            logEvent('warn', 'on-device ear: ' + c.ear.model + ' on webgpu failed (' + msg + ') - trying ' + next + ' on wasm');
            try { if (_earWorker) _earWorker.terminate(); } catch (e) {}
            _earWorker = null; _earBusy = false; _earQueue = [];
            c.ear.device = 'wasm'; c.ear.model = next; c.ear.progress = 0;
            if (c.ear.status !== 'loading') c.ear.status = 'loading';
            try { _earSpawn(); } catch (e2) { _earFail(String(e2 && e2.message || e2)); }
            return;
        }
        _earFail(msg);
    }
    function _earReady() {
        var was = c.ready;
        c.ear.on = true; c.ear.status = 'on'; c.ear.progress = 100; _earEngageOnLoad = false;
        // mid-visit only (a first boot is greeted next anyway), and never over her
        if (_earAnnounce && !_earSaid && c.gate && c.gate.everOpen && !_speakingNow && !_chatInFlight) {
            _earSaid = true;
            speak((/reach/.test(_earAnnounce) ? 'The browser can not reach its speech service' : 'The browser is returning no words for what you say') + ', so I am listening on this device now - please say that again.');
        }
        _earAnnounce = '';
        _earTapAttach();
        logEvent('rec', 'on-device ear listening (' + c.ear.model + ' on ' + c.ear.device + ')');
        _readyUpdate();   // R21 - the loading screen says "ready" once everything is
        void was;
        $scope.$applyAsync();
    }
    function _earFail(msg) {
        var engaged = c.ear.on || _earEngageOnLoad || !c.hasSR;   // was it needed? read before the reset
        _earEngageOnLoad = false; _earAnnounce = '';
        c.ear.on = false; c.ear.status = 'error'; c.ear.error = msg;
        logEvent('err', 'on-device ear failed: ' + msg);
        try { if (_earWorker) _earWorker.terminate(); } catch (e) {}
        _earWorker = null; _earBusy = false; _earQueue = [];
        // R21 - said only when the ear was needed and the browser has not
        // proven it can hear - and never over an answer
        if (engaged && !_nativeHeardWords && !/Lab/.test(c.ear.why || '') && !_speakingNow && !_chatInFlight) speak('I could not load my on-device listening - ' + (/fetch|network|load/i.test(msg) ? 'the model would not download on this network' : 'this browser could not run it') + '. ' + _typeHint());
        _readyUpdate();   // R21 - the browser recognizer's clean start counts again now
        $scope.$applyAsync();
    }
    // speech the ear heard before Mute is never delivered
    function _earForget() {
        _earSeg = []; _earSegMs = 0; _earVoiceMs = 0; _earSilenceMs = 0; _earInSpeech = false;
        _earRing = []; _earRingMs = 0; _earSegHerMs = 0; _earSegSpoken = []; _earQueue = [];
    }
    function _earStop(why) {
        if (!c.ear.on && c.ear.status !== 'loading') return;
        c.ear.on = false; c.ear.why = ''; _earEngageOnLoad = false;
        c.ear.status = _earWorker && c.ear.status !== 'loading' ? 'standby' : 'off';   // loaded stays loaded
        _earSeg = []; _earSegMs = 0; _earInSpeech = false; _earQueue = [];
        logEvent('rec', 'on-device ear ' + (c.ear.status === 'standby' ? 'back in standby' : 'off') + ': ' + why);
        _readyUpdate();
    }
    function _earOnMessage(ev) {
        var d = ev.data || {};
        // R24 - the figure shown only goes up, and "preparing" comes once,
        // after the whole download
        if (d.progress !== undefined) {
            var pct = Math.min(99, Math.max(0, Math.floor(Number(d.progress) || 0)));
            if (!c.ear.prepared && pct > c.ear.progress) { c.ear.progress = pct; _readyUpdate(); }
            return;
        }
        if (d.downloaded) { c.ear.prepared = true; c.ear.progress = 100; _readyUpdate(); return; }
        if (d.loaded) {
            if (d.warmMs) logEvent('rec', 'on-device ear warmed up in ' + d.warmMs + ' ms');
            // R21 - the on-device ear is the default ear until the browser's
            // recognizer has returned words: a recognizer that starts and then
            // hears nothing (no error at all) is otherwise indistinguishable
            // from one that works, and the user would talk into nothing
            // R24 - a background copy waits in standby while the browser's
            // recognizer is fine; the first deaf strike engages it
            var bgReady = c.ear.background && !_earEngageOnLoad && c.ear.mode !== 'on' && c.hasSR && _nativeVerdict === 'ok';
            c.ear.background = false;
            if (!bgReady && (_earEngageOnLoad || c.ear.mode === 'on' || !c.hasSR || !_nativeHeardWords)) {
                if (!c.ear.why) c.ear.why = !c.hasSR ? 'this browser has no speech recognizer' : (c.ear.mode === 'on' ? 'switched on in the Lab' : 'until the browser recognizer proves it can hear');
                _earEngageOnLoad = false; _earReady();
            }
            else { c.ear.status = 'standby'; c.ear.progress = 100; logEvent('rec', 'on-device ear ready in standby - the browser recognizer is hearing'); _readyUpdate(); }
            return;
        }
        if (d.error) {
            if (c.ear.status === 'loading') return _earLoadFailed(d.error);
            logEvent('err', 'on-device ear: ' + d.error);
            _earBusy = false;
            // a GPU run that breaks after loading: back to the small model, and this segment is lost
            if (c.ear.device === 'webgpu' && c.ear.heard === 0) { c.ear.status = 'loading'; c.ear.on = false; _earLoadFailed(d.error); return; }
            _earNext();
            return;
        }
        if (d.text !== undefined && d.partial) {
            // the words so far, while the user is still speaking: live text
            // only, never a command; a slow device stops asking for them
            _earBusy = false; _earPartialMs = d.ms; _earPartialOk = d.ms < 1800;
            var ptext = String(d.text).replace(/\s+/g, ' ').trim();
            if (_earInSpeech && !_speakingNow && !c.micOff && !EAR_HALLUCINATION_RE.test(ptext)) { c.interim = '(on-device) ' + ptext; $scope.$applyAsync(); }
            _earNext();
            return;
        }
        if (d.text !== undefined) {
            _earBusy = false; c.ear.lastMs = d.ms;
            var jobMeta = d.id !== undefined ? _earJobMeta[d.id] : null;
            if (d.id !== undefined) delete _earJobMeta[d.id];
            var text = String(d.text).replace(/\s+/g, ' ').trim();
            if (EAR_HALLUCINATION_RE.test(text)) {
                logEvent('rec.f', 'on-device: nothing said (' + JSON.stringify(text) + ', ' + d.ms + ' ms)');
                if (c.interim && /on-device/.test(c.interim)) { c.interim = ''; $scope.$applyAsync(); }
            } else if (!c.ear.on) {
                // R21 - handed back to the browser recognizer (or switched off)
                // while this was in the worker: that ear has these words too
                logEvent('rec.f', 'on-device: "' + text + '" dropped - the browser recognizer has the floor now');
            } else {
                c.ear.heard++;
                logEvent('rec.f', 'on-device: "' + text + '" (' + d.ms + ' ms)' + (jobMeta && jobMeta.overlap ? ' - heard over my voice (' + Math.round(jobMeta.herShare * 100) + '%)' : ''));
                _earDeliver(text, jobMeta);
            }
            _earNext();
        }
    }
    // R21 - within 4 s of the hand-back, a browser final whose words are
    // mostly the ear's last delivery is that same utterance, heard twice
    function _handbackRepeat(t) {
        if (!_earHandbackAt || Date.now() - _earHandbackAt > 4000 || !_earLastSaid || Date.now() - _earLastSaid.at > 4000) return false;
        var bTok = _normTokens(t), eTok = _normTokens(_earLastSaid.text);
        var hit = bTok.filter(function (w) { return eTok.indexOf(w) >= 0; }).length;
        return !!bTok.length && hit / bTok.length >= 0.7;
    }
    // the same road a browser final travels: barge-in scoring, aliases, the buffer
    function _earDeliver(text, meta) {
        var t = text, conf = 0.85;
        // a segment in the worker when Mute was pressed: not for her, not even a barge-in
        if (c.micOff) { _heardLog(t, conf, 'ignored: mic muted'); return; }
        recLastActivityAt = Date.now();
        _lastFinalAt = Date.now(); c.micHealth.lastFinalAt = _lastFinalAt;
        if (Date.now() < ignoreFinalsUntil) { _heardLog(t, conf, 'dropped: right after my own voice'); return; }
        // R21 - heard while she was speaking: scored against what she was
        // saying THEN, even if she has finished (or started something else)
        if (meta && meta.overlap) {
            if (_looksLikeEcho(t, meta.spoken)) {
                logEvent('rec.echo', 'on-device: "' + t + '" (my own voice, heard over it)');
                _heardLog(t, conf, 'dropped: my own voice');
                return;
            }
            var st = _stripEchoEdges(t, meta.spoken);
            if (st !== t) { logEvent('rec.echo', 'on-device: my own words stripped: "' + t + '" -> "' + st + '"'); t = st; }
            // mostly her voice, and too little of it to be a command: noise
            if (meta.herShare >= 0.8 && _normTokens(t).length < 3 && !HARD_INTERRUPT_RE.test(t) && !matchLocal(t.toLowerCase()) && !_isNoAnswer(t)) {
                logEvent('rec.echo', 'on-device: "' + t + '" (too little, over my voice)');
                _heardLog(t, conf, 'dropped: too weak over my voice');
                return;
            }
        }
        if (_speakingNow || _fillerChainActive || currentFillerAudio || currentFillerUtter) {
            if (_handleFinalWhileSpeaking(t, conf)) return;
            if (_lastBargeText) { t = _lastBargeText; _lastBargeText = ''; }
        }
        var forgiven = _forgive(t);
        if (forgiven !== t) { logEvent('train', 'forgiven: "' + t + '" -> "' + forgiven + '"'); t = forgiven; }
        var aliased = applyAliases(t);
        if (aliased !== t) { logEvent('train', 'alias-rewrite: "' + t + '" -> "' + aliased + '"'); t = aliased; }
        _earLastSaid = { text: t, at: Date.now() };
        _enqueueFinalTranscript(t, conf);
    }
    // v7.8 - the mic graph runs at the ear's 16 kHz when the browser allows
    // it, so the browser resamples the mic with its own proper filter; one
    // that refuses (older WebKit) gets its default rate, and the ear's own
    // low-pass decimator does the job
    function _newMicContext() {
        var Ctor = window.AudioContext || window.webkitAudioContext, ctx = null;
        try { ctx = new Ctor({ sampleRate: EAR_RATE }); } catch (eRate) { ctx = null; }
        return ctx || new Ctor();
    }
    // a browser that gave the 16 kHz context but will not feed a 48 kHz mic
    // into it (old Firefox): the default rate, so the mic graph still runs
    function _micSourceFor(stream) {
        try { return _micCtx.createMediaStreamSource(stream); }
        catch (eSrc) {
            if (!_micCtx || _micCtx.sampleRate !== EAR_RATE) throw eSrc;
            logEvent('warn', 'mic audio: no 16 kHz graph for this mic (' + (eSrc && eSrc.message || eSrc) + ') - using the default rate');
            var was = _micCtx;
            try { was.close(); } catch (eClose) {}
            _micCtx = new (window.AudioContext || window.webkitAudioContext)();
            _micCtx.onstatechange = was.onstatechange;
            return _micCtx.createMediaStreamSource(stream);
        }
    }
    // the mic's own audio, tapped after the gain stage; a silent sink keeps
    // the processor running without playing the mic through the speakers
    function _earFrameSize(rate) { return rate <= 16000 ? 1024 : (rate <= 24000 ? 2048 : 4096); }
    function _earTapAttach() {
        if (_earProc || !_micCtx || !_micGainNode) return;
        try {
            _earRate = _micCtx.sampleRate || 48000;
            // a frame stays 64-85 ms whatever the rate: at 16 kHz a 4096
            // frame is 256 ms, and the frame the meter rises in is pre-roll,
            // not voiced, so a one-word "yes" fell under EAR_MIN_SPEECH_MS
            _earProc = _micCtx.createScriptProcessor(_earFrameSize(_earRate), 1, 1);
            _earSink = _micCtx.createGain(); _earSink.gain.value = 0;
            _earProc.onaudioprocess = function (ev) {
                if (!c.ear.on) return;
                var inp = ev.inputBuffer.getChannelData(0);
                _earFeed(new Float32Array(inp), _earRate);
            };
            _micGainNode.connect(_earProc); _earProc.connect(_earSink); _earSink.connect(_micCtx.destination);
        } catch (e) { logEvent('err', 'on-device ear: could not tap the mic: ' + (e.message || e)); _earProc = null; }
    }
    function _earTapDetach() {
        try { if (_earProc) { _earProc.disconnect(); _earProc.onaudioprocess = null; } if (_earSink) _earSink.disconnect(); } catch (e) {}
        _earProc = null; _earSink = null;
    }
    // segments: a frame is speech when the meter would show it; a segment
    // opens on speech, keeps a little pre-roll, and closes on silence
    function _earFeed(frame, rate) {
        var sum = 0;
        for (var i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        var level = Math.min(100, Math.round(Math.sqrt(sum / frame.length) * 360));
        var ms = frame.length / rate * 1000;
        var nowF = Date.now();
        if (_herVoiceOn()) _herVoiceLastOnAt = nowF;
        var herish = !!_herVoiceLastOnAt && nowF - _herVoiceLastOnAt < EAR_ECHO_TAIL_MS;
        if (!_earInSpeech) {
            _earRing.push(frame); _earRingMs += ms;
            while (_earRingMs > EAR_PREROLL_MS && _earRing.length > 1) { _earRingMs -= _earRing[0].length / rate * 1000; _earRing.shift(); }
            if (level >= EAR_START_LEVEL) {
                _earInSpeech = true; _earSeg = _earRing.slice(); _earSegMs = _earRingMs; _earVoiceMs = 0; _earSilenceMs = 0; _earLastPartialAt = 0;
                _earRing = []; _earRingMs = 0;
                _earSegHerMs = 0; _earSegSpoken = [];
                if (herish) { _earSegHerMs = ms; _earNoteSpoken(); }
                if (!_speakingNow) { c.interim = '(on-device) hearing…'; $scope.$applyAsync(); }
            }
            return;
        }
        _earSeg.push(frame); _earSegMs += ms; _earVoiceMs += ms;
        if (herish) { _earSegHerMs += ms; _earNoteSpoken(); }
        if (level < EAR_STOP_LEVEL) _earSilenceMs += ms; else _earSilenceMs = 0;
        // live words while the user still speaks, when the worker is free
        if (_earPartialOk && !_earBusy && !_earQueue.length && _earWorker && _earSilenceMs < EAR_STOP_LEVEL && _earVoiceMs - _earLastPartialAt >= EAR_PARTIAL_MS && _earVoiceMs >= EAR_PARTIAL_MS) {
            _earLastPartialAt = _earVoiceMs;
            _earBusy = true;
            var part = _earTo16k(_earSeg, rate);
            _earWorker.postMessage({ cmd: 'run', id: Date.now(), partial: true, audio: part }, [part.buffer]);
        }
        if (_earSilenceMs >= EAR_SILENCE_MS || _earSegMs >= EAR_MAX_MS) {
            // the voiced part is what was said after the meter rose, less the trailing silence: the pre-roll is not speech
            var seg = _earSeg, voicedMs = _earVoiceMs - _earSilenceMs;
            // v7.8 - her share is of the voiced part: the longer wait for silence must not dilute it
            var meta = { overlap: _earSegHerMs > 0, herShare: voicedMs > 0 ? Math.min(1, _earSegHerMs / voicedMs) : 0, spoken: _earSegSpoken.slice() };
            _earSeg = []; _earSegMs = 0; _earVoiceMs = 0; _earInSpeech = false; _earSilenceMs = 0; _earSegHerMs = 0; _earSegSpoken = [];
            if (voicedMs < EAR_MIN_SPEECH_MS) { if (c.interim && /on-device/.test(c.interim)) { c.interim = ''; $scope.$applyAsync(); } return; }
            _earSubmit(_earTo16k(seg, rate), meta);
        }
    }
    // v7.8 - a proper decimator: a 33-tap windowed-sinc low-pass (Hamming,
    // cutoff 7 kHz) evaluated at each 16 kHz output sample, so what lies
    // above 8 kHz is removed rather than folded onto the speech (the block
    // average it replaces left a 19 kHz tone only 14 dB down, as a 3 kHz
    // alias). A mic rate that is not a whole multiple (44.1 kHz) blends the
    // two nearest centres. The taps are made once per rate
    var EAR_FIR_TAPS = 33;
    var _earFir = null, _earFirRate = 0;
    function _earFirTaps(rate) {
        if (_earFir && _earFirRate === rate) return _earFir;
        var n = EAR_FIR_TAPS, mid = (n - 1) / 2, fc = 7000 / rate, taps = new Float32Array(n), sum = 0, i;
        for (i = 0; i < n; i++) {
            var u = i - mid, sinc = u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u);
            taps[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1)));
            sum += taps[i];
        }
        for (i = 0; i < n; i++) taps[i] /= sum;   // unity gain in the passband
        _earFir = taps; _earFirRate = rate;
        return taps;
    }
    // the filter centred on input sample `at` (edges are zero-padded)
    function _earFirAt(x, taps, at) {
        var n = taps.length, start = at - ((n - 1) >> 1), acc = 0, k;
        if (start >= 0 && start + n <= x.length) { for (k = 0; k < n; k++) acc += x[start + k] * taps[k]; return acc; }
        for (k = 0; k < n; k++) { var j = start + k; if (j >= 0 && j < x.length) acc += x[j] * taps[k]; }
        return acc;
    }
    function _earTo16k(frames, rate) {
        var total = 0, i;
        for (i = 0; i < frames.length; i++) total += frames[i].length;
        var all = new Float32Array(total), off = 0;
        for (i = 0; i < frames.length; i++) { all.set(frames[i], off); off += frames[i].length; }
        if (rate === EAR_RATE) return all;
        var ratio = rate / EAR_RATE, n = Math.floor(all.length / ratio), out = new Float32Array(n), taps = _earFirTaps(rate);
        var whole = ratio === Math.floor(ratio);
        for (i = 0; i < n; i++) {
            var pos = i * ratio, c0 = Math.floor(pos), frac = pos - c0, v = _earFirAt(all, taps, c0);
            if (!whole && frac > 0) v += (_earFirAt(all, taps, c0 + 1) - v) * frac;
            out[i] = v;
        }
        return out;
    }
    function _earSubmit(audio, meta) {
        if (!_earWorker || !c.ear.on) return;
        if (_earQueue.length >= 2) _earQueue.shift();   // never fall behind: the oldest goes
        _earQueue.push({ audio: audio, meta: meta || null });
        if (!_speakingNow) { c.interim = '(on-device) working out what you said…'; $scope.$applyAsync(); }
        _earNext();
    }
    function _earNext() {
        if (_earBusy || !_earQueue.length || !_earWorker) return;
        _earBusy = true;
        var job = _earQueue.shift();
        if (job && job.audio === undefined) job = { audio: job, meta: null };
        var id = ++_earJobSeq;
        _earJobMeta[id] = job.meta;
        _earWorker.postMessage({ cmd: 'run', id: id, audio: job.audio }, [job.audio.buffer]);
    }
    // the meter shows speech, the recognizer returns nothing: judged every
    // ten seconds, healed in steps, the ear as the last step
    function _deafAccumulate(level, now) {
        if (_deafLastFrameAt) {
            var dt = Math.min(100, now - _deafLastFrameAt);
            if (level >= DEAF_LOUD_LEVEL && !_speakingNow && !_calibActive && (now - _speakingSince) > 1500) _deafLoudMs += dt;
        }
        _deafLastFrameAt = now;
        if (!_deafWinStart) _deafWinStart = now;
    }
    function _deafCheck(now) {
        if (!_deafWinStart || now - _deafWinStart < DEAF_WINDOW_MS) return;
        var loud = _deafLoudMs, since = _deafWinStart;
        _deafWinStart = now; _deafLoudMs = 0;
        if (c.ear.on || !c.alert || !c.hasSR || c.permission === 'denied') return;
        var words = _lastInterimAt >= since || _lastFinalAt >= since;
        if (words) { if (_deafStrikes) logEvent('rec', 'words are back - recognizer healthy'); _deafStrikes = 0; return; }
        if (loud < DEAF_LOUD_MS) return;
        _deafStrikes++;
        c.micHealth.deafStrikes = (c.micHealth.deafStrikes || 0) + 1;
        logEvent('warn', 'sound without words: ' + Math.round(loud / 100) / 10 + 's of speech on the meter, nothing from the recognizer (strike ' + _deafStrikes + ')');
        // an ear already loaded takes over at once; the browser's recognizer
        // is still healed in the background and hands back if it recovers
        if (_deafStrikes === 1 && c.ear.status === 'standby' && _earStart('the browser returned no words for clear speech')) { $scope.$applyAsync(); return; }
        // R24 - the first sign the recognizer may be deaf: the ear starts
        // downloading in standby while the browser is healed in steps
        if (_deafStrikes === 1 && c.ear.status === 'off') _earLoad();
        if (_deafStrikes === 2) {
            _srNoGrammar = true;
            _fullMicRecycle('deaf: rebuilding without the grammar');
        } else if (_deafStrikes === 3 && c.recLang !== 'en-US') {
            _langFellBack = true;
            logEvent('warn', 'still no words in ' + c.recLang + ' - trying plain en-US');
            c.recLang = 'en-US';
            _fullMicRecycle('deaf: plain en-US');
        } else if (_deafStrikes >= 4) {
            if (!_earStart('the browser returned no words for clear speech') && c.ear.mode === 'off' && !_earSaid) {
                _earSaid = true;
                speak('I can hear you, but the browser is returning no words for what you say. My on-device listening is switched off in the Lab - switch it on there, or type to me.');
            }
        }
        $scope.$applyAsync();
    }
    var _notAllowedStrikes = 0;
    var _lastLowConfNudgeAt = 0;
    var _floorStuckStrikes = 0;
    // R8.2 - prosody capture (speech-delivery sentiment hints for the brain)
    var _prosFirstAt = 0, _prosSum = 0, _prosN = 0, _prosPeak = 0;
    var _netErrStreak = 0, _lastNetErrSaidAt = 0;
    c.micHealth = {
        speechService: 'ok',    // 'unreachable' after 3 network errors in a row
        networkErrors: 0,
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
        // muted: onend, the watchdogs and a wake all come through here
        if (c.micOff) return;
        if (!_ctrlDestroyed && !c.ear.on) {
            if (!c.hasSR) _earStart('this browser has no speech recognizer', true);
            else if (c.ear.mode === 'on') _earStart('switched on in the Lab', true);
        }
        if (!c.hasSR || _ctrlDestroyed) return;
        try { if (contRec) contRec.stop(); } catch (e) {}

        contRec = new SR();
        contRec.continuous     = true;
        contRec.interimResults = true;
        contRec.lang           = c.recLang || 'en-IN';   // R9 - Lab language selector
        contRec.maxAlternatives = 5;   // R2.2 - get top 5 guesses to re-rank against personal vocab
        // the grammar list is a hint Chrome's service tolerates; Edge's and
        // a deaf session are better off without it
        if (!_srNoGrammar && !_edgeBrowser) attachGrammar(contRec);
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
            // started, and no network error while it settled: the service is reachable
            if (_nativeVerdict !== 'ok') {
                if (_nativeVerdictTimer) $timeout.cancel(_nativeVerdictTimer);
                _nativeVerdictTimer = $timeout(function () { if (_nativeVerdict === 'unknown' && c.recRunning) _nativeSaw('ok'); }, NATIVE_SETTLE_MS);
            }
            $scope.$applyAsync();
        };

        contRec.onresult = function (ev) {
            recLastActivityAt = Date.now();   // R1.1 - silent-rec heartbeat
            if (c.micOff) return;   // muted: nothing heard is for her, not even a barge-in
            _notAllowedStrikes = 0;           // R8.1 - real results = mic healthy
            if (_netErrStreak) { _netErrStreak = 0; c.micHealth.speechService = 'ok'; }
            if (_deafStrikes && !c.ear.on) _deafStrikes = 0;
            if (!_nativeHeardWords) {
                for (var hw = ev.resultIndex; hw < ev.results.length; hw++) {
                    if (ev.results[hw] && ev.results[hw][0] && String(ev.results[hw][0].transcript || '').trim()) { _nativeHeardWords = true; logEvent('rec', 'the browser recognizer returned words - it can hear'); _readyUpdate(); break; }
                }
            }
            if (_nativeVerdict !== 'ok') _nativeSaw('ok');
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                var conf = (res[0] && res[0].confidence) || 0;
                // while the on-device ear listens, the browser's own results
                // stay out of the way - unless they keep coming, which means
                // the recognizer healed and the ear can rest (automatic mode)
                if (c.ear.on && res.isFinal) {
                    _earNativeSeen++;
                    if (c.ear.mode === 'auto' && _earNativeSeen >= 3) {
                        _earStop('the browser recognizer is hearing again');
                        _earHandbackAt = Date.now();
                    } else {
                        _heardLog(t, conf, 'ignored: the on-device ear is listening');
                        continue;
                    }
                }
                // R21 - right after the hand-back, the browser's final for words
                // the ear already delivered (the ear was quicker) is the same
                // utterance: never asked twice
                if (res.isFinal && _handbackRepeat(t)) { _heardLog(t, conf, 'dropped: the on-device ear already heard this'); continue; }
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
                    // 'Talking interrupts Netra' off: a screen reader or TV must not cut her off
                    if (floorHeld && _voiceBargeOn()) {
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
                    _heardLog(t, conf, 'dropped: right after my own voice');
                    continue;
                }
                // R7 - echo tail after an instant yield: her audio stopped
                // mid-word, but a final containing HER last words can still
                // arrive for ~1.2s. Score it against what she was saying
                // and drop pure echo, while the user's real command passes.
                if (Date.now() - _lastYieldAt < 1200 && _looksLikeEcho(t)) {
                    logEvent('rec.echo', '"' + t.trim() + '" (post-yield echo tail)');
                    _heardLog(t, conf, 'dropped: my own echo');
                    continue;
                }
                // R6 - BARGE-IN: Netra currently holds the floor (speaking,
                // or filler chain running while she thinks). Score this
                // final: her own echo is dropped; a reflex "stop" yields
                // instantly; substantive user speech stops her audio and
                // falls through to be processed as the next command.
                var barged = false;
                if (_speakingNow || _fillerChainActive || currentFillerAudio || currentFillerUtter) {
                    if (_handleFinalWhileSpeaking(t, conf)) continue;
                    if (_lastBargeText) { t = _lastBargeText; _lastBargeText = ''; barged = true; }
                }
                // R2.2 - pick the best alternative against personal vocab -
                // never for a barge-in whose text was already cut: the raw
                // alternatives would put her echo words back
                var picked = barged ? null : pickBestAlternative(res);
                if (picked && picked.transcript !== t) {
                    logEvent('train', 'reranked: "' + t + '" -> "' + picked.transcript + '" (vocab hits: ' + picked.vocabHits + ')');
                    t = picked.transcript;
                    conf = picked.confidence;
                }
                // heard, not typed: a mis-heard command word is forgiven first
                var forgivenT = _forgive(t);
                if (forgivenT !== t) { logEvent('train', 'forgiven: "' + t + '" -> "' + forgivenT + '"'); t = forgivenT; }
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
            if (ev.error === 'network') {
                // the browser could not reach its speech service: sound is
                // captured but no words come back. Silent before, so it read
                // as "she does not understand me" - say what it is, once.
                _netErrStreak++;
                c.micHealth.networkErrors = (c.micHealth.networkErrors || 0) + 1;
                // the first refusal already switches to the ear that needs no
                // service. R24 - also after a clean start that never heard a
                // word: the gate opens on a clean start now, and a slow refusal
                // must still bring the ear
                if (_nativeVerdict === 'unknown' || (_nativeVerdict === 'ok' && !_nativeHeardWords)) { _nativeSaw('blocked'); _earStart('the browser can not reach its speech service', true); }
                if (_netErrStreak === 3) {
                    c.micHealth.speechService = 'unreachable';
                    logEvent('err', 'speech service unreachable - 3 network errors in a row (the browser can not reach its speech service: network, VPN or proxy)');
                    // the ear needs no speech service: it takes over now
                    if (!_earStart('the browser can not reach its speech service') && Date.now() - _lastNetErrSaidAt > 300000 && !_speakingNow) {
                        _lastNetErrSaidAt = Date.now();
                        speak('I can hear sound, but the browser can not reach its speech service right now, so I can not make out words. That is usually the network or a VPN. ' + _typeHint());
                    }
                    $scope.$applyAsync();
                }
                return;
            }
            if (ev.error === 'no-speech' ||
                ev.error === 'audio-capture' ||
                ev.error === 'aborted') {
                return;
            }
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
                _handleNotAllowed(ev.error);
                return;
            }
            if (ev.error === 'language-not-supported') {
                // this browser's service will not take the language: plain
                // en-US next, and the ear if even that is refused
                if (c.recLang !== 'en-US') {
                    logEvent('warn', 'the browser will not recognise ' + c.recLang + ' - switching to en-US');
                    var refusedLang = c.recLang;
                    c.recLang = 'en-US'; _langFellBack = true;
                    if (!_earSaid) speak('This browser will not recognise ' + refusedLang + ' speech here, so I am listening in plain English now.');
                } else {
                    _earStart('the browser refuses the language');
                }
                return;
            }
            logEvent('err', 'recognition error: ' + ev.error);
        };

        contRec.onend = function () {
            if (_ctrlDestroyed) return;
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
            c.permission = 'denied';   // before the state: the status says what to do about it
            setState('error');
            cue('error');
            _announce(_micBlockedText(), 'alert');
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
    // R13 - Zoom/Teams behaviour: the moment the audio device list changes
    // (headset plugged in / unplugged / bluetooth reconnects / OS default
    // switches) rebuild the whole capture stack so we are ALWAYS on the
    // device the user expects - never silently recording a dead mic.
    var _devChangeDebounce = null;
    try {
        if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
            navigator.mediaDevices.addEventListener('devicechange', function () {
                if (_ctrlDestroyed) return;
                if (_devChangeDebounce) $timeout.cancel(_devChangeDebounce);
                _devChangeDebounce = $timeout(function () {
                    logEvent('mic', 'audio devices changed - rebuilding mic stack on the new device');
                    _fullMicRecycle('device change');
                }, 900);
            });
        }
    } catch (eDC) {}

    function _fullMicRecycle(reason) {
        if (_recyclingMic) return false;   // R13 - callers can now tell it was skipped
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
        return true;
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
    var watchdogLastPlayedTo = -1;   // currentAudio.currentTime at the last tick
    var _permProbeCounter = 0;
    function startListeningWatchdog() {
        var tick = function () {
            if (_ctrlDestroyed) return;
            var now = Date.now();
            // Stuck-in-speaking detection: if state has been "speaking"
            // for more than 30s without progress, force a FULL floor
            // release (R8.1: setState alone left _speakingNow true, so
            // every later utterance was echo-scored and short commands
            // were eaten forever - "hears but does not register").
            // A long reply whose audio is still advancing is not stuck;
            // browser TTS has no clock, so it gets the time its text needs.
            if (c.state === 'speaking') {
                var playedTo = -1;
                try { if (currentAudio && !currentAudio.paused && !currentAudio.ended) playedTo = currentAudio.currentTime; } catch (ePT) {}
                var advancing = playedTo >= 0 && playedTo !== watchdogLastPlayedTo;
                watchdogLastPlayedTo = playedTo;
                var ttsAllowance = (TTS && (TTS.speaking || TTS.pending)) ? String(_speakingText || '').length * 110 : 0;
                // R27 - WebKit on iPhone can leave speechSynthesis.speaking set
                // after the line has ended: there the text's own time decides
                var stuckAfter = (c.app && c.app.ios) ? 6000 + String(_speakingText || '').length * 90 : 30000 + ttsAllowance;
                if (!watchdogLastSpeakingStart || advancing) {
                    watchdogLastSpeakingStart = now;
                } else if (now - watchdogLastSpeakingStart > stuckAfter) {
                    logEvent('warn', 'watchdog: stuck in speaking - full floor release');
                    watchdogLastSpeakingStart = 0;
                    stopSpeaking('watchdog stuck-speaking');
                    ignoreFinalsUntil = now;
                }
            } else {
                watchdogLastSpeakingStart = 0;
            }

            // R19 - sound without words: heal the recognizer, then open the ear
            _deafCheck(now);

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
            if (c.permission === 'granted' && !c.recRunning && !c.micOff) {
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
        _visibilityHandler = function () {
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
        };
        $window.document.addEventListener('visibilitychange', _visibilityHandler);
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
    function _heardLog(text, conf, fate) {
        try {
            if (!c.heard) c.heard = [];
            var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
            c.heard.unshift({ t: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
                              text: String(text || '').trim().substring(0, 160),
                              conf: (typeof conf === 'number' && conf > 0) ? conf.toFixed(2) : '-', fate: fate || 'heard' });
            if (c.heard.length > 12) c.heard.length = 12;
            $scope.$applyAsync();
        } catch (e) {}
    }
    function _heardFate(fate) { if (c.heard && c.heard.length) { c.heard[0].fate = fate; $scope.$applyAsync(); } }

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
        c._typedTurn = false;   // heard, not typed
        // muted: not even her name wakes her - only Unmute does
        if (c.micOff) { _heardLog(clean, conf, 'ignored: mic muted - press Unmute'); return; }
        // R8.1 - calibration read-back has priority over command routing
        if (_calibConsume(clean)) { _heardLog(clean, conf, 'mic check read-back'); return; }
        // R21 - nothing is accepted before Netra can hear, speak AND answer
        // ("stop", "wait" and "stop listening" always work; asleep, only a
        // wake phrase is for her at all)
        if (c.gate && !c.gate.open && !HARD_INTERRUPT_RE.test(clean) && !matchSleep(clean.toLowerCase())) {
            if (!c.alert && !matchExplicitWakeUp(clean)) { _heardLog(clean, conf, 'ignored: asleep - say "Netra" to wake her'); return; }
            _gateRefuse(clean, conf);
            return;
        }
        var lower = clean.toLowerCase();
        c._hushed = false;   // "quiet" lasts until the user speaks again
        c.prevHeard  = c.lastHeard;   // what "I said X" / "no, I meant X" corrects
        c.lastHeard  = clean;
        c.captionKeep = false;   // her kept caption gives way to what was heard
        c.confidence = conf ? conf.toFixed(2) : '-';
        if (typeof conf === 'number') _pushConfidence(conf);   // R1 chart
        logEvent('rec.f', '"' + clean + '" conf=' + c.confidence);
        _heardLog(clean, conf, 'heard');
        // R2.2 - auto-learn: every word in a confident utterance becomes
        // part of the personal vocabulary, so frequent names/projects
        // self-reinforce over time.
        if (conf >= MIN_CONFIDENCE) learnFromTranscript(clean);
        $scope.$applyAsync();

        // a yes or no to 'I heard "...". Is that right?' - hers was the last
        // question, so it is answered before the server's read-back is
        if (_heardCheckAnswer(clean)) return;

        // ---- 0. "no" / "stop" to a running plan or a waiting read-back is
        // the server's answer - not sleep, and never too short to count ----
        if (c.alert && c.conversationOpen && _isNoAnswer(clean)) {
            _heardFate('answer: no');
            _answerNo(clean);
            return;
        }

        // ---- 1. Sleep command works in any mode ----
        if (matchSleep(lower)) {
            _heardFate('sleep');
            _cancelPlanContinue();
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

        // ---- 1b. "stop" / "wait" with nothing playing: a quiet acknowledgement.
        // She has already stopped; a spoken reply here would be one more
        // thing to talk over ----
        if (c.alert) {
            // by any spelling the recognizer gives her name ("nada stop")
            var afterName = matchesWake(clean);
            var stopBody = (afterName !== null && afterName.length) ? afterName : clean;
            // "quiet" / "silence" are a hush, handled as a local intent below
            var stopLead = matchLocal(stopBody) ? null : stopBody.match(LEADING_STOP_RE);
            if (stopLead) {
                var justYielded = Date.now() - _bargeStoppedAt < 3000;
                var after = _afterStop(stopLead[stopLead.length - 1], justYielded);
                if (after === '') {
                    // the live transcript already stopped her a moment ago:
                    // this final is that same "stop", plus whatever the mic
                    // caught of her last word
                    if (justYielded) {
                        _heardFate('stop - yielded');
                        logEvent('conv', '"' + clean + '" - the stop that already yielded');
                        return;
                    }
                    _heardFate('stop - nothing was playing');
                    logEvent('conv', '"' + clean + '" - nothing to stop');
                    cue('pause');
                    return;
                }
                // "stop, list my tickets": the command after the stop;
                // "stop watching INC0010013": the whole utterance, untouched
                if (after !== 'whole') {
                    clean = after; lower = clean.toLowerCase();
                    logEvent('conv', 'stop, then: "' + clean + '"');
                }
            }
        }

        // ---- 2. Dormant mode: only wake commands resume ----
        if (!c.alert) {
            // Accept: "Netra ..." leading the utterance, or a whole "wake up" /
            // "are you there" / "come back" - heard clearly. A "hello" on the
            // phone or a colleague named Neha is not the user asking for her.
            var wakePhrase = !(conf > 0 && conf < MIN_CONFIDENCE) && matchExplicitWakeUp(clean);
            if (wakePhrase) {
                _heardFate('woke her');
                c.alert = true;
                setState('idle');
                cue('resume');
                openConversation('woke from dormant');
                var restW = matchesWake(clean, true);
                if (restW && restW.length > 2 && !/^(listen|wake\s*up|wake|are\s+you\s+there|come\s+back|hello)$/i.test(restW.replace(/[.!?,\s]+$/, ''))) {
                    speak('Yes, I am back.', function () {
                        $timeout(function () { processCommand(restW, conf); }, 200);
                    });
                } else {
                    speak('Yes, I am listening. Go ahead.');
                }
            } else {
                logEvent('rec', 'dormant - ignored');
                _heardFate('ignored: asleep - say "Netra" to wake her');
            }
            return;
        }

        // ---- 3. ALWAYS-LISTENING / CONVERSATION MODE ----
        // No wake word required. Strip a leading "Netra" if user happens
        // to say it. Filter very short utterances and low-confidence
        // chatter so background noise does not become a command.
        if (c.conversationOpen) {
            var stripped = matchesWake(clean);
            var input = (stripped !== null) ? stripped : clean;

            // Bare "Netra" / "Netra-only" - just acknowledge with a chirp
            if (stripped !== null && (stripped.length === 0 || stripped.length < 2)) {
                cue('wake');
                logEvent('conv', 'name only heard (still listening)');
                _heardFate('my name - listening');
                return;
            }
            // Filter chatter - but "no" and "ok" are whole answers
            if (input.length < MIN_LENGTH && !/^(no|ok)$/i.test(input)) {
                logEvent('rec', 'ignored (too short: "' + input + '")');
                _heardFate('ignored: too short');
                return;
            }
            if (conf > 0 && conf < MIN_CONFIDENCE) {
                logEvent('rec', 'ignored (low conf ' + conf.toFixed(2) + ': "' + input + '")');
                _heardFate('ignored: low confidence');
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
        var afterWake = matchesWake(clean);
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
        _heardFate('ignored: not addressed to Netra');
    }

    function processCommand(text, conf) {
        var lower = (text || '').toLowerCase();
        // something new was said or typed: the failed turn is over
        if (c.lastFailed) { c.lastFailed = false; _applyLiveStatus(); }

        // the mic check on request, since it no longer runs on every load
        if (/^((hey |ok |okay )?netra[,!.\s]*)?(run (a |the )?)?(mic|microphone|voice) (check|test|calibration)( please)?$|^(calibrate|recalibrate)( (the |my )?(mic|microphone))?( please)?$/i.test(lower.replace(/[.!?]+$/, '').trim())) {
            _heardFate('mic check');
            logEvent('lab', 'mic check requested by voice');
            c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
            startCalibration(false, '');
            return;
        }

        // Re-check sleep / wake locally
        if (matchSleep(lower)) {
            _cancelPlanContinue();
            c.alert = false;
            setState('dormant');
            cue('pause');
            speak('Going to sleep. Say "Netra" to bring me back.', function () {
                _labNlpCapture('Going to sleep.', ['local:sleep'], 0);
            });
            return;
        }

        // Local intent shortcut
        var local = matchLocal(text);
        if (local) {
            if (local.forward) {
                logEvent('local', 'correction - running "' + local.forward + '"');
                processCommand(local.forward, conf);
                return;
            }
            logEvent('local', 'intent=' + local.intent);
            _heardFate('answered on the page (' + local.intent + ')');
            if (local.intent === 'pace') local.reply = _stepPace(/faster|quicker|hurry|jaldi/.test(lower));
            if (local.intent === 'quiet') c._hushed = true;
            // R2.10 - intent may carry a server-side _action (e.g. rewind_mem)
            // Drop the last exchange from local geminiHistory (back to before
            // its prompt, tool calls and all) and ping the server to drop the
            // last mem entry.
            if (local._action === 'rewind_mem') {
                var cutAt = _lastPromptIndex(geminiHistory);
                if (cutAt >= 0) {
                    geminiHistory = geminiHistory.slice(0, cutAt);
                    _memPersist();
                    logEvent('local', 'rewound to before your last prompt');
                }
                try {
                    c.data.action = 'rewind_mem';
                    c.server.update();   // fire-and-forget
                } catch (eR) { logEvent('warn', 'rewind_mem server call failed: ' + eR.message); }
            }
            try { _convoPush('you', text); _convoPush('netra', local.reply); } catch (eCv) {}
            if (local.intent !== 'repeat') { c.lastAnswer = String(local.reply || ''); c.lastAnswerAt = Date.now(); }
            setState('speaking');
            speak(local.reply, function () {
                _labNlpCapture(local.reply, ['local:' + local.intent], 0);
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
            _heardFate('asked to repeat (low confidence)');
            speak('Sorry, I did not catch that clearly. Kindly say it once more.', function () {
                setState('idle');
            });
            return;
        }
        // heard, but not well: read it back for a yes rather than run a guess
        if (_heardUnsure(text, conf)) return;

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
            _heardFate('queued behind the current turn');
            _queuedUtterance = transcript;
            // said before the in-flight reply was heard: it can not answer it
            c._lastReplyUnheard = true;
            logEvent('srv', 'queued (chat in flight): "' + transcript + '"');
            tone([620], 0.05);   // soft tick: "got it, one moment"
            return;
        }
        _chatInFlight = true;
        if (transcript !== '[continue plan]') _cancelPlanContinue();
        if (_bargedReply) { logEvent('barge', 'interrupted reply superseded by a new request - not said'); _bargedReply = null; }
        _heardFate('sent to Netra');
        var myEpoch = ++_turnEpoch;
        // a reply released by the hung timer is still on its way: this turn
        // makes it stale, so it will never be heard
        if (_repliesPending > 0) c._lastReplyUnheard = true;
        var mySeq = ++_chatSeq;
        _repliesPending++;
        _cancelReprompt();

        // R28 - the caption shows the question and the status names the step
        // (an automatic turn is not something the user said)
        if (transcript !== '[continue plan]' && c._nextTurnAuto !== transcript) c.lastHeard = transcript;
        c.activity = _activityLabel(transcript, !!(c.data && c.data.is_guest));
        setState('thinking');
        _waitStart();
        logEvent('srv', 'sending: "' + transcript + '"');
        _lastSentText = transcript;
        logEvent('mem', 'carrying ' + c.mem.prompts + ' of your prompts (' + geminiHistory.length + ' turns, ~' + c.mem.kb + 'KB) to the brain');
        _convoPush('you', transcript);   // R7 - chat tab

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;
        // R18 - auto turns (debrief, briefing) must not count as the user's
        // turn, or a read-back waiting for "yes" goes stale underneath them
        c.data.auto = !!c._nextTurnAuto && c._nextTurnAuto === transcript;
        c._nextTurnAuto = false;
        // what Try again sends if this turn fails
        var myAsk = { text: transcript, auto: c.data.auto };
        _sentAsk = myAsk;
        // an auto turn is not the user answering: keep the flag for their next turn
        c.data.drop_unheard = !c.data.auto && !!c._lastReplyUnheard;
        if (!c.data.auto) c._lastReplyUnheard = false;
        // R8.2 - live-stage flag (server strips navigation tools) + prosody
        c.data.live_mode = !!c.liveMode;
        c.data.typed = !!c._typedTurn;   // typed words are never rewritten on the fast lane
        // spoken clock times follow this clock, not the profile's timezone
        try {
            c.data.tz_offset_min = -new Date().getTimezoneOffset();
            c.data.tz_name = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '';
        } catch (eTz) {}
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
        // R21 - only after a real wait: most answers arrive in ~1-2 s, and
        // a filler that has started is one more thing to talk over
        if (_fillerStartTimer) $timeout.cancel(_fillerStartTimer);
        _fillerStartTimer = $timeout(function () {
            _fillerStartTimer = null;
            if (_chatInFlight && myEpoch === _turnEpoch) startFillerChain();
        }, FILLER_DELAY_MS);

        c.server.update().then(
            function () {
                $timeout.cancel(hung);
                if (_fillerStartTimer) { $timeout.cancel(_fillerStartTimer); _fillerStartTimer = null; }
                _chatInFlight = false;
                _repliesPending = Math.max(0, _repliesPending - 1);
                // R6 - a barge-in after this call went out makes the reply
                // stale: keep its history + stats, but never speak it over
                // the user's newer request.
                var stale = (myEpoch !== _turnEpoch);
                // a barge that sent nothing newer (a local reply, noise, a
                // reflex "wait") only interrupted this reply - it is still owed
                var superseded = stale && (mySeq !== _chatSeq || !!_queuedUtterance);
                var planNext = false;
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
                    // R11 - payload got too heavy: the server now asks for a
                    // HALF-trim (newest half survives) instead of a full
                    // wipe. force_history_reset kept for belt-and-braces.
                    if (r.trim_history_half) {
                        geminiHistory = geminiHistory.slice(_promptIndexFrom(geminiHistory, Math.floor(geminiHistory.length / 2)));
                        _memPersist();
                        logEvent('mem', 'memory squeezed: kept the newest ' + geminiHistory.length + ' turns (server said payload too large)');
                    } else if (r.force_history_reset) {
                        logEvent('warn', 'server requested history reset (payload too large)');
                        _memForget('server reset');
                    }
                    // R17 - a plan used its per-transaction write budget and
                    // has steps left: bring the brain back automatically so
                    // long plans span turns without the user re-prompting.
                    // Guarded by stale (barge-in wins) and a soft local cap.
                    // The next hop goes only after this progress was heard,
                    // and any stop, barge, sleep or new request cancels it.
                    if (r.continue_plan && !stale) {
                        c._planHops = (c._planHops || 0) + 1;
                        if (c._planHops <= 6) {
                            logEvent('brain', 'plan continues - resubmitting once this progress is said (hop ' + c._planHops + ')');
                            planNext = true;
                        }
                    } else if (!r.continue_plan) {
                        c._planHops = 0;
                    }
                    // a cancelled reminder must not fire from this page, even when
                    // the reply that confirmed the cancel is never spoken
                    if (r.directives && r.directives.cancel_reminder_ids) {
                        r.directives.cancel_reminder_ids.forEach(function (rid) {
                            if (_localReminderTimers[rid]) { $timeout.cancel(_localReminderTimers[rid]); delete _localReminderTimers[rid]; }
                        });
                    }
                    // R2 - act on client directives from tools
                    // R6 - never act on directives from a barged (stale) turn
                    if (r.directives && !stale) {
                        // R8.2 - reminders schedule locally for to-the-minute
                        // announcements while the tab stays open (the scanner
                        // covers closed-tab delivery at ~5 min granularity).
                        if (r.directives.reminder_at_ms) {
                            _scheduleLocalReminder(r.directives.reminder_at_ms, r.directives.reminder_text, r.directives.reminder_id);
                        }
                        // R8.2 - HARD NAV LOCK on the Live stage: even if a
                        // stale prompt or history slips a directive through,
                        // this page never navigates away.
                        if (c.liveMode && (r.directives.navigate_url || r.directives.open_url || r.directives.click_button_label)) {
                            logEvent('nav', 'live stage - navigation/click directive suppressed');
                            if (r.directives.click_button_label) r.message = String(r.message || '') + ' I can not press buttons from this page, so I pressed nothing.';
                            if (r.directives.open_url) r.message = String(r.message || '') + ' I can not open tabs from this page, so nothing opened.';
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
                        // Tried now, so the reply says what really happened;
                        // when blocked, the fallback link takes focus and the
                        // user is told Enter opens it (a key press is a gesture).
                        if (r.directives.open_url) {
                            logEvent('nav', 'opening: ' + r.directives.open_url);
                            if (!_openTab(r.directives.open_url)) {
                                r.message = String(r.message || '') + ' Your browser blocked the new tab, so nothing opened yet - press Enter to open it.';
                            }
                        }
                        if (r.directives.click_button_label) {
                            // decide now, so the reply says what really happens
                            var btnPick = _pickButton(r.directives.click_button_label);
                            logEvent('click', btnPick.el ? 'pressing: "' + btnPick.name + '"' : btnPick.say);
                            r.message = String(r.message || '') + ' ' + btnPick.say;
                            if (btnPick.el) {
                                $timeout(function () {
                                    try { btnPick.el.click(); } catch (e) { logEvent('err', 'click failed: ' + e.message); }
                                }, 800);
                            }
                        }
                        }   // end live-stage nav lock
                    }
                }
                if (!r) {
                    logEvent('err', 'server returned but no response object');
                    c.stats.errors++;
                    _turnFailed(myAsk);
                    stopFillerChain();
                    speak('Sorry, the server returned an empty response.', function () {
                        _drainQueuedUtterance();   // R6 - don't drop a barged request
                    });
                    return;
                }
                // every reply, failed ones included - a failed turn still spent quota
                if (r.agency) c.agency = r.agency;   // R17 - AGENCY card refresh
                if (r.brain) c.brain = r.brain;      // R18 - BRAIN card refresh
                if (Array.isArray(r.history)) {
                    geminiHistory = r.history;
                    _memPersist();   // R11 - survive refreshes
                    if (r.memory) {
                        logEvent('mem', 'memory: ' + (r.memory.prompts || 0) + '/50 prompts in the live window, ' +
                            c.mem.entries + ' turns, ~' + c.mem.kb + 'KB' +
                            (r.memory.digested ? ', ' + r.memory.digested + ' older prompts folded into the digest' : ''));
                    }
                }
                if (stale) {
                    lastReply = r.message || lastReply;
                    // a reply the user never heard must not be answerable:
                    // tell the server on the next turn so it drops its draft
                    // (a newer turn already sent was told when it went out)
                    c._awaitingConfirm = false;
                    if (mySeq === _chatSeq) c._lastReplyUnheard = true;
                    if (!superseded && c.alert) {
                        logEvent('barge', 'reply arrived after a barge-in that asked nothing new - saying it once the floor is free');
                        _sayBargedReply({ r: r }, 0);
                    } else {
                        logEvent('barge', 'reply arrived after barge-in - kept in history, not spoken');
                    }
                    _drainQueuedUtterance();
                    return;
                }
                // R21 - the brain was busy for this turn: hold the question, show
                // the loading screen, ask again the moment the brain is back
                if (r.brain_down) {
                    stopFillerChain();
                    var again = !!(_gateReasked && [].concat(_gateReasked.texts || _gateReasked.text).indexOf(transcript) >= 0 && Date.now() - _gateReasked.at < 2 * 60000);
                    _gateReasked = null;
                    // a question already asked again once is not held a second
                    // time: the brain passed its ping but not the real question.
                    // R24 - held beside any held before it, never in its place,
                    // and one said meanwhile waits too: it is not sent into a
                    // closed gate
                    if (!again) _gateHold(transcript);
                    if (_queuedUtterance) { _gateHold(_queuedUtterance); _queuedUtterance = null; }
                    if (_gateAskAfter && _gateAskAfter.length) { _gateAskAfter.forEach(function (t) { _gateHold(t); }); _gateAskAfter = []; }
                    if (c.gate) {
                        c.gate.brain = false; c.gate.brainDown = true;
                        c.gate.brainText = again ? 'still too busy - try again in a minute' : 'busy - I will answer as soon as it is back';
                    }
                    logEvent('gate', again ? 'brain still busy after asking again - giving up on "' + String(transcript).substring(0, 60) + '"'
                                           : 'brain busy - holding "' + String(transcript).substring(0, 60) + '"');
                    _gateUpdate();
                    speak(again ? 'Sorry, my reasoning is still too busy to answer that. Please ask me again in a minute.'
                                : (r.message || 'My reasoning is busy right now. I will answer that as soon as it is back.'), function () {
                        if (c.alert) setState('idle');
                        _drainQueuedUtterance();
                    });
                    if (again) {
                        if (_brainProbeTimer) $timeout.cancel(_brainProbeTimer);
                        _brainProbeTimer = $timeout(function () { _brainProbe('retry after a second busy'); }, 30000);
                    } else {
                        _brainProbe('brain busy mid-visit');
                    }
                    return;
                }
                c._awaitingConfirm = !!r.awaiting_confirm;
                c._awaitingConfirmAt = Date.now();
                if (r.ok) {
                    lastReply = r.message || '';
                    c.lastAnswer = String(r.message || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
                    c.lastAnswerAt = Date.now();
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
                        if (planNext && myEpoch === _turnEpoch && !_queuedUtterance) _planContinueLater(myEpoch);
                        _drainQueuedUtterance();
                    });
                } else {
                    logEvent('err', 'server says: ' + (r.message || 'unknown error'));
                    // "repeat" must replay THIS answer, not an older read-back
                    c.lastAnswer = String(r.message || 'Sorry, something went wrong.').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
                    c.lastAnswerAt = Date.now();
                    c.stats.errors++;
                    _turnFailed(myAsk);
                    cue('error');
                    deliverServerReply(r.message || 'Sorry, something went wrong.', function () {
                        if (c.alert) setState('idle');
                        _drainQueuedUtterance();
                    });
                }
            },
            function (err) {
                $timeout.cancel(hung);
                if (_fillerStartTimer) { $timeout.cancel(_fillerStartTimer); _fillerStartTimer = null; }
                _chatInFlight = false;
                _repliesPending = Math.max(0, _repliesPending - 1);
                _labNlpCapture('(transport error)', [], null);
                c.stats.errors++;
                _turnFailed(myAsk);
                cue('error');
                logEvent('err', 'transport error: ' + (err && (err.message || err.status) || err));
                c.lastAnswer = 'Sorry, I could not reach the server.';
                c.lastAnswerAt = Date.now();
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
        // R24 - the loading screen is up: held for when it opens, never sent
        // into a gate that is shut (it would only come back "busy")
        if (c.gate && !c.gate.open && !c.gate.typing) {
            logEvent('gate', 'not ready - holding the queued "' + String(q).substring(0, 60) + '"');
            _gateHold(q);
            return;
        }
        logEvent('srv', 'draining queued utterance: "' + q + '"');
        $timeout(function () {
            handleHeard(q);
            // R24 - the next held question, after this one's answer
            if (!_queuedUtterance && _gateAskAfter && _gateAskAfter.length) _queuedUtterance = _gateAskAfter.shift();
        }, 80);
    }

    // R17 - the next plan hop, a moment after the last one's progress was
    // said. Anything since (a stop, a barge, sleep, a new request) wins.
    function _planContinueLater(epoch) {
        _cancelPlanContinue();
        _planContinueTimer = $timeout(function () {
            _planContinueTimer = null;
            if (epoch !== _turnEpoch || !c.alert || _chatInFlight || _queuedUtterance) {
                logEvent('brain', 'plan not continued - something came up after its progress line');
                return;
            }
            processCommand('[continue plan]', 1.0);
        }, 1200);
    }
    function _cancelPlanContinue() {
        if (!_planContinueTimer) return;
        $timeout.cancel(_planContinueTimer);
        _planContinueTimer = null;
        logEvent('brain', 'plan continue cancelled');
    }
    function _planRunning() { return (c._planHops || 0) > 0; }

    // what the server takes as "no": it declines a parked read-back and
    // stops a running plan
    function _isDecline(t) {
        return /^(netra[,!.\s]*)?(no|nope|no no|no thanks|no stop|stop|stop it|stop the plan|cancel|cancel that|cancel it|don'?t|do not|not now|hold off|leave it|forget it|never ?mind)[.!,?\s]*$/i.test(String(t || '').trim());
    }
    // must the server hear this as "no"? Any stop word while a plan runs; a
    // decline while a read-back waits. Silencing her voice, sleeping, or
    // dropping it as too short left the plan writing and the read-back
    // confirmable by a later "okay".
    function _isNoAnswer(t) {
        var s = String(t || '').trim();
        if (_planRunning()) return _isDecline(s) || HARD_INTERRUPT_RE.test(s);
        return !!c._awaitingConfirm && Date.now() - (c._awaitingConfirmAt || 0) < 10 * 60000 && _isDecline(s);
    }
    // a final the recognizer was unsure of (after the local shortcuts, and
    // never a yes/no - that is the server's answer): read it back once. A yes
    // runs it, a no or a rephrase replaces it - never a guessed record for a
    // half-heard word
    function _heardUnsure(text, conf) {
        var t = String(text || '').trim();
        if (!t || !(conf > 0 && conf < HEARD_ASK_CONF)) return false;
        if (HEARD_YES_RE.test(t) || HEARD_NO_RE.test(t) || _isNoAnswer(t)) return false;
        // a long one is quicker to send: the model asks its one question
        if (t.split(/\s+/).length > 12) return false;
        _heardCheck = { text: t, at: Date.now() };
        logEvent('warn', 'low confidence ' + conf.toFixed(2) + ' - reading "' + t + '" back');
        _heardFate('asked to confirm (low confidence)');
        speak('I heard "' + t + '". Is that right?', function () { setState('idle'); });
        return true;
    }
    // the answer to that read-back: false when nothing waits, or when
    // something else was said - that is the request, said again
    function _heardCheckAnswer(text) {
        var hc = _heardCheck;
        if (!hc) return false;
        _heardCheck = null;
        var t = String(text || '').trim();
        if (Date.now() - hc.at > HEARD_ASK_WINDOW_MS) return false;
        if (HEARD_YES_RE.test(t)) {
            _heardFate('yes - running "' + hc.text + '"');
            logEvent('conv', 'read-back confirmed: "' + hc.text + '"');
            processCommand(hc.text, 1.0);
            return true;
        }
        if (HEARD_NO_RE.test(t)) {
            _heardFate('no - dropped');
            speak('Okay, say it once more.', function () { setState('idle'); });
            return true;
        }
        return false;
    }
    function _answerNo(heard) {
        _cancelPlanContinue();
        logEvent('conv', '"' + heard + '" is a no - telling the server');
        handleHeard('no');
    }

    // R6 - a reply a barge interrupted when nothing newer was asked (a local
    // reply, noise, a reflex "wait"): said once the user is done and she is
    // free, so a write is never done unannounced. An interrupted plan hop is
    // stopped instead, and the server says how far it got. A new request
    // drops it (handleHeard).
    function _sayBargedReply(p, tries) {
        _bargedReply = p;
        $timeout(function () {
            if (_bargedReply !== p) return;
            if (!c.alert) { _bargedReply = null; return; }
            var userTalking = _finalBuffer.length > 0 || !!_finalTimer || (_lastInterimAt > 0 && Date.now() - _lastInterimAt < 1500);
            if (userTalking || _speakingNow || _chatInFlight || c.state === 'speaking' || c.state === 'thinking') {
                if (tries < 40) _sayBargedReply(p, tries + 1);
                else { _bargedReply = null; logEvent('barge', 'interrupted reply dropped - the floor never came free'); }
                return;
            }
            _bargedReply = null;
            var r = p.r;
            if (r.continue_plan) { _answerNo('(plan interrupted)'); return; }
            var text = String(r.message || (r.ok ? '' : 'Sorry, something went wrong.'));
            if (!text) return;
            if (r.directives && (r.directives.navigate_url || r.directives.open_url || r.directives.click_button_label)) {
                text += ' I did not open or press anything, because you spoke over me.';
            }
            // heard now, so it can be answered
            c._lastReplyUnheard = false;
            c._awaitingConfirm = !!r.awaiting_confirm;
            c._awaitingConfirmAt = Date.now();
            c.lastAnswer = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
            c.lastAnswerAt = Date.now();
            _convoPush('netra', text);
            setState('speaking');
            speak('About your earlier request: ' + text, function () {
                if (c.alert) setState('idle');
                _armReprompt(text);
            });
        }, 700);
    }

    // R2.4 - a new tab, tried at once so the reply can say whether it opened.
    // No "noopener" in the features: with it window.open always returns
    // null, so a blocked tab and an opened one looked the same.
    function _openTab(url) {
        var win = null;
        try { win = $window.open(url, '_blank'); }
        catch (e) { logEvent('err', 'window.open threw: ' + e.message); }
        if (win) {
            try { win.opener = null; } catch (eO) {}
            return true;
        }
        c.pendingOpenUrl = url;
        logEvent('warn', 'popup blocked - the link takes focus, Enter opens it');
        $scope.$applyAsync();
        $timeout(function () {
            try { var a = document.querySelector('.netra-card-link'); if (a) a.focus(); } catch (eF) {}
        }, 60);
        return false;
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
    var _repliesPending = 0;       // chats sent whose reply has not landed (the hung timer releases the turn early)
    var _chatSeq        = 0;       // bumped per chat sent
    var _queuedUtterance = null;   // barge-in that arrived while a chat was in flight
    var _bargedReply    = null;    // a reply a barge interrupted, said once the floor is free
    var _planContinueTimer = null; // the pending [continue plan] resubmit
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
    // the same reflex with something after it
    var LEADING_STOP_RE = /^((hey|ok|okay) )?(netra[,!.\s]*)?(stop|wait|hold on|hang on|shut up|be quiet|quiet|silence|pause|enough|ruko|chup|bas)\b[.!,?\s]*(.*)$/i;
    var BARGE_ASK_CONF = 0.66;   // a barge-in below this is asked again, not sent as a command
    var HEARD_ASK_CONF = 0.55;   // a final below this is read back for a yes before it runs
    var HEARD_ASK_WINDOW_MS = 20000;   // how long that yes may take
    var HEARD_YES_RE = /^(netra[,!.\s]*)?(yes|yeah|yep|yup|ya|haan|correct|right|that'?s right|yes it is|yes that'?s right|ok|okay|sure)[.!,?\s]*$/i;
    var HEARD_NO_RE = /^(netra[,!.\s]*)?(no|nope|no no|nah|nahi|wrong|that'?s wrong|not right|no it'?s not|not that)[.!,?\s]*$/i;
    var _heardCheck = null;   // { text, at } while 'I heard "...". Is that right?' waits
    // a word after "stop" that continues a command ("stop watching", "pause the
    // mission", "wait for the approval"): the whole utterance is the command
    var STOP_TAIL_COMMAND_RE = /^(watching|tracking|following|chasing|nudging|escalating|monitoring|notifications?|alerts?|reminders?|missions?|orders?|plans?|scanner|tasks?|the|my|all|everything|standing|for|until|till|on|at|in|with|to|before|after|while|about|when|if|unless|because|so|but)$/i;
    // What the words after a "stop" mean: '' is just a stop; 'whole' means the
    // whole utterance is the command ("stop watching INC0010013"); anything
    // else is the command that follows the stop ("stop, list my tickets").
    // noiseOk: she was just cut off, so a short unrecognised tail is what the
    // mic caught of her own voice ("stop a way")
    function _afterStop(tail, noiseOk) {
        var t = String(tail || '').trim().replace(/^(and|then|now)\s+/i, '');
        var words = t.split(/\s+/).filter(Boolean);
        if (!words.length || /^(it|that|this|please|now|talking|speaking|reading|netra)( please)?$/i.test(t)) return '';
        if (matchLocal(t)) return t;
        if (STOP_TAIL_COMMAND_RE.test(words[0]) || /\b(inc|req|ritm|chg|prb|kb|sctask|incident|request|change|problem|ticket|task)\s*\d{3,}\b/i.test(normalizeNumbers(t))) return 'whole';
        if (words.length >= 3) return t;
        return noiseOk ? '' : 'whole';
    }

    function _normTokens(s) {
        return String(s || '').toLowerCase()
            .replace(/[^a-z0-9\s']/g, ' ')
            .split(/\s+/)
            .filter(function (w) { return w.length > 1; });
    }

    // Score a heard final against what Netra is currently saying (plus the
    // last filler line). High overlap means the mic picked up her own voice.
    function _looksLikeEcho(heard, extra) {
        var heardToks = _normTokens(heard);
        if (!heardToks.length) return true;   // nothing substantive
        var own = {};
        _normTokens(_speakingText).forEach(function (w) { own[w] = 1; });
        _normTokens(_fillerEchoText).forEach(function (w) { own[w] = 1; });
        (extra || []).forEach(function (s) { _normTokens(s).forEach(function (w) { own[w] = 1; }); });
        var hits = 0;
        for (var i = 0; i < heardToks.length; i++) if (own[heardToks[i]]) hits++;
        var ratio = hits / heardToks.length;
        // 1-2 word fragments that all appear in her sentence are echo
        if (heardToks.length <= 2 && ratio >= 0.99) return true;
        return ratio >= ECHO_OVERLAP_RATIO;
    }

    // With speakers, the recognizer hears her too: a final can be HER last
    // words followed by the user's ("...your tickets what is the status of
    // ten thirteen"). Strip her words from the edges; keep what the user said.
    // words the user could be commanding with: a leading run is never hers
    // when it starts with one of these ("read the newest three tickets to me")
    var USER_LEAD_RE = /^(read|open|show|list|tell|give|find|search|create|raise|close|resolve|assign|add|set|update|change|what|who|how|when|where|which|why|is|are|can|could|do|does|did|yes|no|netra|please|stop|wait|pause)$/;
    function _stripEchoEdges(heard, extra) {
        var hers = _normTokens(_speakingText).concat(_normTokens(_fillerEchoText));
        (extra || []).forEach(function (s) { hers = hers.concat(_normTokens(s)); });
        if (!hers.length) return heard;
        var hersStr = ' ' + hers.join(' ') + ' ';
        var words = String(heard || '').trim().split(/\s+/).filter(Boolean);
        if (words.length < 3) return heard;
        var tok = words.map(function (w) { return w.toLowerCase().replace(/[^a-z0-9']/g, ''); });
        // a run is hers when its real words (one-letter words ride along)
        // appear in her line in that order, at least two of them: a single
        // shared "open" or "the" is no evidence of echo
        var isHers = function (from, to) {
            var run = [];
            for (var i = from; i < to; i++) if (tok[i].length > 1) run.push(tok[i]);
            return run.length >= 2 && hersStr.indexOf(' ' + run.join(' ') + ' ') >= 0;
        };
        var a = 0, b = words.length;
        if (!USER_LEAD_RE.test(tok[0])) {
            for (var i = words.length - 2; i >= 2; i--) if (isHers(0, i)) { a = i; break; }
        }
        for (var j = a + 2; j <= words.length - 2; j++) if (isHers(j, words.length)) { b = j; break; }
        if (a === 0 && b === words.length) return heard;
        var rest = words.slice(a, b);
        // too little left to be a command: judge the whole utterance instead
        if (rest.length < 2 || rest.join(' ').length < BARGE_MIN_CHARS) return heard;
        return rest.join(' ');
    }
    var _lastBargeText = '';

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

    // Silence the playing element, handlers detached first: pause() and
    // src='' fire async error / play()-rejection events, which are the
    // engines' fallback-respeak paths.
    function _silenceCurrentAudio() {
        if (!currentAudio) return;
        try {
            currentAudio.onended = currentAudio.onerror = currentAudio.onplaying = null;
            currentAudio.pause();
            currentAudio.src = '';
        } catch (e) {}
        try { detachOutputAnalyser(currentAudio); } catch (e) {}
        currentAudio = null;
    }

    // Universal silencer - every engine, every filler, the pipeline queue.
    var _bargeStoppedAt = 0;   // when the user's voice last cut her off
    function stopSpeaking(reason) {
        if (/barge|reflex|unsure/i.test(String(reason || ''))) _bargeStoppedAt = Date.now();
        _speakSessionId++;                      // aborts pipelined sentence queue
        _turnEpoch++;                           // any in-flight reply is now stale
        // a cut-off calibration prompt never reaches its tone (edge-live
        // drops the done-callback): end the check, do not leave it stuck
        if (_calibActive && c.labCalib && c.labCalib.stage === 'prompt') {
            _calibActive = false;
            _calibSession++;
            c.labCalib.stage = 'skipped';
            _calibFocus();
        }
        _cancelPlanContinue();                  // and no plan hop goes out behind it
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
            // one sound per event: the blip, not the blip and the your-turn chime
            _quietOpen = true;
            try { setState(c.alert ? 'idle' : 'dormant'); } finally { _quietOpen = false; }
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
        // talking does not interrupt her (Settings): dropped like her own echo;
        // tap, Escape and End still stop her
        if (!_voiceBargeOn()) {
            _heardLog(trimmed, conf, 'dropped: talking does not interrupt (switched off)');
            return true;
        }
        if (_looksLikeEcho(trimmed)) {
            logEvent('rec.echo', '"' + trimmed + '" (my own voice, overlap-matched)');
            _heardLog(trimmed, conf, 'dropped: my own voice');
            _restoreDuck();
            return true;
        }
        // "no" / "stop" to a running plan or a waiting read-back: she stops
        // AND the server hears it, even when it is one short word
        if (_isNoAnswer(trimmed)) {
            stopSpeaking('answer "' + trimmed + '"');
            _dropFinalBuffer('answered no');
            _answerNo(trimmed);
            return true;
        }
        if (HARD_INTERRUPT_RE.test(trimmed)) {
            stopSpeaking('reflex "' + trimmed + '"');
            _dropFinalBuffer('reflex interrupt');
            return true;
        }
        // "stop" with a tail the mic caught from the speakers ("stop a
        // way"): the stop is the command, a short tail is noise, a longer
        // one ("stop, what time is it") is the next command
        var lead = matchLocal(trimmed) ? null : trimmed.match(LEADING_STOP_RE);
        if (lead) {
            stopSpeaking('reflex "' + trimmed + '"');
            var after = _afterStop(lead[lead.length - 1], true);
            if (after === '') {
                logEvent('rec.echo', '"' + trimmed + '" - stopped; the tail is noise from my own voice');
                _heardLog(trimmed, conf, 'stop - yielded');
                _dropFinalBuffer('reflex interrupt');
                return true;
            }
            // "stop, list my tickets" runs the command after the stop;
            // "stop watching INC0010013" is the whole command
            _lastBargeText = after === 'whole' ? '' : after;
            return false;
        }
        var stripped = _stripEchoEdges(trimmed);
        if (stripped !== trimmed) {
            logEvent('rec.echo', 'my own words stripped: "' + trimmed + '" -> "' + stripped + '"');
            trimmed = stripped;
        }
        var words = trimmed.split(/\s+/).length;
        if (trimmed.length < BARGE_MIN_CHARS || words < 2 || (conf > 0 && conf < BARGE_MIN_CONF)) {
            logEvent('rec.echo', '"' + trimmed + '" (too weak to barge: conf=' + (conf || 0).toFixed(2) + ')');
            _heardLog(trimmed, conf, 'dropped: too weak to interrupt');
            return true;
        }
        // Speech over her own voice comes through garbled ("health and
        // cute" for "Netra stop"): a barge-in the recognizer is unsure of
        // stops her - the user clearly spoke - but is asked again rather
        // than sent to the model as a command
        if (conf > 0 && conf < BARGE_ASK_CONF && !matchLocal(trimmed.toLowerCase())) {
            stopSpeaking('unsure barge-in "' + trimmed + '"');
            _dropFinalBuffer('unsure barge-in');
            _heardLog(trimmed, conf, 'asked to repeat (spoken over my voice, low confidence)');
            logEvent('rec', 'barge-in "' + trimmed + '" conf=' + conf.toFixed(2) + ' - asking again rather than guessing');
            $timeout(function () { speak('Sorry, say that again?', function () { setState('idle'); }); }, 250);
            return true;
        }
        // Genuine barge-in: yield the floor, let the utterance flow on
        // into the normal pipeline as the next command.
        _lastBargeText = trimmed !== String(t || '').trim() ? trimmed : '';
        stopSpeaking('user barge-in');
        return false;
    }

    /* ---- Netra-side interjections ---------------------------------- */
    var BACKCHANNEL_PHRASES = ['Mm-hmm.', 'Right.', 'Okay...', 'Hmm.', 'Got it.'];
    var backchannelCache = [];   // [{url, text}]
    function preloadBackchannels() {
        if (typeof WebSocket === 'undefined') return;
        if ((c.ttsEngine || 'browser') !== 'edge' || !_edgeVoiceAvailable()) return;   // R21 - same voice as the replies or none
        if (_edgeCircuitOpen()) return;
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
        return;   // R20 - no "still here" nudges: silence after a question is the user's to keep
        // eslint-disable-next-line no-unreachable
        if (!/\?\s*$/.test(String(replyText || '').trim())) return;
        _repromptArmed = true;
        _repromptTimer = $timeout(function () {
            if (!_repromptArmed || !c.alert || c._hushed) return;
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
    // the stage caption: her words while she speaks - and when no voice plays
    // (captions only) until the next thing heard or said - the user's otherwise
    c.captionKeep = false;
    c.captionWho = function () { return _captionWho(); };
    c.captionText = function () { return _captionText(); };
    function _captionWho() {
        // while she works on it, the question - not the line she said before
        if (c.state === 'thinking' && c.lastHeard) return 'you';
        if (c.spoken && (c.state === 'speaking' || (c.captionKeep && !c.interim))) return 'netra';
        if (c.state !== 'speaking' && (c.interim || c.lastHeard)) return 'you';
        return '';
    }
    function _captionText() {
        var who = _captionWho();
        if (who === 'netra') return c.spoken || '';
        if (who === 'you') return String(c.interim || c.lastHeard || '').replace(/^\(on-device\)\s*/, '');
        return '';
    }
    // R28 - no voice will play this line: her words stay on screen, and a
    // screen reader gets the whole line once (with a voice it never does)
    var _keptSaid = '';
    function _keepCaption() {
        if (c.captionKeep && _keptSaid === c.spoken) return;
        c.captionKeep = true;
        _keptSaid = c.spoken;
        _announce(c.spoken, 'reply');
    }
    function _captionsOnly() { return !!(c.labMute || c.captionKeep || !c.hasTTS); }
    function speak(text, done) {
        if (_ctrlDestroyed) return;   // a reply landing after navigation stays silent
        if (!text) {
            // Even with no text, fire callback + reset state to keep the
            // state machine consistent.
            _afterTTS(done);
            return;
        }
        // R18 - "repeat" and the did-she-just-ask-a-question check both read
        // this; nothing ever set it, so repeat always said "I have not said
        // anything yet"
        c.lastSpoken = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
        // her voice takes the floor: a state not yet announced is not read over it
        _hushState();
        // R9 - Lab mute: captions still update, no audio (used for NLP
        // dry-runs and quiet dev sessions).
        if (c.labMute) {
            c.spoken = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`#>]/g, '').trim();
            c.captionKeep = false;
            _keepCaption();   // no voice: her words stay on screen
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
        c.captionKeep = false;   // set again below if no voice plays this line
        $scope.$applyAsync();

        // R6 - register what she is about to say for the echo-scorer and
        // clear any pending question-nudge (she is taking the floor).
        _markSpeaking(c.spoken);
        _cancelReprompt();
        // an earlier line still synthesizing must never play over this one
        _speakSessionId++;

        // R1: wrap the done callback so state ALWAYS resets to idle/dormant
        // after TTS finishes - prevents "stuck in speaking" bug.
        var wrappedDone = function () { _afterTTS(done); };

        // R2.8 - engine selection. 'gemini' uses Gemini-native TTS
        // (same key as chat, costs a Gemini-quota credit per turn,
        // sounds most like Gemini chat). Otherwise fall through to
        // Edge / StreamElements / browser as before.
        var engine = c.ttsEngine || (c.useRemoteTTS ? 'edge' : 'browser');
        if (engine === 'edge' && !_edgeVoiceAvailable()) {
            if (!_edgeUnavailableSaid) {
                _edgeUnavailableSaid = true;
                logEvent('tts', 'the Microsoft neural voice is only served to Microsoft Edge - using the browser voice ' + (c.voiceName || '') + '. Open Netra in Edge for the neural voice, or pick the Gemini engine.');
            }
            engine = 'browser';
        }
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
        if (_edgeCircuitOpen() || typeof WebSocket === 'undefined') {
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
                _silenceCurrentAudio();
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
        if (_edgeCircuitOpen()) return speakStreamElements(text, done);
        if (typeof WebSocket === 'undefined') return speakStreamElements(text, done);
        if (_edgeLiveBroken || typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported('audio/mpeg')) {
            return (text.length > 220 ? speakEdgePipelined(text, done) : speakEdgeTTS(text, done));
        }
        var session = ++_speakSessionId;
        var settled = false, audioStarted = false, playRequested = false;
        var gotAnyAudio = false, wsEnded = false, wsOpened = false, refused = false;
        var myVer = _edgeVersion();
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
        // mse: the fault is in streamed playback here (bytes reached the
        // MediaSource and it still failed) - only that switches the session
        // to the buffered neural voice; a socket that opened and then died
        // is a blip, retried buffered for this reply only
        function bail(reason, mse) {
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
            if (mse) {
                _edgeLiveBroken = true;
                logEvent('warn', 'edge-live: ' + reason + ' - streamed playback is off for this session, using the buffered neural voice');
                return (text.length > 220 ? speakEdgePipelined(text, done) : speakEdgeTTS(text, done));
            }
            if (wsOpened || gotAnyAudio) {
                logEvent('warn', 'edge-live: ' + reason + ' - saying this one through the buffered neural voice');
                return (text.length > 220 ? speakEdgePipelined(text, done) : speakEdgeTTS(text, done));
            }
            logEvent('warn', 'edge-live: ' + reason + (refused ? ' (handshake refused)' : '') + ' - falling back');
            _edgeFallback(text, done, myVer, refused);
        }
        var watchdog = $timeout(function () { if (!audioStarted) bail('no audio in 6s', gotAnyAudio); }, 6000);

        function pump() {
            if (settled || !sb) return;
            if (!sb.updating && pendingChunks.length) {
                var chunk = pendingChunks.shift();
                try { sb.appendBuffer(chunk); } catch (e) { bail('appendBuffer: ' + (e.message || e), true); }
                return;
            }
            if (wsEnded && !sb.updating && !pendingChunks.length && msrc.readyState === 'open') {
                try { msrc.endOfStream(); } catch (e) {}
            }
        }
        function requestPlay() {
            if (playRequested || settled) return;
            playRequested = true;
            audio.play().catch(function (e) { bail('play() rejected: ' + (e && e.message || e), !(e && e.name === 'NotAllowedError')); });
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
                try { sb = msrc.addSourceBuffer('audio/mpeg'); } catch (e) { return bail('addSourceBuffer: ' + (e.message || e), true); }
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
                _edgeVersionWorked(myVer);
                logEvent('tts', 'edge-live playing: ' + c.edgeVoice + ' (streamed, ' + text.length + ' chars)');
            };
            audio.onended = finish;
            audio.onerror = function () {
                if (audioStarted) finish();   // mid-play glitch: never respeak
                else bail('audio element error ' + (audio.error ? audio.error.code + ' ' + String(audio.error.message || '').substring(0, 80) : '') + ' (chunks ' + pendingChunks.length + ', source ' + msrc.readyState + ')', true);
            };

            _edgeWssUrl(function (wssUrl, requestId) {
            if (settled) return;
            try { ws = new WebSocket(wssUrl); }
            catch (eW) { return bail('ws ctor: ' + (eW.message || eW)); }
            _edgeLiveWs = ws;
            ws.binaryType = 'arraybuffer';
            ws.onopen = function () {
                if (settled) return;
                wsOpened = true;
                _edgeVersionOpened(myVer);
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
                if (!wsOpened) refused = true;
                if (!audioStarted) bail('ws error');
                else { wsEnded = true; pump(); }
            };
            ws.onclose = function () {
                if (!wsOpened) refused = true;
                // closed before any audio: say so now, not after the 6s watchdog
                if (!gotAnyAudio && !settled) return bail('closed before audio');
                wsEnded = true; pump();
            };
            });   // _edgeWssUrl
        } catch (e) {
            bail('threw: ' + (e.message || e));
        }
    }

    // SSML-aware variant of _edgeBlob: same WSS transport, but runs the
    // text through _buildHumanSSML so pipelined segments keep the stress /
    // breath / hesitation prosody of the single-shot path.
    function _edgeSsmlBlob(text, voice, cb0, retried) {
        var myVer = _edgeVersion(), opened = false, timedOut = false;
        var cb = function (blob) {
            if (blob) { _edgeVersionWorked(myVer); return cb0(blob); }
            if (!retried && !opened && !timedOut && _edgeVersionRotate(myVer)) return _edgeSsmlBlob(text, voice, cb0, true);
            cb0(null);
        };
        _edgeWssUrl(function (wssUrl, requestId) {
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var settled = false;
            var watchdog = $timeout(function () {
                if (!settled) { settled = true; timedOut = true; try { ws.close(); } catch (e) {} cb(null); }
            }, 6000);
            ws.onopen = function () {
                opened = true;
                _edgeVersionOpened(myVer);
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
        // The read-aloud service only serves <voice> with one <prosody>
        // (rate / pitch / volume) round plain text: a <break>, an
        // <emphasis> or a nested <prosody> closes the socket with
        // "SSML is invalid" (1007) - checked live 2026-09-24 - and every
        // reply used to carry them, which is why the neural voice was
        // never heard and the browser's default voice spoke instead. The
        // pauses now live in the punctuation the voice already honours:
        // sentence ends, commas, dashes and "..." (a real thinking pause).
        // Input is capped: the service limits SSML to a few KB.
        var t = String(text || '').substring(0, 6000);
        // markdown emphasis markers are for the eye: drop them
        t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*`_#]+/g, ' ');
        // an ellipsis is the pause; longer runs are not longer pauses
        t = t.replace(/\.{3,}/g, '...');
        // a dash between words reads as a short pause
        t = t.replace(/\s+(--|—)\s+/g, ' - ');
        // XML escape
        t = t.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&apos;');
        t = t.replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
        // pace from the user-tunable c.speechRate, rendered by the vocoder
        var ratePct = Math.round(((c.speechRate || 1.06) - 1) * 100);
        var rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
        return '<speak version=\'1.0\' xml:lang=\'en-US\'>' +
               '<voice name=\'' + voice + '\'>' +
               '<prosody rate=\'' + rateStr + '\' pitch=\'+0Hz\'>' + t + '</prosody>' +
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

    // Once routed through a graph an element is heard ONLY through it, so
    // TTS must never ride the mic's context (stopMicLevelMeter closes that on
    // every device change / recycle, silencing the rest of the sentence). The
    // cue context lives as long as the page; while it is not running the
    // element plays directly and only the visualiser sits this one out.
    function _outputCtx() {
        unlockAudio();
        if (!audioCtx || audioCtx.state === 'closed') return null;
        if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch (e) {} return null; }
        return audioCtx;
    }

    function attachOutputAnalyser(audioEl) {
        if (!audioEl || !window.AudioContext) return;
        try {
            var analyser;
            if (audioEl.__netraSrc) {
                analyser = audioEl.__netraSrc.netraAnalyser;
            } else {
                var ctx = _outputCtx();
                if (!ctx) return;
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
        if (c.hasSR && !c.recRunning && !c.micOff && c.permission !== 'denied') {
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
    c.edgeVoice = 'en-GB-SoniaNeural';   // v7.9 - Sonia (British English) is Netra's voice by default
    var EDGE_VOICES = [
        'en-GB-SoniaNeural',             // Netra's voice (default)
        'en-US-AvaMultilingualNeural',   // newest gen, most human
        'en-US-EmmaMultilingualNeural',  // newest gen, brighter
        'en-US-AndrewMultilingualNeural',// newest gen, male
        'en-US-BrianMultilingualNeural', // newest gen, male casual
        'en-US-JennyNeural', 'en-US-AriaNeural',
        'en-IN-NeerjaNeural', 'en-IN-AashiNeural', 'en-IN-AnanyaNeural',
        'hi-IN-SwaraNeural'
    ];
    c.edgeVoices = EDGE_VOICES;   // R13 - the setup panel lists them too
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
    // Microsoft refuses a client version it considers too old (a 403 at the
    // handshake, which the browser only shows as a socket error) - and that
    // is how the neural voice silently became the robotic browser voice.
    // The version is a list, newest first, plus this browser's own build; a
    // failed synthesis moves to the next one before any fallback voice.
    var EDGE_GEC_VERSIONS = ['1-143.0.3650.75', '1-140.0.3485.14', '1-130.0.2849.68'];
    var _edgeUnavailableSaid = false;
    var _edgeVerIdx = -1, _edgeVerTried = 0;
    try {
        if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
            navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then(function (ua) {
                var list = (ua && ua.fullVersionList) || [];
                for (var i = 0; i < list.length; i++) {
                    if (/^(Chromium|Microsoft Edge|Google Chrome)$/.test(String(list[i].brand)) && /^\d+\.\d+\.\d+\.\d+$/.test(String(list[i].version))) {
                        // last, not first: Microsoft refused a plain Chromium build
                        // number where the known Edge builds passed
                        var v = '1-' + list[i].version;
                        if (EDGE_GEC_VERSIONS.indexOf(v) < 0) EDGE_GEC_VERSIONS.push(v);
                        break;
                    }
                }
            }, function () {});
        }
    } catch (eUA) {}
    // Microsoft's read-aloud service now refuses the handshake from any
    // browser whose user agent is not Edge (checked: every Chrome UA gets
    // 403 whatever version it sends). A browser can not change that
    // header for a socket, so in Chrome the neural voice is simply not on
    // offer - use the best voice the browser has, and say so once.
    var _edgeBrowser = /\bEdg(e|A|iOS)?\//.test(navigator.userAgent || '');
    function _edgeVoiceAvailable() { return _edgeBrowser && typeof WebSocket !== 'undefined'; }
    function _edgeVersion() {
        if (_edgeVerIdx < 0) {
            _edgeVerIdx = 0;
            try {
                var saved = _store ? String(_store.getItem('netra_edgeVer') || '') : '';
                if (saved && EDGE_GEC_VERSIONS.indexOf(saved) >= 0) _edgeVerIdx = EDGE_GEC_VERSIONS.indexOf(saved);
            } catch (e) {}
        }
        return EDGE_GEC_VERSIONS[Math.min(_edgeVerIdx, EDGE_GEC_VERSIONS.length - 1)];
    }
    var _edgeVerOpenedAt = 0, _edgeVerOpenedVer = '';   // when, and on which version, a socket last opened
    function _edgeVersionOpened(v) { _edgeVerOpenedAt = Date.now(); _edgeVerOpenedVer = v || _edgeVersion(); }
    // a request that played proves ITS version (a lane that opened on one
    // version must not bless the version a parallel lane rotated to)
    function _edgeVersionWorked(v) {
        _edgeVerTried = 0;
        var i = v ? EDGE_GEC_VERSIONS.indexOf(v) : -1;
        if (i >= 0) _edgeVerIdx = i;
        try { if (_store) _store.setItem('netra_edgeVer', _edgeVersion()); } catch (e) {}
    }
    // start again from the best-known version (the saved one, else the newest)
    function _edgeVersionReseed() {
        _edgeVerTried = 0;
        _edgeVerIdx = -1;
        _gecCache = { win: 0, val: '' };
        return _edgeVersion();
    }
    // failedVer: the version the failed request used - parallel failures of
    // the same version rotate once, not once each
    function _edgeVersionRotate(failedVer) {
        if (failedVer && failedVer !== _edgeVersion()) return true;   // already moved on; retry on the new one
        if (_edgeVerOpenedVer === _edgeVersion() && _edgeVerOpenedAt && Date.now() - _edgeVerOpenedAt < 120000) return false;   // this version works: a passing refusal
        if (_edgeVerTried >= EDGE_GEC_VERSIONS.length - 1) {
            // every version refused in a row is an outage, not a retired
            // version: this line still falls back, but the next attempt
            // starts from the best-known version, never stuck on the oldest
            logEvent('tts', 'edge refused every client version - probably no network; the next attempt starts from ' + _edgeVersionReseed());
            return false;
        }
        _edgeVerTried++;
        _edgeVerIdx = (Math.max(0, _edgeVerIdx) + 1) % EDGE_GEC_VERSIONS.length;
        _gecCache = { win: 0, val: '' };
        logEvent('tts', 'edge refused the handshake - trying client version ' + _edgeVersion());
        return true;
    }
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
                (gec ? '&Sec-MS-GEC=' + gec + '&Sec-MS-GEC-Version=' + _edgeVersion() : '') +
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
        var session = _speakSessionId;   // a stop or a newer line makes this one stale
        var resolved = false;
        var watchdog = $timeout(function () {
            if (!resolved) { resolved = true;
                if (session !== _speakSessionId) return;
                logEvent('warn', 'gemini-tts no response in 12s - fallback edge');
                speakEdgeTTS(text, done);
            }
        }, 12000);
        c.server.update().then(function () {
            if (resolved) return;
            $timeout.cancel(watchdog);
            if (session !== _speakSessionId) { resolved = true; return; }
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
                _silenceCurrentAudio();
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
                    if (session !== _speakSessionId) return;
                    logEvent('warn', 'gemini audio playback error - fallback edge');
                    speakEdgeTTS(text, done);
                };
                audio.play().catch(function (e) {
                    if (resolved) return;
                    resolved = true;
                    if (session !== _speakSessionId) return;   // paused by a stop: stay silent
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
            if (session !== _speakSessionId) return;
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
    var NETRA_BUILD = 'v7.6-ios';   // bumped: reopens Edge TTS for everyone whose breaker tripped on an old build
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

    var _edgeLiveBroken = false;   // streamed (MediaSource) playback failed once this session: use blobs
    function _edgeFallback(text, done, failedVer, handshakeRefused) {
        // before giving up the neural voice, try the next client version -
        // but only when the service refused the handshake, never for a
        // playback problem on this side
        if (handshakeRefused && _edgeVersionRotate(failedVer)) return speakEdgeLive(text, done);
        _edgeFails++;
        _ssSet('netra_edgeFails', _edgeFails);
        _ssSet('netra_edgeFailsAt', Date.now());   // R13 - lets the breaker half-open later
        if (_edgeFails === REMOTE_FAIL_LIMIT) {
            logEvent('tts', 'edge circuit open - will retry once after 10 quiet minutes');
        }
        speakStreamElements(text, done);
    }
    // R13 - HALF-OPEN breaker (the old one latched FOREVER: two flaky
    // seconds of wifi and every future session was stuck on the fallback
    // voice, which is why picking a voice "did nothing"). After 10 minutes
    // the circuit lets ONE fresh edge attempt through; success resets it,
    // failure re-latches for another 10.
    function _edgeCircuitOpen() {
        if (!_edgeVoiceAvailable()) return true;
        if (_edgeFails < REMOTE_FAIL_LIMIT) return false;
        var trippedAt = _ssGet('netra_edgeFailsAt', 0);
        if (!trippedAt || Date.now() - trippedAt > 600000) {
            _edgeFails = REMOTE_FAIL_LIMIT - 1;
            _ssSet('netra_edgeFails', _edgeFails);
            _edgeVersionReseed();
            _edgeLiveBroken = false;
            logEvent('tts', 'edge circuit half-open - giving edge one fresh shot');
            return false;
        }
        return true;
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
        // R3.5.2 - skip if circuit is open (R13: half-opens after 10 min)
        if (_edgeCircuitOpen()) {
            return speakStreamElements(text, done);
        }
        // Some networks/CSPs forbid arbitrary WSS - fall back fast if blocked.
        if (typeof WebSocket === 'undefined') {
            return speakStreamElements(text, done);
        }
        // a stop or a newer line makes this one stale: it must neither play
        // when its audio arrives nor respeak through a fallback
        var session = _speakSessionId;
        _edgeWssUrl(function (wssUrl, requestId) {
        if (session !== _speakSessionId) return;
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var resolved = false, opened = false, myVer = _edgeVersion();
            var watchdog = $timeout(function () {
                if (!resolved) { resolved = true; try { ws.close(); } catch (e) {}
                    if (session !== _speakSessionId) return;
                    logEvent('warn', 'edge TTS no audio in 6s - fallback');
                    _edgeFallback(text, done, myVer, false);
                }
            }, 6000);

            ws.onopen = function () {
                opened = true;
                _edgeVersionOpened(myVer);
                if (session !== _speakSessionId) { resolved = true; $timeout.cancel(watchdog); try { ws.close(); } catch (e) {} return; }
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
                        // the socket's job is done: its close event is no failure
                        ws.onclose = ws.onerror = null;
                        try { ws.close(); } catch (e) {}
                        if (resolved) return;
                        if (session !== _speakSessionId) { resolved = true; $timeout.cancel(watchdog); return; }
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
                        _silenceCurrentAudio();
                        currentAudio = audio;
                        // R2.9.1 - attach BEFORE play() so MediaElementSource binds in time
                        attachOutputAnalyser(audio);
                        audio.onplaying = function () {
                            if (resolved) return;
                            $timeout.cancel(watchdog);
                            _edgeFails = 0;
                            _ssSet('netra_edgeFails', 0);   // R4.2 - clear persisted breaker on recovery
                            _edgeVersionWorked(myVer);
                            logEvent('tts', 'edge playing: ' + c.edgeVoice + ' (buffered, ' + text.length + ' chars)');
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
                            if (session !== _speakSessionId) return;
                            logEvent('warn', 'edge audio playback error - fallback');
                            _edgeFallback(text, done);
                        };
                        audio.play().catch(function (e) {
                            if (resolved) return;
                            resolved = true;
                            if (session !== _speakSessionId) return;   // paused by a stop: stay silent
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
                if (session !== _speakSessionId) return;
                logEvent('warn', 'edge ws error' + (opened ? '' : ' (handshake refused)') + ' - fallback');
                _edgeFallback(text, done, myVer, !opened);
            };

            ws.onclose = function () {
                if (!resolved) {
                    resolved = true;
                    $timeout.cancel(watchdog);
                    if (session !== _speakSessionId) return;
                    logEvent('warn', 'edge ws closed early' + (opened ? '' : ' (handshake refused)') + ' - fallback');
                    _edgeFallback(text, done, myVer, !opened);
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
        'Give me a moment.',
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
        'Alright, looking that up now.',
        'Just checking the records, one moment.',
        // LONG (~3s)
        'Give me a moment, I am pulling that information from the system now.',
        'Bear with me for a second, I am just looking into the details.',
        'One moment please, I am checking that on my end for you.',
        'Hold on, I am fetching the latest information for you right now.',
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
    var VR_FILLER_RE = /vulnerability|risk data|exposure numbers|security backlog/i;
    var _lastSentText = '';
    var lastFillerPlayedAt = 0;
    var currentFillerAudio = null;
    // R3.7 - filler chain state. While _fillerChainActive is true, fillers
    // auto-loop until the server replies. _pendingReply queues the real
    // response if it arrives in the second half of a filler. _currentFillerEst
    // is the estimated total ms of the currently-playing filler audio.
    var _fillerChainActive = false;
    var _pendingReply       = null;   // {text, done, queuedAt}
    var _fillerStartTimer   = null;   // R21 - fillers only after a real wait
    var FILLER_DELAY_MS     = 1500;
    var _currentFillerStart = 0;
    var _currentFillerEst   = 0;

    function _edgeBlob(text, voice, cb0, retried) {
        var myVer = _edgeVersion(), opened = false, timedOut = false;
        var cb = function (blob) {
            if (blob) { _edgeVersionWorked(myVer); return cb0(blob); }
            if (!retried && !opened && !timedOut && _edgeVersionRotate(myVer)) return _edgeBlob(text, voice, cb0, true);
            cb0(null);
        };
        _edgeWssUrl(function (wssUrl, requestId) {
        try {
            var ws = new WebSocket(wssUrl);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var done = false;
            var watchdog = $timeout(function () {
                if (!done) { done = true; timedOut = true; try { ws.close(); } catch (e) {} cb(null); }
            }, 5000);
            ws.onopen = function () {
                opened = true;
                _edgeVersionOpened(myVer);
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
        // R21 - pre-rendered fillers are neural-voice audio: in any other
        // voice they would not match the replies (and in Chrome every one
        // of them is a refused connection). The live voice says them instead.
        if ((c.ttsEngine || 'browser') !== 'edge' || !_edgeVoiceAvailable()) {
            logEvent('tts', 'fillers will use the live voice (' + (c.ttsEngine || 'browser') + ')');
            return;
        }
        // R4.3 - respect the persisted circuit breaker. If Edge has already
        // failed >=REMOTE_FAIL_LIMIT times across previous sessions, don't
        // spam 27 more failed WSS connections at boot - they all fail
        // identically. The filler chain (R4.1) will use live browser TTS
        // instead.
        if (_edgeCircuitOpen()) {
            logEvent('tts', 'skipping filler preload - edge circuit open (' + _edgeFails + ' prior fails); chain will use live browser TTS');
            return;
        }
        logEvent('tts', 'pre-loading thinking-cue fillers...');
        // three sockets at a time: a burst of 37 gets some of them refused
        // by the service, and a refusal used to read as a bad client version
        var pending = FILLER_PHRASES.length, next = 0;
        function one() {
            if (next >= FILLER_PHRASES.length) return;
            var phrase = FILLER_PHRASES[next++];
            _edgeBlob(phrase, c.edgeVoice, function (blob) {
                if (blob) {
                    var url = URL.createObjectURL(blob);
                    fillerCache.push({ url: url, text: phrase });
                }
                if (--pending === 0) {
                    logEvent('tts', 'filler cache ready (' + fillerCache.length + '/' + FILLER_PHRASES.length + ')');
                }
                one();
            });
        }
        one(); one(); one();
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
            // "checking the vulnerability queue" is a lie while a printer
            // ticket is being looked up: those lines only for those questions
            var vr = /vulnerab|\bcve\b|exposure|risk|security|patch|scan/i.test(_lastSentText);
            var pool = fillerCache.filter(function (x) { return vr || !VR_FILLER_RE.test(x.text); });
            if (!pool.length) pool = fillerCache;
            var f = pool[Math.floor(Math.random() * pool.length)];
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
            // R21 - the answer never waits for a filler to finish
            logEvent('tts', 'reply cuts the filler at ' + Math.round(ratio*100) + '%');
            if (currentFillerAudio) { try { currentFillerAudio.pause(); } catch (e) {} currentFillerAudio = null; }
            if (currentFillerUtter && typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (e) {} currentFillerUtter = null; }
            _fillerChainActive = false;
            _pendingReply = null;
            speak(text, done);
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
        _silenceCurrentAudio();
        // Also stop browser TTS so we never overlap
        if (TTS && (TTS.speaking || TTS.pending)) {
            try { TTS.cancel(); } catch (e) {}
        }
        var session = _speakSessionId;   // a stop or a newer line makes this one stale
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
            // stopSpeaking's pause() rejects the pending play(): not a failure
            if (session !== _speakSessionId) return;
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
        _silenceCurrentAudio();
        if (!c.hasTTS) {
            logEvent('err', 'no browser TTS available');
            _keepCaption();   // captions only: her words stay on screen
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
        u.rate  = c.speechRate || 1.06;   // R13 - follow the pace slider here too
        u.pitch = 1.05;
        u.volume = 1.0;
        var v = chooseVoice();
        if (v) {
            u.voice = v;
            u.lang  = v.lang || 'en-IN';
            logEvent('tts', 'browser: ' + v.name + ' / ' + (v.lang || 'en-IN') + ' (' + text.length + ' chars)');
        } else {
            // R13 - even with no matching voice object, follow the locale
            // of the picked voice instead of hardcoding en-IN
            u.lang = (String(c.edgeVoice || '').match(/^[a-z]{2}-[A-Z]{2}/) || ['en-IN'])[0];
            logEvent('tts', 'browser DEFAULT voice for ' + u.lang + ' (' + text.length + ' chars)');
        }

        var startedAt = Date.now();
        var startWatchdog = $timeout(function () {
            if (Date.now() - startedAt > 1800 && !TTS.speaking) {
                logEvent('warn', 'TTS never fired onstart in 1.8s - voice may be silent or autoplay blocked');
            }
        }, 2000);

        var voiced = false;
        u.onstart = function () {
            $timeout.cancel(startWatchdog);
            voiced = true;
            c.captionKeep = false;
            setState('speaking');
            logEvent('tts', 'onstart');
        };
        u.onend = function () {
            $timeout.cancel(startWatchdog);
            _clearSpeaking();   // R6
            if (!voiced) _keepCaption();   // ended without a sound (no voice installed)
            logEvent('tts', 'onend');
            _resumeAudio('after speech');   // R27 - WebKit interrupts the mic's context while she speaks
            if (done) done();
        };
        u.onerror = function (ev) {
            $timeout.cancel(startWatchdog);
            _clearSpeaking();   // R6
            // no voice played (none installed, or blocked): keep her words on
            // screen until the next thing heard or said; a barge-in is not that
            var err = ev && ev.error;
            if (!voiced && err !== 'interrupted' && err !== 'canceled') _keepCaption();
            logEvent('err', 'TTS error: ' + (ev && ev.error));
            if (ev && ev.error === 'not-allowed' && c.gate) {
                // R21 - the page has not been pressed or tapped yet: say so on
                // the loading screen instead of talking into nothing
                _voiceBlocked = true;
                _speechUnlocked = false;   // the next tap unlocks again
                _gateUpdate();
            }
            if (done) done();
        };

        var session = _speakSessionId;
        try {
            // Small delay helps Chrome after cancel(); a stop inside it wins
            $timeout(function () { if (session === _speakSessionId) TTS.speak(u); }, 60);
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
        // v7.9 - Sonia (English, United Kingdom) is Netra's voice wherever
        // this device has her: an installed copy first, else the online one
        var sonia = voices.find(function (vv) { return /Sonia/i.test(vv.name || '') && vv.localService; }) ||
                    voices.find(function (vv) { return /Sonia/i.test(vv.name || ''); });
        if (sonia) return sonia;
        // R13 FIX - the browser fallback now honors the picked voice too:
        // match the same speaker name first (Edge exposes "Microsoft Ava
        // Online (Natural)..." locally), then the same locale, and only
        // then the generic quality picker. Before this, falling back to
        // browser TTS silently ignored the user's choice.
        // R20 - a voice installed on this machine speaks at once and needs
        // no network; an online one can stall or fail on a locked-down
        // network. Only when there is none does the name/locale match run.
        var locals = voices.filter(function (vv) { return vv.localService && /^en([-_]|$)/i.test(vv.lang || ''); });
        if (locals.length) return pickFemaleVoice(locals);
        try {
            var mV = String(c.edgeVoice || '').match(/^([a-z]{2}-[A-Z]{2})-([A-Za-z]+?)(Multilingual)?Neural$/);
            if (mV) {
                var wantLoc = mV[1], wantName = mV[2];
                var byName = voices.find(function (vv) { return vv.name.indexOf(wantName) >= 0; });
                if (byName) return byName;
                var sameLoc = function (vv) { return String(vv.lang || '').replace('_', '-').indexOf(wantLoc) === 0; };
                var byLoc = voices.find(function (vv) { return sameLoc(vv) && /Natural|Neural|Online|Google/i.test(vv.name); }) ||
                            voices.find(sameLoc);
                if (byLoc) return byLoc;
            }
        } catch (eCV) {}
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
    function pickFemaleVoice(pool) {
        if (!c.hasTTS) return null;
        var voices = pool || TTS.getVoices() || [];
        if (!voices.length) return null;

        var isEng = function (v) { return /^en([-_]|$)/i.test(v.lang || ''); };
        var find = function (pred) { for (var i = 0; i < voices.length; i++) if (pred(voices[i])) return voices[i]; return null; };

        // Tier 1: top-shelf neural voices by exact name, best first.
        var premium = [
            'Sonia', 'Ava', 'Aria', 'Emma', 'Jenny', 'Michelle', 'Libby',
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
        // a voice kept from Settings is the one named (the loading card's
        // voice row reads it), when this device still has it
        if (vs.length && c.voiceName === '(picking...)') {
            if (forcedVoiceName && vs.some(function (v) { return v.name === forcedVoiceName; })) c.voiceName = forcedVoiceName;
            else pickFemaleVoice();
        }
        if (c.gate && !c.gate.voice) _gateUpdate();   // R21
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

    // R28 - one short sound per event, each always the same: got it, still
    // working (tick), your turn (open), a problem, ended. Sounds: on, fewer, off
    function cue(kind) {
        if (!audioCtx || !_cueAllowed(kind)) return;
        if (audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) {}
        }
        switch (kind) {
            case 'wake':   tone([660, 880], 0.06); break;
            case 'think':  tone([440],      0.04); break;
            case 'got':    tone([880],      0.04); break;
            case 'tick':   tone([1200],     0.025, 0.03); break;
            case 'open':   tone([523, 784], 0.06, 0.03); break;
            case 'error':  tone([220, 220], 0.09); break;
            case 'end':    tone([660, 330], 0.09); break;
            case 'pause':  tone([330],      0.12); break;
            case 'resume': tone([440, 660], 0.08); break;
        }
    }
    function _cueAllowed(kind) {
        if (c.sounds === 'off' || _speakingNow) return false;
        if (c.sounds === 'fewer' && /^(tick|got|open|think)$/.test(kind)) return false;
        return true;
    }

    // peak 0.06 by default: about 6 dB under the old 0.12, under her voice
    function tone(freqs, dur, peak) {
        if (c.sounds === 'off') return;
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
                g.gain.exponentialRampToValueAtTime(peak || 0.06, start + 0.01);
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
        _hotkeyHandler = function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.tap();
                $scope.$applyAsync();
            }
            if (e.altKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
                // R2.7 - Alt+Shift+R = NUCLEAR reset (history, mic, rec, AudioContext)
                e.preventDefault();
                logEvent('warn', 'Alt+Shift+R: nuclear reset of everything');
                _memForget('nuclear reset');
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
            if (_altDKey(e)) {
                // the loading card is a modal: the Lab would open on top of it,
                // inert (it is behind the card) and covering Start and Type instead
                if (c.liveMode && _gateCardUp()) return;
                e.preventDefault();
                // R28 - on the stage Alt+D opens the Lab (diagnostics), as Settings > More does
                if (c.liveMode) _labKeyToggle(); else c.toggleDev();
                $scope.$applyAsync();
                return;
            }
            // R28 - on the stage: single keys (M, /, T, S, ?) and Escape, which
            // closes a sheet or the typing box first and otherwise stops her
            if (c.liveMode) {
                if (_stageKey(e)) $scope.$applyAsync();
                return;
            }
            if (e.key === 'Escape') {
                // R6 - Escape now silences EVERYTHING (remote audio, browser
                // TTS, filler chain, pipeline queue) via the universal stopper.
                // The old handler only cancelled browser TTS, so Escape did
                // nothing during Edge/Gemini/Stream playback.
                stopSpeaking('Escape key');
                $scope.$applyAsync();
            }
        };
        $window.addEventListener('keydown', _hotkeyHandler);
    }

    /* ============================================================
     *  NOTIFICATION POLLING
     * ============================================================ */
    // one polled notification: spoken when she is free and acked once said;
    // while she is busy or asleep it stays unacked and the next poll brings
    // it back, so nothing is dropped
    function _onPolledNotification(n) {
        if (seenIds[n.id]) { _ackIds.push(n.id); return; }   // spoken already; that ack was lost
        // R8.2 - skip a scanner-promoted reminder that the local
        // timer already announced to the minute.
        if (n.kind === 'reminder' && _reminderAlreadySpoken(n.message)) {
            logEvent('poll', 'reminder already spoken locally - skipped');
            seenIds[n.id] = true;
            _ackIds.push(n.id);
            return;
        }
        if (!c.alert || !_floorFree()) return;   // unacked: the next poll brings it back
        if (c._hushed && n.kind !== 'reminder') return;         // "quiet": only the user's own reminders
        seenIds[n.id] = true;
        // R4.5 - cap seenIds to last 500 keys so long-lived
        // PWA sessions don't accumulate thousands of sys_ids.
        var _seenKeys = Object.keys(seenIds);
        if (_seenKeys.length > 500) {
            for (var _si = 0; _si < _seenKeys.length - 500; _si++) {
                delete seenIds[_seenKeys[_si]];
            }
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
        speak(msg, function () {
            _ackIds.push(n.id);
            if (n.kind === 'reminder') _recentReminderTexts[String(n.message)] = Date.now();   // the page timer's copy stays quiet
        });
    }

    function startNotificationPolling() {
        if (c.data && c.data.is_guest) { logEvent('boot', 'guest - no notifications to poll'); return; }   // R21
        var POLL_MS_ACTIVE  = 9000;
        var POLL_MS_DORMANT = 30000;   // R4.7 - back off when paused/dormant
        var tick = function () {
            if (_ctrlDestroyed) return;
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
            // the server marks a notification delivered only once it is acked
            var acking = _ackIds.splice(0);
            c.data.ack_ids = acking;
            c.server.update().then(
                function () {
                    var list = c.data.notifications || [];
                    if (list.length) logEvent('poll', list.length + ' new');
                    list.forEach(_onPolledNotification);
                },
                function () { _ackIds = acking.concat(_ackIds); }
            ).finally(function () {
                if (_ctrlDestroyed) return;   // a poll in flight at destroy must not re-arm
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
        if (_typedRefused(t)) return;
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

    // what the user really hears, for the Lab
    c.voiceSummary = function () {
        var e = c.ttsEngine || (c.useRemoteTTS ? 'edge' : 'browser');
        if (e === 'edge' && !_edgeVoiceAvailable()) return 'browser voice ' + (c.voiceName || '') + ' (neural voice needs Microsoft Edge)';
        if (e === 'edge') return 'Microsoft neural ' + c.edgeVoice;
        if (e === 'gemini') return 'Gemini ' + c.geminiVoice;
        if (e === 'stream') return 'StreamElements ' + c.remoteVoice;
        return 'browser voice ' + (c.voiceName || '');
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
        _memForget('nuclear reset');
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
        // R13 FIX - picking a voice is a clear "I want to hear THIS" signal:
        // reopen the edge/stream circuits so the pick actually plays instead
        // of being silently swallowed by a breaker from some old failure.
        // (This was THE "voice never changes" bug - edge had tripped, every
        // reply fell back to remote/browser and ignored the picker.)
        _edgeFails = 0; _streamFails = 0;
        _ssSet('netra_edgeFails', 0); _ssSet('netra_streamFails', 0);
        _edgeVersionReseed(); _edgeLiveBroken = false;
        // R13 FIX - the pre-baked filler/backchannel audio was rendered in
        // the OLD voice at boot and never refreshed, so "Mm-hmm" and the
        // thinking cues kept the previous voice forever. Rebuild them.
        try {
            fillerCache.forEach(function (f) { try { URL.revokeObjectURL(f.url); } catch (e1) {} });
            backchannelCache.forEach(function (b) { try { URL.revokeObjectURL(b.url); } catch (e2) {} });
            fillerCache.length = 0;
            backchannelCache.length = 0;
            $timeout(preloadFillers, 400);
            $timeout(preloadBackchannels, 900);
        } catch (eVC) {}
        logEvent('dev', 'voice -> ' + c.edgeVoice + ' (TTS circuits reset, filler cache rebuilding in the new voice)');
    };
    c.devSetRate = function () {
        var r = parseFloat(c.speechRate);
        if (!(r >= 0.85 && r <= 1.3)) { c.speechRate = 1.06; r = 1.06; }
        try { localStorage.setItem('netra_speechRate', String(r)); } catch (e) {}
    };
    c.devPreviewVoice = function () { _previewVoice(); };
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
     *  R28 - THE LIVE STAGE: one status model, one announcer
     *
     *  Every state has one meaning, one line of text, one hint, one
     *  look (window.__netraMode for the stage renderer) and one
     *  announcement. The status row on the page is never a live
     *  region: #netra-say (polite) and the stage's role=alert are the
     *  only ones, written through _announce, so a screen reader hears
     *  each thing once. Her words reach them only when no voice plays.
     *  Everything here is a hoisted function so the tests can reach it.
     * ============================================================ */
    c.srSay = ''; c.srAlert = '';
    c.liveKind = 'boot'; c.liveHint = '';
    c.activity = ''; c.canRetry = false; c.lastFailed = false;
    c.capSize = 'm'; c.capOn = true; c.bargeOn = true; c.sounds = 'on'; c.calm = false;
    try {
        var capPref = localStorage.getItem('netra_caption_size');
        if (/^(s|m|l|xl)$/.test(capPref || '')) c.capSize = capPref;
        c.capOn = localStorage.getItem('netra_captions') !== '0';
        c.bargeOn = localStorage.getItem('netra_voice_barge') !== '0';
        var sndPref = localStorage.getItem('netra_sounds');
        if (/^(on|fewer|off)$/.test(sndPref || '')) c.sounds = sndPref;
        var calmPref = localStorage.getItem('netra_calm');
        c.calm = calmPref === null ? !!($window.matchMedia && $window.matchMedia('(prefers-reduced-motion: reduce)').matches) : calmPref === '1';
    } catch (eStagePref) {}
    try { window.__netraCalm = !!c.calm; } catch (eCalm) {}
    c.loginUrl = _loginUrl();
    c.setCapSize = function (v) { _setCapSize(v); };
    c.setCapOn = function (v) { _setCapOn(v); };
    c.setCalm = function (v) { _setCalm(v); };
    c.setSounds = function (v) { _setSounds(v); };
    c.setBarge = function (v) { _setBarge(v); };
    c.retry = function () { _retryTurn(); };
    c.retryFocus = function () { _focusOffRetry(); };
    // the connection: said once each way, as an alert when it goes
    if (c.liveMode) {
        var _onOffline = function () { _announce('You’re offline. I’ll reconnect when you’re back.', 'alert'); $scope.$applyAsync(); };
        var _onOnline = function () { _announce('Back online.', 'info'); $scope.$applyAsync(); };
        try { $window.addEventListener('offline', _onOffline); $window.addEventListener('online', _onOnline); } catch (eNet) {}
        $scope.$on('$destroy', function () {
            try { $window.removeEventListener('offline', _onOffline); $window.removeEventListener('online', _onOnline); } catch (eNet2) {}
        });
    }

    // what the status row says for a state: {kind, label, hint}
    function _liveStatusFor(s) {
        var g = c.gate, listen = s === 'idle' || s === 'awaiting' || s === 'boot';
        // ended from the loading card too: the card is gone, she is at rest
        if (c.ended) return { kind: 'ended', label: 'Ended', hint: 'The mic is off' };
        if (listen && g && !g.open && !g.typing) return { kind: 'boot', label: 'Getting ready…', hint: '' };
        if (listen && g && g.typing) return { kind: 'typing', label: 'Typing', hint: g.cantHear ? 'Netra can’t hear in this browser' : 'Listening is still loading' };
        if (c.micOff && s === 'speaking') return { kind: 'speak', label: 'Speaking', hint: 'Mic off' };
        if (c.micOff && s !== 'thinking' && s !== 'error') return { kind: 'muted', label: 'Mic off', hint: 'Press Mute or tap Netra to turn it on' };
        switch (s) {
            case 'dormant':  return { kind: 'paused', label: 'Paused', hint: 'Say “Netra” or tap to resume' };
            case 'thinking': return { kind: 'work', label: c.activity || 'Thinking…', hint: '' };
            case 'speaking': return { kind: 'speak', label: 'Speaking', hint: c.bargeOn !== false ? 'Talk or tap to interrupt' : 'Tap Netra or press Esc to stop her' };
            case 'error':
                if (c.permission === 'denied') return { kind: 'error', label: 'I can’t hear you', hint: _micBlockedText() };
                return { kind: 'error', label: 'Couldn’t get an answer', hint: 'Say it again or press Try again' };
        }
        // iPhone: the mic's audio is still suspended - one tap wakes it
        if (c.micNeedsTap) return { kind: 'tap', label: 'Tap anywhere so I can hear you', hint: '' };
        // her apology is over: Try again is still there, and the hint says so
        if (c.lastFailed) return { kind: 'listen', label: 'Listening', hint: 'Say it again or press Try again' };
        return { kind: 'listen', label: 'Listening', hint: _voicePlays() ? '' : 'Replies shown as text — no voice on this device' };
    }
    // a voice will say her lines (a kept caption or the size sample is not "no voice")
    function _voicePlays() { return !!(c.hasTTS && !c.labMute); }
    // writes the status row from c.state; says it only when the kind changes
    function _applyLiveStatus() {
        var st = _liveStatusFor(c.state), was = c.liveKind;
        c.liveStatus = st.label; c.liveHint = st.hint; c.liveKind = st.kind;
        try { window.__netraMode = { muted: 'muted', paused: 'paused', ended: 'ended' }[st.kind] || ''; } catch (eMode) {}
        // the Try again row may be about to go with this state
        _retryRowCheck();
        if (st.kind === was) return;
        // her turn is over: the 'open' earcon says so, unless she was cut off
        // (the falling blip already said it); the greeting covers boot
        if (was === 'speak' && st.kind === 'listen') { if (!_quietOpen) cue('open'); return; }
        if (was === 'boot' && st.kind === 'listen') return;
        // with a voice, her voice is the cue: 'Speaking' is never said over it,
        // nor the mic off, pause or end she has just said out loud. A state
        // still waiting its 500 ms ("Couldn't get an answer", "Thinking…")
        // is dropped too, or it would be read over her voice
        if (_voicePlays() && (st.kind === 'speak' || (was === 'speak' && /^(muted|paused|ended)$/.test(st.kind)))) { _hushState(); return; }
        // a blocked mic has its own alert with what to do
        if (st.kind === 'error' && c.permission === 'denied') return;
        _announce(st.label, 'state');
    }
    // pure: what to do with one announcement. The same text within 1.5 s
    // is not said again; a state waits 500 ms so a quick run of states is
    // said as the last one; an alert goes to the assertive region
    function _announcePlan(last, text, kind, now) {
        if (last && last.text === text && now - last.at < 1500) return { write: false, delay: 0, slot: 'srSay' };
        if (kind === 'alert') return { write: true, delay: 0, slot: 'srAlert' };
        return { write: true, delay: kind === 'state' ? 500 : 0, slot: 'srSay' };
    }
    var _annLast = null, _annTimer = null, _quietOpen = false;
    // her voice is about to say what just changed ("Mic off.", "Paused."):
    // the state waiting to be announced is dropped, so the two never overlap
    function _hushState() {
        if (!_voicePlays() || !_annTimer) return;
        try { $timeout.cancel(_annTimer); } catch (eH) {}
        _annTimer = null;
    }
    function _announce(text, kind) {
        text = String(text || '').trim();
        if (!text) return;
        var plan = _announcePlan(_annLast, text, kind, Date.now());
        if (!plan.write) return;
        // a newer state, reply or note replaces a state not said yet
        if (plan.slot === 'srSay' && _annTimer) { try { $timeout.cancel(_annTimer); } catch (eC) {} _annTimer = null; }
        var put = function () {
            _annTimer = null;
            _annLast = { text: text, at: Date.now() };
            // the same words again: empty the region first, or it is not re-read
            if (c[plan.slot] === text) {
                c[plan.slot] = '';
                $timeout(function () { c[plan.slot] = text; $scope.$applyAsync(); }, 30);
            } else {
                c[plan.slot] = text;
            }
            $scope.$applyAsync();
        };
        if (plan.delay) _annTimer = $timeout(put, plan.delay);
        else put();
    }
    function _micBlockedText() {
        return "I can't hear you: the microphone is blocked. Allow the microphone for this site in your browser, then press Try again, or press Type.";
    }
    // where Sign in goes: the portal's own login link, else the portal's login page
    function _loginUrl() {
        try {
            var links = document.querySelectorAll('a[href*="login"]');
            for (var i = 0; i < links.length; i++) {
                var href = String(links[i].getAttribute('href') || '');
                if (links[i].closest && links[i].closest('.netra-root')) continue;
                if (/^(\/|\?|https?:)/i.test(href)) return href;
            }
        } catch (eL) {}
        return '/sp?id=login';
    }

    // ---- preferences (Settings), each kept in this browser -------------------
    function _setCapSize(v) {
        v = /^(s|m|l|xl)$/.test(String(v)) ? String(v) : 'm';
        c.capSize = v;
        try { localStorage.setItem('netra_caption_size', v); } catch (e) {}
        // an empty box: a sample line shows the new size
        if (!_captionWho()) { c.spoken = 'This is how captions will look.'; c.captionKeep = true; }
    }
    function _setCapOn(v) {
        c.capOn = v !== false;
        try { localStorage.setItem('netra_captions', c.capOn ? '1' : '0'); } catch (e) {}
    }
    // Calm visuals: the stage renderer holds a composed still
    function _setCalm(v) {
        c.calm = !!v;
        try { window.__netraCalm = c.calm; } catch (eW) {}
        try { localStorage.setItem('netra_calm', c.calm ? '1' : '0'); } catch (e) {}
    }
    function _setSounds(v) {
        c.sounds = /^(on|fewer|off)$/.test(String(v)) ? String(v) : 'on';
        try { localStorage.setItem('netra_sounds', c.sounds); } catch (e) {}
    }
    // Talking interrupts Netra: off for a screen reader or a TV that keeps cutting her off
    function _setBarge(v) {
        c.bargeOn = v !== false;
        try { localStorage.setItem('netra_voice_barge', c.bargeOn ? '1' : '0'); } catch (e) {}
        _applyLiveStatus();
    }
    function _voiceBargeOn() { return c.bargeOn !== false; }

    // ---- while she works on it ------------------------------------------------
    // pure: the step named in the status while she works
    function _activityLabel(text, guest) {
        var t = String(text || ''), id = t.match(/\b(INC|RITM|REQ|CHG|PRB|SCTASK|TASK|KB)\d{5,}\b/i);
        if (id && !guest) return 'Looking up ' + id[0].toUpperCase() + '…';
        if (/\b(search|look up|google|latest|news|who is|what is)\b/i.test(t)) return 'Searching the web…';
        if (/\b(time|date|what day)\b/i.test(t)) return 'Checking the time…';
        if (/\bjoke\b/i.test(t)) return 'Finding a joke…';
        if (!guest && /\b(my tickets|approvals?|my requests?)\b/i.test(t)) return 'Checking your work…';
        return 'Thinking…';
    }
    // pure: what a long wait is called
    function _waitStep(ms) {
        if (ms < 8000) return null;
        return ms < 20000 ? 'Still working on it…' : 'This is taking too long';
    }
    // the wait ladder: 'got it' at once, a soft tick every 1.5 s from 2 s,
    // a named step at 8 s and Try again at 20 s. It ends with the turn: a
    // reply, a barge-in, a stop or a newer turn (the hung timer stays the
    // hard stop for the wire)
    var _waitLadder = null;
    function _waitStart() {
        _waitStop();
        cue('got');
        _waitLadder = { epoch: _turnEpoch, at: Date.now(), step: null, timer: null };
        _waitLadder.timer = $timeout(_waitTick, 2000);
    }
    function _waitTick() {
        var w = _waitLadder;
        if (!w) return;
        w.timer = null;
        if (w.epoch !== _turnEpoch || c.state !== 'thinking' || _ctrlDestroyed) { _waitStop(); return; }
        var ms = Date.now() - w.at;
        if (ms < 1900) return;   // a timer that fired early is not a wait
        if (!(_speakingNow || _fillerChainActive || currentFillerAudio || currentFillerUtter)) cue('tick');
        var step = _waitStep(ms);
        if (step && step !== w.step) {
            w.step = step;
            c.liveStatus = step;
            if (ms >= 20000) { c.canRetry = true; c.liveHint = 'Press Try again or type your question'; }
            _announce(step, 'info');
            $scope.$applyAsync();
        }
        w.timer = $timeout(_waitTick, 1500);
    }
    function _waitStop() {
        if (_waitLadder && _waitLadder.timer) { try { $timeout.cancel(_waitLadder.timer); } catch (e) {} }
        _waitLadder = null;
        c.canRetry = false;
        _retryRowCheck();
    }
    // a turn that failed: Try again stays up through her apology and after it,
    // until something new is heard or typed (setState does not clear it).
    // It keeps the question that failed: c.lastHeard moves on with every
    // final (a "stop", a sleep command) and an automatic turn never sets it
    var _failedAsk = null, _sentAsk = null;
    function _turnFailed(ask) {
        _failedAsk = ask && ask.text ? ask : null;
        setState('error');
        c.lastFailed = true;
    }
    // the row's own ng-if, from the state about to be shown (setState clears
    // the wait before it writes c.liveKind)
    function _retryRowUp() {
        return !!(c.canRetry || c.lastFailed || _liveStatusFor(c.state).kind === 'error');
    }
    function _retryRowCheck() {
        if (!_retryRowUp()) _focusOffRetry();
    }
    // the row goes with the turn: focus on its buttons moves to the orb (the
    // stable control, named for what a tap does), never to <body>
    function _focusOffRetry() {
        try {
            var a = document.activeElement;
            if (a && a.closest && a.closest('.netra-retry-row')) _focusEl('.netra-stage-blob-wrap');
        } catch (eR) {}
    }
    // Try again: the question that failed, exactly as it was sent (an
    // automatic turn goes again as one); a blocked mic listens again
    function _retryTurn() {
        _focusOffRetry();
        var waited = !!c.canRetry && !c.lastFailed;
        c.canRetry = false; c.lastFailed = false;
        if (c.permission === 'denied') {
            c.permission = 'prompt';
            _notAllowedStrikes = 0;
            setState('idle');
            startContinuous();
            return;
        }
        // a wait that ran long (the turn has not failed yet): the one on the wire
        var ask = waited ? _sentAsk : _failedAsk;
        _failedAsk = null;
        if (!ask) { if (c.state === 'error') setState('idle'); else _applyLiveStatus(); return; }
        if (ask.auto) c._nextTurnAuto = ask.text;
        handleHeard(ask.text);
    }

    /* ============================================================
     *  STATE
     * ============================================================ */
    function setState(s) {
        c.state = s;
        window.__netraState = s;   // R10 - 3D stage reads this per frame
        c.stateLabel = _stateLabel(s);
        // muted or ended is not paused: her name does not wake her
        if (s === 'dormant' && c.ended) c.stateLabel = 'ended - press Start Netra again to talk to me';
        else if (s === 'dormant' && c.micOff) c.stateLabel = 'mic off - press Mute or tap Netra to turn it on';
        // the turn is over: its step name and its wait go with it
        if (s !== 'thinking') { c.activity = ''; _waitStop(); }
        _applyLiveStatus();
        $scope.$applyAsync();
        // R3.7 - filler chain is now started explicitly from handleHeard()
        // when the server call is dispatched. setState no longer triggers
        // a one-shot filler so we don't double-play.
    }
};

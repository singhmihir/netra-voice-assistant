/**
 * Netra Mic widget - CLIENT CONTROLLER (v6 - voice-only, blind-first)
 *
 * No chat panel, no typing, no buttons that need to be found visually.
 *
 * Behaviour:
 *   1. On first user gesture (any click anywhere, or Alt+N) Netra greets
 *      the user by name and starts wake-word listening.
 *   2. The user says "Netra" anywhere on the page. Netra plays a soft
 *      chirp, says "Yes?", and listens for the actual command.
 *   3. The transcript is sent to the server (Gemini). Netra speaks the
 *      reply in a female en-IN voice.
 *   4. Returns to wake-word listening automatically.
 *
 * Visual: a single pulsing orb in the corner whose colour reflects state.
 * Useful for sighted helpers; the blind user does not need to look at it.
 *
 * Audio cues use the Web Audio API so a blind user can navigate by sound:
 *   - rising two-tone  = Netra heard her wake word, ready for command
 *   - short low click  = command captured, thinking
 *   - none             = Netra speaking (voice is the cue)
 *   - falling two-tone = error
 */
api.controller = function ($scope, $timeout, $window, spUtil) {
    var c = this;

    // ----- state machine -----
    // idle | listening | thinking | speaking | error | paused
    c.state       = 'idle';
    c.stateLabel  = 'getting ready';
    c.lastHeard   = '';
    c.spoken      = '';
    c.needsTap    = true;     // hidden once user interacts once
    c.wakeOn      = true;

    var STATE_LABEL = {
        idle:      'listening for the wake word, say Netra to talk',
        listening: 'listening to your command',
        thinking:  'thinking',
        speaking:  'speaking',
        paused:    'paused, click the orb or press Alt N to resume',
        error:     'sorry, something went wrong',
        boot:      'getting ready'
    };

    // ----- engines -----
    var SR     = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS    = $window.speechSynthesis;
    var hasSR  = !!SR;
    var hasTTS = !!TTS;
    var audioCtx = null;

    var cmdRec    = null;
    var wakeRec   = null;
    var pollTimer = null;
    var seenIds   = {};
    var geminiHistory = [];
    var booted    = false;

    // ============================================================
    //  Lifecycle
    // ============================================================
    c.$onInit = function () {
        setState('boot');
        // Pre-warm voice catalog (browsers populate async)
        if (hasTTS) {
            TTS.getVoices();
            try { TTS.addEventListener('voiceschanged', function(){}); } catch (e) {}
        }
        bindHotkey();
        // Some browsers can start recognition without a gesture; try.
        // If it fails we keep the gate visible until the user taps.
        $timeout(tryBoot, 600);
    };

    c.$onDestroy = function () {
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (TTS) TTS.cancel();
        if (audioCtx) try { audioCtx.close(); } catch (e) {}
    };

    /**
     * Tap target - either the gate banner or the orb. Always safe to call.
     * - First tap unlocks audio + recognition.
     * - Subsequent taps toggle wake listening on/off.
     */
    c.tap = function () {
        if (!booted) { tryBoot(true); return; }
        if (c.state === 'paused') {
            c.wakeOn = true;
            setState('idle');
            startWakeWord();
            cue('resume');
            speak('Listening again.');
        } else {
            c.wakeOn = false;
            try { if (wakeRec) wakeRec.stop(); } catch (e) {}
            try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
            if (TTS) TTS.cancel();
            setState('paused');
            cue('pause');
        }
    };

    // ============================================================
    //  Boot - greet the user, start wake word
    // ============================================================
    function tryBoot(fromTap) {
        if (booted) return;
        if (!hasSR) {
            setState('error');
            speak('Your browser does not support voice. Kindly use Chrome or Edge.');
            return;
        }
        if (!c.data.has_api_key) {
            setState('error');
            speak('Sorry, my AI is not configured yet. The system property for the Gemini API key needs to be set.');
            return;
        }

        // Try to unlock the audio context here so beeps work
        unlockAudio();

        // Try to start the wake word listener. If the browser blocks
        // without a gesture, the catch will keep the gate visible.
        try {
            startWakeWord();
            booted    = true;
            c.needsTap = false;
            startNotificationPolling();
            setState('idle');

            // Friendly greeting in female en-IN voice
            var name = (c.data && c.data.user_name) ? c.data.user_name : 'there';
            // Tiny pause so screen readers don't collide with the announcement
            $timeout(function () {
                speak('Hello ' + name + '. I am Netra, your voice assistant. Whenever you need me, just say my name.');
            }, fromTap ? 200 : 800);
        } catch (e) {
            // Recognition blocked without gesture
            c.needsTap = true;
            $scope.$applyAsync();
        }
    }

    // ============================================================
    //  Wake-word listener (always-on)
    // ============================================================
    function startWakeWord() {
        if (!hasSR || !c.wakeOn) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous     = true;
        wakeRec.interimResults = true;
        wakeRec.lang           = 'en-IN';

        wakeRec.onresult = function (ev) {
            if (c.state !== 'idle') return;
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var t = ev.results[i][0].transcript.toLowerCase();
                if (/\bnetra\b/.test(t) || /\bhello netra\b/.test(t)) {
                    var after = t.split(/\bnetra\b/i)[1] || '';
                    after = after.replace(/^[,\s.]+/, '').trim();
                    if (after.length > 3) {
                        // User said "Netra, do something" in one breath
                        cue('wake');
                        handleHeard(after);
                    } else {
                        cue('wake');
                        startCommandRecognition();
                    }
                    return;
                }
            }
        };
        wakeRec.onerror = function (ev) {
            // Routine - keep listening
            if (c.wakeOn && c.state === 'idle') $timeout(startWakeWord, 700);
        };
        wakeRec.onend = function () {
            if (c.wakeOn && c.state === 'idle') $timeout(startWakeWord, 350);
        };
        try { wakeRec.start(); } catch (e) {}
    }

    // ============================================================
    //  Command capture (after wake)
    // ============================================================
    function startCommandRecognition() {
        if (!hasSR) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        if (TTS) TTS.cancel();

        cmdRec = new SR();
        cmdRec.continuous      = false;
        cmdRec.interimResults  = false;
        cmdRec.lang            = 'en-IN';
        cmdRec.maxAlternatives = 1;

        var captured = '';
        cmdRec.onstart = function () { setState('listening'); };
        cmdRec.onresult = function (ev) {
            captured = ev.results[0][0].transcript;
        };
        cmdRec.onerror = function (ev) {
            // no-speech / aborted / not-allowed
            setState('idle');
            if (c.wakeOn) $timeout(startWakeWord, 200);
        };
        cmdRec.onend = function () {
            if (captured) handleHeard(captured);
            else {
                setState('idle');
                if (c.wakeOn) $timeout(startWakeWord, 200);
            }
        };

        // Short verbal cue so the blind user knows we are listening
        speak('Yes?', function () {
            try { cmdRec.start(); } catch (e) { setState('idle'); }
        });
    }

    // ============================================================
    //  Server round-trip via c.server.update()
    // ============================================================
    function handleHeard(transcript) {
        c.lastHeard = transcript;
        setState('thinking');
        cue('think');

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;

        c.server.update().then(
            function () {
                var r = c.data.response || {};
                if (Array.isArray(r.history)) geminiHistory = r.history;
                if (r.ok) {
                    setState('speaking');
                    speak(r.message, function () {
                        setState('idle');
                        if (c.wakeOn) $timeout(startWakeWord, 200);
                    });
                } else {
                    setState('error');
                    cue('error');
                    speak(r.message || 'Sorry, something went wrong.', function () {
                        setState('idle');
                        if (c.wakeOn) $timeout(startWakeWord, 200);
                    });
                }
            },
            function (err) {
                setState('error');
                cue('error');
                if ($window.console && $window.console.error) $window.console.error('[Netra]', err);
                speak('Sorry, I could not reach the server.', function () {
                    setState('idle');
                    if (c.wakeOn) $timeout(startWakeWord, 200);
                });
            }
        );
    }

    // ============================================================
    //  Text-to-speech - female Indian English priority
    // ============================================================
    function speak(text, done) {
        if (!hasTTS || !text) { if (done) done(); return; }
        var clean = String(text)
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        c.spoken = clean;
        $scope.$applyAsync();

        TTS.cancel();
        var u = new SpeechSynthesisUtterance(clean);
        u.lang  = 'en-IN';
        u.rate  = 0.96;
        u.pitch = 1.05;
        u.volume = 1.0;
        var v = pickFemaleVoice();
        if (v) u.voice = v;

        u.onstart = function () { setState('speaking'); };
        u.onend   = function () { if (done) done(); };
        u.onerror = function () { if (done) done(); };
        TTS.speak(u);
    }

    function pickFemaleVoice() {
        if (!hasTTS) return null;
        var voices = TTS.getVoices() || [];
        if (!voices.length) return null;

        // Known feminine voice names (order = preference)
        var feminineNames = [
            'Neerja', 'Heera', 'Veena', 'Lekha', 'Shruti',
            'Priya', 'Aditi', 'Kalpana', 'Sangeeta',
            'Indian English Female', 'Female (India)',
            'Zira', 'Aria', 'Samantha', 'Karen', 'Susan', 'Female'
        ];

        // Best: en-IN + a name we know is female
        for (var i = 0; i < feminineNames.length; i++) {
            var n = feminineNames[i];
            var match = voices.find(function (vv) {
                return /en[-_]IN/i.test(vv.lang) && vv.name.indexOf(n) >= 0;
            });
            if (match) return match;
        }
        // Next: any en-IN voice that looks "natural"
        var natural = voices.find(function (vv) {
            return /en[-_]IN/i.test(vv.lang) && /Natural|Neural|Online/i.test(vv.name);
        });
        if (natural) return natural;
        // Next: any en-IN voice (might be male, but accent is right)
        var enIn = voices.find(function (vv) { return /en[-_]IN/i.test(vv.lang); });
        if (enIn) return enIn;
        // Hindi female fallback - Google's hi-IN voice
        var hindi = voices.find(function (vv) { return /^hi[-_]IN/i.test(vv.lang); });
        if (hindi) return hindi;
        // Any voice whose name contains a female name we know
        for (var k = 0; k < feminineNames.length; k++) {
            var match2 = voices.find(function (vv) { return vv.name.indexOf(feminineNames[k]) >= 0; });
            if (match2) return match2;
        }
        // Last: en-US, en-GB, then anything
        return voices.find(function (vv) { return /en[-_]US/i.test(vv.lang); }) ||
               voices.find(function (vv) { return /en[-_]GB/i.test(vv.lang); }) ||
               voices[0];
    }

    // ============================================================
    //  Audio cues - short tones via Web Audio for blind navigation
    // ============================================================
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

    // ============================================================
    //  Hotkey: Alt+N toggles pause/resume. Esc stops Netra mid-sentence.
    // ============================================================
    function bindHotkey() {
        $window.addEventListener('keydown', function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.tap();
                $scope.$applyAsync();
            }
            if (e.key === 'Escape') {
                if (TTS) TTS.cancel();
                setState(c.wakeOn ? 'idle' : 'paused');
                $scope.$applyAsync();
            }
        });
    }

    // ============================================================
    //  Notification polling - announces proactive alerts aloud
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 9000;
        var tick = function () {
            c.data.action = 'poll';
            c.server.update().then(
                function () {
                    var list = c.data.notifications || [];
                    list.forEach(function (n) {
                        if (seenIds[n.id]) return;
                        seenIds[n.id] = true;
                        if (c.state === 'listening' || c.state === 'speaking') return;
                        c.spoken = n.message;
                        $scope.$applyAsync();
                        speak(n.message);
                    });
                },
                function () { /* silent */ }
            ).finally(function () {
                pollTimer = $timeout(tick, POLL_MS);
            });
        };
        pollTimer = $timeout(tick, 3000);
    }

    // ============================================================
    //  State helpers
    // ============================================================
    function setState(s) {
        c.state = s;
        c.stateLabel = STATE_LABEL[s] || s;
        $scope.$applyAsync();
    }
};

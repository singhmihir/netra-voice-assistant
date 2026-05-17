/**
 * Netra Mic widget - CLIENT CONTROLLER (v7 - DEV-FRIENDLY)
 *
 * Same engine as v6 (always-on wake word + Gemini), with a visible
 * developer panel so you can SEE everything:
 *   - what the mic is hearing (interim + final transcripts)
 *   - confidence scores
 *   - chosen TTS voice + manual voice override
 *   - mic permission status
 *   - live event log
 *   - manual test buttons (test mic, skip wake, test TTS, etc.)
 *   - a "type to test" input that bypasses speech recognition entirely
 *
 * To switch to blind-only mode, set DEV_DEFAULT_ON = false below
 * (or toggle in the UI with Alt+D).
 *
 * Fuzzy wake matching now accepts many mishearings of "Netra"
 * (Neetra / Naitra / Mitra / Metro / Hey Netra / Ok Netra / etc.)
 * so the wake word actually fires for real users.
 */
api.controller = function ($scope, $timeout, $window) {
    var c = this;

    var DEV_DEFAULT_ON = true;  // <-- flip to false to hide the panel by default

    // ----- state machine -----
    c.state       = 'idle';
    c.stateLabel  = 'getting ready';
    c.lastHeard   = '';
    c.spoken      = '';
    c.needsTap    = true;
    c.wakeOn      = true;
    c.devOn       = DEV_DEFAULT_ON;

    // ----- dev panel state -----
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

    var STATE_LABEL = {
        idle:      'listening for wake word - say "Netra"',
        listening: 'listening to your command',
        thinking:  'thinking',
        speaking:  'speaking',
        paused:    'paused (orb / Alt+N to resume)',
        error:     'error - check the event log',
        boot:      'getting ready'
    };

    // ----- engines -----
    var SR     = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS    = $window.speechSynthesis;
    c.hasSR    = !!SR;
    c.hasTTS   = !!TTS;
    var audioCtx = null;

    var cmdRec    = null;
    var wakeRec   = null;
    var devRec    = null;
    var pollTimer = null;
    var seenIds   = {};
    var geminiHistory = [];
    var booted    = false;
    var lastReply = '';
    var forcedVoiceName = '';

    /* ============================================================
     *  Fuzzy wake word patterns
     *  Real-world ASR mishears "Netra" as: Neetra, Naitra, Mitra,
     *  Metro, Mantra, Centra, Netro, Natra, Nitra, etc.
     *  We accept any of these as the wake.
     * ============================================================ */
    var WAKE_PATTERNS = [
        /\bnetra\b/i,    /\bneetra\b/i,  /\bnaitra\b/i,
        /\bnetro\b/i,    /\bnetera\b/i,  /\bnatra\b/i,
        /\bnitra\b/i,    /\bmetra\b/i,   /\bmehra\b/i,
        /\bmantra\b/i,   /\bcentra\b/i,  /\bintra\b/i,
        /\bnehra\b/i,    /\bneatre\b/i,  /\bneera\b/i,
        /\bnetwra\b/i,   /\bnektra\b/i,  /\bnitra\b/i,
        /\bhey\s+net\w*\b/i, /\bok\s+net\w*\b/i
    ];

    function matchesWake(text) {
        if (!text) return null;
        for (var i = 0; i < WAKE_PATTERNS.length; i++) {
            var p = WAKE_PATTERNS[i];
            if (p.test(text)) {
                var rest = text.replace(p, '').replace(/^[,.\s]+/, '').trim();
                return rest;
            }
        }
        return null;
    }

    // ============================================================
    //  Logging
    // ============================================================
    function logEvent(level, msg) {
        var d = new Date();
        var ts = String(d.getHours()).padStart(2,'0') + ':' +
                 String(d.getMinutes()).padStart(2,'0') + ':' +
                 String(d.getSeconds()).padStart(2,'0');
        c.events.unshift({ t: ts, l: level, m: String(msg) });
        if (c.events.length > 80) c.events.length = 80;
        if ($window.console && $window.console.log) {
            $window.console.log('[Netra ' + level + '] ' + msg);
        }
        $scope.$applyAsync();
    }

    // ============================================================
    //  Lifecycle
    // ============================================================
    c.$onInit = function () {
        setState('boot');
        logEvent('init', 'controller booting, SR=' + c.hasSR + ' TTS=' + c.hasTTS);

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
    };

    c.$onDestroy = function () {
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
        try { if (devRec)  devRec.stop();  } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
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

    /**
     * Tap target - the orb or the gate.
     *   first tap = unlock audio + recognition
     *   later tap = pause/resume
     */
    c.tap = function () {
        if (!booted) { tryBoot(true); return; }
        if (c.state === 'paused') {
            c.wakeOn = true;
            setState('idle');
            startWakeWord();
            cue('resume');
            speak('Listening again.');
            logEvent('dev', 'resumed');
        } else {
            c.wakeOn = false;
            try { if (wakeRec) wakeRec.stop(); } catch (e) {}
            try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
            if (TTS) TTS.cancel();
            setState('paused');
            cue('pause');
            logEvent('dev', 'paused');
        }
    };

    // ============================================================
    //  Boot
    // ============================================================
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
            startWakeWord();
            booted     = true;
            c.needsTap = false;
            startNotificationPolling();
            setState('idle');
            logEvent('boot', 'wake-word listener started');

            var name = (c.data && c.data.user_name) ? c.data.user_name : 'there';
            $timeout(function () {
                speak('Hello ' + name + '. I am Netra, your voice assistant. Whenever you need me, just say my name.');
            }, fromTap ? 200 : 800);
        } catch (e) {
            logEvent('err', 'boot failed: ' + e);
            c.needsTap = true;
            $scope.$applyAsync();
        }
    }

    // ============================================================
    //  Wake-word listener
    // ============================================================
    function startWakeWord() {
        if (!c.hasSR || !c.wakeOn) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous     = true;
        wakeRec.interimResults = true;
        wakeRec.lang           = 'en-IN';

        wakeRec.onresult = function (ev) {
            if (c.state !== 'idle') return;
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                if (!t) continue;
                if (!res.isFinal) {
                    c.interim = t.trim();
                    $scope.$applyAsync();
                    continue;
                }
                logEvent('wake.f', '"' + t.trim() + '"');
                c.interim = '';
                var rest = matchesWake(t);
                if (rest !== null) {
                    logEvent('wake', 'MATCH - rest: "' + rest + '"');
                    if (rest.length > 3) {
                        cue('wake');
                        handleHeard(rest);
                    } else {
                        cue('wake');
                        startCommandRecognition();
                    }
                    return;
                }
            }
        };
        wakeRec.onerror = function (ev) {
            logEvent('err', 'wake recognition error: ' + ev.error);
            if (c.wakeOn && c.state === 'idle') $timeout(startWakeWord, 700);
        };
        wakeRec.onend = function () {
            if (c.wakeOn && c.state === 'idle') $timeout(startWakeWord, 350);
        };
        try { wakeRec.start(); } catch (e) {
            logEvent('err', 'wakeRec.start failed: ' + e);
        }
    }

    // ============================================================
    //  Command capture (after wake)
    // ============================================================
    function startCommandRecognition() {
        if (!c.hasSR) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        if (TTS) TTS.cancel();

        cmdRec = new SR();
        cmdRec.continuous      = false;
        cmdRec.interimResults  = true;
        cmdRec.lang            = 'en-IN';
        cmdRec.maxAlternatives = 1;

        var captured = '';
        cmdRec.onstart = function () {
            setState('listening');
            logEvent('cmd', 'recognition started');
        };
        cmdRec.onresult = function (ev) {
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                var cf = (res[0] && res[0].confidence) || 0;
                if (!res.isFinal) {
                    c.interim = t;
                    $scope.$applyAsync();
                } else {
                    captured = t;
                    c.confidence = cf ? cf.toFixed(2) : '-';
                    logEvent('cmd.f', '"' + t + '" conf=' + c.confidence);
                }
            }
        };
        cmdRec.onerror = function (ev) {
            logEvent('err', 'cmd recognition error: ' + ev.error);
            setState('idle');
            c.interim = '';
            if (c.wakeOn) $timeout(startWakeWord, 200);
        };
        cmdRec.onend = function () {
            c.interim = '';
            if (captured) handleHeard(captured);
            else {
                logEvent('cmd', 'ended with no transcript');
                setState('idle');
                if (c.wakeOn) $timeout(startWakeWord, 200);
            }
        };

        speak('Yes?', function () {
            try { cmdRec.start(); } catch (e) {
                logEvent('err', 'cmdRec.start failed: ' + e);
                setState('idle');
            }
        });
    }

    // ============================================================
    //  Server round-trip
    // ============================================================
    function handleHeard(transcript) {
        c.lastHeard = transcript;
        setState('thinking');
        cue('think');
        logEvent('srv', 'sending: "' + transcript + '"');

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;

        c.server.update().then(
            function () {
                var r = c.data.response || {};
                if (Array.isArray(r.history)) geminiHistory = r.history;
                if (r.ok) {
                    lastReply = r.message || '';
                    logEvent('srv', 'reply ok (' + lastReply.length + ' chars)');
                    setState('speaking');
                    speak(r.message, function () {
                        setState('idle');
                        if (c.wakeOn) $timeout(startWakeWord, 200);
                    });
                } else {
                    logEvent('err', 'server says: ' + (r.message || 'unknown error'));
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
                logEvent('err', 'transport error: ' + (err && (err.message || err.status) || err));
                speak('Sorry, I could not reach the server.', function () {
                    setState('idle');
                    if (c.wakeOn) $timeout(startWakeWord, 200);
                });
            }
        );
    }

    // ============================================================
    //  TTS
    // ============================================================
    function speak(text, done) {
        if (!c.hasTTS || !text) { if (done) done(); return; }
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
        var v = chooseVoice();
        if (v) { u.voice = v; }

        u.onstart = function () { setState('speaking'); };
        u.onend   = function () { if (done) done(); };
        u.onerror = function (ev) {
            logEvent('err', 'TTS error: ' + (ev && ev.error));
            if (done) done();
        };
        TTS.speak(u);
    }

    function chooseVoice() {
        var voices = TTS.getVoices() || [];
        if (!voices.length) return null;
        if (forcedVoiceName) {
            var fv = voices.find(function (vv) { return vv.name === forcedVoiceName; });
            if (fv) return fv;
        }
        return pickFemaleVoice();
    }

    function pickFemaleVoice() {
        if (!c.hasTTS) return null;
        var voices = TTS.getVoices() || [];
        if (!voices.length) return null;

        var feminineNames = [
            'Neerja', 'Heera', 'Veena', 'Lekha', 'Shruti',
            'Priya', 'Aditi', 'Kalpana', 'Sangeeta',
            'Indian English Female', 'Female (India)',
            'Zira', 'Aria', 'Samantha', 'Karen', 'Susan', 'Female'
        ];
        var pick = null;
        for (var i = 0; i < feminineNames.length; i++) {
            var n = feminineNames[i];
            var match = voices.find(function (vv) {
                return /en[-_]IN/i.test(vv.lang) && vv.name.indexOf(n) >= 0;
            });
            if (match) { pick = match; break; }
        }
        if (!pick) {
            pick = voices.find(function (vv) {
                return /en[-_]IN/i.test(vv.lang) && /Natural|Neural|Online/i.test(vv.name);
            });
        }
        if (!pick) pick = voices.find(function (vv) { return /en[-_]IN/i.test(vv.lang); });
        if (!pick) pick = voices.find(function (vv) { return /^hi[-_]IN/i.test(vv.lang); });
        if (!pick) {
            for (var k = 0; k < feminineNames.length; k++) {
                var m2 = voices.find(function (vv) { return vv.name.indexOf(feminineNames[k]) >= 0; });
                if (m2) { pick = m2; break; }
            }
        }
        if (!pick) {
            pick = voices.find(function (vv) { return /en[-_]US/i.test(vv.lang); }) ||
                   voices.find(function (vv) { return /en[-_]GB/i.test(vv.lang); }) ||
                   voices[0];
        }
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

    // ============================================================
    //  Audio cues
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
    //  Hotkeys
    //    Alt+N - pause / resume
    //    Alt+D - toggle dev panel
    //    Esc   - stop Netra mid-sentence
    // ============================================================
    function bindHotkeys() {
        $window.addEventListener('keydown', function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.tap();
                $scope.$applyAsync();
            }
            if (e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                c.toggleDev();
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
    //  Notification polling
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 9000;
        var tick = function () {
            c.data.action = 'poll';
            c.server.update().then(
                function () {
                    var list = c.data.notifications || [];
                    if (list.length) logEvent('poll', list.length + ' new');
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
    //  DEV PANEL ACTIONS
    // ============================================================
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
        // Need an audio context for downstream cues, even though no mic
        unlockAudio();
        handleHeard(t);
    };

    c.devSkipWake = function () {
        unlockAudio();
        logEvent('dev', 'skip wake -> command recognition');
        startCommandRecognition();
    };

    c.devTestMic = function () {
        if (!c.hasSR) { logEvent('err', 'no SpeechRecognition'); return; }
        unlockAudio();
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (devRec)  devRec.stop();  } catch (e) {}

        devRec = new SR();
        devRec.continuous     = true;
        devRec.interimResults = true;
        devRec.lang           = 'en-IN';
        logEvent('dev', 'TEST MIC - speak now, 8 seconds...');

        devRec.onresult = function (ev) {
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                var cf = (res[0] && res[0].confidence) || 0;
                if (res.isFinal) {
                    logEvent('mic.f', '"' + t.trim() + '" conf=' + (cf ? cf.toFixed(2) : '-'));
                } else {
                    c.interim = t;
                    $scope.$applyAsync();
                }
            }
        };
        devRec.onerror = function (ev) {
            logEvent('err', 'TEST MIC error: ' + ev.error);
        };
        devRec.onend = function () {
            c.interim = '';
            logEvent('dev', 'TEST MIC ended');
            $scope.$applyAsync();
            if (c.wakeOn) $timeout(startWakeWord, 300);
        };
        try {
            devRec.start();
            $timeout(function () { try { devRec.stop(); } catch (e) {} }, 8000);
        } catch (e) {
            logEvent('err', 'TEST MIC start failed: ' + e);
        }
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

    c.devStop = function () {
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
        try { if (devRec)  devRec.stop();  } catch (e) {}
        if (TTS) TTS.cancel();
        c.wakeOn = false;
        setState('paused');
        logEvent('dev', 'stop all');
    };

    c.devClearLog = function () {
        c.events = [];
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

    // ============================================================
    //  State helper
    // ============================================================
    function setState(s) {
        c.state = s;
        c.stateLabel = STATE_LABEL[s] || s;
        $scope.$applyAsync();
    }
};

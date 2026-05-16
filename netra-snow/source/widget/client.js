/**
 * Service Portal widget client controller — netra-mic v2.
 *
 * Adds:
 *   • pending-state two-turn dialogue (e.g. "pause" → "for how long?" → "2 hours")
 *   • pause/resume UI synced with server-side x_netra_user_pref
 *   • last-response memory (for "repeat that")
 *   • smarter wake-word handling (ignores wake when the user is mid-dialogue)
 */
api.controller = function ($scope, $http, $timeout, $window, spUtil) {
    var c = this;

    // -------- public state (bound to template) --------
    c.status         = 'idle';           // idle | listening | thinking | speaking | error
    c.busy           = false;
    c.wakeOn         = true;
    c.lastTranscript = '';
    c.lastResponse   = '';
    c.announcement   = '';
    c.paused         = !!c.data.paused;
    c.pausedUntilLabel = c.data.paused_until ? formatLocalTime(c.data.paused_until) : '';
    c.pendingPrompt  = '';

    // -------- private --------
    var SR  = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS = $window.speechSynthesis;
    var hasSR  = !!SR;
    var hasTTS = !!TTS;

    var cmdRec = null;
    var wakeRec = null;
    var pollTimer = null;
    var seenNotificationIds = {};
    var pendingContext = null;            // server-side pending state echo
    var lastSpoken = '';                  // for "repeat that"

    c.$onInit = function () {
        if (!hasSR) {
            c.lastResponse = 'Your browser does not support speech recognition. Use Chrome or Edge.';
            c.status = 'error';
            announce(c.lastResponse);
            return;
        }
        startWakeWord();
        bindHotkey();
        startNotificationPolling();
        speak('Netra ready.');
    };

    c.$onDestroy = function () {
        try { wakeRec && wakeRec.stop(); } catch (e) {}
        try { cmdRec && cmdRec.stop(); } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (TTS) TTS.cancel();
    };

    // ============================================================
    //  UI handlers
    // ============================================================
    c.toggleRecording = function () {
        if (c.status === 'listening') {
            try { cmdRec && cmdRec.stop(); } catch (e) {}
        } else if (!c.busy) {
            startCommandRecognition();
        }
    };

    c.toggleWake = function () {
        c.wakeOn = !c.wakeOn;
        if (c.wakeOn) startWakeWord();
        else { try { wakeRec && wakeRec.stop(); } catch (e) {} }
        announce(c.wakeOn ? 'Wake word on.' : 'Wake word off.');
    };

    c.askPause = function () {
        // Simulate the user saying "pause" so we go through the same flow
        handleCommand('pause');
    };

    c.resume = function () {
        handleCommand('resume');
    };

    c.help = function () {
        handleCommand('help');
    };

    c.micLabel = function () {
        return c.status === 'listening' ? 'Stop recording' : 'Start recording — click or say Netra';
    };

    c.statusLabel = function () {
        if (c.paused) return 'paused';
        return ({
            idle:      pendingContext ? 'waiting for answer' : 'ready',
            listening: 'listening...',
            thinking:  'thinking...',
            speaking:  'speaking...',
            error:     'error'
        })[c.status] || c.status;
    };

    // ============================================================
    //  Wake word
    // ============================================================
    function startWakeWord() {
        if (!hasSR || !c.wakeOn) return;
        try { wakeRec && wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous = true;
        wakeRec.interimResults = true;
        wakeRec.lang = 'en-US';

        wakeRec.onresult = function (ev) {
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var transcript = ev.results[i][0].transcript.toLowerCase();
                if (c.status !== 'idle' || c.busy) return;
                if (/\bnetra\b/.test(transcript) || /\bjarvis\b/.test(transcript)) {
                    var after = transcript.split(/\bnetra\b|\bjarvis\b/i)[1];
                    if (after && after.trim().length > 3) {
                        handleCommand(after.trim());
                    } else {
                        startCommandRecognition();
                    }
                    return;
                }
            }
        };
        wakeRec.onerror = function () {
            if (c.wakeOn && c.status === 'idle') $timeout(startWakeWord, 800);
        };
        wakeRec.onend = function () {
            if (c.wakeOn && c.status === 'idle') $timeout(startWakeWord, 400);
        };
        try { wakeRec.start(); } catch (e) {}
    }

    // ============================================================
    //  Command recognition
    // ============================================================
    function startCommandRecognition() {
        if (c.busy) return;
        try { wakeRec && wakeRec.stop(); } catch (e) {}
        if (TTS) TTS.cancel();

        cmdRec = new SR();
        cmdRec.continuous = false;
        cmdRec.interimResults = false;
        cmdRec.lang = 'en-US';
        cmdRec.maxAlternatives = 1;

        var captured = '';
        cmdRec.onstart  = function () { c.status = 'listening'; announce('Listening.'); $scope.$applyAsync(); };
        cmdRec.onresult = function (ev) { captured = ev.results[0][0].transcript; };
        cmdRec.onerror  = function (ev) { c.lastResponse = 'I did not catch that. (' + ev.error + ')'; announce(c.lastResponse); resetToIdle(); };
        cmdRec.onend    = function () { captured ? handleCommand(captured) : resetToIdle(); };

        speak('Yes?', function () {
            try { cmdRec.start(); } catch (e) { resetToIdle(); }
        });
    }

    // ============================================================
    //  Server round-trip
    // ============================================================
    function handleCommand(transcript) {
        c.lastTranscript = transcript;
        c.status = 'thinking';
        c.busy = true;
        announce('Processing.');
        $scope.$applyAsync();

        $http.post('/api/x_netra/voice/command', {
            transcript: transcript,
            pending: pendingContext
        })
        .then(function (resp) {
            var d = resp.data || {};

            // Handle "repeat that"
            var msg = d.message;
            if (msg === '__REPEAT__') msg = lastSpoken || "I haven't said anything yet.";

            c.lastResponse = msg;
            announce(msg);

            // Pending-state bookkeeping
            if (d.pending) {
                pendingContext = d.pending;
                c.pendingPrompt = msg;       // show the question on screen too
            } else if (d.clear_pending) {
                pendingContext = null;
                c.pendingPrompt = '';
            }

            // Pause state may have changed
            if (typeof d.paused === 'boolean') {
                c.paused = d.paused;
                if (d.paused) {
                    // Refresh paused-until label from a follow-up GET
                    refreshPauseStatus();
                } else {
                    c.pausedUntilLabel = '';
                }
            }

            if (d.refresh_tickets) spUtil.update($scope);

            if (d.stop) { resetToIdle(); return; }

            speak(msg, function () {
                resetToIdle(/*keepPending=*/ !!d.pending);
            });
        })
        .catch(function () {
            c.lastResponse = 'Sorry, something went wrong on the server.';
            announce(c.lastResponse);
            speak(c.lastResponse, function () { resetToIdle(); });
        });
    }

    function resetToIdle(keepPending) {
        c.status = 'idle';
        c.busy = false;
        if (!keepPending) {
            // pendingContext already cleared by caller if needed
        }
        $scope.$applyAsync();
        if (c.wakeOn) $timeout(startWakeWord, 300);
    }

    function refreshPauseStatus() {
        // Re-read the pause window from the notifications endpoint
        $http.get('/api/x_netra/voice/notifications').then(function (resp) {
            var d = resp.data || {};
            c.paused = !!d.paused;
            c.pausedUntilLabel = d.paused_until ? formatLocalTime(d.paused_until) : '';
        });
    }

    // ============================================================
    //  TTS
    // ============================================================
    function speak(text, done) {
        if (!hasTTS || !text) { if (done) done(); return; }
        TTS.cancel();
        lastSpoken = text;
        var u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.lang = 'en-US';
        var voices = TTS.getVoices();
        var pick = voices.find(function (v) { return /Natural|Online|Google/i.test(v.name); })
                || voices.find(function (v) { return /en-US/i.test(v.lang); });
        if (pick) u.voice = pick;

        u.onstart = function () { c.status = 'speaking'; $scope.$applyAsync(); };
        u.onend   = function () { if (done) done(); };
        u.onerror = function () { if (done) done(); };
        TTS.speak(u);
    }

    // ============================================================
    //  Notification polling — proactive interrupts (respects pause)
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 8000;
        var tick = function () {
            $http.get('/api/x_netra/voice/notifications')
                .then(function (resp) {
                    var d = resp.data || {};
                    c.paused = !!d.paused;
                    c.pausedUntilLabel = d.paused_until ? formatLocalTime(d.paused_until) : '';
                    var list = d.notifications || [];
                    list.forEach(function (n) {
                        if (seenNotificationIds[n.id]) return;
                        if (c.status === 'listening' || c.status === 'speaking') return;
                        seenNotificationIds[n.id] = true;
                        c.lastResponse = n.message;
                        announce(n.message);
                        speak(n.message);
                    });
                })
                .finally(function () {
                    pollTimer = $timeout(tick, POLL_MS);
                });
        };
        pollTimer = $timeout(tick, 2000);
    }

    // ============================================================
    //  Helpers
    // ============================================================
    function announce(text) {
        c.announcement = '';
        $timeout(function () { c.announcement = text; }, 30);
    }

    function bindHotkey() {
        $window.addEventListener('keydown', function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.toggleRecording();
                $scope.$applyAsync();
            }
            if (e.key === 'Escape' && TTS) {
                TTS.cancel();
                pendingContext = null;
                c.pendingPrompt = '';
                resetToIdle();
            }
        });
    }

    function formatLocalTime(gdt) {
        if (!gdt) return '';
        // Server gives us a UTC "YYYY-MM-DD HH:MM:SS"; convert to local clock time
        try {
            var iso = String(gdt).replace(' ', 'T') + 'Z';
            var dt = new Date(iso);
            return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return gdt;
        }
    }
};

/**
 * Service Portal widget client controller - netra-mic (v4 - self-contained)
 *
 * Replaces every $http call with c.server.update(). The widget no longer
 * touches /api/<scope>/voice/* at all - the Scripted REST API can be
 * deleted (or left as a diagnostic tool, your call).
 *
 * Standard SP server round-trip pattern:
 *   1. set c.data.action = '<command|poll>' and other inputs
 *   2. call c.server.update()
 *   3. read c.data.response or c.data.notifications in the .then()
 */
api.controller = function ($scope, $timeout, $window, spUtil) {
    var c = this;

    // -------- state bound to the template --------
    c.status           = 'idle';
    c.busy             = false;
    c.wakeOn           = true;
    c.lastTranscript   = '';
    c.lastResponse     = '';
    c.announcement     = '';
    c.paused           = !!c.data.paused;
    c.pausedUntilLabel = c.data.paused_until ? formatLocalTime(c.data.paused_until) : '';
    c.pendingPrompt    = '';

    // -------- private --------
    var SR     = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS    = $window.speechSynthesis;
    var hasSR  = !!SR;
    var hasTTS = !!TTS;

    var cmdRec    = null;
    var wakeRec   = null;
    var pollTimer = null;
    var seenNotificationIds = {};
    var pendingContext = null;
    var lastSpoken     = '';

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
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (cmdRec) cmdRec.stop(); } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (TTS) TTS.cancel();
    };

    // ============================================================
    //  UI handlers
    // ============================================================
    c.toggleRecording = function () {
        if (c.status === 'listening') {
            try { if (cmdRec) cmdRec.stop(); } catch (e) {}
        } else if (!c.busy) {
            startCommandRecognition();
        }
    };

    c.toggleWake = function () {
        c.wakeOn = !c.wakeOn;
        if (c.wakeOn) startWakeWord();
        else { try { if (wakeRec) wakeRec.stop(); } catch (e) {} }
        announce(c.wakeOn ? 'Wake word on.' : 'Wake word off.');
    };

    c.askPause = function () { handleCommand('pause'); };
    c.resume   = function () { handleCommand('resume'); };
    c.help     = function () { handleCommand('help'); };

    c.micLabel = function () {
        return c.status === 'listening' ? 'Stop recording' : 'Start recording - click or say Netra';
    };

    c.statusLabel = function () {
        if (c.paused) return 'paused';
        var labels = {
            idle:      pendingContext ? 'waiting for answer' : 'ready',
            listening: 'listening...',
            thinking:  'thinking...',
            speaking:  'speaking...',
            error:     'error'
        };
        return labels[c.status] || c.status;
    };

    // ============================================================
    //  Wake word
    // ============================================================
    function startWakeWord() {
        if (!hasSR || !c.wakeOn) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous     = true;
        wakeRec.interimResults = true;
        wakeRec.lang           = 'en-US';

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
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        if (TTS) TTS.cancel();

        cmdRec = new SR();
        cmdRec.continuous      = false;
        cmdRec.interimResults  = false;
        cmdRec.lang            = 'en-US';
        cmdRec.maxAlternatives = 1;

        var captured = '';
        cmdRec.onstart  = function () { c.status = 'listening'; announce('Listening.'); $scope.$applyAsync(); };
        cmdRec.onresult = function (ev) { captured = ev.results[0][0].transcript; };
        cmdRec.onerror  = function (ev) { c.lastResponse = 'I did not catch that. (' + ev.error + ')'; announce(c.lastResponse); resetToIdle(); };
        cmdRec.onend    = function () { if (captured) { handleCommand(captured); } else { resetToIdle(); } };

        speak('Yes?', function () {
            try { cmdRec.start(); } catch (e) { resetToIdle(); }
        });
    }

    // ============================================================
    //  Server round-trip via c.server.update() - PROVEN SP PATTERN
    // ============================================================
    function handleCommand(transcript) {
        c.lastTranscript = transcript;
        c.status = 'thinking';
        c.busy = true;
        announce('Processing.');
        $scope.$applyAsync();

        c.data.action     = 'command';
        c.data.transcript = transcript;
        c.data.pending    = pendingContext;

        c.server.update().then(
            function () {
                var d = c.data.response || {};
                var msg = d.message;
                if (msg === '__REPEAT__') msg = lastSpoken || "I haven't said anything yet.";

                c.lastResponse = msg;
                announce(msg);

                if (d.pending) {
                    pendingContext = d.pending;
                    c.pendingPrompt = msg;
                } else if (d.clear_pending) {
                    pendingContext = null;
                    c.pendingPrompt = '';
                }

                if (typeof d.paused === 'boolean') {
                    c.paused = d.paused;
                    c.pausedUntilLabel = c.data.paused_until ? formatLocalTime(c.data.paused_until) : '';
                }

                if (d.refresh_tickets && spUtil && spUtil.update) {
                    try { spUtil.update($scope); } catch (e) {}
                }

                if (d.stop) { resetToIdle(); return; }

                if (d.navigate) {
                    speak(msg, function () {
                        resetToIdle();
                        $window.location.href = d.navigate;
                    });
                    return;
                }

                speak(msg, function () {
                    resetToIdle(!!d.pending);
                });
            },
            function (err) {
                var detail = (err && err.message) ? err.message : 'unknown';
                if ($window.console && $window.console.error) {
                    $window.console.error('[Netra] c.server.update(command) failed:', err);
                }
                c.lastResponse = 'Server call failed: ' + detail;
                announce(c.lastResponse);
                speak(c.lastResponse, function () { resetToIdle(); });
            }
        );
    }

    function resetToIdle(keepPending) {
        c.status = 'idle';
        c.busy = false;
        $scope.$applyAsync();
        if (c.wakeOn) $timeout(startWakeWord, 300);
    }

    // ============================================================
    //  TTS
    // ============================================================
    function speak(text, done) {
        if (!hasTTS || !text) { if (done) done(); return; }
        TTS.cancel();
        lastSpoken = text;
        var u = new SpeechSynthesisUtterance(text);
        u.rate  = 1.0;
        u.pitch = 1.0;
        u.lang  = 'en-US';
        var voices = TTS.getVoices();
        var pick = voices.find(function (v) { return /Natural|Online|Google/i.test(v.name); }) ||
                   voices.find(function (v) { return /en-US/i.test(v.lang); });
        if (pick) u.voice = pick;
        u.onstart = function () { c.status = 'speaking'; $scope.$applyAsync(); };
        u.onend   = function () { if (done) done(); };
        u.onerror = function () { if (done) done(); };
        TTS.speak(u);
    }

    // ============================================================
    //  Notification polling - via c.server.update({action:'poll'})
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 8000;
        var tick = function () {
            c.data.action = 'poll';
            c.server.update().then(
                function () {
                    c.paused = !!c.data.paused;
                    c.pausedUntilLabel = c.data.paused_until ? formatLocalTime(c.data.paused_until) : '';
                    var list = c.data.notifications || [];
                    list.forEach(function (n) {
                        if (seenNotificationIds[n.id]) return;
                        if (c.status === 'listening' || c.status === 'speaking') return;
                        seenNotificationIds[n.id] = true;
                        c.lastResponse = n.message;
                        announce(n.message);
                        speak(n.message);
                    });
                },
                function (err) {
                    if ($window.console && $window.console.warn) {
                        $window.console.warn('[Netra] poll failed:', err);
                    }
                }
            ).finally(function () {
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
        try {
            var iso = String(gdt).replace(' ', 'T') + 'Z';
            var dt  = new Date(iso);
            return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return gdt;
        }
    }
};

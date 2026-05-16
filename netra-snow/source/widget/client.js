/**
 * Service Portal widget client controller — netra-mic.
 *
 * Free stack:
 *   - SpeechRecognition (Web Speech API) for STT — built into Chrome/Edge
 *   - SpeechSynthesis for TTS — built into every modern browser
 *
 * State machine:  idle → listening → thinking → speaking → idle
 *
 * Wake word: a separate, low-priority SpeechRecognition instance runs
 * continuously and scans transcripts for "netra". When seen, we flip into
 * full listening mode and treat anything after the wake word as the command.
 */
api.controller = function ($scope, $http, $timeout, $window, spUtil) {
    var c = this;

    // -------- public state --------
    c.status         = 'idle';           // idle | listening | thinking | speaking | error
    c.busy           = false;
    c.wakeOn         = true;
    c.lastTranscript = '';
    c.lastResponse   = '';
    c.announcement   = '';

    // -------- private --------
    var SR  = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS = $window.speechSynthesis;
    var hasSR  = !!SR;
    var hasTTS = !!TTS;

    var cmdRec = null;   // recognition instance for active commands
    var wakeRec = null;  // recognition instance always-listening for the wake word
    var pollTimer = null;
    var seenNotificationIds = {};

    // ============================================================
    // boot
    // ============================================================
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
    // UI handlers
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

    c.help = function () {
        speak("You can say: create a ticket for, list my tickets, " +
              "resolve I N C followed by the number, update a ticket with a comment, " +
              "or ask for the status of a ticket. Say stop at any time.");
    };

    c.micLabel = function () {
        return c.status === 'listening' ? 'Stop recording' : 'Start recording — say or click';
    };

    c.statusLabel = function () {
        return ({
            idle:      'ready',
            listening: 'listening...',
            thinking:  'thinking...',
            speaking:  'speaking...',
            error:     'error'
        })[c.status] || c.status;
    };

    // ============================================================
    // wake word
    // ============================================================
    function startWakeWord() {
        if (!hasSR || !c.wakeOn) return;
        try { wakeRec && wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous = true;
        wakeRec.interimResults = true;
        wakeRec.lang = 'en-US';

        wakeRec.onresult = function (ev) {
            // Only act on final results to avoid double-firing on interim words
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var transcript = ev.results[i][0].transcript.toLowerCase();
                if (c.status !== 'idle') return;
                if (/\bnetra\b/.test(transcript) || /\bjarvis\b/.test(transcript)) {
                    // Maybe the user said "Netra <command>" in one breath
                    var after = transcript.split(/\bnetra\b|\bjarvis\b/i)[1];
                    if (after && after.trim().length > 3) {
                        // Treat the rest of this utterance as the command, no second mic prompt
                        handleCommand(after.trim());
                    } else {
                        startCommandRecognition();
                    }
                    return;
                }
            }
        };
        wakeRec.onerror = function (ev) {
            // 'no-speech' and 'aborted' are routine — silently restart
            if (c.wakeOn && c.status === 'idle') {
                $timeout(startWakeWord, 800);
            }
        };
        wakeRec.onend = function () {
            // Browsers eventually stop continuous recognition; restart while we're idle
            if (c.wakeOn && c.status === 'idle') {
                $timeout(startWakeWord, 400);
            }
        };
        try { wakeRec.start(); } catch (e) { /* already started */ }
    }

    // ============================================================
    // command recognition (after wake word OR mic-button click)
    // ============================================================
    function startCommandRecognition() {
        if (c.busy) return;
        // Stop wake-word listener while we capture the command
        try { wakeRec && wakeRec.stop(); } catch (e) {}
        if (TTS) TTS.cancel();

        cmdRec = new SR();
        cmdRec.continuous = false;
        cmdRec.interimResults = false;
        cmdRec.lang = 'en-US';
        cmdRec.maxAlternatives = 1;

        var captured = '';
        cmdRec.onstart = function () {
            c.status = 'listening';
            announce('Listening.');
            $scope.$applyAsync();
        };
        cmdRec.onresult = function (ev) {
            captured = ev.results[0][0].transcript;
        };
        cmdRec.onerror = function (ev) {
            c.lastResponse = 'I did not catch that. (' + ev.error + ')';
            announce(c.lastResponse);
            resetToIdle();
        };
        cmdRec.onend = function () {
            if (captured) {
                handleCommand(captured);
            } else {
                resetToIdle();
            }
        };

        // Small chirp before capture so the user knows we're listening
        speak('Yes?', function () {
            try { cmdRec.start(); } catch (e) { resetToIdle(); }
        });
    }

    // ============================================================
    // server round-trip
    // ============================================================
    function handleCommand(transcript) {
        c.lastTranscript = transcript;
        c.status = 'thinking';
        c.busy = true;
        announce('Processing.');
        $scope.$applyAsync();

        $http.post('/api/x_netra/voice/command', { transcript: transcript })
            .then(function (resp) {
                var d = resp.data || {};
                c.lastResponse = d.message || '';
                announce(c.lastResponse);
                if (d.refresh_tickets) {
                    // Inform any listening widgets to reload tickets
                    spUtil.update($scope);
                }
                if (d.stop) {
                    resetToIdle();
                    return;
                }
                speak(c.lastResponse, resetToIdle);
            })
            .catch(function (err) {
                c.lastResponse = 'Sorry, something went wrong on the server.';
                announce(c.lastResponse);
                speak(c.lastResponse, resetToIdle);
            });
    }

    function resetToIdle() {
        c.status = 'idle';
        c.busy = false;
        $scope.$applyAsync();
        if (c.wakeOn) $timeout(startWakeWord, 300);
    }

    // ============================================================
    // text-to-speech
    // ============================================================
    function speak(text, done) {
        if (!hasTTS || !text) { if (done) done(); return; }
        TTS.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.lang = 'en-US';
        // Prefer a natural-sounding voice when available
        var voices = TTS.getVoices();
        var pick = voices.find(function (v) { return /Natural|Online|Google/i.test(v.name); })
                || voices.find(function (v) { return /en-US/i.test(v.lang); });
        if (pick) u.voice = pick;

        u.onstart = function () { c.status = 'speaking'; $scope.$applyAsync(); };
        u.onend = function ()   { if (done) done(); };
        u.onerror = function () { if (done) done(); };
        TTS.speak(u);
    }

    // ============================================================
    // notification polling — proactive interrupts
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 8000;
        var tick = function () {
            $http.get('/api/x_netra/voice/notifications')
                .then(function (resp) {
                    var list = (resp.data && resp.data.notifications) || [];
                    list.forEach(function (n) {
                        if (seenNotificationIds[n.id]) return;
                        seenNotificationIds[n.id] = true;
                        // Don't interrupt while the user is mid-command
                        if (c.status === 'listening' || c.status === 'speaking') {
                            // requeue once: leave for next tick
                            delete seenNotificationIds[n.id];
                            return;
                        }
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
    // helpers
    // ============================================================
    function announce(text) {
        c.announcement = '';
        $timeout(function () { c.announcement = text; }, 30);
    }

    function bindHotkey() {
        $window.addEventListener('keydown', function (e) {
            // Alt+N — push-to-talk
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.toggleRecording();
                $scope.$applyAsync();
            }
            // Escape — stop talking
            if (e.key === 'Escape' && TTS) {
                TTS.cancel();
                resetToIdle();
            }
        });
    }
};

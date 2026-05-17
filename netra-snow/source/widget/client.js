/**
 * Netra Mic widget - CLIENT CONTROLLER  (v5 - Gemini agent)
 *
 * Modern Gemini-style chat with Indian English voice (en-IN), wake word,
 * push-to-talk, and full tool-use conversation history.
 *
 * All round-trips go through c.server.update() - no Scripted REST,
 * no $http.post, no 400-prone cross-scope calls.
 */
api.controller = function ($scope, $timeout, $window, $sce, spUtil) {
    var c = this;

    // -------- UI state bound to template --------
    c.expanded   = false;
    c.messages   = [];          // { role, html, text, time }
    c.thinking   = false;
    c.draft      = '';
    c.listening  = false;
    c.wakeOn     = true;
    c.needSetup  = !c.data.has_api_key;
    c.paused     = !!c.data.paused;
    c.pendingNotify = '';

    // -------- private --------
    var SR     = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var TTS    = $window.speechSynthesis;
    var hasSR  = !!SR;
    var hasTTS = !!TTS;

    var cmdRec    = null;
    var wakeRec   = null;
    var pollTimer = null;
    var seenIds   = {};
    var geminiHistory = [];     // model-side conversation
    var voicesReady   = false;

    c.$onInit = function () {
        // Pre-warm voice list (browsers populate async)
        if (hasTTS) {
            TTS.getVoices();
            try { TTS.addEventListener('voiceschanged', function(){ voicesReady = true; }); } catch (e) {}
        }
        if (hasSR && !c.needSetup) startWakeWord();
        bindHotkey();
        startNotificationPolling();
    };

    c.$onDestroy = function () {
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}
        try { if (cmdRec)  cmdRec.stop();  } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (TTS) TTS.cancel();
    };

    // ============================================================
    //  UI bindings
    // ============================================================
    c.expand   = function () { c.expanded = true; };
    c.collapse = function () { c.expanded = false; };

    c.send = function (text) {
        var msg = (text != null ? text : c.draft || '').trim();
        if (!msg) return;
        c.draft = '';
        c.expanded = true;
        pushMessage('user', msg);
        c.thinking = true;
        scrollSoon();

        c.data.action  = 'chat';
        c.data.message = msg;
        c.data.history = geminiHistory;

        c.server.update().then(
            function () {
                c.thinking = false;
                var r = c.data.response || {};
                if (r.ok) {
                    pushMessage('assistant', r.message);
                    if (Array.isArray(r.history)) geminiHistory = r.history;
                    if (typeof r.paused === 'boolean') c.paused = r.paused;
                    speak(r.message);
                } else {
                    pushMessage('assistant', '⚠️ ' + (r.message || 'Something went wrong.'));
                    speak(r.message || 'Sorry, something went wrong.');
                }
                scrollSoon();
            },
            function (err) {
                c.thinking = false;
                var detail = (err && err.message) ? err.message : 'Could not reach server.';
                pushMessage('assistant', '⚠️ Server call failed: ' + detail);
                if ($window.console && $window.console.error) $window.console.error('[Netra]', err);
                scrollSoon();
            }
        );
    };

    c.onKeyPress = function (ev) {
        if ((ev.which || ev.keyCode) === 13 && !ev.shiftKey) {
            ev.preventDefault();
            c.send();
        }
    };

    c.toggleMic = function () {
        if (!hasSR) {
            pushMessage('assistant', 'Voice input is not supported in this browser. Kindly use Chrome or Edge, or just type below.');
            return;
        }
        if (c.listening) {
            try { if (cmdRec) cmdRec.stop(); } catch (e) {}
        } else {
            startCommandRecognition();
        }
    };

    c.toggleWake = function () {
        c.wakeOn = !c.wakeOn;
        if (c.wakeOn) startWakeWord();
        else { try { if (wakeRec) wakeRec.stop(); } catch (e) {} }
    };

    c.newChat = function () {
        c.messages = [];
        geminiHistory = [];
        c.draft = '';
        if (TTS) TTS.cancel();
    };

    c.quick = function (text) { c.send(text); };

    c.dismissNotify = function () { c.pendingNotify = ''; };

    // ============================================================
    //  Markdown -> safe HTML for chat bubbles
    // ============================================================
    function pushMessage(role, text) {
        c.messages.push({
            role: role,
            text: text,
            html: $sce.trustAsHtml(formatMarkdown(text)),
            time: nowHM()
        });
    }

    function formatMarkdown(s) {
        s = String(s == null ? '' : s);
        // Escape first
        s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Code blocks ``` ... ```
        s = s.replace(/```([\s\S]*?)```/g, function (_, code) {
            return '<pre><code>' + code.trim() + '</code></pre>';
        });
        // Inline code
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold / italic
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // Ticket numbers as visible chips
        s = s.replace(/\b(INC|CHG|RITM|REQ|SCTASK|KB|PRB)\d{6,}\b/g, function (n) {
            return '<span class="netra-num">' + n + '</span>';
        });
        // Line breaks
        s = s.replace(/\n/g, '<br>');
        return s;
    }

    function nowHM() {
        var d = new Date();
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function scrollSoon() {
        $timeout(function () {
            var el = document.querySelector('.netra-messages');
            if (el) el.scrollTop = el.scrollHeight;
        }, 30);
    }

    // ============================================================
    //  Indian English TTS (en-IN preferred)
    // ============================================================
    function speak(text) {
        if (!hasTTS || !text) return;
        // Strip markdown leftovers for clean speech
        var clean = String(text)
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        TTS.cancel();
        var u = new SpeechSynthesisUtterance(clean);
        u.lang  = 'en-IN';
        u.rate  = 0.95;
        u.pitch = 1.0;
        var voices = TTS.getVoices() || [];
        var pick =
            voices.find(function (v) { return /en[-_]IN/i.test(v.lang) && /Natural|Neural|Online/i.test(v.name); }) ||
            voices.find(function (v) { return /Neerja|Heera|Prabhat|Ravi|Veena|Rishi|Lekha/i.test(v.name); }) ||
            voices.find(function (v) { return /en[-_]IN/i.test(v.lang); }) ||
            voices.find(function (v) { return /^Google.*हिन्दी|Hindi/i.test(v.name); }) ||
            voices.find(function (v) { return /en[-_]GB/i.test(v.lang); }) ||
            voices.find(function (v) { return /en[-_]US/i.test(v.lang); });
        if (pick) u.voice = pick;
        TTS.speak(u);
    }

    // ============================================================
    //  Wake word ("Netra")
    // ============================================================
    function startWakeWord() {
        if (!hasSR || !c.wakeOn) return;
        try { if (wakeRec) wakeRec.stop(); } catch (e) {}

        wakeRec = new SR();
        wakeRec.continuous     = true;
        wakeRec.interimResults = true;
        wakeRec.lang           = 'en-IN';

        wakeRec.onresult = function (ev) {
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var t = ev.results[i][0].transcript.toLowerCase();
                if (c.listening || c.thinking) return;
                if (/\bnetra\b/.test(t) || /\bhello netra\b/.test(t)) {
                    c.expanded = true;
                    var after = t.split(/\bnetra\b|\bhello netra\b/i)[1];
                    if (after && after.trim().length > 3) {
                        c.send(after.trim());
                    } else {
                        startCommandRecognition();
                    }
                    $scope.$applyAsync();
                    return;
                }
            }
        };
        wakeRec.onerror = function () {
            if (c.wakeOn && !c.listening) $timeout(startWakeWord, 800);
        };
        wakeRec.onend = function () {
            if (c.wakeOn && !c.listening) $timeout(startWakeWord, 400);
        };
        try { wakeRec.start(); } catch (e) {}
    }

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
        cmdRec.onstart  = function () { c.listening = true;  $scope.$applyAsync(); };
        cmdRec.onresult = function (ev) { captured = ev.results[0][0].transcript; };
        cmdRec.onerror  = function ()    { c.listening = false; $scope.$applyAsync(); };
        cmdRec.onend    = function ()    {
            c.listening = false;
            $scope.$applyAsync();
            if (captured) c.send(captured);
            else if (c.wakeOn) $timeout(startWakeWord, 300);
        };
        try { cmdRec.start(); } catch (e) {}
    }

    function bindHotkey() {
        $window.addEventListener('keydown', function (e) {
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                c.expanded = true;
                if (!c.listening) c.toggleMic();
                $scope.$applyAsync();
            }
            if (e.key === 'Escape') {
                if (TTS) TTS.cancel();
                c.listening = false;
                $scope.$applyAsync();
            }
        });
    }

    // ============================================================
    //  Notification polling (proactive interrupts)
    // ============================================================
    function startNotificationPolling() {
        var POLL_MS = 8000;
        var tick = function () {
            c.data.action = 'poll';
            c.server.update().then(
                function () {
                    if (typeof c.data.paused === 'boolean') c.paused = c.data.paused;
                    var list = c.data.notifications || [];
                    list.forEach(function (n) {
                        if (seenIds[n.id]) return;
                        seenIds[n.id] = true;
                        if (c.listening || c.thinking) return;
                        c.pendingNotify = n.message;
                        pushMessage('assistant', '🔔 ' + n.message);
                        speak(n.message);
                        scrollSoon();
                    });
                },
                function () { /* silent - polling */ }
            ).finally(function () {
                pollTimer = $timeout(tick, POLL_MS);
            });
        };
        pollTimer = $timeout(tick, 2500);
    }
};

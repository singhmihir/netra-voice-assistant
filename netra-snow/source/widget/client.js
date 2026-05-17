/**
 * Netra Mic widget - CLIENT CONTROLLER (v8 - always-on, voice-controlled)
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

    var DEV_DEFAULT_ON  = true;   // dev panel visible by default
    var WAKE_TIMEOUT_MS = 8000;   // time to wait for follow-up command after bare "Netra"
    var MIN_CONFIDENCE  = 0.3;    // below this, ask for repetition
    var RESTART_DELAY   = 250;    // ms before reopening recognition after onend
    var TTS_GUARD_MS    = 350;    // ignore mic finals this long after TTS ends (echo)

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
    var ignoreFinalsUntil = 0;   // timestamp - we ignore finals before this
    var commandMode = false;
    var commandTimer = null;

    /* ============================================================
     *  FUZZY WAKE WORD
     *  Real-world ASR mishears "Netra" as: Neetra, Naitra, Mitra,
     *  Metro, Mantra, Centra, Netro, Natra, Nitra, Nehra, etc.
     * ============================================================ */
    var WAKE_PATTERNS = [
        /\bnetra\b/i,    /\bneetra\b/i,  /\bnaitra\b/i,
        /\bnetro\b/i,    /\bnetera\b/i,  /\bnatra\b/i,
        /\bnitra\b/i,    /\bmetra\b/i,   /\bmehra\b/i,
        /\bmantra\b/i,   /\bcentra\b/i,  /\bintra\b/i,
        /\bnehra\b/i,    /\bneatre\b/i,  /\bneera\b/i,
        /\bnetwra\b/i,   /\bnektra\b/i,
        /\bhey\s+net\w*\b/i, /\bok\s+net\w*\b/i,
        /\bhello\s+net\w*\b/i, /\bnehtra\b/i
    ];

    function matchesWake(text) {
        if (!text) return null;
        for (var i = 0; i < WAKE_PATTERNS.length; i++) {
            var p = WAKE_PATTERNS[i];
            if (p.test(text)) {
                var rest = text.replace(p, ' ').replace(/^[,.\s]+/, '').replace(/\s+/g,' ').trim();
                return rest;
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

        // greetings
        if (/^(hi|hello|hey|namaste|good\s*(morning|afternoon|evening|day))\b/.test(lc) && lc.length < 30) {
            var h = new Date().getHours();
            var greet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
            return { intent: 'greet', reply: greet + ', how may I help you?' };
        }
        // thanks
        if (/\b(thanks|thank you|thanks a lot|much appreciated)\b/.test(lc) && lc.length < 35) {
            return { intent: 'thanks', reply: 'You are most welcome. Do let me know if anything else is required.' };
        }
        // identity
        if (/\b(who are you|what are you|your name|introduce yourself|tell me about yourself)\b/.test(lc)) {
            return { intent: 'identity', reply: 'I am Netra, your voice assistant for ServiceNow. I can open tickets, list your open issues, resolve them, search the knowledge base, and handle approvals - all by voice.' };
        }
        // capabilities / help
        if (/\b(what can you do|help me|your capabilities|commands|what do you do)\b/.test(lc)) {
            return { intent: 'help', reply: 'You can ask me to open a ticket, list your open incidents, resolve a ticket, add a comment, check approvals, or search the knowledge base. Just speak naturally in plain English.' };
        }
        // time
        if (/\b(what(\s+is|\'s)?(\s+the)?\s+time|tell\s+me\s+the\s+time|current\s+time)\b/.test(lc)) {
            var t = new Date();
            var hh = t.getHours(), mm = t.getMinutes();
            var ampm = hh < 12 ? 'AM' : 'PM';
            var h12 = hh % 12; if (h12 === 0) h12 = 12;
            return { intent: 'time', reply: 'The time is ' + h12 + ' ' + (mm < 10 ? 'oh ' + mm : mm) + ' ' + ampm + '.' };
        }
        // date
        if (/\b(what(\s+is|\'s)?(\s+the|today\'?s)?\s+date|today\'?s\s+date|what day is)\b/.test(lc)) {
            var d = new Date();
            var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            return { intent: 'date', reply: 'Today is ' + days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + '.' };
        }
        // small talk
        if (/\b(how are you|how\'?s it going|how do you do)\b/.test(lc)) {
            return { intent: 'smalltalk', reply: 'I am doing well, thank you. Ready to help whenever you are.' };
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

        // common misheard prefixes
        out = out.replace(/\bink\b/gi, 'INC');
        out = out.replace(/\bI\s*and\s*C\b/gi, 'INC');

        // coalesce PREFIX + digits possibly separated by spaces
        out = out.replace(/\b(INC|CHG|RITM|SCTASK|PRB|KB)\s*([\d\s]+)/g, function (_, prefix, digits) {
            var cleaned = digits.replace(/\s+/g,'');
            // pad to 7 digits for incident-like
            if (cleaned.length > 0 && cleaned.length < 7 && /^(INC|CHG|RITM|SCTASK|PRB)$/.test(prefix)) {
                while (cleaned.length < 7) cleaned = '0' + cleaned;
            }
            return prefix + cleaned;
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
     *  LIFECYCLE
     * ============================================================ */
    c.$onInit = function () {
        setState('boot');
        logEvent('init', 'controller v8 booting, SR=' + c.hasSR + ' TTS=' + c.hasTTS + ' GrammarList=' + !!SGL);

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
        c.recRunning = false;
        try { if (contRec) contRec.stop(); } catch (e) {}
        if (pollTimer) $timeout.cancel(pollTimer);
        if (commandTimer) $timeout.cancel(commandTimer);
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

    c.tap = function () {
        if (!booted) { tryBoot(true); return; }
        // toggle sleep/wake by tap as a convenience for sighted helpers
        if (c.alert) {
            c.alert = false;
            setState('dormant');
            speak('Going to sleep. Say Netra to wake me.');
        } else {
            c.alert = true;
            setState('idle');
            cue('resume');
            speak('Yes, I am back.');
        }
    };

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
            booted     = true;
            c.needsTap = false;
            startNotificationPolling();
            setState('idle');
            logEvent('boot', 'continuous recognition started (always-on)');

            var name = (c.data && c.data.user_name) ? c.data.user_name : 'there';
            $timeout(function () {
                speak('Hello ' + name + '. I am Netra, your voice assistant. The microphone is always open. Say my name whenever you need me. Say "stop listening" if you want me to sleep.');
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
    function startContinuous() {
        if (!c.hasSR) return;
        try { if (contRec) contRec.stop(); } catch (e) {}

        contRec = new SR();
        contRec.continuous     = true;
        contRec.interimResults = true;
        contRec.lang           = 'en-IN';
        contRec.maxAlternatives = 1;
        attachGrammar(contRec);

        contRec.onstart = function () {
            c.recRunning = true;
            $scope.$applyAsync();
        };

        contRec.onresult = function (ev) {
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var res = ev.results[i];
                var t = (res[0] && res[0].transcript) || '';
                var conf = (res[0] && res[0].confidence) || 0;
                if (!res.isFinal) {
                    c.interim = t;
                    $scope.$applyAsync();
                    continue;
                }
                c.interim = '';
                // Ignore echoes of Netra's own TTS
                if (Date.now() < ignoreFinalsUntil) {
                    logEvent('rec.echo', '"' + t.trim() + '" (ignored - within TTS guard)');
                    continue;
                }
                processFinalTranscript(t, conf);
            }
        };

        contRec.onerror = function (ev) {
            // 'no-speech', 'audio-capture' are routine in always-on mode
            if (ev.error === 'no-speech' || ev.error === 'audio-capture') return;
            if (ev.error === 'not-allowed') {
                logEvent('err', 'mic permission DENIED - aborting recognition');
                c.recRunning = false;
                setState('error');
                c.permission = 'denied';
                $scope.$applyAsync();
                return;
            }
            logEvent('err', 'recognition error: ' + ev.error);
        };

        contRec.onend = function () {
            c.recRunning = false;
            $scope.$applyAsync();
            // Always restart unless permission was denied
            if (c.permission === 'denied') return;
            $timeout(startContinuous, RESTART_DELAY);
        };

        try { contRec.start(); }
        catch (e) {
            logEvent('err', 'contRec.start failed: ' + e);
            // common cause: already started
            $timeout(startContinuous, 1000);
        }
    }

    function attachGrammar(rec) {
        if (!SGL) return;
        try {
            var domain = '#JSGF V1.0; grammar netra; public <command> = ' +
                'netra | hey netra | ok netra | hello netra | neetra | naitra | ' +
                'open | list | resolve | close | approve | reject | comment | update | search | knowledge | ' +
                'ticket | incident | INC | CHG | RITM | approval | change | request | task | problem | ' +
                'pause | resume | stop | start | listen | sleep | wake | wake up | go to sleep | ' +
                'urgent | critical | high | medium | low | priority | ' +
                'status | what | which | how | when | who | where | tell me | show me | read | ' +
                'zero | one | two | three | four | five | six | seven | eight | nine | ten ;';
            var list = new SGL();
            list.addFromString(domain, 0.6);
            rec.grammars = list;
            logEvent('init', 'speech grammar attached (domain vocab biasing)');
        } catch (e) {
            logEvent('warn', 'grammar not supported: ' + e);
        }
    }

    /* ============================================================
     *  FINAL TRANSCRIPT DISPATCH
     * ============================================================ */
    function processFinalTranscript(text, conf) {
        var clean = (text || '').trim();
        if (!clean) return;
        var lower = clean.toLowerCase();
        c.lastHeard  = clean;
        c.confidence = conf ? conf.toFixed(2) : '-';
        logEvent('rec.f', '"' + clean + '" conf=' + c.confidence);
        $scope.$applyAsync();

        // ---- 1. Sleep command works in any mode ----
        if (matchSleep(lower)) {
            commandMode = false;
            if (commandTimer) $timeout.cancel(commandTimer);
            if (!c.alert) return;  // already asleep
            c.alert = false;
            setState('dormant');
            cue('pause');
            speak('Going to sleep. Say "Netra" or "Netra wake up" to bring me back.');
            return;
        }

        // ---- 2. Dormant mode: only wake-word resumes ----
        if (!c.alert) {
            if (matchExplicitWakeUp(lower)) {
                c.alert = true;
                setState('idle');
                cue('resume');
                var rest = matchesWake(lower);
                // If they also gave a command in the same breath, do it
                if (rest && rest.length > 2 && !/^(listen|wake\s*up|wake|are\s+you\s+there|hello)$/i.test(rest)) {
                    speak('Yes, I am back.', function () {
                        $timeout(function () { processCommand(rest, conf); }, 200);
                    });
                } else {
                    speak('Yes, I am listening.');
                }
            } else {
                logEvent('rec', 'dormant - ignored');
            }
            return;
        }

        // ---- 3. Wake match (alert mode) ----
        var afterWake = matchesWake(lower);
        if (afterWake !== null) {
            cue('wake');
            if (afterWake.length > 2) {
                // "Netra <command>" in one breath
                processCommand(afterWake, conf);
            } else {
                // Just "Netra" alone - arm for next utterance
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

        // ---- 4. We're in command-armed mode after a bare "Netra" ----
        if (commandMode) {
            commandMode = false;
            if (commandTimer) $timeout.cancel(commandTimer);
            processCommand(clean, conf);
            return;
        }

        // ---- 5. Otherwise - background chatter, ignore ----
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
            setState('speaking');
            speak(local.reply, function () { if (c.alert) setState('idle'); });
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
        setState('thinking');
        cue('think');
        logEvent('srv', 'sending: "' + transcript + '"');

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;

        var hung = $timeout(function () {
            logEvent('warn', 'server >12s, may be hung');
        }, 12000);

        c.server.update().then(
            function () {
                $timeout.cancel(hung);
                var r = c.data.response;
                if (!r) {
                    logEvent('err', 'server returned but no response object (is server.js v7+ deployed?)');
                    setState('error');
                    speak('Sorry, the server returned an empty response.');
                    return;
                }
                if (Array.isArray(r.history)) geminiHistory = r.history;
                if (r.ok) {
                    lastReply = r.message || '';
                    logEvent('srv', 'reply ok (' + lastReply.length + ' chars)');
                    setState('speaking');
                    speak(r.message, function () {
                        if (c.alert) setState('idle');
                    });
                } else {
                    logEvent('err', 'server says: ' + (r.message || 'unknown error'));
                    setState('error');
                    cue('error');
                    speak(r.message || 'Sorry, something went wrong.', function () {
                        if (c.alert) setState('idle');
                    });
                }
            },
            function (err) {
                $timeout.cancel(hung);
                setState('error');
                cue('error');
                logEvent('err', 'transport error: ' + (err && (err.message || err.status) || err));
                speak('Sorry, I could not reach the server.', function () {
                    if (c.alert) setState('idle');
                });
            }
        );
    }

    /* ============================================================
     *  TTS  (with verbose logging so silent failures surface)
     * ============================================================ */
    function speak(text, done) {
        if (!c.hasTTS) {
            logEvent('err', 'no TTS available');
            if (done) done();
            return;
        }
        if (!text) { if (done) done(); return; }

        var clean = String(text)
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        c.spoken = clean;
        $scope.$applyAsync();

        // Echo guard - ignore mic finals during AND just after speech
        ignoreFinalsUntil = Date.now() + 60000;  // long, refreshed every utterance

        if (TTS.speaking || TTS.pending) {
            TTS.cancel();
        }

        var u = new SpeechSynthesisUtterance(clean);
        u.rate  = 0.96;
        u.pitch = 1.05;
        u.volume = 1.0;
        var v = chooseVoice();
        if (v) {
            u.voice = v;
            u.lang  = v.lang || 'en-IN';
            logEvent('tts', 'speaking with ' + v.name + ' / ' + (v.lang || 'en-IN') + ' (' + clean.length + ' chars)');
        } else {
            u.lang = 'en-IN';
            logEvent('tts', 'speaking with DEFAULT voice (no en-IN found) (' + clean.length + ' chars)');
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
            ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
            logEvent('tts', 'onend');
            if (done) done();
        };
        u.onerror = function (ev) {
            $timeout.cancel(startWatchdog);
            ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
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
            if (e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                c.toggleDev();
                $scope.$applyAsync();
            }
            if (e.key === 'Escape') {
                if (TTS) TTS.cancel();
                ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
                setState(c.alert ? 'idle' : 'dormant');
                $scope.$applyAsync();
            }
        });
    }

    /* ============================================================
     *  NOTIFICATION POLLING
     * ============================================================ */
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
                        if (c.state === 'listening' || c.state === 'speaking' || c.state === 'awaiting') return;
                        if (!c.alert) return;  // don't disturb when dormant
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

    c.devDiagnose = function () {
        logEvent('dev', '=== diagnostics ===');
        logEvent('dev', 'SR=' + c.hasSR + ' TTS=' + c.hasTTS + ' Grammars=' + !!SGL);
        logEvent('dev', 'rec running=' + c.recRunning + ' state=' + c.state + ' alert=' + c.alert);
        logEvent('dev', 'mic permission=' + c.permission);
        logEvent('dev', 'voice=' + c.voiceName);
        var enIn = c.voices.filter(function(v){ return /en[-_]IN/i.test(v.lang); });
        logEvent('dev', 'en-IN voices: ' + (enIn.length ? enIn.map(function(v){return v.name;}).join(', ') : 'NONE - install Windows English India pack'));
        logEvent('dev', 'total voices: ' + c.voices.length);
    };

    /* ============================================================
     *  STATE
     * ============================================================ */
    function setState(s) {
        c.state = s;
        c.stateLabel = STATE_LABEL[s] || s;
        $scope.$applyAsync();
    }
};

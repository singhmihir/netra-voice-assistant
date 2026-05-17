/**
 * Netra Mic widget - CLIENT CONTROLLER (Release 2 - web + in-tab control)
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

    var DEV_DEFAULT_ON      = true;   // dev panel visible by default
    var ALWAYS_LISTEN       = true;   // v12 - no wake word ever; sleep with "stop listening"
    var WAKE_TIMEOUT_MS     = 8000;   // legacy wake-armed window (only used if ALWAYS_LISTEN is false)
    var MIN_CONFIDENCE      = 0.35;   // below this, ignore as chatter
    var MIN_LENGTH          = 3;      // ignore utterances shorter than this many chars
    var RESTART_DELAY       = 250;    // ms before reopening recognition after onend
    var TTS_GUARD_MS        = 350;    // ignore mic finals this long after TTS ends
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
    // R1.4 - last-turn tool-call trace (Claude-style thinking transparency)
    c.lastTrace = [];   // [{name, ts}, ...]
    c.pendingScreenshot = null;

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
    function _statsTick() {
        var sec = Math.floor((Date.now() - BOOT_TIME) / 1000);
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        c.stats.uptimeLabel = (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
        $scope.$applyAsync();
        $timeout(_statsTick, 1000);
    }
    $timeout(_statsTick, 1000);

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
        c.charts.confSeries.push(Math.round(conf * 100));
        if (c.charts.confSeries.length > 30) c.charts.confSeries.shift();
        c.charts.confPath = _seriesToPath(c.charts.confSeries, 100);
    }
    function _pushLatency(ms) {
        if (typeof ms !== 'number' || !isFinite(ms)) return;
        c.charts.latSeries.push(ms);
        if (c.charts.latSeries.length > 30) c.charts.latSeries.shift();
        c.charts.latPath = _seriesToPath(c.charts.latSeries);
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
        $timeout(startMicLevelMeter, 1000);   // R1.2 - mic-level live VU
        $timeout(preloadFillers, 2500);       // R1.6 - thinking-cue cache
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
        navigator.mediaDevices.getUserMedia({ audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true
        } }).then(function (stream) {
            _micStream = stream;
            c.micStreamActive = true;
            $scope.$applyAsync();
            _micCtx = new (window.AudioContext || window.webkitAudioContext)();
            var source = _micCtx.createMediaStreamSource(stream);
            _micAnalyser = _micCtx.createAnalyser();
            _micAnalyser.fftSize = 1024;
            _micAnalyser.smoothingTimeConstant = 0.5;
            source.connect(_micAnalyser);
            var data = new Uint8Array(_micAnalyser.frequencyBinCount);

            var loop = function () {
                _micAnalyser.getByteTimeDomainData(data);
                // RMS over the waveform
                var sum = 0;
                for (var i = 0; i < data.length; i++) {
                    var v = (data[i] - 128) / 128;
                    sum += v * v;
                }
                var rms = Math.sqrt(sum / data.length);
                var level = Math.min(100, Math.round(rms * 300));   // scale up
                c.micLevel = level;
                if (level > c.micLevelPeak) c.micLevelPeak = level;
                $scope.$applyAsync();
                _micRafId = requestAnimationFrame(loop);
            };
            loop();
            logEvent('mic', 'live level meter started (audio is flowing)');
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
                speak(greet);
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

    function startContinuous() {
        if (!c.hasSR) return;
        try { if (contRec) contRec.stop(); } catch (e) {}

        contRec = new SR();
        contRec.continuous     = true;
        contRec.interimResults = true;
        contRec.lang           = 'en-IN';
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
                processFinalTranscript(t, conf);
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
            $timeout(startContinuous, delay);
        };

        try { contRec.start(); }
        catch (e) {
            logEvent('err', 'contRec.start failed: ' + e);
            // common cause: already started
            $timeout(startContinuous, 1000);
        }
    }

    /* ============================================================
     *  R1 - LISTENING WATCHDOG
     *
     *  Every 10 seconds verify recognition is actually running. If
     *  recRunning has been false for 3+ checks, force-restart.
     *  Also detects "stuck in speaking" state and recovers.
     * ============================================================ */
    var watchdogStrikes = 0;
    var watchdogLastSpeakingStart = 0;
    function startListeningWatchdog() {
        var tick = function () {
            var now = Date.now();
            // Stuck-in-speaking detection: if state has been "speaking"
            // for more than 30s without progress, force back to idle.
            if (c.state === 'speaking') {
                if (!watchdogLastSpeakingStart) {
                    watchdogLastSpeakingStart = now;
                } else if (now - watchdogLastSpeakingStart > 30000) {
                    logEvent('warn', 'watchdog: stuck in speaking >30s - forcing idle');
                    setState(c.alert ? 'idle' : 'dormant');
                    watchdogLastSpeakingStart = 0;
                    // Reset ignoreFinalsUntil so mic isn't locked
                    ignoreFinalsUntil = now;
                }
            } else {
                watchdogLastSpeakingStart = 0;
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

    function attachGrammar(rec) {
        if (!SGL) return;
        try {
            var wakeOptions = WAKE_WORDS.join(' | ');
            var v = (c.data && c.data.vocab) || {};
            var dynGroups   = compactList(v.groups, 60);
            var dynApps     = compactList(v.apps, 50);
            var dynCats     = compactList(v.categories, 25);
            var dynKb       = compactList(v.kb_titles, 30);
            var dynCatItems = compactList(v.catalog_items, 25);
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
                    'KB | INC | CHG | RITM | SCTASK | PRB | ' +
                    'status | state | priority | impact | severity | urgency | assignee | watcher | ' +
                    'VPN | email | password | network | computer | laptop | monitor | keyboard | wifi | server | ' +
                    'account | access | login | reset | unlock | enable | disable ;\n' +
                'public <modifier> = urgent | critical | high | medium | low | normal | ' +
                    'P1 | P2 | P3 | P4 | priority one | priority two | priority three | ' +
                    'open | closed | resolved | pending | new | in progress | assigned | ' +
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
    function processFinalTranscript(text, conf) {
        var clean = (text || '').trim();
        if (!clean) return;
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
        setState('thinking');
        cue('think');
        logEvent('srv', 'sending: "' + transcript + '"');

        c.data.action  = 'chat';
        c.data.message = transcript;
        c.data.history = geminiHistory;
        // R1.4 - attach screenshot if one was just captured
        if (c.pendingScreenshot) {
            c.data.image_b64 = c.pendingScreenshot;
            c.data.image_mime = 'image/png';
            logEvent('srv', 'attaching screenshot (' + Math.round(c.pendingScreenshot.length / 1024) + ' KB)');
            c.pendingScreenshot = null;
        }

        var hung = $timeout(function () {
            logEvent('warn', 'server >12s, may be hung');
        }, 12000);

        var startedAt = Date.now();   // R1 - latency tracking
        c.stats.utterances++;

        c.server.update().then(
            function () {
                $timeout.cancel(hung);
                // R1 - record latency + model + tools used
                var elapsed = Date.now() - startedAt;
                c.stats.lastLatencyMs = elapsed;
                _pushLatency(elapsed);
                var r = c.data.response;
                if (r) {
                    if (r.model_used) c.stats.lastModel = r.model_used;
                    if (r.tools_called) {
                        c.stats.toolsCalled += r.tools_called.length || 0;
                        r.tools_called.forEach(function (name) { _countTool(name); });
                        // R1.4 - record the last turn's tool trace
                        c.lastTrace = r.tools_called.map(function (name, i) {
                            return { name: name, order: i + 1 };
                        });
                    }
                    // R2 - act on client directives from tools
                    if (r.directives) {
                        if (r.directives.navigate_url) {
                            logEvent('nav', 'navigating to ' + r.directives.navigate_url);
                            // Slight delay so Netra finishes saying the lead-in
                            $timeout(function () {
                                try { $window.location.assign(r.directives.navigate_url); } catch (e) {
                                    logEvent('err', 'navigation failed: ' + e.message);
                                }
                            }, 1500);
                        }
                        if (r.directives.click_button_label) {
                            logEvent('click', 'clicking button: ' + r.directives.click_button_label);
                            $timeout(function () {
                                _findAndClickButton(r.directives.click_button_label);
                            }, 800);
                        }
                    }
                }
                if (!r) {
                    logEvent('err', 'server returned but no response object');
                    c.stats.errors++;
                    setState('error');
                    speak('Sorry, the server returned an empty response.');
                    return;
                }
                if (Array.isArray(r.history)) geminiHistory = r.history;
                if (r.ok) {
                    lastReply = r.message || '';
                    logEvent('srv', 'reply ok (' + lastReply.length + ' chars, ' + elapsed + ' ms)' + (r.model_used ? ' via ' + r.model_used : ''));
                    setState('speaking');
                    speak(r.message, function () {
                        if (c.alert) {
                            setState('idle');
                            openConversation('after server reply');
                        }
                    });
                } else {
                    logEvent('err', 'server says: ' + (r.message || 'unknown error'));
                    c.stats.errors++;
                    setState('error');
                    cue('error');
                    speak(r.message || 'Sorry, something went wrong.', function () {
                        if (c.alert) setState('idle');
                    });
                }
            },
            function (err) {
                $timeout.cancel(hung);
                c.stats.errors++;
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

        var clean = String(text)
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        c.spoken = clean;
        $scope.$applyAsync();

        // R1: wrap the done callback so state ALWAYS resets to idle/dormant
        // after TTS finishes - prevents "stuck in speaking" bug.
        var wrappedDone = function () { _afterTTS(done); };

        // R1.6 - ONE continuous Edge TTS call for the whole response (no
        // mid-response audio gaps). SSML <break> tags between sentences
        // give natural pacing inside the single audio stream. Filler
        // sounds still play on state -> thinking before the reply starts.
        var engine = c.ttsEngine || (c.useRemoteTTS ? 'edge' : 'browser');
        if (engine === 'edge') {
            speakEdgeTTS(clean, wrappedDone);
        } else if (engine === 'stream') {
            speakStreamElements(clean, wrappedDone);
        } else {
            speakBrowser(clean, wrappedDone);
        }
    }

    // Build SSML body with natural breath breaks between sentences.
    // Splits on .!? boundaries and inserts <break time="180ms"/>.
    function _buildHumanSSML(text, voice) {
        var safe = String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        // Insert breath break after every .!? (followed by space or end)
        safe = safe.replace(/([.!?]+)(\s|$)/g, '$1<break time="180ms"/>$2');
        // Slightly shorter pause after commas
        safe = safe.replace(/(,)(\s)/g, '$1<break time="80ms"/>$2');
        // Slightly longer pause after em-dashes (Indian-English thinking pause)
        safe = safe.replace(/( - | -- | — )/g, '<break time="120ms"/>$1');
        return '<speak version=\'1.0\' xml:lang=\'en-IN\'>' +
               '<voice name=\'' + voice + '\'>' +
               '<prosody rate=\'+15%\' pitch=\'+1st\'>' + safe + '</prosody>' +
               '</voice></speak>';
    }

    // Unified post-TTS handler: reset state, ensure mic is open, fire user callback.
    function _afterTTS(userDone) {
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
     *  played through an <audio> element with playbackRate = 1.20
     *  for that natural, slightly-quick-but-human cadence.
     *
     *  Voices: en-IN-NeerjaNeural (default - warm Indian female),
     *  en-IN-AashiNeural, en-IN-AnanyaNeural, hi-IN-SwaraNeural.
     *
     *  Falls back to speakStreamElements -> speakBrowser on error.
     * ============================================================ */
    var EDGE_WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    c.edgeVoice = 'en-IN-NeerjaNeural';
    var EDGE_VOICES = [
        'en-IN-NeerjaNeural', 'en-IN-AashiNeural', 'en-IN-AnanyaNeural',
        'hi-IN-SwaraNeural',  'en-US-JennyNeural', 'en-US-AriaNeural'
    ];

    function _edgeConnectId() {
        // 32-hex random
        var chars = '0123456789abcdef';
        var s = '';
        for (var i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * 16)];
        return s;
    }

    function speakEdgeTTS(text, done) {
        if (!text) { _afterTTS(done); return; }
        // Some networks/CSPs forbid arbitrary WSS - fall back fast if blocked.
        if (typeof WebSocket === 'undefined') {
            return speakStreamElements(text, done);
        }
        try {
            var requestId = _edgeConnectId();
            var ws = new WebSocket(EDGE_WSS_URL + '&ConnectionId=' + requestId);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var resolved = false;
            var watchdog = $timeout(function () {
                if (!resolved) { resolved = true; try { ws.close(); } catch (e) {}
                    logEvent('warn', 'edge TTS no audio in 6s - fallback');
                    speakStreamElements(text, done);
                }
            }, 6000);

            ws.onopen = function () {
                logEvent('tts', 'edge: ' + c.edgeVoice + ' (' + text.length + ' chars)');
                var now = new Date().toISOString();
                // 1. Speech config
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
                ws.send('X-Timestamp:' + now + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                // 2. SSML body with sentence/comma/em-dash breath breaks.
                //    R1.6 - one continuous audio stream with natural pacing
                //    inside, rather than multiple TTS calls per sentence.
                var ssml = _buildHumanSSML(text, c.edgeVoice);
                ws.send('X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' + ssml);
                ignoreFinalsUntil = Date.now() + 15000;
                setState('speaking');
            };

            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('Path:turn.end') >= 0) {
                        try { ws.close(); } catch (e) {}
                        // Assemble MP3 chunks and play
                        if (chunks.length === 0) {
                            logEvent('warn', 'edge returned no audio - fallback');
                            if (!resolved) { resolved = true; $timeout.cancel(watchdog); speakStreamElements(text, done); }
                            return;
                        }
                        var blob = new Blob(chunks, { type: 'audio/mp3' });
                        var url = URL.createObjectURL(blob);
                        var audio = new Audio(url);
                        audio.playbackRate = 1.50;   // R2.1 - 1.5x, brisk + Claude-like
                        audio.volume = 1.0;
                        currentAudio = audio;
                        audio.onplaying = function () {
                            if (resolved) return;
                            $timeout.cancel(watchdog);
                            logEvent('tts', 'edge playing @1.20x');
                        };
                        audio.onended = function () {
                            if (resolved) return;
                            resolved = true;
                            URL.revokeObjectURL(url);
                            if (currentAudio === audio) currentAudio = null;
                            ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
                            if (done) try { done(); } catch (e) {}
                        };
                        audio.onerror = function () {
                            if (resolved) return;
                            resolved = true;
                            URL.revokeObjectURL(url);
                            logEvent('warn', 'edge audio playback error - fallback');
                            speakStreamElements(text, done);
                        };
                        audio.play().catch(function (e) {
                            if (resolved) return;
                            resolved = true;
                            logEvent('warn', 'edge play() rejected: ' + e.message);
                            speakStreamElements(text, done);
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
                speakStreamElements(text, done);
            };

            ws.onclose = function () {
                if (!resolved) {
                    resolved = true;
                    $timeout.cancel(watchdog);
                    logEvent('warn', 'edge ws closed early - fallback');
                    speakStreamElements(text, done);
                }
            };
        } catch (e) {
            logEvent('err', 'edge TTS threw: ' + e.message);
            speakStreamElements(text, done);
        }
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
    var FILLER_PHRASES = ['Hmm.', 'Let me see.', 'Okay so.', 'Right.', 'Mm.', 'Ahh.'];
    var fillerCache = [];   // [{url, text}]
    var lastFillerPlayedAt = 0;
    var currentFillerAudio = null;

    function _edgeBlob(text, voice, cb) {
        try {
            var requestId = _edgeConnectId();
            var ws = new WebSocket(EDGE_WSS_URL + '&ConnectionId=' + requestId);
            ws.binaryType = 'arraybuffer';
            var chunks = [];
            var done = false;
            var watchdog = $timeout(function () {
                if (!done) { done = true; try { ws.close(); } catch (e) {} cb(null); }
            }, 5000);
            ws.onopen = function () {
                var cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
                ws.send('X-Timestamp:' + new Date().toISOString() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg);
                var safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var ssml = '<speak version=\'1.0\' xml:lang=\'en-IN\'><voice name=\'' + (voice || c.edgeVoice) + '\'>' +
                           '<prosody rate=\'+5%\' pitch=\'+0Hz\'>' + safe + '</prosody></voice></speak>';
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
    }

    function preloadFillers() {
        if (typeof WebSocket === 'undefined') return;
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
        if (!fillerCache.length) return;
        // Only one filler at a time, and at most once per 4s
        if (Date.now() - lastFillerPlayedAt < 4000) return;
        if (currentFillerAudio) { try { currentFillerAudio.pause(); } catch (e) {} }
        var f = fillerCache[Math.floor(Math.random() * fillerCache.length)];
        var a = new Audio(f.url);
        a.volume = 0.75;
        a.playbackRate = 1.15;
        currentFillerAudio = a;
        lastFillerPlayedAt = Date.now();
        a.play().catch(function () { /* ignore - autoplay may be blocked */ });
        logEvent('tts', 'filler: "' + f.text + '"');
    }

    function speakStreamElements(text, done) {
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
        ignoreFinalsUntil = Date.now() + 15000;

        var audio = new Audio();
        audio.src = url;
        audio.volume = 1.0;
        audio.playbackRate = 1.50;   // R2.1 - 1.5x, brisk + Claude-like
        currentAudio = audio;

        // Single fallback guard - whichever signal fires first wins
        var resolved = false;
        var fallback = function (reason) {
            if (resolved) return;
            resolved = true;
            $timeout.cancel(watchdog);
            try { audio.pause(); audio.src = ''; } catch (e) {}
            if (currentAudio === audio) currentAudio = null;
            logEvent('warn', 'remote -> browser fallback: ' + reason);
            speakBrowser(text, done);
        };
        var finish = function () {
            if (resolved) return;
            resolved = true;
            $timeout.cancel(watchdog);
            ignoreFinalsUntil = Date.now() + TTS_GUARD_MS;
            if (currentAudio === audio) currentAudio = null;
            if (done) done();
        };

        var watchdog = $timeout(function () { fallback('no playback in 4s'); }, 4000);

        audio.onplaying = function () {
            if (resolved) return;
            $timeout.cancel(watchdog);
            setState('speaking');
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
        ignoreFinalsUntil = Date.now() + 15000;

        if (TTS.speaking || TTS.pending) {
            TTS.cancel();
        }

        var u = new SpeechSynthesisUtterance(text);
        u.rate  = 1.50;   // R2.1 - 1.5x, brisk + Claude-like
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

    c.devToggleTTS = function () {
        // R1.5 - cycle: edge -> stream -> browser -> edge
        var seq = ['edge', 'stream', 'browser'];
        var idx = seq.indexOf(c.ttsEngine || 'edge');
        c.ttsEngine = seq[(idx + 1) % seq.length];
        // Keep useRemoteTTS in sync for legacy code paths
        c.useRemoteTTS = (c.ttsEngine !== 'browser');
        logEvent('dev', 'TTS engine -> ' + c.ttsEngine +
                 (c.ttsEngine === 'edge'   ? ' (' + c.edgeVoice + ', Microsoft Neural, free)' :
                  c.ttsEngine === 'stream' ? ' (StreamElements ' + c.remoteVoice + ')' :
                                             ' (browser ' + c.voiceName + ')'));
    };

    c.devCycleRemoteVoice = function () {
        // R1.5 - if Edge is the current engine, cycle Edge voices; otherwise StreamElements
        if (c.ttsEngine === 'edge') {
            var ei = EDGE_VOICES.indexOf(c.edgeVoice);
            c.edgeVoice = EDGE_VOICES[(ei + 1) % EDGE_VOICES.length];
            logEvent('dev', 'Edge voice -> ' + c.edgeVoice);
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
    function setState(s) {
        var prev = c.state;
        c.state = s;
        c.stateLabel = STATE_LABEL[s] || s;
        $scope.$applyAsync();
        // R1.6 - on transition INTO 'thinking', play a thinking-cue filler
        // so there is no dead air while Gemini is processing.
        if (s === 'thinking' && prev !== 'thinking') {
            $timeout(playThinkingFiller, 80);
        }
    }
};

/* Netra on a phone, and the stage controls for everyone.
 *
 * Pinch-zoom stays on; End never strands a Guest or the installed app on the
 * login page; Mute mic really stops her listening; with no voice installed
 * her words stay on screen; one app shell on the live page; the install
 * button, the Lab and the settings fit a phone and work from the keyboard;
 * the portal under the stage is out of the way; the offline page comes back
 * by itself. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra');
var fs = require('fs'), path = require('path'), vm = require('vm');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var CSS = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');
var APP = fs.readFileSync(path.join(N.SRC, 'scripted_rest', 'app.js'), 'utf8').replace(/__NETRA_SCOPE__/g, 'x_196061_netra_v1');

var store = {};
global.localStorage = { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
global.window = global.window || {};

// a very small DOM: enough for querySelector by tag[attr="v"], .class and #id
function El(tag, attrs) {
    this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.parentNode = null;
    this.style = {}; this.offsetParent = {}; this.isConnected = true; this.focused = 0;
    for (var k in (attrs || {})) this.attrs[k] = attrs[k];
}
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attrs.hasOwnProperty(k) ? this.attrs[k] : null; };
El.prototype.hasAttribute = function (k) { return this.attrs.hasOwnProperty(k); };
El.prototype.appendChild = function (ch) { ch.parentNode = this; this.children.push(ch); return ch; };
El.prototype.focus = function () { this.focused++; DOC.activeElement = this; };
El.prototype.contains = function (el) { for (; el; el = el.parentNode) if (el === this) return true; return false; };
El.prototype.all = function () { var out = []; this.children.forEach(function (ch) { out.push(ch); out = out.concat(ch.all()); }); return out; };
El.prototype.matches = function (sel) {
    var self = this;
    return sel.split(',').some(function (s) {
        s = s.trim();
        var m = s.match(/^([a-z]*)(?:\[([a-z-]+)(?:~?="([^"]*)")?\])?$/i), cls = s.match(/^\.([\w-]+)$/), id = s.match(/^#([\w-]+)$/);
        if (cls) return (' ' + (self.attrs['class'] || '') + ' ').indexOf(' ' + cls[1] + ' ') >= 0;
        if (id) return self.attrs.id === id[1];
        if (!m) return false;
        if (m[1] && self.tagName !== m[1].toUpperCase()) return false;
        if (m[2] && !self.hasAttribute(m[2])) return false;
        if (m[2] && m[3] !== undefined && (' ' + self.attrs[m[2]] + ' ').indexOf(' ' + m[3] + ' ') < 0) return false;
        return true;
    });
};
El.prototype.querySelectorAll = function (sel) { return this.all().filter(function (el) { return el.matches(sel); }); };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function (sel) { for (var el = this; el; el = el.parentNode) if (el.matches && el.matches(sel)) return el; return null; };
var DOC = null;
function makeDoc() {
    var d = new El('#document'); d.head = d.appendChild(new El('head')); d.body = d.appendChild(new El('body'));
    d.body.inert = false;   // a browser with inert
    d.createElement = function (t) { return new El(t); };
    d.activeElement = d.body;
    DOC = d; global.document = d;
    return d;
}
function el(tag, cls, attrs) { var e = new El(tag, attrs); if (cls) e.attrs['class'] = cls; return e; }

// the page's controller with its outside world stubbed
function page() {
    makeDoc();
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], log: [], states: [] };
    function noop() {}
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('logEvent', function (k, m) { rec.log.push(k + ': ' + m); });
    ['cue', 'tone', 'openConversation', 'closeConversation', '_convoPush', 'saveTrainingData', 'attachGrammar', 'learnFromTranscript',
     '_pushConfidence', 'stopFillerChain', 'unlockAudio', 'startContinuous', 'stopSpeaking', '_cancelPlanContinue', '_firstRunCheck', '_memPersist']
        .forEach(function (n) { set(n, noop); });
    set('STATE_LABEL', {}); set('LIVE_STATUS', {});
    set('WAKE_WORDS', ['netra']); set('SALUTATION_PREFIXES', ['hey', 'ok', 'okay']); set('MIN_LENGTH', 3); set('MIN_CONFIDENCE', 0.35);
    set('_calibActive', false); set('_speakingNow', false); set('_chatInFlight', false); set('_queuedUtterance', null);
    set('_inertMade', []); set('_inertTabs', []); set('_inertFreed', false);
    set('booted', true); set('_finalBuffer', []); set('_finalConfs', []); set('_finalTimer', null); set('recLastActivityAt', Date.now()); set('_micGainNode', null); set('contRec', null);
    c.events = []; c.stats = {}; c.aliases = {}; c.personalVocab = {}; c.data = {}; c.micHealth = {}; c.heard = [];
    c.alert = true; c.conversationOpen = false; c.state = 'idle'; c.lastHeard = ''; c.spoken = ''; c.interim = ''; c.recRunning = true;
    c.labCalib = { stage: 'idle' }; c.gate = { open: true };
    c.app = { canInstall: false, standalone: false, ios: false, showHelp: false, installed: false, fromApp: false, shareWhere: 'Safari\'s toolbar' };
    c.micGain = 1.5; c.micOff = false; c.ended = false; c.captionKeep = false;
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec };
}
function win(p, extra) {
    var w = { innerWidth: 390, navigator: { userAgent: '' }, location: { search: '?id=netra_live', assign: function (u) { w.went = u; } },
              history: { length: 3, back: function () { w.went = 'back'; } }, addEventListener: function () {}, removeEventListener: function () {},
              matchMedia: function () { return { matches: false }; }, document: DOC };
    for (var k in (extra || {})) w[k] = extra[k];
    p.set('$window', w);
    return w;
}

// the text of the CSS rule for a selector, within an optional @media block
function block(src, media) {
    var at = src.indexOf(media);
    T.ok(at >= 0, 'found ' + media);
    var depth = 0, i = src.indexOf('{', at), start = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
}
function rule(src, sel) {
    var at = src.indexOf(sel + ' {');
    T.ok(at >= 0, 'found the rule ' + sel);
    return src.slice(at, src.indexOf('}', at) + 1);
}
// WCAG contrast of two #rrggbb colours
function lum(hex) {
    var v = [1, 3, 5].map(function (i) { var x = parseInt(hex.substr(i, 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { var la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
function bg(ruleText) { var m = ruleText.match(/background:\s*(#[0-9a-f]{6})/i); T.ok(m, 'a solid background in ' + ruleText.slice(0, 40)); return m[1]; }

// ---- 1. pinch-zoom -------------------------------------------------------

T.test('the live page lets a low-vision user pinch to zoom: the theme\'s user-scalable=no is replaced', function () {
    var p = page(), d = DOC;
    d.head.appendChild(new El('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no' }));
    d.body.appendChild(new El('meta', { name: 'viewport', content: 'width=device-width, user-scalable=no' }));   // a theme that sets it twice
    p.c.liveMode = true; p.c.data = { app_base: '' };
    win(p, { location: { search: '?id=netra_live&netra_app=1' } });
    p.f._appShell();
    T.eq(d.head.querySelectorAll('meta[name="viewport"]').length, 1, 'no second viewport meta added');
    var vps = d.querySelectorAll('meta[name="viewport"]');
    vps.forEach(function (vp) { T.eq(vp.getAttribute('content'), 'width=device-width, initial-scale=1, viewport-fit=cover'); });
    T.eq(p.c.app.fromApp, true, 'opened from the installed app\'s start page');
});

// ---- 2. End ---------------------------------------------------------------

T.test('End: a Guest or the installed app stays on the page, asleep, with "Start Netra again"; signed-in desktop goes back', function () {
    [[{ is_guest: true }, {}], [{ is_guest: false }, { standalone: true }], [{ is_guest: false }, { fromApp: true }]].forEach(function (k) {
        var p = page(), c = p.c, w = win(p);
        c.data = k[0]; for (var a in k[1]) c.app[a] = k[1][a];
        p.f._liveExit();
        T.eq(w.went, undefined, JSON.stringify(k) + ': no trip to the login page');
        T.eq(c.ended, true); T.eq(c.micOff, true, 'she stops listening'); T.eq(c.alert, false);
        T.match(p.rec.spoken.join(' '), /Start Netra again/);
        p.f._liveRestart();
        T.eq(c.ended, false); T.eq(c.micOff, false); T.eq(c.alert, true, 'back and listening');
    });
    var p = page(), w = win(p);
    p.c.data = { is_guest: false };
    p.f._liveExit();
    T.eq(w.went, 'back', 'a signed-in desktop user returns to the portal as before');
    T.match(TPL, /class="netra-ended-btn" ng-if="c\.ended" ng-click="c\.liveRestart\(\)">Start Netra again</);
});

// ---- 3. Mute mic ------------------------------------------------------------

T.test('Mute mic means she does not listen: her name does not wake her, the ear hears silence, Unmute brings her back', function () {
    var p = page(), c = p.c, gain = { gain: { value: 1.5 } };
    p.set('_micGainNode', gain);
    p.set('setState', function (s) { c.state = s; });
    p.f._micMute();
    T.eq(c.micOff, true); T.eq(c.alert, false);
    T.eq(gain.gain.value, 0, 'the meter and the on-device ear get silence');
    T.match(p.rec.spoken[0], /Unmute/);
    ['Netra wake up', 'Netra', 'stop listening', 'list my tickets'].forEach(function (u) {
        p.f.processFinalTranscript(u, 0.95);
        T.eq(c.alert, false, '"' + u + '" while muted');
        T.eq(c.micOff, true);
    });
    T.eq(c.lastHeard, '', 'nothing heard is used');
    c.micGain = 2; p.f._micGainApply();
    T.eq(gain.gain.value, 0, 'the sensitivity slider does not unmute');
    p.f._micUnmute();
    T.eq(c.micOff, false); T.eq(c.alert, true); T.eq(gain.gain.value, 2);
});

T.test('the Mute button and her status say what is true', function () {
    var p = page(), c = p.c;
    p.set('window', {});
    p.f._micMute(true);
    T.match(c.liveStatus, /Mic off/); T.match(c.stateLabel, /mic off/);
    T.match(TPL, /class="netra-ctl netra-ctl-mic" ng-click="c\.toggleMic\(\)"/);
    T.match(TPL, /aria-label="\{\{c\.micOff \? 'Unmute mic' : 'Mute mic'\}\}"/);
    T.notMatch(TPL, /Tap to mute or wake/, 'the blob no longer claims to mute');
});

// ---- 4. captions only --------------------------------------------------------

T.test('captions only: with no voice her words stay on screen until the next thing heard', function () {
    var p = page(), c = p.c;
    ['_silenceCurrentAudio', '_markSpeaking', '_clearSpeaking'].forEach(function (n) { p.set(n, function () {}); });
    c.hasTTS = false; c.spoken = 'Hello, I am Netra.'; c.state = 'idle';
    p.f.speakBrowser('Hello, I am Netra.', function () {});
    T.eq(p.f._captionWho(), 'netra', 'the greeting shows though no voice played');
    c.interim = 'list my';
    T.eq(p.f._captionWho(), 'you', 'the user speaking takes the caption');
    c.interim = '';
    p.set('setState', function (s) { c.state = s; });
    p.set('_calibConsume', function () { return false; });
    p.set('handleHeard', function () {});
    p.f.processFinalTranscript('list my tickets', 0.95);
    T.eq(c.captionKeep, false); T.eq(p.f._captionWho(), 'you');
});

T.test('captions only: a voice that fails keeps the caption, a barge-in does not', function () {
    [['synthesis-failed', true], ['not-allowed', true], ['interrupted', false]].forEach(function (k) {
        var p = page(), c = p.c;
        ['_silenceCurrentAudio', '_markSpeaking', '_clearSpeaking', '_gateUpdate'].forEach(function (n) { p.set(n, function () {}); });
        global.SpeechSynthesisUtterance = function (t) { this.text = t; };
        p.set('TTS', { speaking: false, pending: false, cancel: function () {}, getVoices: function () { return []; }, speak: function (u) { u.onerror({ error: k[0] }); } });
        p.set('_speakSessionId', 1); p.set('forcedVoiceName', '');
        c.hasTTS = true; c.spoken = 'Your ticket is resolved.'; c.state = 'idle';
        p.f.speakBrowser('Your ticket is resolved.', function () {});
        T.eq(c.captionKeep, k[1], k[0]);
        delete global.SpeechSynthesisUtterance;
    });
    T.match(TPL, /netra-stage-caption-netra"\s+ng-show="c\.captionWho\(\) === 'netra'"/);
    T.notMatch(block(CSS, '@media (max-height: 520px) and (orientation: landscape)'), /netra-stage-caption \{ display: none/, 'no caption-less landscape');
    T.match(block(TPL, '/* a phone held sideways: a short caption'), /\.netra-stage \.netra-stage-caption \{[^}]*font-size: 13px/);
});

// ---- 5. one app shell ----------------------------------------------------------

T.test('the live page gets no second manifest, icon or theme colour from the old installer', function () {
    var p = page(), d = DOC;
    p.c.liveMode = true;
    p.f._installPWA();
    T.eq(d.head.children.length, 0, 'nothing added');
});

// ---- 6. install button vs the state pill ------------------------------------------

T.test('on a 320-412 px phone the install button sits below the header, clear of the state pill and the Settings tab', function () {
    var narrow = block(CSS, '/* phones (320-480 px)');
    var top = +(narrow.match(/\.netra-app-btn \{ top: calc\((\d+)px/) || [])[1];
    var headTop = +(block(CSS, '@media (max-width: 480px) {\n    .netra-stage-controls').match(/\.netra-stage-head \{ top: calc\((\d+)px/) || [])[1];
    T.ok(top >= headTop + 30, 'button top ' + top + ' px is below the header row (' + headTop + ' px + its ~22 px pills)');
    // second row: the Settings tab on the left (~8 + 110 px), the button on the right (~130 px wide)
    [320, 375, 390, 412].forEach(function (w) { T.ok(8 + 110 < w - 12 - 130, w + ' px: the tab and the button do not meet'); });
    T.match(rule(CSS, '.netra-app-btn'), /min-height: 44px/);
});

// ---- 7. contrast --------------------------------------------------------------------

T.test('button text is at least 4.5:1 and the round control icons at least 3:1', function () {
    T.ok(contrast('#ffffff', bg(rule(CSS, '.netra-app-help-ok'))) >= 4.5, 'Got it');
    T.ok(contrast('#ffffff', bg(rule(CSS, '.netra-ended-btn'))) >= 4.5, 'Start Netra again');
    var off = (APP.match(/'button\{[^}]*background:(#[0-9a-f]{6})/i) || [])[1];
    T.ok(off && contrast('#ffffff', off) >= 4.5, 'offline Try again: ' + off);
    var ctl = rule(CSS, '.netra-ctl');
    T.notMatch(ctl, /background: rgba/, 'a solid fill, not a see-through one');
    T.ok(contrast((ctl.match(/color: (#[0-9a-f]{6})/i) || [])[1], bg(ctl)) >= 3, 'mute / lab / end icons');
    var muted = rule(CSS, '.netra-ctl-muted');
    T.ok(contrast((muted.match(/color: (#[0-9a-f]{6})/i) || [])[1], bg(muted)) >= 3, 'the muted icon');
    T.notMatch(rule(CSS, '.netra-ctl-lab-on'), /background: var\(/, 'the open-Lab state is solid too');
});

// ---- 8. focus ring on the blob ----------------------------------------------------------

T.test('the blob has a visible keyboard focus ring, in 3D mode too', function () {
    T.match(TPL, /\.netra-stage\.netra-3d-on \.netra-stage-blob-wrap:focus-visible \{\s*outline: 3px solid #ffffff !important;\s*outline-offset: 6px;/);
    T.notMatch(rule(CSS, '.netra-stage-blob-wrap:focus-visible'), /outline: none/);
});

// ---- 9. reduced motion ---------------------------------------------------------------------

T.test('prefers-reduced-motion stills the 2D stage', function () {
    var rm = block(TPL, '@media (prefers-reduced-motion: reduce)');
    T.match(rm, /\.netra-stage \*[^{]*\{\s*animation: none !important;\s*transition: none !important;/);
});

// ---- 10. nothing invisible to Tab to ---------------------------------------------------------

T.test('the portal under the live stage is inert; no floating orb there, no DEV badge for a Guest', function () {
    var p = page(), d = DOC;
    p.c.liveMode = true;
    var skip = d.body.appendChild(el('a', 'skip', { href: '#main' }));
    var header = d.body.appendChild(el('header', 'navbar'));
    header.appendChild(el('a', '', { href: '/login' }));
    var wrap = d.body.appendChild(el('div', 'page'));
    var side = wrap.appendChild(el('div', 'sidebar'));
    var root = wrap.appendChild(el('div', 'netra-root'));
    var live = root.appendChild(el('div', 'netra-sr-only', { role: 'status' }));
    root.appendChild(el('div', 'netra-stage'));
    d.body.appendChild(el('script'));
    p.f._inertChrome();
    [skip, header, side].forEach(function (e) { T.ok(e.hasAttribute('inert') && e.getAttribute('aria-hidden') === 'true', e.tagName + ' is inert'); });
    [wrap, root, live].forEach(function (e) { T.ok(!e.hasAttribute('inert') && !e.hasAttribute('aria-hidden'), e.attrs['class'] + ' stays reachable'); });
    T.match(TPL, /<button class="netra-orb" ng-if="!c\.liveMode"/);
    T.match(TPL, /class="netra-dev-badge" ng-show="!c\.devOn && !\(c\.data && c\.data\.is_guest\)"/);
});

// ---- 11. touch targets ----------------------------------------------------------------------------

T.test('on a touch screen every small control is at least 44 x 44 px', function () {
    var coarse = block(CSS, '@media (pointer: coarse)');
    T.match(coarse, /\.netra-lab-x \{ min-width: 44px; min-height: 44px;/, 'the Lab close x (was 14 x 18)');
    ['.netra-setup-tab', '.netra-setup-check', '.netra-lab-btns button', '.netra-lab-cmd button', '.netra-lab-selects select', '.netra-calib-actions button'].forEach(function (s) {
        T.ok(coarse.indexOf(s) >= 0, s);
    });
    T.match(coarse, /min-height: 44px/);
    T.match(block(TPL, '/* touch screens: a checkbox'), /width: 24px; height: 24px/);
});

// ---- 12. the Lab on a phone ------------------------------------------------------------------------

T.test('the Lab on a phone: a full-width sheet above the round controls, rows that wrap, her answer inside, no saved desktop spot', function () {
    var phone = block(TPL, '@media (max-width: 600px)');
    var lab = phone.slice(phone.indexOf('.netra-stage .netra-lab {'));
    T.match(lab, /bottom: calc\(116px/, 'stops above the controls (46 px + 62 px + the focus ring + the home bar)');
    T.match(block(TPL, '/* 480 px and less: the controls sit'), /bottom: calc\(104px/, '480 px and less: 30 px + 62 px + the ring');
    T.match(lab, /overflow-x: hidden/);
    T.match(lab, /left: calc\(8px \+ env\(safe-area-inset-left/);
    T.match(block(CSS, '/* the Lab on a phone'), /\.netra-lab-selects \{ flex-wrap: wrap; \}/);
    T.match(TPL, /class="netra-lab-answer" ng-show="c\.spoken"><b>Netra<\/b> \{\{c\.spoken\}\}/);
    var p = page(), panel = DOC.body.appendChild(el('aside', 'netra-lab'));
    global.sessionStorage = { getItem: function () { return JSON.stringify({ left: '900px', top: '40px' }); } };
    win(p, { innerWidth: 390 });
    p.f._labRestorePos();
    T.eq(panel.style.left, undefined, 'a phone ignores where the window was dragged on a desktop');
    win(p, { innerWidth: 1280 });
    p.f._labRestorePos();
    T.eq(panel.style.left, '900px');
    delete global.sessionStorage;
});

// ---- 13. Guest settings -------------------------------------------------------------------------------

T.test('a Guest is not offered the morning briefing', function () {
    T.match(TPL, /<label class="netra-setup-check" ng-if="!\(c\.data && c\.data\.is_guest\)">\s*<input type="checkbox" ng-model="c\.prefBrief"/);
});

// ---- 14. the iOS install help ----------------------------------------------------------------------------

T.test('install help: worded for the browser, focus to the title, Escape closes, focus back, name starts "Install app"', function () {
    var p = page(), c = p.c;
    T.eq(p.f._shareWhere('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1'), 'Chrome\'s address bar');
    T.eq(p.f._shareWhere('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari\'s toolbar');
    var btn = DOC.body.appendChild(el('button', 'netra-app-btn'));
    var title = DOC.body.appendChild(el('div', 'netra-app-help-title', { id: 'netra-app-help-title' }));
    c.app.ios = true;
    btn.focus();
    p.f._installApp();
    T.eq(c.app.showHelp, true); T.ok(DOC.activeElement === title, 'VoiceOver lands on the steps');
    var stopped = 0;
    p.f._appHelpKey({ key: 'Escape', preventDefault: function () {}, stopPropagation: function () { stopped++; } });
    T.eq(c.app.showHelp, false, 'Escape closes'); T.eq(stopped, 0, 'the page\'s Escape still stops her talking');
    T.ok(DOC.activeElement === btn, 'focus is back on the button, not lost to the page');
    var b = TPL.slice(TPL.indexOf('<button type="button" class="netra-app-btn"'));
    b = b.slice(0, b.indexOf('</button>'));
    T.notMatch(b, /aria-label=/, 'the accessible name is the visible "Install app"');
    T.match(b, /aria-controls="netra-app-help"/); T.match(b, /aria-expanded/);
    T.match(b, /<span>Install app<\/span>/);
    T.match(TPL, /in \{\{c\.app\.shareWhere\}\}\./);
    T.match(TPL, /ng-keydown="c\.appHelpKey\(\$event\)"/);
    T.match(TPL, /id="netra-app-help-title" tabindex="-1"/);
});

// ---- 15. the Settings sheet from the keyboard ------------------------------------------------------------

T.test('Settings: Escape closes and focus returns to the tab; on a phone Tab wraps inside the sheet', function () {
    var p = page(), c = p.c;
    win(p, { innerWidth: 390 });
    var tab = DOC.body.appendChild(el('button', 'netra-setup-tab'));
    var body = DOC.body.appendChild(el('div', 'netra-setup-body'));
    var first = body.appendChild(el('select')), mid = body.appendChild(el('button')), last = body.appendChild(el('button'));
    var hidden = body.appendChild(el('button')); hidden.offsetParent = null;   // a control not on screen
    c.setupOn = true;
    function key(k, shift) { var e = { key: k, shiftKey: !!shift, prevented: 0, preventDefault: function () { e.prevented++; }, stopPropagation: function () {} }; p.f._setupKey(e); return e; }
    last.focus();
    T.eq(key('Tab').prevented, 1); T.ok(DOC.activeElement === first, 'Tab on the last control goes to the first');
    key('Tab', true); T.ok(DOC.activeElement === last, 'Shift+Tab on the first goes to the last');
    mid.focus(); T.eq(key('Tab').prevented, 0, 'in between, Tab moves normally');
    key('Escape');
    T.eq(c.setupOn, false); T.ok(DOC.activeElement === tab, 'Escape closes, focus on the Settings tab');
    T.match(TPL, /<aside class="netra-setup"[^>]*ng-keydown="c\.setupKey\(\$event\)"/);
});

// ---- 16. landscape notch -----------------------------------------------------------------------------------

T.test('held sideways, the Settings, the install help and the Lab keep clear of the notch', function () {
    T.match(rule(TPL, '  .netra-setup'), /left: calc\(14px \+ env\(safe-area-inset-left/);
    T.match(rule(TPL, '  .netra-lab'), /right: calc\(26px \+ env\(safe-area-inset-right/);
    var help = rule(CSS, '.netra-app-help');
    T.match(help, /right: calc\(12px \+ env\(safe-area-inset-right/); T.match(help, /left: calc\(12px \+ env\(safe-area-inset-left/);
    T.match(block(TPL, '@media (max-width: 600px)'), /padding: 16px calc\(18px \+ env\(safe-area-inset-right, 0px\)\) calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\) calc\(18px \+ env\(safe-area-inset-left/);
});

// ---- 17. the offline page -------------------------------------------------------------------------------------

T.test('the offline page reloads by itself when the connection comes back, and still has Try again', function () {
    var out = { body: '' }, response = { setStatus: function () {}, setContentType: function () {}, setHeader: function () {}, getStreamWriter: function () { return { writeString: function (s) { out.body += s; } }; } };
    vm.runInNewContext(APP, { request: { pathParams: { file: 'sw' } }, response: response, JSON: JSON, String: String });
    var handlers = {}, got = null;
    vm.runInNewContext(out.body, { self: { addEventListener: function (k, f) { handlers[k] = f; }, skipWaiting: function () {}, clients: { claim: function () {} } },
        Response: function (b) { this.body = b; }, fetch: function () { return Promise.reject(new Error('offline')); } });
    handlers.fetch({ request: { mode: 'navigate', method: 'GET', url: 'https://x/sp?id=netra_live' }, respondWith: function (pr) { got = pr; } });
    return got.then(function (res) {
        T.match(res.body, />Try again<\/button>/);
        var js = (res.body.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
        T.ok(js, 'a script on the offline page');
        var on = {}, reloads = 0;
        vm.runInNewContext(js, { addEventListener: function (k, f) { on[k] = f; }, location: { reload: function () { reloads++; } } });
        T.ok(typeof on.online === 'function', 'listens for the connection');
        on.online();
        T.eq(reloads, 1, 'Netra comes back by herself');
    });
});

T.run(__filename);

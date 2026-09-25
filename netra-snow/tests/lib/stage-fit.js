/* Renders the Live stage's grid in a real browser (Playwright's Chromium) with
 * the widget's stylesheet and the template's inline <style>, at the sizes
 * people really use, and prints where each row ends as JSON.
 * Run by live-stage.test.js; prints {"skip": why} when there is no browser. */
'use strict';
var fs = require('fs'), path = require('path');
var W = path.join(__dirname, '..', '..', 'source', 'widget');
var pw = null;
try { pw = require('playwright'); } catch (e) {
    try { pw = require(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright')); } catch (e2) { pw = null; }
}
if (!pw) { console.log(JSON.stringify({ skip: 'no playwright' })); process.exit(0); }

var tpl = fs.readFileSync(path.join(W, 'template.html'), 'utf8');
var css = fs.readFileSync(path.join(W, 'stylesheet.scss'), 'utf8');
var inline = tpl.slice(tpl.indexOf('<style>'), tpl.indexOf('</style>') + 8);

// what the portal's compiler does to the widget stylesheet, as far as layout
// goes: every rule is scoped under .v<sys_id> (so the page's own unscoped
// rules lose on specificity), the inside of @supports and @keyframes is
// passed through as written, a rule with min(), max() or clamp() around
// calc() is dropped whole (found live: it took the stage's grid with it),
// and the space after a ")" before an operator is taken out, so
// "var(--a) + 1px" becomes the invalid "var(--a)+ 1px"
function portal(src) {
    function walk(s) {
        var out = '', i = 0;
        for (;;) {
            var open = s.indexOf('{', i);
            if (open < 0) return out;
            var head = s.slice(i, open).trim(), depth = 1, j = open + 1;
            while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
            var body = s.slice(open + 1, j - 1);
            if (/^@media/.test(head)) out += head + ' {' + walk(body) + '}\n';
            else if (/^@/.test(head)) out += head + ' {' + body + '}\n';
            else if (!/\b(min|max|clamp)\([^;{}]*calc\(/.test(body)) out += head.split(',').map(function (x) { return '.vtest ' + x.trim(); }).join(', ') + ' {' + body.replace(/\)\s+([-+*\/])/g, ')$1') + '}\n';
            i = j;
        }
    }
    return walk(src.replace(/\/\*[\s\S]*?\*\//g, ''));
}
var compiled = portal(css);
// the real control bar and typing box, as the template has them
var BAR = tpl.slice(tpl.indexOf('<div class="netra-stage-controls" role="group"'));
BAR = BAR.slice(0, BAR.indexOf('\n    </div>') + 11);
var TYPE = tpl.slice(tpl.indexOf('<form class="netra-type"'));
TYPE = TYPE.slice(0, TYPE.indexOf('</form>') + 7);
// the real header, with a Guest's Sign in (the widest it gets)
var HEAD = tpl.slice(tpl.indexOf('<header class="netra-stage-head">'));
HEAD = HEAD.slice(0, HEAD.indexOf('</header>') + 9);
// the 'Try saying' starters, which take the aux row before the first question
var TRY = '<div class="netra-try" role="group"><p class="netra-try-h">Try saying</p>' +
    ['What can you do?', 'Tell me a joke', 'What time is it in Tokyo?', 'Search the web for today’s news']
        .map(function (s) { return '<button type="button" class="netra-try-chip">' + s + '</button>'; }).join('') + '</div>';
var LONG = 'Tokyo is nine hours ahead of London, so it is a quarter past six in the evening there, mild and about eighteen degrees.';

// the stage's rows with their real classes; the typing box is open in the aux row
function stage(st) {
    return '<div class="vtest"><div class="netra-root"><div class="netra-stage netra-3d-on netra-cap-' + (st.size || 'm') + '"' + (st.vvh ? ' style="--vvh:' + st.vvh + 'px" data-kbd=""' : '') + '>' +
        HEAD +
        '<div class="netra-stage-center"><div class="netra-stage-orbit"></div>' +
        '<button type="button" class="netra-stage-blob-wrap" id="orb"><svg class="netra-stage-svg" viewBox="0 0 120 120"></svg></button>' +
        '<div class="netra-status" id="status"><p class="netra-status-label">' + st.label + '</p>' +
        (st.hint ? '<p class="netra-status-hint">' + st.hint + '</p>' : '') +
        (st.retry ? '<div class="netra-retry-row"><button class="netra-retry">Try again</button><button class="netra-retry">Type instead</button></div>' : '') + '</div>' +
        '<section class="netra-cap" id="cap"><p class="netra-cap-line"><b class="netra-cap-who is-netra">Netra</b> <span class="netra-cap-text">' + LONG + '</span></p></section>' +
        '</div>' + BAR + (st.aux === 'try' ? TRY : TYPE) +
        '</div></div></div>';
}
var STATES = {
    listening: { label: 'Listening' },
    speaking: { label: 'Speaking', hint: 'Talk or tap to interrupt' },
    retry: { label: 'Couldn’t get an answer', hint: 'Say it again or press Try again', retry: true },
    xl: { label: 'Speaking', hint: 'Talk or tap to interrupt', size: 'xl' },
    starters: { label: 'Listening', aux: 'try' }
};
// a third number is the height left above the on-screen keyboard (--vvh);
// the stage then has data-kbd, as _vvWatch sets it
var SIZES = [[375, 667], [390, 664], [360, 640], [320, 568], [412, 915], [667, 375], [1280, 720], [1366, 657], [390, 844, 480], [390, 844, 380],
    [320, 568, 308], [844, 390, 230], [844, 390, 190], [667, 375, 190]];

(async function () {
    var browser;
    try { browser = await pw.chromium.launch(); } catch (e) { console.log(JSON.stringify({ skip: 'no browser: ' + String(e.message || e).split('\n')[0] })); return; }
    var out = [];
    for (var s = 0; s < SIZES.length; s++) {
        var ctx = await browser.newContext({ viewport: { width: SIZES[s][0], height: SIZES[s][1] } });
        var page = await ctx.newPage();
        for (var k in STATES) {
            // the keyboard is up only while typing, and the starters hide then
            if (SIZES[s][2] && STATES[k].aux === 'try') continue;
            var st = Object.assign({ vvh: SIZES[s][2] }, STATES[k]);
            await page.setContent('<!doctype html><html><head><style>' + compiled + '</style>' + inline + '</head><body class="netra-live-body">' + stage(st) + '</body></html>');
            var m = await page.evaluate(function () {
                function r(sel) { var b = document.querySelector(sel).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; }
                var cap = document.querySelector('#cap'), cs = getComputedStyle(cap), line = parseFloat(getComputedStyle(cap.querySelector('.netra-cap-line')).lineHeight);
                return { stage: r('.netra-stage'), orb: r('#orb'), status: r('#status'), cap: r('#cap'), aux: r(document.querySelector('#netra-type') ? '#netra-type' : '.netra-try'), bar: r('.netra-stage-controls'),
                    // the caption's text area and one line of it; where the middle cuts it
                    capText: Math.round(cap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)), capLine: Math.round(line),
                    head: [r('.netra-head-settings'), r('.netra-stage-brand'), r('.netra-head-signin')],
                    mid: r('.netra-stage-center'), midClip: getComputedStyle(document.querySelector('.netra-stage-center')).overflow,
                    labels: [].map.call(document.querySelectorAll('.netra-ctl-label'), function (l) { return l.textContent + (l.getBoundingClientRect().width > 2 ? '' : ' (hidden)'); }) };
            });
            if (process.env.NETRA_SHOT) await page.screenshot({ path: process.env.NETRA_SHOT + '/' + SIZES[s].join('x') + '-' + k + '.png' });
            m.size = SIZES[s].slice(0, 2).join('x') + (SIZES[s][2] ? ' --vvh ' + SIZES[s][2] : ''); m.state = k;
            out.push(m);
        }
        await ctx.close();
    }
    await browser.close();
    console.log(JSON.stringify(out));
})().catch(function (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); });

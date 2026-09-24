/*
 * The page's instant local replies must never swallow an answer the server
 * is waiting for, and "repeat" must replay what Netra actually said.
 */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra');
var cl = N.loadClient(), c = cl.c, f = cl.fn;
function local(u) { var r = f.matchLocal(u); return r ? r.intent : 'SERVER'; }

T.test('while a read-back waits, yes/ok/scratch-that go to the server', function () {
    c.lastAnswer = 'I can raise that. An incident for "VPN drops". Shall I?'; c._awaitingConfirm = true;
    ['yes', 'ok', 'okay', 'scratch that', 'forget that', 'undo that', 'no'].forEach(function (u) { T.eq(local(u), 'SERVER', u); });
    T.eq(f.matchLocal('repeat that').reply, c.lastAnswer, 'repeat replays the read-back');
});

T.test('a reprompt nudge does not change what "repeat" replays or whether an answer is awaited', function () {
    c.lastAnswer = 'That would put priority back on incident ending 0 1 3. Shall I?'; c._awaitingConfirm = false;
    c.lastSpoken = 'Take your time... I am listening.';   // the 9-second nudge
    T.eq(local('okay'), 'SERVER', 'the question is still open');
    T.eq(f.matchLocal('repeat').reply, c.lastAnswer);
});

T.test('only whole-utterance matches are answered locally', function () {
    c.lastAnswer = 'Done.'; c._awaitingConfirm = false;
    T.eq(local('okay'), 'ack');
    T.eq(local('hello'), 'greet');
    ['hey netra, list my tickets', 'thanks, now resolve it', 'what time was that ticket opened', 'what are you working on',
     'hello, is INC0010013 fixed'].forEach(function (u) { T.eq(local(u), 'SERVER', u); });
});

T.test('the auto flag rides only with its own utterance', function () {
    var src = require('fs').readFileSync(require('path').join(N.SRC, 'widget', 'client.js'), 'utf8');
    T.match(src, /c\.data\.auto = !!c\._nextTurnAuto && c\._nextTurnAuto === transcript;/);
    T.match(src, /awaitingAnswer = _stillAwaiting\(\);/);
    // an auto turn neither sends nor uses up the "never heard" flag
    T.match(src, /c\.data\.drop_unheard = !c\.data\.auto && !!c\._lastReplyUnheard;/);
    T.match(src, /if \(!c\.data\.auto\) c\._lastReplyUnheard = false;/);
});

T.test('the auto briefing waits for an owed answer - but not forever', function () {
    var now = Date.now();
    c._awaitingConfirm = true; c._awaitingConfirmAt = now; c.lastAnswer = 'Done.'; c.lastAnswerAt = now;
    T.ok(f._stillAwaiting(), 'read-back parked just now');
    c._awaitingConfirmAt = now - 11 * 60000;
    T.ok(!f._stillAwaiting(), 'the server dropped it after 10 minutes, so should the page');
    c._awaitingConfirm = false; c.lastAnswer = 'Shall I read the rest?'; c.lastAnswerAt = now - 2 * 60000;
    T.ok(!f._stillAwaiting(), 'an unanswered plain question stops blocking after a minute');
});

T.test('trimming history never wipes it when the last exchange is one long run of tool calls', function () {
    var c = N.loadClient();
    var fn = c.fn || c;
    var P = function (t) { return { role: 'user', parts: [{ text: t }] }; };
    var call = { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] };
    var resp = { role: 'user', parts: [{ functionResponse: { name: 'x', response: {} } }] };
    var arr = [P('first'), { role: 'model', parts: [{ text: 'ok' }] }, P('second')];
    for (var i = 0; i < 10; i++) arr.push(call, resp);
    T.eq(fn._promptIndexFrom(arr, Math.floor(arr.length / 2)), 2, 'keeps from the last prompt');
});

T.run(__filename);

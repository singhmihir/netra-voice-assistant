/* What Netra hears and what she says: number parsing, spoken references, times. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), g = N.glide;
g.reset();
var f = N.loadServer({ input: { action: 'chat' } }).fn;
function nums(u) { return f._findNums(f._normSpoken(u)); }

T.test('ticket numbers from speech', function () {
    T.eq(nums('status of i n c zero zero one zero zero one three'), ['INC0010013']);
    T.eq(nums('i n c 0 0 1 0 0 1 3'), ['INC0010013']);
    T.eq(nums('incident one zero zero one three'), ['INC0010013'], 'spoken prefix + short form');
    T.eq(nums('inc 10013'), ['INC0010013'], 'short form pads to 7 digits');
    T.eq(nums('r i t m zero zero one zero zero zero one'), ['RITM0010001']);
    T.eq(nums('what about CHG0030006 and INC0010013'), ['CHG0030006', 'INC0010013']);
    T.eq(nums('my printer is jammed'), []);
});

T.test('first mention speaks the last three digits', function () {
    T.eq(f._spkNum('INC0010013'), '**incident ending 0 1 3**');
    T.eq(f._spkNum('CHG0030006'), '**change ending 0 0 6**');
    T.eq(f._spkNum('RITM0010001'), '**requested item ending 0 0 1**');
    T.eq(f._spkNum('not-a-number'), 'not-a-number');
    T.eq(f._spokenRefs('INC0010020 assigned to Database'), '**incident ending 0 2 0** assigned to Database');
});

T.test('a sys_id tail read aloud is mapped back to the real ticket', function () {
    var log = [{ result: { matches: [
        { sys_id: '46cebb88a9fe198101aee93734f9768b', number: 'INC0000013' },
        { sys_id: '0123456789abcdef0123456789ab3af3', number: 'INC0000060' },
        { sys_id: '0123456789abcdef0123456789abc345', number: 'INC0000032' }] } }];
    T.eq(f._fixSpokenRefs('Back in March, **incident ending 68b** was slow. Also **incident ending 3af3**.', log),
         'Back in March, **incident ending 0 1 3** was slow. Also **incident ending 0 6 0**.');
    T.eq(f._fixSpokenRefs('**incident ending 0 1 3** is right', log), '**incident ending 0 1 3** is right', 'real tail untouched');
    T.eq(f._fixSpokenRefs('incident ending 3 4 5', log), 'incident ending 0 3 2', 'digit-only sys_id tail');
    T.eq(f._fixSpokenRefs('this is the ending of a bad deal', log), 'this is the ending of a bad deal', 'ordinary words untouched');
    T.eq(f._fixSpokenRefs('incident ending 68b', []), 'incident ending 68b', 'no tool results, no change');
});

T.test('dates are precomputed for the model, not worked out by it', function () {
    T.eq(f._whenSpoken('2026-03-31 19:56:12'), 'in March 2026, about 6 months ago');
    T.eq(f._whenSpoken('2016-12-13 21:43:14'), 'in December 2016, about 10 years ago');
    T.eq(f._whenSpoken('2026-09-20 10:00:00'), '3 days ago');
    T.eq(f._whenSpoken(''), '');
});

T.test('clock times are right for a 12-hour profile format', function () {
    // the shim's getDisplayValue() is a 12-hour user format, like a real
    // profile can be; the old parse heard 3:05 PM as 3:05 AM
    T.eq(f._clockAt(Date.UTC(2026, 8, 23, 15, 5)), '3:05 PM');
    T.eq(f._clockAt(Date.UTC(2026, 8, 23, 0, 30)), '12:30 AM');
    g.P.tzOffsetMs = 5.5 * 3600000;   // IST user
    T.eq(f._clockAt(Date.UTC(2026, 8, 23, 15, 5)), '8:35 PM', 'user timezone applied');
    g.P.tzOffsetMs = 0;
});

T.test('yes / no parsing', function () {
    ['yes', 'yeah', 'ok', 'okay', 'go ahead', 'run it', 'apply them', 'please do'].forEach(function (u) { T.eq(f._yesNo(u), 'yes', u); });
    ['no', 'nope', 'cancel', 'stop', 'never mind', 'forget that', 'scratch that'].forEach(function (u) { T.eq(f._yesNo(u), 'no', u); });
    ['yes but first check the other one', 'no idea', 'okay what about INC0010013'].forEach(function (u) { T.eq(f._yesNo(u), null, u); });
});

T.run(__filename);

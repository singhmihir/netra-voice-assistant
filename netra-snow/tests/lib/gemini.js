/*
 * Scripted stand-in for the Gemini REST API. Tests queue the replies the
 * "model" gives, in order; every generateContent request is recorded so a
 * test can assert how many calls a turn really cost.
 */
'use strict';

function reply(parts) { return { candidates: [{ content: { role: 'model', parts: parts }, finishReason: 'STOP' }] }; }
function text(t) { return reply([{ text: t }]); }
function call(name, args) { return reply([{ functionCall: { name: name, args: args || {} } }]); }
function calls(list) { return reply(list.map(function (c) { return { functionCall: { name: c[0], args: c[1] || {} } }; })); }
function http(status, body) { return { status: status, body: typeof body === 'string' ? body : JSON.stringify(body) }; }
function quota429(kind) {
    return http(429, { error: { code: 429, details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: kind === 'day' ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: kind === 'day' ? '20' : '5' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } });
}

function unitVec(seed) {
    var v = [], s = 0;
    for (var i = 0; i < 768; i++) { var x = Math.sin((i + 1) * (seed + 1)); v.push(x); s += x * x; }
    s = Math.sqrt(s);
    return v.map(function (x) { return x / s; });
}

/**
 * install(P, queue) - queue is an array of replies (from text/call/calls/http);
 * returns a log: { generate: [requestBodies], embed: n, models: [model ids] }
 */
function install(P, queue) {
    var log = { generate: [], embed: 0, models: [] };
    P.HTTP = function (req) {
        var m = /models\/([^:]+):(generateContent|embedContent|batchEmbedContents)/.exec(req.endpoint);
        if (!m) return http(404, { error: 'unknown endpoint ' + req.endpoint });
        if (m[2] !== 'generateContent') {
            log.embed++;
            var body = {};
            try { body = JSON.parse(req.body || '{}'); } catch (e) {}
            var t = JSON.stringify(body).length;
            return http(200, { embedding: { values: unitVec(t % 7) } });
        }
        var reqBody = JSON.parse(req.body || '{}');
        log.generate.push(reqBody);
        log.models.push(decodeURIComponent(m[1]));
        var next = queue.shift();
        // a reply may be computed from what the turn actually sent
        if (typeof next === 'function') next = next(reqBody, JSON.stringify(reqBody));
        if (!next) return http(500, { error: { code: 500, message: 'test script exhausted - the turn made more model calls than the test expected' } });
        if (next.status) return next;
        return http(200, next);
    };
    return log;
}

// a structured-output (responseSchema) reply
function json(obj) { return reply([{ text: JSON.stringify(obj) }]); }

module.exports = { json: json, install: install, text: text, call: call, calls: calls, http: http, quota429: quota429, unitVec: unitVec };

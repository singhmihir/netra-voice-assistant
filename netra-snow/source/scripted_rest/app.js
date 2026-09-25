/**
 * Scripted REST resource: GET /api/__NETRA_SCOPE__/voice/app/{file}
 * PUBLIC (requires_authentication = false): the public Netra Live page is
 * opened by Guests, and a browser fetches these before anyone logs in.
 *
 * Netra as an installable app (a Progressive Web App):
 *   /app/manifest  the web app manifest: name, icons, start page, colours.
 *                  Android Chrome installs it as a real app (a WebAPK in the
 *                  app drawer); iOS Safari uses it for Add to Home Screen.
 *   /app/sw        the service worker: leaves every request alone except a
 *                  navigation to Netra Live that fails for want of a network,
 *                  which gets a small "Netra is offline" page instead of the
 *                  browser's error. Sent with Service-Worker-Allowed: / so the
 *                  page can register it for the /sp scope.
 *
 * The icons are db_image records (served by the platform at /<name>):
 *   netra-app-192.png, netra-app-512.png, netra-app-maskable-512.png,
 *   netra-app-180.png (the iOS home-screen icon).
 * Nothing here reads or writes records, so a Guest learns nothing from it.
 */
(function process(request, response) {
    var file = String((request.pathParams && request.pathParams.file) || '').replace(/\.(json|webmanifest|js)$/, '');

    if (file === 'manifest') {
        var manifest = {
            id: '/sp?id=netra_live',
            name: 'Netra - voice assistant',
            short_name: 'Netra',
            description: 'Talk to Netra, the voice-first ServiceNow assistant. Ask anything, hands-free.',
            start_url: '/sp?id=netra_live&netra_app=1',
            scope: '/sp',
            display: 'standalone',
            orientation: 'any',
            background_color: '#0e0e10',
            theme_color: '#0e0e10',
            categories: ['productivity', 'utilities'],
            icons: [
                { src: '/netra-app-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: '/netra-app-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                { src: '/netra-app-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
            ]
        };
        response.setStatus(200);
        response.setContentType('application/manifest+json');
        response.setHeader('Cache-Control', 'public, max-age=3600');
        response.getStreamWriter().writeString(JSON.stringify(manifest));
        return;
    }

    if (file === 'sw') {
        var sw = [
            "/* Netra app service worker - network first, always. Only a navigation to",
            "   Netra Live that fails for want of a network is answered here. */",
            "var OFFLINE = '<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">' +",
            "  '<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">' +",
            "  '<meta name=\"theme-color\" content=\"#0e0e10\"><title>Netra - offline</title>' +",
            "  '<style>html,body{margin:0;height:100%;background:#0e0e10;color:#e8eaed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +",
            "  'main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center;box-sizing:border-box}' +",
            "  '.orb{width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#a8c7fa,#4285f4 45%,#9b72cb 75%,transparent 76%);opacity:.55;filter:saturate(.6)}' +",
            "  'h1{font-size:22px;font-weight:600;margin:0}p{margin:0;max-width:30em;line-height:1.5;color:#bdc1c6}' +",
            "  'button{font:inherit;font-size:17px;padding:12px 28px;border-radius:999px;border:0;background:#1967d2;color:#fff;min-height:48px}' +",
            "  'button:focus-visible{outline:3px solid #fff;outline-offset:3px}</style></head>' +",
            "  '<body><main role=\"main\"><div class=\"orb\" aria-hidden=\"true\"></div><h1 role=\"alert\">Netra is offline</h1>' +",
            "  '<p>Your phone has no connection right now. Connect to the internet and Netra will be right back.</p>' +",
            "  '<button onclick=\"location.reload()\">Try again</button></main>' +",
            // back by itself the moment the connection returns
            "  '<script>addEventListener(\"online\",function(){location.reload()})</script></body></html>';",
            "self.addEventListener('install', function () { self.skipWaiting(); });",
            "self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });",
            "self.addEventListener('fetch', function (e) {",
            "  var req = e.request;",
            "  if (req.mode !== 'navigate' || req.method !== 'GET' || req.url.indexOf('id=netra_live') < 0) return;",
            "  e.respondWith(fetch(req).catch(function () {",
            "    return new Response(OFFLINE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });",
            "  }));",
            "});"
        ].join('\n');
        response.setStatus(200);
        response.setContentType('application/javascript');
        response.setHeader('Service-Worker-Allowed', '/');
        response.setHeader('Cache-Control', 'no-cache');
        response.getStreamWriter().writeString(sw);
        return;
    }

    response.setStatus(404);
    response.setContentType('application/json');
    response.getStreamWriter().writeString(JSON.stringify({ ok: false, error: 'unknown app file: ' + file }));
})(request, response);

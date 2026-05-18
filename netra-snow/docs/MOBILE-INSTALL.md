# Netra on Mobile — Install Guide (R3.3)

Netra ships as a **Progressive Web App (PWA)** on top of the ServiceNow
Service Portal page that already hosts the widget. From R3.3 onward, the
client controller injects a web manifest, an Apple touch icon, and the
necessary `apple-mobile-web-app-*` meta tags at boot, so any modern phone
browser will offer "Add to Home Screen" / "Install app" on the SP page.

Once installed, the home-screen icon launches Netra **full-screen, no
browser chrome**, in portrait, with the violet theme colour applied to
the system status bar.

---

## 1. Prerequisites

- The Service Portal page where Netra is embedded must be reachable from
  the phone (over the open web or via VPN to your ServiceNow instance).
  On a Personal Developer Instance the URL is:

      https://dev373407.service-now.com/sp?id=index

- You must be able to log in to ServiceNow on the phone. Modern PDIs go
  to sleep after ~24h of inactivity; if `/sp` returns a sleep screen,
  log in to the instance from a desktop first to wake it up.

- The phone browser must allow the microphone for the SP origin. Both
  iOS Safari and Android Chrome will prompt the first time Netra opens
  its mic stream.

---

## 2. Install on Android (Chrome / Edge / Brave)

1. Open Chrome on the phone.
2. Sign in to ServiceNow and navigate to `/sp?id=index`.
3. Tap the **three-dot menu** (top-right).
4. Tap **"Install app"** (Chrome) or **"Add to Home screen"** (Edge / Brave).
   - Chrome may auto-suggest a banner saying *"Netra — Voice for
     ServiceNow"* — tapping that works the same way.
5. Confirm the install. The Netra icon appears on the home screen.
6. Tap the icon. Netra launches in standalone mode (no URL bar, no
   browser tabs, no back button visible — only the orb).

### What Android handles natively
- **Continuous speech recognition** — Chrome on Android supports the
  Web Speech API including `continuous = true`. The mic stays open as
  intended.
- **Speaker-cone pulse + voice ring** — Web Audio API is fully
  supported.
- **Hardware mute key** — pauses the mic; Netra resumes when unmuted.

---

## 3. Install on iPhone / iPad (Safari)

iOS only allows PWA install through Safari (not Chrome/Firefox — they
re-skin Safari but the "Add to Home Screen" affordance lives in the
Safari share sheet).

1. Open **Safari** on the phone (not Chrome).
2. Sign in to ServiceNow and navigate to `/sp?id=index`.
3. Tap the **Share** button (square-with-arrow icon in the bottom bar).
4. Scroll down to **"Add to Home Screen"** and tap it.
5. The dialog shows the Netra icon and the title *"Netra"*. Tap **Add**.
6. The icon appears on the home screen. Tap to launch — Netra opens in
   full-screen standalone mode with the violet status bar.

### Known iOS Safari limitations (browser-imposed, not Netra)
- **Speech recognition is non-continuous.** iOS Safari requires a fresh
  user gesture per recognition session — the mic stops after each
  utterance. Netra detects this and re-arms the recognizer on the next
  tap on the orb. *In practice this means iOS users tap the orb once
  per command, instead of speaking continuously.*
- **No background mic.** When Netra is not the foreground app, the mic
  closes. Netra resumes when the app is foregrounded again.
- **No Web Bluetooth / Web USB.** Not used by Netra, listed for
  completeness.
- **Wake-word "Netra" still works** when the orb is active in
  foreground; it is the *continuous* recognition between commands
  that iOS does not allow.

---

## 4. What the manifest contains

The manifest is generated at runtime by `_installPWA()` in
`source/widget/client.js` and attached as a Blob URL to a
`<link rel="manifest">` tag in `<head>`:

```json
{
  "name":             "Netra - Voice for ServiceNow",
  "short_name":       "Netra",
  "description":      "Voice-first ServiceNow assistant for blind and low-vision users.",
  "start_url":        "/sp?id=index",
  "scope":            "/sp",
  "display":          "standalone",
  "orientation":      "portrait",
  "background_color": "#0a0a14",
  "theme_color":      "#b48af0",
  "lang":             "en-IN",
  "icons": [
    { "src": "/sys_attachment.do?sys_id=a73423ab9370c350936af0a75d03d62e", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
    { "src": "/sys_attachment.do?sys_id=1144e32393b0c350936af0a75d03d62d", "sizes": "192x192", "type": "image/png", "purpose": "any" }
  ]
}
```

The icons live as `sys_attachment` records on the widget itself, so
they ship with the widget update set — no separate CDN.

---

## 5. Uninstall / reinstall

- **Android**: long-press the icon → *Uninstall*. Reinstall is just
  step 2.4 again.
- **iOS**: long-press the icon → *Remove App* → *Delete from Home
  Screen*. Reinstall is step 3.4 again.

If Netra was updated (new widget version) after the install, the PWA
shell refreshes automatically when the user re-opens the app and the
network is reachable. There is no service worker yet (see *Limitations*
below) so refresh is online-only.

---

## 6. Current limitations and roadmap

| Limitation | Workaround | Status |
|---|---|---|
| iOS Safari one-shot speech recognition | Tap orb per command | Browser-imposed |
| No offline mode (no service worker) | Stay online | R3.4 candidate |
| No background notifications (no push) | Foreground only | R4 candidate |
| PDI sleep on inactivity | Wake instance first | Hosting-specific |
| Mic icon in iOS status bar | Cosmetic only | iOS-imposed |

---

## 7. Verifying the install

After install, on the phone:

1. Launch Netra from the home screen.
2. Confirm the address bar is **gone** (proves standalone mode).
3. Confirm the orb renders in **violet** dormant breathing — proves
   the latest stylesheet shipped.
4. Tap the orb. Grant mic permission when prompted.
5. Say *"Netra, what's the time?"* — Netra should respond verbally
   within ~1.5s on a fast connection.

If any of those fail, open the desktop version of `/sp?id=index` and
press **Alt+Shift+D** to bring up the dev panel — the *Voice* tab will
show whether `_installPWA` ran (event name `pwa` in the log).

# Netra — voice-first assistant for ServiceNow

A scoped ServiceNow Service Portal widget that lets blind and visually-impaired users operate the platform entirely by voice. Runs natively inside ServiceNow — no external services, no recurring cost.

> The repo root is intentionally minimal; the working code, docs, and deployment artefacts live under [netra-snow/](netra-snow/).

## Layout

| Path | What lives there |
|---|---|
| [netra-snow/source/widget/](netra-snow/source/widget/) | The four widget files: `template.html`, `client.js`, `server.js`, `stylesheet.scss` |
| [netra-snow/docs/](netra-snow/docs/) | Technical Design Document + test report |
| [netra-snow/update-set/](netra-snow/update-set/) | Canonical deployment bundle: `NetraDeploymentV1.xml` |
| [netra-snow/scripts/](netra-snow/scripts/) | PowerShell + Python helpers for build, diagrams, and update-set export |
| [netra-snow/install/](netra-snow/install/) | One-shot installer that wires the scoped app and Business Rule |
| [netra-snow/branding/](netra-snow/branding/) | Logo, icon, and badge assets |
| [netra-snow/preview/](netra-snow/preview/) | Standalone HTML preview of the orb UI |

## Getting started

See [netra-snow/INSTALL.md](netra-snow/INSTALL.md) for the deployment procedure and [netra-snow/README.md](netra-snow/README.md) for the voice-command reference.

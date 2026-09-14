# Browser-host Sites acceptance — 12 September 2026

The room creator runs the authoritative shared physics and bots in the browser. Real WebRTC connects same-LAN guests; D1 stores only temporary signaling. This mode has no host migration, STUN/TURN relay, paid external game server, custom domain or AI API.

## Verified locally

- Final lint, both TypeScript projects and 644 tests across 68 files passed. The separate eight-client Node load gate and Node production build passed before the final browser-only join fix.
- HostRuntime tests cover unjoined/guest command authority, malformed input, eight-bot spectator simulation, late-spectator sync and resume credential rejection. SQLite-backed signaling tests cover reservation conflicts, credentials, bounded offers and expiry using the production SQL/migrations.
- Two independent Chromium browser sessions ran the actual Sites build at the local Worker/SQLite preview. Guest initial join, fighter-to-spectator transitions, eight bots with mixed chassis and difficulties, two spectators, natural knockouts and results passed. Both browsers returned byte-for-byte identical result-table text (Bot 9 won the first match with 3 KO). Rematch reset scores and the second natural result reached both browsers (Bot 8 won).
- Host departure closed the guest connection, displayed a recoverable message and still allowed leaving the room. A fresh room with two human fighters started. Real keyboard movement/attack was exercised; guest page reload restored the same participant into the active match through the existing resume grace.
- Two store-level arrival-order regressions were reproduced before fixing them: fresh guest room/match publications preceding welcome, and creating another room after leaving. Deferred initial delivery now lets the action acknowledgement establish the new session; stale deferred work is discarded on generation change. Three transport/store tests cover initial lobby, late spectator and subsequent host/guest room entry.
- Portrait lobby and landscape match screenshots were inspected for clipping, controls and responsive fit. Desktop eight-bot capture was inspected. These are desktop Chromium viewport checks, not physical mobile-device acceptance.
- Existing Node Chromium journeys: host settings/leave/rejoin, rematch consecutive quick attacks, result participant statuses, all four lobby models, and live Three.js movement/ability passed. The long keyboard/combat/reconnect/result journey initially reached full heavy charge under concurrent browser load (450 ms instead of partial charge); its unchanged focused rerun passed in 19.2 seconds. No threshold was weakened.

## Corrected findings

Intrinsic lobby frame height fixes buttons being clipped outside the polygon frame. The installed Three.js release maps the removed PCFSoftShadowMap to PCFShadowMap; selecting PCFShadowMap directly removes that renderer warning. Host/guest initial publication ordering now respects the store's protection against stale departed-session events.

## Publication and limits

Site registration exists in `.openai/hosting.json`; user explicitly authorized public access. Source push, saved version and deployment remain separately tracked through Sites responses. This file records local acceptance and does not claim successful production deployment. Original game checkout and its service were left untouched.

OpenAI Help Center confirms Sites usage is included within plan-specific public-beta limits: https://help.openai.com/en/articles/20001339. The site needs internet to load and establish a room, then gameplay travels directly across the local network. Isolated guest Wi-Fi can prevent a direct route. Host tab must remain open and active. Host reload/closure ends the room; guests cannot take over. Plan limits or future beta changes can restrict hosting; no unlimited-free promise is made. Physical second-device Wi-Fi/LAN and shipping Safari acceptance remain unperformed.

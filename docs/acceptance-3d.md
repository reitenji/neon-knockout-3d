# Neon Knockout 3D acceptance — 2026-09-12

Implementation commit: `a51154c82c35c31f5755c811dd3a9c8abb6061bf`.

This release is an independent Three.js 2.5D game based on published Neon Knockout main (`4a4e788`). The original working checkout was preserved. Four original articulated fighters have distinct silhouettes, motion and authoritative Space abilities: RIFT rush, BASTION armor, PULSE radial burst, WRAITH phase. The shared fighter definitions also drive local movement prediction and HUD cooldowns.

## Automated and visual evidence

- `npm run verify`: ESLint, both TypeScript projects, **610 tests in 62 unit/integration files**, ten-second eight-client Socket.IO load check, production client/server build.
- Chromium: 12 browser journeys covering invites, host settings, join/leave/rejoin, keyboard combat, reconnect, results, rematches, lobby character previews, live Three.js movement/ability, landscape touch input, WebRTC and forced Socket.IO/polling fallback.
- Chromium performance: two additional gates passed with unchanged performance thresholds. One real 1280×720 browser rendered eight authoritative players while seven lightweight Socket.IO clients generated combat. Median 120.48 FPS, p95 frame time 10 ms. Four simultaneous credited knockouts produced a maximum correlated frame time of 10.3 ms. See [recorded metrics](../artifacts/qa/performance.json).
- A 20 ms simulated RTT browser check passed: immediate rendered prediction and bounded reconciliation (p95 correction 1 unit). This is a controlled same-host impairment test.
- Playwright mobile WebKit: one trusted touchscreen attack reached the authoritative server through WebRTC exactly once.
- Reviewed desktop lobby, desktop match and mobile match screenshots. Four fighters are distinguishable; preview framing and desktop lobby footer were corrected. See [lobby](../artifacts/qa/lobby-desktop.png), [match](../artifacts/qa/match-desktop.png), [mobile](../artifacts/qa/match-mobile.png).

## Review corrections

A scoped simulation review caught PULSE retaining its own spawn protection while bursting. Accepted offensive activation now clears it before contact resolution; rejected activation and nonoffensive dashes preserve protection. Regression coverage checks all three behaviors.

The renderer review caught return animation starting before the server selected the spawn point and a missing protection cue. The fighter now stays faded during respawn delay and animates its return at the authoritative spawn position; a stable white ground ring indicates active spawn protection. Predicted offensive actions remove that cue promptly. Focused presentation tests reproduce the original failures and verify the corrected lifecycle and disposal.

The performance fixtures were adjusted for intentional character differences: the movement-latency sampler resets fighter positions before the combat load, and the two BASTION targets start 10 units nearer the fall boundary so armor still allows four same-tick knockouts. Thresholds were not relaxed.

## Practical limits

All automated participants ran on one Mac. Frame and latency measurements describe this machine and controlled test run, not every phone or Wi-Fi network. No second physical phone/laptop acceptance was performed. Runtime assets are local, and the host prints private LAN invite URLs; TCP 4175 and UDP 53140–53171 are separate from the original game's defaults. A second device on the same Wi-Fi must use the host's LAN address, not localhost.

The final production host returned HTTP 200 from `/health` through both loopback and its private LAN interface, with a wildcard TCP listener on port 4175. This proves host reachability from the host machine only.

The game uses procedural low-poly robots and authored pose curves. It does not include imported motion-capture characters, online matchmaking, WAN relays, or a hosted Internet deployment.

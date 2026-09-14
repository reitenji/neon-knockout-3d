# Browser-hosted LAN matches through Sites

This living ExecPlan follows /Users/serkances/.codex/PLANS.md. Execute inline using superpowers:executing-plans; no delegation is requested. Work only in /Users/serkances/dev/neon-knockout-3d.

## Purpose and approved behavior

The user asked to publish through Sites, then explicitly accepted the room creator's browser acting as host when a fully server-hosted Sites architecture is unavailable. Other browsers on the same Wi-Fi/LAN connect to the creator via WebRTC data channels, which are encrypted browser-to-browser connections. Preserve eight total fighters, up to eight additional spectators, bots, mechanics, lobby, results and rematches. The host may be a spectator. Closing or reloading the host tab ends its room; do not pretend host migration is implemented. No paid relay or external game hosting service will be provisioned. Sites supplies source hosting and a small D1-backed connection mailbox; D1 stores temporary offers/answers, never per-frame game simulation. Existing Node LAN mode remains usable for the already shipped game and its acceptance tests.

## Progress

- [x] Inspect Sites capabilities, document why shared server state is not verified, and get user's browser-host direction.
- [x] Existing mechanics/bot/spectator unit and integration checks: 635 tests plus eight-client load and production build pass.
- [x] Resolve existing lobby browser interaction regression and finish baseline bot watch acceptance.
- [x] Make room simulation browser-portable and add validated host command/runtime tests.
- [x] Implement short-lived D1 signaling API with owner/guest authorization, bounds and cleanup; exercise it against SQLite.
- [x] Implement browser GameClient with WebRTC host/guest sessions, readable loss behavior and refresh-based fighter resume.
- [x] Add Sites build output and truthful LAN hosting copy; run local browser host/guest/bot/spectator flows.
- [ ] Register exactly one Site, save exact source, package and deploy with the explicitly approved public audience; check deployed runtime.

## Context and interfaces

src/server/rooms/roomManager.ts already owns bots, room roles and simulation. Its only Node-only dependencies are token comparison and hex parsing; replace these with portable byte operations while retaining token validation and existing tests. All game modules otherwise use plain TypeScript. src/client/network/GameClient.ts defines the interface consumed by gameStore.ts and App.tsx. Implement that interface in a separate BrowserHostClient.ts, choosing it only in the Sites build using Vite mode sites. Node LAN builds keep the Socket.IO client.

Create src/client/network/browserHost/HostRuntime.ts to own a RoomManager, validate command payloads with existing protocol schemas, and send GameClient events to each connection. The host local connection is reserved and cannot be impersonated by remote requests. Peer commands never choose another connection's identity. Only a joined member receives room or match events. Bind a fresh unpredictable connection ID per data channel, reject oversized/malformed messages, and enforce the 8-fighter/8-spectator constraints in RoomManager. Deliver snapshots in increasing tick order and skip snapshot sends when the peer's buffered output is excessive.

src/sites/signaling.ts exports a Worker-compatible fetch handler. D1 contains room code, high-entropy owner credential, expiry and connection offers with high-entropy per-guest credentials. All remote owner operations require the owner credential. Guest polling only sees its own answer. Limit SDP size, pending offers and expiration. Use SQL prepared statements and migrations under drizzle. Serve frontend assets through the Sites asset binding. Endpoints under /api/peer-rooms provide room reservation, heartbeat/pending offers, guest offer creation, owner answer submission, guest answer polling and owner closure. Connection mailbox data expires and is deleted in bounded batches. Never expose credentials in logs or source URLs.

The browser host advances the exact shared RoomManager on a bounded timer, dispatches its own input locally and remote input from WebRTC, and broadcasts room/snapshot/event messages. BrowserHostClient creates offers with no external ICE servers for same-LAN scope. It polls Sites only during establishment; the host refreshes its room lease while available. Explain unsupported isolated guest Wi-Fi or browsers that cannot establish a peer route through a visible recoverable connection error. A dropped guest reconnects through the same mailbox and existing resume token/grace rules. Closing the host ends all peer sessions and eventually expires the mailbox.

## Milestones and validation

First preserve baseline room and visual behavior, repairing only evidenced regressions. Run the current vitest suite, lint/typecheck/build and targeted existing Playwright flows.

Next exercise HostRuntime directly with simulated message delivery: solo host plus bots, guest fighter/spectator join, unauthorized bot management, malformed input, capacity, results and host closure. Test signaling SQL using local SQLite with the same prepared statements, proving credentials cannot read other offers or control rooms and expired entries are inaccessible. Local worker preview should use the same handler behind a minimal Node-only test/dev server with SQLite and static dist/client; production Worker source must not import Node SQLite or HTTP.

Then exercise the Sites browser build with two independent real browser contexts, not mocked RTCPeerConnection: room creation, guest connection, same snapshot/scoring, spectator join, eight-bot watching, rematch, guest reconnect and host closure. Record same-host browser acceptance separately from physical second-device LAN acceptance. Check portrait lobby and landscape match layouts and game-frame performance.

Finally build dist/server/index.js as a Cloudflare Worker and dist/client assets plus dist/.openai/hosting.json and D1 migrations. Use the Sites plugin's registration, exact-source push, package, save/deploy and status contracts. Never fabricate live URLs or mark a pending/failed deployment successful. Respect the default private audience until explicit sharing is requested.

## Decision Log

On 12 September the user chose a browser host after investigation found no documented Sites binding for Durable Objects. This changes trust to the room owner and permits host-dependent session lifetime. Preserve physics and game presentation, changing only hosting/transport and explanatory copy. D1 is used as a short-lived rendezvous store because Worker module memory is not shared across requests. Keep the existing Node server as the separate local execution target during verification and for current LAN users.

## Surprises & Discoveries

The resumed branch contains committed mechanics and uncommitted bot/spectator and visual work. The full baseline unit suite is green after adding metadata to fixtures and staging the old jab-ringout test nearer the void threshold. Existing browser tests currently time out near lobby readiness; inspect real element action logs and fix before claiming completion.

## Outcomes & Retrospective

Implementation and publication remain in progress. Sites billing documentation confirms beta plan limits but did not establish an unlimited zero-cost guarantee; no separate paid hosting has been provisioned. Physical second-device acceptance remains unperformed.


### 12 September implementation evidence

641 tests across 67 files passed before the final guest-order regression was added. Lint and both TypeScript checks passed. A real browser found initial room events arriving before the guest welcome; a store-level regression reproduced LANDING instead of LOBBY, then the fix passed for both lobby and late-spectator match synchronization. Room events are buffered until the welcome establishes identity. Two independent Chromium sessions connected through real RTCPeerConnection using the local Sites Worker preview. Eight mixed-chassis/difficulty bots and two spectators ran naturally to a result: both browsers showed exactly the same eight-player result table, including Bot 9 winning with three knockouts, and rematch restarted at zero scores. No forced ringout or fake WebRTC was used in that browser acceptance. The lobby clip-path issue was fixed with intrinsic frame height; targeted existing Node host-settings acceptance passed.

The Site was registered exactly once as appgprj_6aa5803bd7ac81918fd6d885c1532a20. User explicitly approved public access; access revision 2 is public. Native source push/save/deploy are still pending. OpenAI Help Center now confirms beta usage is included within plan limits. No paid external service was provisioned. Physical second-device tests remain unperformed.

Final local acceptance: 644 tests, lint/typecheck, two-browser guest refresh/resume, repeated room creation, portrait lobby and landscape match passed; see docs/acceptance-browser-host.md. Public source publication is the remaining step.

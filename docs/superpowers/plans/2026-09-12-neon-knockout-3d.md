# Neon Knockout 3D Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the character simulation task with a scoped review. The controller owns renderer and integration. This is a living ExecPlan following /Users/serkances/.codex/PLANS.md.

**Goal:** Publish a separate, playable LAN arena game with Three.js 2.5D rendering and four distinct animated fighters with server-authoritative abilities.

**Architecture:** Keep the existing Node simulation and networking, and replace Phaser with Three.js. Shared fighter metadata controls both prediction and simulation. Articulated procedural models keep the entire game self-contained.

**Tech Stack:** TypeScript, React, Three.js, Node, Socket.IO, WebRTC, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-09-12-neon-knockout-3d-design.md

## Global Constraints

Work only in /Users/serkances/dev/neon-knockout-3d. Preserve /Users/serkances/dev/game and its uncommitted work. Product copy is Turkish. Default port is 4175. Play supports two to eight players on the same LAN. No external assets are fetched at runtime. Existing WASD/J/K/Space and touch controls remain. Each chassis must have a unique silhouette, animation personality, and gameplay ability. Server and prediction must agree about movement. The original published source SHA is 4a4e7887a6a28cc2aab8d45efc4a53f3f6efaca3.

## Progress

- [x] (2026-09-12) Verify source, authorization and remote identity; create isolated repository checkout on feature/neon-knockout-3d.
- [x] Establish passing inherited test baseline: 69 files / 682 tests.
- [x] Task 1: implement and test character abilities and shared prediction: commits 19018ad + eee046e; scoped review approved after the PULSE protection regression fix.
- [x] Task 2: replace the renderer with authored 3D fighters, arena, animation, input and audio integration.
- [x] Task 3: integrate previews, ability descriptions, HUD and Turkish product identity.
- [x] Task 4a: browser acceptance, scoped review, fix findings and document evidence.
- [x] Task 4b: published main to https://github.com/reitenji/neon-knockout-3d; first release f17e10d, verified 0/0 local/remote parity.

## Context and Orientation

src/server/game/simulation.ts advances a server-owned match. movement.ts applies movement; combatResolution.ts applies hits and credit. src/shared/kinematics.ts and src/client/game/prediction.ts share movement prediction. src/client/game/GamePresentationBridge.ts delivers network snapshots and input. The starting source used src/client/game/phaser for rendering alongside reusable input, session and timeline adapters, embedded through PhaserArena.tsx. The completed renderer now lives in src/client/game/three, embedded through ThreeArena.tsx. Retain reusable session/timeline/attack cue logic in a renderer-independent runtime directory, remove Phaser-specific renderers and their obsolete tests after replacing their behavior. tests/e2e/fixtures.ts starts an isolated real server for browser tests.

## Task 1: Distinct fighter abilities

Ownership: src/shared/fighters.ts, src/shared/kinematics.ts, src/client/game/prediction.ts, src/server/game/*.ts, and associated behavior tests. Do not edit renderer, React UI, dependencies, or package configuration. Use existing chassis identifiers RIFT, BASTION, PULSE, WRAITH. Export FIGHTERS keyed by Chassis with fields name, role, abilityName, description, color, moveSpeed, dashSpeed, dashDurationMs, dashInvulnerabilityMs, dashCooldownMs, knockbackMultiplier and any clearly named additional numeric values. Keep model/protocol changes minimal; use the existing dash field and snapshot timers instead of another ability button or optional protocol generation.

Implement RIFT as fast forward rush (move speed 350, dash speed 900, duration 160ms, invulnerability 100ms, cooldown 1300ms). BASTION is heavy (move speed 275, dash speed 420, duration 250ms, invulnerability 0ms, cooldown 1700ms), resisting incoming knockback at multiplier 0.65 normally and 0.3 during the armored advance. PULSE (move speed 315, dash speed 650, duration 140ms, invulnerability 80ms, cooldown 1800ms) emits a radius-125 radial burst on a newly accepted dash; burst gives 8 overload and 260 base impulse, respecting existing respawn protection, invulnerability, hit credit and one-hit-per-activation rules. WRAITH (move speed 340, dash speed 780, duration 210ms, invulnerability 190ms, cooldown 1550ms) has a long phase window and incoming knockback multiplier 1.12. All unmentioned normal incoming knockback multipliers are 1. Existing perfect dodge refund remains bounded by each cooldown.

Use a new test that creates one match of each chassis, advances identical movement, and proves BASTION < PULSE < WRAITH < RIFT travel distance. Exercise accepted dash through public simulation inputs, checking its snapshot timers, pulse burst hit credit exactly once, invulnerability and protected targets, and no activation during respawn or stun. Compare client prediction and server positions for each chassis. Tests must fail before implementation and pass afterward. Update existing assumptions only where distinct abilities intentionally replace universal values; preserve neutral RIFT combat timings. Run npm test with targeted files before full integration.

## Task 2: Three.js match rendering

Ownership: controller. Create src/client/game/three/FighterModel.ts for geometry/pivot ownership, fighterMotion.ts for pure animation poses, ArenaWorld.ts for platform and lighting, createThreeGame.ts for frame loop and bridge integration. Move renderer-independent input/session/audio/timeline helpers into src/client/game/runtime and replace Phaser keyboard/audio adapters with DOM keyboard and Web Audio adapters. React ThreeArena replaces PhaserArena; factory returns a destroy method and releases RAF, subscriptions, geometry, materials, renderer context, and keyboard listeners.

Create all four articulated silhouettes using Three.js mesh groups. Coordinates are world x=simulation x-640, world z=simulation y-360. Orthographic camera sees the entire octagon, while height supplies legs, body, shadow and falling motion. Root transforms follow authoritative/predicted positions; body and limbs animate independently without changing hitboxes. Frame loop samples the existing ArenaSession, samples SnapshotTimeline for remote players, applies attack cues at their server timing, and renders pulses and event effects. Preserve reduced motion and handle renderer construction failure with a visible Turkish error. Remove Phaser dependency and all obsolete renderer paths only in this new repository. Verify model geometry and deterministic poses using Node tests; browser checks verify the actual canvas.

## Task 3: Lobby and HUD

Add a shared Three.js character showcase to the lobby, selecting one detailed preview while four compact options identify every chassis. Display FIGHTERS abilityName and description. Use shared cooldown values and snapshot remaining time in MatchHud. Update product name, title and README to Neon Knockout 3D, describe Space abilities and default LAN port 4175. Touch controls must expose the selected ability name without losing their existing input contract. Keep all game content local and preserve same-network join links.

## Task 4: Acceptance and publication

Run npm run lint, npm run typecheck, npm test, npm run build, then the browser journeys appropriate to the changed renderer (lobby selection, two-client combat, ability use, result/rematch, reconnect, landscape touch, and eight-player rendering). Capture desktop and mobile screenshots under artifacts/qa. Inspect them for distinct silhouettes, readable combat, missing meshes, clipped controls and console errors. Run a scoped code review over the new branch and correct material issues. Default host must return HTTP 200 at /health on localhost and the actual discovered private address; do not claim a physical second device was used unless it was.

After checks pass, commit and create reitenji/neon-knockout-3d as a public repository, matching the original project's visibility and the user's explicit request to send the new repository. Push the verified branch as main and verify remote SHA and git rev-list parity. Do not push to the upstream repository. Keep local host available for the user and provide the local and GitHub URLs with tested limitations.

## Surprises & Discoveries

The inherited Phaser implementation passed 682 tests. Replacing renderer-only tests while preserving reusable runtime tests yields a different suite count. Actual browser flows passed: joining, settings, combat, reconnect, result/rematch, touch input, network fallback, and WebRTC. A fixed-width preview camera initially clipped tall models; viewport-aware camera extents and podium spacing fix the framing. The new UDP range is 53140–53171 so both games can run concurrently.

The source working checkout is on an older dirty WebRTC branch while upstream main already contains the published adaptive networking implementation. The new repository therefore starts from verified upstream main rather than copying incomplete working edits.

## Decision Log

Use an independent clone and a feature branch instead of a nested worktree: the user requested an independent repository, and this isolates both source files and git metadata. Reuse established robot names and controls; special movement abilities occupy Space so the existing keyboard/touch/network input contract stays simple. Procedural articulated robots are final authored assets, not model placeholders. They avoid external asset dependencies while making shape and motion controllable.

## Validation and Acceptance

All commands run in /Users/serkances/dev/neon-knockout-3d. npm ci installs the lockfile; npm run verify checks lint, TypeScript, unit/integration/load tests and production build. npm run lan serves the game on port 4175. Join two independent browser sessions, choose different fighters, ready both and start a match. Both must observe the same positions, hits and score. Movement ability activates only on a new Space press and respects cooldown. All four models and their actions must be visible in browser captures. A screenshot alone does not prove networking or animation; report simulation tests, real browser motion/input checks and host reachability separately.

## Idempotence and Recovery

The old checkout and upstream remote are read-only sources. Never clean or reset either. New files and dependencies belong only to the independent clone. Use file-scoped commits and review diffs; do not publish generated logs, secrets, node_modules or test-run output. Stop only processes started by this task when restarting the new host.

## Outcomes & Retrospective

Implementation passed 610 tests, the eight-client load gate, lint, type checks and production build. Sixteen distinct browser checks cover Chromium combat/UI, performance, WebKit touch and the 20 ms simulated RTT tier. Scoped review fixed PULSE spawn-protection cancellation, return-animation timing and the visible protection cue. Production /health returned HTTP 200 via loopback and the private LAN address. See docs/acceptance-3d.md for measurements and the explicit physical-device acceptance limit. Implementation is committed as a51154c. Published to independent public repository https://github.com/reitenji/neon-knockout-3d on main; first release f17e10d verified with 0/0 local/remote parity. Final documentation records this completed result. The new production host remains available on port 4175.

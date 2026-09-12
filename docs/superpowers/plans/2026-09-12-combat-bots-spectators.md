# Combat feel, eight bots and spectators

> **For agentic workers:** Use superpowers:subagent-driven-development task by task. This ExecPlan follows /Users/serkances/.codex/PLANS.md and is self-contained; update Progress and Outcomes throughout execution.

## Purpose and approved scope

The user finds the animations and combat weak and has explicitly asked to improve mechanics first, then add up to eight bots using the same rules, with spectator participation managed in the lobby. Work only in /Users/serkances/dev/neon-knockout-3d; preserve the original game checkout. Deliver observable improvements to movement, contact and combos, then a solo host can choose to fight bots or watch a bot-only match. Continue through integration, tests, browser acceptance, publication and restart of only com.reitenji.neon-knockout-3d on port4175. Do not describe this as completion of the separate brainstormed team/map/mode backlog.

## Progress

- [x] Inspect current source and confirm clean main301f155; create feature/combat-bots-spectators.
- [ ] Improve and verify shared movement/combo/edge recovery mechanics.
- [ ] Improve distinct full-body animations, contact feedback and directional recoil.
- [ ] Add authoritative bots and spectator room lifecycle after mechanics contract settles.
- [ ] Add lobby management, spectator rendering and result flows.
- [ ] Run integrated tests and real browser solo/watch/mixed flows; review and fix findings.
- [ ] Publish verified changes and restart the new game host; report actual acceptance limits.

## Constraints and decisions

Use existing Three.js, React, Socket.IO/WebRTC and deterministic Node simulation. Bots submit ordinary InputFrame values through the simulation; no external AI APIs. Eight bots must be supported. User confirmed at most eight total fighters (human plusbot), with spectators outside that limit. A spectator host can watch eight bots. Keep GAME.maxPlayers=8; do not add a ninthfighter. Bound human spectators to8 perroom to keep resource use finite. Keep Turkish controls, WASD/J/K/Space and touch. Do not reintroduce a second renderer, input protocol generation or legacy adapter.

## Context and interfaces

src/shared/kinematics.ts advances player positions and is used by src/server/game/movement.ts and src/client/game/prediction.ts. src/shared/constants.ts and combat/profiles.ts supply quick/heavy timing and impulse. src/server/game/combatResolution.ts generates HIT metadata and hitstun. src/client/game/three/FighterModel.ts owns articulated geometry, fighterMotion.ts produces poses, FighterView.ts applies them to roots and limbs, and createThreeGame.ts consumes immutable snapshots and events. Visual poses must not change authoritative positions or stall network sampling.

src/server/rooms/roomManager.ts owns identities, ready states, host migration, match creation, result lifecycle and simulation ticks; createGameServer.ts binds schema-validated socket commands. src/shared/model.ts and protocol.ts define serialized types. Client socket actions live in src/client/network and state/gameStore.ts; LobbyScreen.tsx and App.tsx render actions. Spectators remain human room members and receive match snapshots, but never appear in simulation players, rankings or damage/score targets.

## Milestone 1: mechanical foundation

Controller owns shared kinematics/constants, server combat rules and focused simulation tests. Make voluntary release stop decisively by linear deceleration to exact zero when normal grounded speed is at or below moveSpeed, while preserving knockback decay above normal movement speed and outside-platform physics. Keep prediction and server identical. Reduce first and second quick impulses from280/325 to110/150; retain a strong third455 and heavy460–760. Keep their existing overload accumulation and bounded stun so a victim has defensive opportunities. Verify the first two hits keep a stationary opponent close enough to follow with the next combo and a third hit launches substantially farther. Preserve ability-specific armor and phase behavior. Existing tests that require a huge first jab for scripted ringouts must use a finisher/appropriate staged edge distance, never lower correctness or performance thresholds. Recovery uses the existing directional Space ability after hitstun: steer back to platform and consume normal cooldown, with tests proving escape works near the ledge and cannot be repeated during cooldown. No new grab/throw subsystem.

Use a focused gameFeel.test.ts and shared kinematic tests to establish failing assertions before edits: grounded speed reaches zero afterrelease; server and prediction agree for every fighter; quick1/2 displace less than quick3; identical inputs during recovery obey cooldown. Run relevant simulation tests, inspect any existing fixture assumptions and commit only scoped files.

## Milestone 2: visual weight and combat readability

A worker owns only src/client/game/three and new tests there. Keep public createFighterView().apply signature compatible. Derive locomotion phase from traveled distance so idle/decelerating legs stop cycling independently of root speed; articulated knees/feet and counter-moving planted stance reduce skating. Author separate RIFT sharp alternating strikes, BASTION planted shoulder/gauntlet punches, PULSE emitter recoil and WRAITH hooked/sideways strikes. Blend transition poses over a short interval instead of instantly replacing them. Directional HIT response uses event attacker/impact versus defender facing, with restart for a fresh hit. Add bounded visual-only contact hold (roughly35ms quick,65ms heavy) and readable directional sparks, respecting reduced motion. Network/simulation clocks and input continue during holds. Strong attacks should visibly differ from jabs; preserve server hit geometry, respawn location and static spawn shield fixes. Add tests for distinct attack poses, motion tied to displacement, directional hit responses, fresh hit restart, effects cleanup and no simulation clock changes. Capture actual action frames for review.

## Milestone 3: bots and spectators

After the mechanical contract is ready, a worker owns shared model/protocol changes and server room/network integration plus server tests. Add BotDifficulty EASY/NORMAL/HARD, RoomPlayer.role FIGHTER/SPECTATOR and RoomPlayer.botDifficulty nullable (null means human). Human role can change in lobby only; joining as spectator is also allowed during an active match. Spectators may host/manage/start a match, never need ready, cannot send gameplay actions and do not pause a match on disconnect. Only fighter humans need ready; bots are ready automatically including rematches. Bots never become host or reserve reconnect slots. Last human departure removes the room and its bots. A disconnected human fighter follows existing grace rules.

Socket commands: lobby:role {role}; lobby:bot:add {chassis,difficulty}; lobby:bot:update {playerId,chassis,difficulty}; lobby:bot:remove {playerId}. Only host can manage bots; commands validate phase and enforce bot/capacity limits server-side. Extend room:join with role, defaulting to fighter only where payload omission is still valid for ordinary invite joins. Keep bot and spectator metadata in room publications; only actual fighters enter MatchSnapshot.players. Bots have generated internal IDs and no network connections. Start must support spectator host plus2–8 bots; a sole fighter with no opponent cannotstart.

New server/game/botController.ts owns per-bot reaction memory and InputFrame generation. Observe public match snapshots on bounded difficulty-specific reaction intervals, roughly300/180/110ms; do not read opponent queuedinputs or private timers. Prioritize avoiding void edges, target nearby active fighters, approach/space, jab or charge/release heavy based on distance and opponent observed recovery, dodge visible windup/pulses with limited accuracy, and use each existing Space ability opportunistically. Emit monotonically increasing sequence numbers; quick/dash must have release frames and obey ordinary cooldown/stun. Deterministic seeded variability prevents identical synchronized bot patterns. Difficulty changes reaction/choice, never damage/speed/protection. Tests cover valid bounded inputs, finite/monotonic values, no all-knowing reactions, edgeavoidance, all four characters, eightbot-only match progresses and produces hits/KO/results, host-only permissions, spectators cannot altergameplay, rolechange/start/resume/leave/last-human cleanup and rematches.

## Milestone 4: client integration and acceptance

Controller owns client network/store/UI, any fixture updates needed for required role metadata, and E2E tests. Add a clear lobby choice 'Oyuncu'/'Seyirci', host 'Bot Ekle' with chassis and Kolay/Normal/Zor, per-bot edit/remove controls, separate fighter/spectator counts and list labels. Spectators hide character/readycontrols and personal combat HUD/touchinputs. Render the full match with an explicit 'Seyirci' indicator, score list and existing leave control. Host spectators can return to lobby or start an eligible rematch. Actual humans can join through a spectator selection on landing/invite and choose player mode in lobby when capacity permits. Use current UI tokens and layout, no decorative redesign. Test portrait lobby, landscape match and desktop without clipping.

Run npm run verify and browser journeys for solo plusbots, spectator plus8bots, midmatch spectatorjoin, role changes, removebot/permission rejection, results/rematch and ordinary human multiplayer. Observe combat for at least a full bot-only round, not merely presence of meshes. Use one renderer plus max bot load for frame budget and unchanged transport acceptance. Independent scoped review checks simulation fairness, cleanup/host rules and actual motion screenshots; fix material findings before publication. Commit and push to the independent repo, verify remote SHA and0/0parity, then restart only the identified newgame launchctl service and verify /health and page200. Physical seconddevice LAN is untested unless actually exercised.

## Surprises & Discoveries

Current first-two quick impulses are large enough to separate fighters before a combo develops. Voluntary movement uses exponentialdrag and never reaches exactzero quickly. Existing visual attacks share one motionrecipe. No bot or spectator roles currently exist. The original source-checkout is not a safe place for these changes; this independent repo is the only writeboundary.

## Decision Log

Mechanics first is the user's explicit order. Rendering improvements can run alongside shared mechanicwork because they consume the same immutable snapshotcontract. Bot implementation starts only after that contract is tested, then client integration follows its exact schema. Spectators andbots share room membership but onlyfighters enter simulation; this keeps networking readable and preserves authoritative rule ownership.

## Outcomes & Retrospective

In progress. Completion requires visible combat improvements and real solo/bot/spectator journeys, not test counts alone. Any remaining subjective quality limits and unperformed physical-device checks must be stated explicitly.

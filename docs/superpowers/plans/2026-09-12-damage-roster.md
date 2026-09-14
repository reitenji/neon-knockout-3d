# Damage, exact-edge ringouts and eight distinct fighters

This living ExecPlan follows /Users/serkances/.codex/PLANS.md. Execute inline, without subagents, only in /Users/serkances/dev/neon-knockout-3d. Preserve unrelated edits and the original /Users/serkances/dev/game checkout.

## Purpose

Players must recognize themselves by a consistent personal color, see damage accumulate up to 250%, feel greater launch force as damage rises, and visibly fall at the actual platform boundary. Add four complete selectable characters, including models, motion, abilities and bot support, while keeping eight total fighters. Publish the validated result to the existing public Sites game.

## Progress

- [x] Inspect damage, boundary, renderer, character and transport definitions; resolve color intent with the user.
- [x] Implement and verify 250% damage, critical launches and immediate edge ringouts.
- [x] Add four characters through shared rules, bots, validation, geometry and animations.
- [x] Apply player identity colors and damage glow; adapt the lobby preview for eight characters.
- [x] Run simulation, rendering, UI and browser checks and fix affected regressions.
- [ ] Publish the verified revision to the existing public Site.

## Context and orientation

src/shared/model.ts defines CHASSIS; src/shared/fighters.ts defines movement and Space abilities. React lobby and both network paths must accept all eight entries. src/server/game/combatResolution.ts owns all damage and impulse; src/server/game/simulation.ts resolves ringouts. Server and prediction share kinematics. ArenaWorld builds the actual platform from shared polygon vertices. FighterModel owns materials and articulated geometry; FighterView applies poses and per-player presentation. BotController feeds normal controls into the same simulation.

## Decisions

The user clarified that colors must distinguish players. Reuse unique fighter accent assignments and apply those colors to the actual armor/emissive material, labels and ground marker. Do not introduce a color picker. Character identity comes from geometry, motion and abilities. Preview the selected model using the local player's color.

Damage remains low-impact for initial combos and grows more steeply past 100%. The cap is 250%; any successful damaging hit at the cap has a minimum launch impulse sufficient to cross the longest arena span, including armored fighters. Existing invulnerability and spawn protection continue preventing damage; critical hits cancel ongoing movement abilities so they cannot erase the launch. Do not simulate a knockout by immediately awarding a point at the hit location: the fighter must travel to the edge and fall there.

Remove the 80-unit void margin. A fighter center crossing the polygon ends ground support; pin the knockout pose to the actual crossed segment so a fast launch cannot appear to fall far beyond it. Existing outside-platform recovery fixtures must move inside the edge because the requested rule replaces the old recovery margin.

New fighters: EMBER, orange furnace robot with short-range explosive dash; VOLT, yellow agile sprinter with a short fast dash; TITAN, green heavy robot with a slow armored brace; NOVA, blue hovering satellite with a wide weaker shockwave. Shared metadata supplies burst and armor behavior so bots and prediction use the same definitions. Each gets a distinct model and strike motion. Keep current keyboard/touch controls and no new dependencies.

## Milestones and verification

First add executable regressions around increasing damage, the 250% cap, all-fighter critical launches and exact-edge knockout positions. Modify the authoritative combat and boundary functions, preserving low-damage combo timing and scoring. Include flat, diagonal and contracted edges plus a high-speed crossing. Run the affected simulation tests and adapt only assertions whose intended behavior changed.

Next extend CHASSIS, FIGHTERS and every exhaustive mapping/transport validator. Generalize burst and armored movement using FighterDefinition fields. Add geometry and motion for each new fighter, then verify server/prediction movement agreement, burst/armor cooldown behavior, valid bot inputs and eight-bot natural match progression.

Finally apply personal colors in FighterView and preview, add continuous brightening and a smooth pulse halo driven by normalized damage, respect reduced motion with a static halo, reset visuals on respawn and dispose every added object. The lobby keeps existing controls and tokens; arrange eight preview models in two rows to preserve readable size on phones. Verify all eight selections and bot options, damage readings, no clipping and real two-browser gameplay.

Run npm test, npm run typecheck, npm run lint, the Sites build helper and focused browser acceptance in this checkout. Use real rendering for colors, glow, all models and edge falling. Controlled simulation fixtures may set damage for visual QA but must be identified as such; do not add a production debug interface. Separate local browser evidence from successful publication. Commit/push only scoped files, package the unchanged build, save/deploy to the existing project_id, and confirm native success.

## Surprises & discoveries

The old maximum is 150 and boundary knockout requires 80 units outside the polygon. Player accents currently color only rings and names; the main model uses chassis color, so duplicate chassis are hard to distinguish. The legacy WebRTC snapshot validator hardcodes four chassis and must be updated too.

## Recovery and idempotence

No schema migration, paid service or new Site is needed. Reuse the current public Site and source credential until expiry. Keep existing local plan notes and screenshots unstaged. Stop only preview processes started by this work. Failed deploys resume with their saved version IDs.

## Outcomes & retrospective

Implementation and local acceptance complete. Full suite: 674 tests passed; two additional EMBER/NOVA boundary/protection regressions then passed in the 18-test ability suite (676 total cases). Lint, typecheck and Sites build passed. Desktop and 390px mobile lobby accepted all eight chassis; two separate browser contexts played matching RIFT models in different player colors plus all four new bots. No production page console errors. A temporary local fixture exercised actual renderer/simulation at 0–250% and a critical TITAN jab: HIT tick 6, KNOCKOUT tick 11 at (1140,360). The fixture was removed; no debug endpoint is shipped. Publication is the remaining checkpoint. Subjective feel and cross-device network quality remain distinct from deterministic physics and same-Mac browser acceptance.

12 September 2026: Created after inspecting source and clarifying that player distinction is the purpose of color changes.

23:34 TRT: Local verification complete. The prior eight-player combat fixture began outside the old platform and was moved just inside each edge to preserve its simultaneous-hit/scoring intent under the new boundary rule.

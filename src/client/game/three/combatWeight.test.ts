import { afterEach, expect, it, vi } from 'vitest';
import { OrthographicCamera, Scene, Vector3 } from 'three';
import { createMatchState } from '../../../server/game/state.js';
import { snapshotMatch } from '../../../server/game/simulation.js';
import { DEFAULT_ROOM_SETTINGS } from '../../../shared/roomSettings.js';
import { CHASSIS, type GameEvent } from '../../../shared/model.js';
import { createFighterView } from './FighterView.js';
import { fighterMotion } from './fighterMotion.js';
import { CombatEffects } from './CombatEffects.js';

const snapshot = () => snapshotMatch(createMatchState([
  { playerId: 'p1', name: 'Rift', chassis: 'RIFT', accent: 0 },
  { playerId: 'p2', name: 'Bastion', chassis: 'BASTION', accent: 1 }
], 0, DEFAULT_ROOM_SETTINGS));
afterEach(() => vi.restoreAllMocks());
it('authors four different full body strike silhouettes and stronger finishers', () => {
  const poses = CHASSIS.map(chassis => fighterMotion(chassis, 'quick-1', 0.5, 0, false));
  expect(new Set(poses.map(pose => JSON.stringify(pose))).size).toBe(4);
  for (const chassis of CHASSIS) {
    expect(fighterMotion(chassis, 'heavy-release', 0.5, 0, false)).not.toEqual(fighterMotion(chassis, 'quick-1', 0.5, 0, false));
  }
});
it('advances a planted articulated gait only when the presented root travels', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const player = { ...snapshot().players[0]!, velocity: { x: 100, y: 0 } };
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, false, false);
  view.apply(player, player.position, player.facing, null);
  now = 100; view.apply(player, { x: player.position.x + 12, y: player.position.y }, player.facing, null);
  const rotation = view.model.leftLeg.quaternion.clone();
  now = 160; view.apply(player, { x: player.position.x + 12, y: player.position.y }, player.facing, null);
  expect(view.model.leftLeg.quaternion.angleTo(rotation)).toBeCloseTo(0, 6);
  expect(view.model.leftKnee.quaternion.angleTo(view.model.rightKnee.quaternion)).toBeGreaterThan(0.01);
  view.model.root.updateMatrixWorld(true);
  const heights = [view.model.leftFoot, view.model.rightFoot].map(foot => foot.getWorldPosition(new Vector3()).y);
  expect(Math.min(...heights)).toBeCloseTo(3.5, 3);
  view.destroy();
});
it('restarts directional recoil on fresh hits while a visual contact hold leaves roots and snapshots live', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const snap = snapshot(); const player = { ...snap.players[0]!, facing: { x: 0, y: 1 }, hitstunRemainingMs: 180 };
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, false, false);
  const hit: GameEvent = { type: 'HIT', eventId: 1, tick: 1, attackerId: 'p2', targetId: 'p1', attack: 'QUICK_1', impactPosition: player.position, impulse: 110, resultingOverload: 8 };
  view.apply(player, player.position, player.facing, null);
  view.contact(hit, { x: player.position.x - 30, y: player.position.y });
  now = 60; view.apply(player, player.position, player.facing, null);
  expect(view.model.body.rotation.z).toBeLessThan(0);
  now = 150; view.apply(player, player.position, player.facing, null);
  view.contact({ ...hit, eventId: 2 }, { x: player.position.x + 30, y: player.position.y });
  now = 170; view.apply(player, { x: player.position.x + 20, y: player.position.y }, player.facing, null);
  expect(view.model.body.rotation.z).toBeGreaterThan(0);
  expect(view.model.root.position.x).toBeCloseTo(player.position.x + 20 - 640);
  expect(player.hitstunRemainingMs).toBe(180);
  view.destroy();
});
it('emits directional hit sparks, bounds effect count and disposes expired meshes', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const scene = new Scene(); const effects = new CombatEffects(scene, false); const snap = snapshot();
  effects.ingest({ type: 'HIT', eventId: 1, tick: 1, attackerId: 'p1', targetId: 'p2', attack: 'HEAVY', impactPosition: snap.players[1]!.position, impulse: 700, resultingOverload: 30 }, snap);
  expect(scene.getObjectByName('contact-sparks')).toBeDefined();
  effects.update(90);
  expect(scene.getObjectByName('contact-sparks')!.children.length).toBeGreaterThan(1);
  effects.update(1000); expect(scene.children).toHaveLength(0);
  effects.dispose(); expect(scene.children).toHaveLength(0);
});

it('blends an attack entry and releases a heavy contact hold within 65 ms', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const player = snapshot().players[0]!;
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, false, false);
  view.apply(player, player.position, player.facing, null);
  const before = view.model.leftArm.rotation.x;
  const attack = { ...player.action, kind: 'HEAVY' as const, attackId: 1 };
  now = 50; view.apply(player, player.position, player.facing, attack);
  expect(view.model.leftArm.rotation.x).toBe(before);
  now = 180; view.apply(player, player.position, player.facing, attack);
  view.contact({ type: 'HIT', eventId: 1, tick: 1, attackerId: 'p1', targetId: 'p2', attack: 'HEAVY', impactPosition: player.position, impulse: 700, resultingOverload: 30 }, player.position);
  now = 185; view.apply(player, player.position, player.facing, attack);
  const contact = view.model.leftArm.rotation.x;
  now = 230; view.apply(player, { x: player.position.x + 5, y: player.position.y }, player.facing, attack);
  expect(view.model.leftArm.rotation.x).toBe(contact);
  expect(view.model.root.position.x).toBe(player.position.x + 5 - 640);
  now = 340; view.apply(player, player.position, player.facing, attack);
  expect(view.model.leftArm.rotation.x).not.toBe(contact);
  view.destroy();
});
it('caps concurrent effects and keeps reduced motion hits free of traveling sparks', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const scene = new Scene(); const effects = new CombatEffects(scene, true); const snap = snapshot();
  for (let eventId = 0; eventId < 60; eventId++) effects.ingest({ type: 'HIT', eventId, tick: 1, attackerId: 'p1', targetId: 'p2', attack: 'QUICK_1', impactPosition: snap.players[1]!.position, impulse: 110, resultingOverload: 8 }, snap);
  expect(scene.children).toHaveLength(32);
  expect(scene.getObjectByName('contact-sparks')).toBeUndefined();
  const geometry = scene.children[0]!.children[0] as import('three').Mesh;
  const disposed = vi.spyOn(geometry.geometry, 'dispose');
  effects.dispose();
  expect(disposed).toHaveBeenCalledOnce();
  expect(scene.children).toHaveLength(0);
});
it('keeps the supporting sole fixed in world space as the root crosses a stride', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const player = { ...snapshot().players[0]!, facing: { x: 0, y: 1 }, velocity: { x: 0, y: 100 } };
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, false, false);
  view.apply(player, player.position, player.facing, null);
  now = 100; view.apply(player, { x: player.position.x, y: player.position.y + 2 }, player.facing, null);
  view.model.root.updateMatrixWorld(true);
  const planted = view.model.leftFoot.getWorldPosition(new Vector3());
  now = 120; view.apply(player, { x: player.position.x, y: player.position.y + 5 }, player.facing, null);
  view.model.root.updateMatrixWorld(true);
  expect(view.model.leftFoot.getWorldPosition(new Vector3()).distanceTo(planted)).toBeLessThan(0.01);
  view.destroy();
});
it('blends a moving foot into its resting stance instead of snapping on release', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const player = { ...snapshot().players[0]!, velocity: { x: 100, y: 0 } };
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, false, false);
  view.apply(player, player.position, player.facing, null);
  const position = { x: player.position.x + 12, y: player.position.y };
  now = 100; view.apply(player, position, player.facing, null);
  view.model.root.updateMatrixWorld(true);
  const before = view.model.leftFoot.getWorldPosition(new Vector3());
  now = 110; view.apply({ ...player, velocity: { x: 0, y: 0 } }, position, player.facing, null);
  view.model.root.updateMatrixWorld(true);
  expect(view.model.leftFoot.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(0.01);
  view.destroy();
});

import { afterEach, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, OrthographicCamera, Scene } from 'three';
import { createMatchState } from '../../../server/game/state.js';
import { snapshotMatch } from '../../../server/game/simulation.js';
import { DEFAULT_ROOM_SETTINGS } from '../../../shared/roomSettings.js';
import { createFighterView } from './FighterView.js';

afterEach(() => vi.restoreAllMocks());

it('waits for the authoritative spawn position before playing the return animation', () => {
  const player = snapshotMatch(createMatchState([
    { playerId: 'p1', name: 'Rift', chassis: 'RIFT', accent: 0 },
    { playerId: 'p2', name: 'Bastion', chassis: 'BASTION', accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS)).players[0]!;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const scene = new Scene();
  const parent = document.createElement('div');
  const view = createFighterView(scene, new OrthographicCamera(), parent, player, true, false);
  const apply = (remaining: number) => view.apply({ ...player, respawnRemainingMs: remaining },
    remaining > 0 ? { x: 1260, y: 360 } : { x: 640, y: 360 }, player.facing, null);
  apply(600);
  now = 300; apply(300);
  now = 450; apply(150);
  expect(view.model.root.visible).toBe(false);
  now = 600; apply(0);
  expect(view.model.root.position.x).toBe(0);
  expect(view.model.body.position.y).toBeGreaterThan(60);
  expect(view.model.body.scale.x).toBeCloseTo(0.65);
  now = 770; apply(0);
  expect(view.model.root.visible).toBe(true);
  expect(view.model.body.position.y).toBeGreaterThan(0);
  now = 950; apply(0);
  expect(view.model.body.scale.x).toBe(1);
  view.destroy();
  expect(scene.children).toHaveLength(0);
  expect(parent.children).toHaveLength(0);
});

it('shows a stable spawn shield until protection expires or a predicted strike cancels it', () => {
  const player = snapshotMatch(createMatchState([
    { playerId: 'p1', name: 'Rift', chassis: 'RIFT', accent: 0 },
    { playerId: 'p2', name: 'Bastion', chassis: 'BASTION', accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS)).players[0]!;
  const scene = new Scene();
  const view = createFighterView(scene, new OrthographicCamera(), document.createElement('div'), player, true, true);
  const apply = (protection: number, strike = false) => view.apply({ ...player, protectionRemainingMs: protection },
    player.position, player.facing, strike ? { ...player.action, kind: 'QUICK_1', charging: false } : null);
  apply(650);
  const shield = scene.getObjectByName('spawn-protection');
  expect(shield?.visible).toBe(true);
  apply(300);
  expect(shield?.visible).toBe(true);
  apply(0);
  expect(shield?.visible).toBe(false);
  apply(650, true);
  expect(shield?.visible).toBe(false);
  view.destroy();
});

it('distinguishes identical chassis by body color and strengthens damage glow without losing identity', () => {
  const players = snapshotMatch(createMatchState([
    { playerId: 'a', name: 'A', chassis: 'RIFT', accent: 0 },
    { playerId: 'b', name: 'B', chassis: 'RIFT', accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS)).players;
  const scene = new Scene();
  const views = players.map(p => createFighterView(scene, new OrthographicCamera(), document.createElement('div'), p, false, false));
  expect(views[0]!.model.armor.color.getHexString()).toBe('6ee7f2');
  expect(views[1]!.model.armor.color.getHexString()).toBe('ff8a5b');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const view = views[0]!, player = players[0]!;
  const apply = (overload: number) => view.apply({ ...player, overload }, player.position, player.facing, null);
  apply(0); const base = view.model.glow.emissiveIntensity;
  apply(125); const mid = view.model.glow.emissiveIntensity;
  apply(250); const peak = view.model.glow.emissiveIntensity;
  expect(base).toBeLessThan(mid); expect(mid).toBeLessThan(peak);
  now = 250; apply(250);
  expect(view.model.glow.emissiveIntensity).not.toBe(peak);
  expect(view.model.armor.color.getHexString()).toBe('6ee7f2');
  apply(0);
  expect(view.model.glow.emissiveIntensity).toBe(base);
  expect(view.model.armor.emissiveIntensity).toBe(0);
  expect(scene.getObjectByName('damage-aura')?.visible).toBe(false);
  views.forEach(v => v.destroy());
  expect(scene.children).toHaveLength(0);
});

it('keeps critical damage highlighting static with reduced motion', () => {
  const player = snapshotMatch(createMatchState([{ playerId: 'a', name: 'A', chassis: 'TITAN', accent: 2 }], 0, DEFAULT_ROOM_SETTINGS)).players[0]!;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const view = createFighterView(new Scene(), new OrthographicCamera(), document.createElement('div'), player, true, true);
  const apply = () => view.apply({ ...player, overload: 250 }, player.position, player.facing, null);
  apply(); const glow = view.model.glow.emissiveIntensity;
  now = 250; apply(); expect(view.model.glow.emissiveIntensity).toBe(glow);
  view.destroy();
});

it('marks only the controlled fighter with a red ring that follows movement and respawn', () => {
  const players = snapshotMatch(createMatchState([
    { playerId: 'a', name: 'A', chassis: 'RIFT', accent: 0 },
    { playerId: 'b', name: 'B', chassis: 'RIFT', accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS)).players;
  const scene = new Scene();
  const views = players.map((p, i) => createFighterView(scene, new OrthographicCamera(), document.createElement('div'), p, i === 0, true));
  const rings = scene.children.filter(o => o.name === 'local-player-ring');
  expect(rings).toHaveLength(1);
  const ring = rings[0] as Mesh<never, MeshBasicMaterial>;
  expect(ring.material.color.getHexString()).toBe('ff3344');
  const player = players[0]!;
  views[0]!.apply({ ...player, respawnRemainingMs: 0 }, { x: 700, y: 400 }, player.facing, null);
  expect(ring.position.x).toBe(60);
  expect(ring.visible).toBe(true);
  views[0]!.apply({ ...player, respawnRemainingMs: 500 }, player.position, player.facing, null);
  expect(ring.visible).toBe(false);
  views.forEach(v => v.destroy());
  expect(scene.children).toHaveLength(0);
});

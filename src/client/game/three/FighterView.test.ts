import { afterEach, expect, it, vi } from 'vitest';
import { OrthographicCamera, Scene } from 'three';
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

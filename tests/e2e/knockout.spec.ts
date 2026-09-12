import type { Page } from '@playwright/test';
import { GAME } from '../../src/shared/constants.js';
import type { GameEvent, MatchPlayer, MatchSnapshot, Vec2 } from '../../src/shared/model.js';
import {
  assertNoUnexpectedErrors,
  createTwoPlayerMatch,
  expect,
  test,
  type E2eGame,
  type MatchPages
} from './fixtures.js';

function snapshot(game: E2eGame, code: string): MatchSnapshot {
  const value = game.harness.matchSnapshot(code);
  if (!value) throw new Error(`Missing authoritative snapshot for ${code}.`);
  return value;
}

function player(game: E2eGame, code: string, playerId: string): MatchPlayer {
  const value = snapshot(game, code).players.find((candidate) => candidate.playerId === playerId);
  if (!value) throw new Error(`Missing authoritative player ${playerId}.`);
  return value;
}

function marker(game: E2eGame, code: string): number {
  return game.harness.recentEvents(code).at(-1)?.eventId ?? 0;
}

async function expectLocalAndOpponentTelemetry(match: MatchPages): Promise<void> {
  await expect(match.host.page.getByLabel(/^Ada ağ telemetrisi:/)).not.toContainText('—');
  await expect(match.host.page.getByLabel(/^Linus ağ telemetrisi:/)).not.toContainText('—');
  await expect(match.guest.page.getByLabel(/^Linus ağ telemetrisi:/)).not.toContainText('—');
  await expect(match.guest.page.getByLabel(/^Ada ağ telemetrisi:/)).not.toContainText('—');
  await expect(match.host.page.locator('.match-hud')).not.toContainText(/Delay|Rollback|\bRB\b/);
  await expect(match.guest.page.locator('.match-hud')).not.toContainText(/Delay|Rollback|\bRB\b/);
}

function eventsAfter(game: E2eGame, code: string, eventId: number): readonly GameEvent[] {
  return game.harness.recentEvents(code).filter((event) => event.eventId > eventId);
}

async function waitForEvent<T extends GameEvent['type']>(
  game: E2eGame,
  code: string,
  eventId: number,
  type: T,
  predicate: (event: Extract<GameEvent, { type: T }>) => boolean = () => true,
  timeout = 5_000
): Promise<Extract<GameEvent, { type: T }>> {
  let matched: Extract<GameEvent, { type: T }> | null = null;
  await expect.poll(() => {
    matched = eventsAfter(game, code, eventId).find((event): event is Extract<GameEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<GameEvent, { type: T }>)) ?? null;
    return matched?.eventId ?? null;
  }, { timeout }).not.toBeNull();
  return matched!;
}

async function waitForNeutral(game: E2eGame, match: MatchPages): Promise<void> {
  await expect.poll(() => {
    const current = snapshot(game, match.code);
    return [match.hostPlayerId, match.guestPlayerId].every((playerId) => {
      const candidate = current.players.find((value) => value.playerId === playerId);
      return candidate?.action.kind === null && candidate.hitstunRemainingMs === 0 &&
        candidate.dashRemainingMs === 0 && candidate.respawnRemainingMs === 0;
    });
  }).toBe(true);
}

async function placePlayers(
  game: E2eGame,
  match: MatchPages,
  hostPosition: Vec2,
  guestPosition: Vec2,
  hostFacing: Vec2 = { x: 1, y: 0 },
  guestFacing: Vec2 = { x: -1, y: 0 }
): Promise<void> {
  game.harness.placePlayer(match.code, match.hostPlayerId, hostPosition, hostFacing);
  game.harness.placePlayer(match.code, match.guestPlayerId, guestPosition, guestFacing);
  await expect.poll(() => {
    const current = snapshot(game, match.code);
    return [
      player(game, match.code, match.hostPlayerId).position.x,
      player(game, match.code, match.hostPlayerId).position.y,
      player(game, match.code, match.guestPlayerId).position.x,
      player(game, match.code, match.guestPlayerId).position.y,
      current.phase
    ];
  }).toEqual([hostPosition.x, hostPosition.y, guestPosition.x, guestPosition.y, 'REGULATION']);
}

async function release(page: Page, ...keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => page.keyboard.up(key)));
}

test('host room settings remain authoritative through a guest leave and clean rejoin', async ({ browser, game }) => {
  const configuredSettings = { durationMs: 90_000, knockoutTarget: 3 } as const;
  const match = await createTwoPlayerMatch(browser, game, configuredSettings);
  try {
    const started = snapshot(game, match.code);
    expect(started.settings).toEqual(configuredSettings);
    expect(started.remainingMs).toBeGreaterThan(85_000);
    expect(started.remainingMs).toBeLessThanOrEqual(configuredSettings.durationMs);

    for (const participant of [match.host, match.guest]) {
      await expect(participant.page.getByRole('timer', { name: 'Kalan süre' }))
        .toHaveText(/^01:(?:[0-2]\d|30)$/);
      await expect(participant.page.getByLabel('Kazanma hedefi')).toHaveText('İlk 3 knockout');
      await expect(participant.page.getByRole('button', { name: 'Odadan Çık' })).toHaveCount(1);
    }

    const leaveMarker = marker(game, match.code);
    await match.guest.page.getByRole('button', { name: 'Odadan Çık' }).click();

    await expect(match.guest.page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await expect(match.guest.page.getByRole('button', { name: 'Odadan Çık' })).toHaveCount(0);
    const noContest = await waitForEvent(
      game,
      match.code,
      leaveMarker,
      'RESULT',
      (event) => event.reason === 'NO_CONTEST'
    );
    expect(noContest).toMatchObject({ winnerPlayerId: null, reason: 'NO_CONTEST' });

    await expect(match.host.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    await expect.poll(() => game.server.rooms.debugRoom(match.code)).toMatchObject({
      phase: 'LOBBY',
      connectedCount: 1,
      reservedCount: 0,
      playerIds: [match.hostPlayerId]
    });
    await expect(match.host.page.getByLabel('Maç süresi')).toHaveValue('90000');
    await expect(match.host.page.getByLabel('Kazanma hedefi')).toHaveValue('3');
    await expect(match.host.page.getByLabel('Maç süresi')).toBeEnabled();
    await expect(match.host.page.getByLabel('Kazanma hedefi')).toBeEnabled();
    await expect(match.host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toHaveCount(0);

    expect(await match.guest.page.evaluate((roomCode) => ({
      lastRoom: window.localStorage.getItem('neon-relay:last-room'),
      resumeToken: window.localStorage.getItem(`neon-relay:${roomCode}:resume`)
    }), match.code)).toEqual({ lastRoom: null, resumeToken: null });

    await match.guest.page.getByLabel('Oyuncu adı').fill('Linus');
    await match.guest.page.getByLabel('Oda kodu').fill(match.code);
    await match.guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
    await expect(match.guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    await expect(match.guest.page.getByLabel('Maç süresi')).toHaveValue('90000');
    await expect(match.guest.page.getByLabel('Kazanma hedefi')).toHaveValue('3');
    await expect(match.guest.page.getByLabel('Maç süresi')).toBeDisabled();
    await expect(match.guest.page.getByLabel('Kazanma hedefi')).toBeDisabled();
    await expect(match.host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toBeVisible();
    await expect.poll(() => game.server.rooms.debugRoom(match.code)).toMatchObject({
      phase: 'LOBBY',
      connectedCount: 2,
      reservedCount: 0
    });
    const rejoinedIds = game.server.rooms.debugRoom(match.code)?.playerIds ?? [];
    expect(rejoinedIds).toContain(match.hostPlayerId);
    expect(rejoinedIds).not.toContain(match.guestPlayerId);

    await match.guest.page.getByRole('button', { name: 'Odadan Çık' }).click();
    await expect(match.guest.page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await expect(match.host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toHaveCount(0);
    await expect.poll(() => game.server.rooms.debugRoom(match.code)?.playerIds).toEqual([match.hostPlayerId]);
    expect(await match.guest.page.evaluate((roomCode) => ({
      lastRoom: window.localStorage.getItem('neon-relay:last-room'),
      resumeToken: window.localStorage.getItem(`neon-relay:${roomCode}:resume`)
    }), match.code)).toEqual({ lastRoom: null, resumeToken: null });

    await match.guest.page.reload();
    await expect(match.guest.page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await expect(match.guest.page.getByText('Bağlı', { exact: true })).toBeVisible();
    await expect(match.guest.page.getByRole('button', { name: 'Odadan Çık' })).toHaveCount(0);
    await expect.poll(() => game.server.rooms.debugRoom(match.code)?.playerIds).toEqual([match.hostPlayerId]);
    await assertNoUnexpectedErrors(game, match.host, match.guest);
  } finally {
    await match.close();
  }
});

test('two keyboard-only production contexts prove combat, reconnect, result, and rematch', async ({ browser, game }) => {
  const match = await createTwoPlayerMatch(browser, game);
  const journeyMarker = marker(game, match.code);
  try {
    for (const participant of [match.host, match.guest]) {
      await expect(participant.page.getByRole('region', { name: 'Oyuncu listesi' })).toBeVisible();
    }
    await expectLocalAndOpponentTelemetry(match);

    await placePlayers(game, match, { x: 500, y: 300 }, { x: 900, y: 500 });
    const beforeMouseTick = snapshot(game, match.code).tick;
    const beforeMouse = player(game, match.code, match.hostPlayerId);
    const canvas = match.host.page.locator('.game-stage canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Three.js canvas was not mounted.');
    await match.host.page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2);
    await match.host.page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3, { button: 'left' });
    await match.host.page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7, { button: 'right' });
    await expect.poll(() => snapshot(game, match.code).tick).toBeGreaterThan(beforeMouseTick + 4);
    const afterMouse = player(game, match.code, match.hostPlayerId);
    expect(afterMouse.position).toEqual(beforeMouse.position);
    expect(afterMouse.facing).toEqual(beforeMouse.facing);
    expect(afterMouse.action.kind).toBeNull();

    const beforeLegacyKeysTick = snapshot(game, match.code).tick;
    const beforeLegacyKeys = player(game, match.code, match.hostPlayerId);
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']) {
      await match.host.page.keyboard.press(key);
    }
    await expect.poll(() => snapshot(game, match.code).tick).toBeGreaterThan(beforeLegacyKeysTick + 4);
    const afterLegacyKeys = player(game, match.code, match.hostPlayerId);
    expect(afterLegacyKeys.position).toEqual(beforeLegacyKeys.position);
    expect(afterLegacyKeys.facing).toEqual(beforeLegacyKeys.facing);
    expect(afterLegacyKeys.action.kind).toBeNull();

    const movementStart = afterMouse.position.x;
    await match.host.page.keyboard.down('d');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).position.x).toBeGreaterThan(movementStart + 15);
    await match.host.page.keyboard.up('d');
    await waitForNeutral(game, match);

    await placePlayers(
      game,
      match,
      { x: 500, y: 300 },
      { x: 548, y: 348 },
      { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    );
    let eventMarker = marker(game, match.code);
    await Promise.all([
      match.host.page.keyboard.down('s'),
      match.host.page.keyboard.down('d')
    ]);
    await match.host.page.keyboard.down('j');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.kind).toBe('QUICK_1');
    const diagonal = player(game, match.code, match.hostPlayerId).action.lockedFacing;
    expect(diagonal?.x).toBeCloseTo(Math.SQRT1_2, 4);
    expect(diagonal?.y).toBeCloseTo(Math.SQRT1_2, 4);
    await release(match.host.page, 'j', 's', 'd');
    const diagonalHit = await waitForEvent(
      game,
      match.code,
      eventMarker,
      'HIT',
      (event) => event.attackerId === match.hostPlayerId && event.targetId === match.guestPlayerId
    );
    expect(diagonalHit.attack).toBe('QUICK_1');
    await waitForNeutral(game, match);

    await placePlayers(game, match, { x: 500, y: 360 }, { x: 570, y: 360 });
    eventMarker = marker(game, match.code);
    await match.host.page.keyboard.down('k');
    await match.host.page.keyboard.down('w');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.chargeMs).toBeGreaterThan(50);
    await match.host.page.keyboard.down('d');
    await match.host.page.keyboard.up('w');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.chargeMs).toBeGreaterThanOrEqual(220);
    const chargedHost = player(game, match.code, match.hostPlayerId);
    game.harness.placePlayer(
      match.code,
      match.guestPlayerId,
      { x: chargedHost.position.x + 85, y: chargedHost.position.y },
      { x: -1, y: 0 }
    );
    await expect.poll(() => player(game, match.code, match.guestPlayerId).position).toEqual({
      x: chargedHost.position.x + 85,
      y: chargedHost.position.y
    });
    await match.host.page.keyboard.up('d');
    await match.host.page.keyboard.up('k');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.kind).toBe('HEAVY');
    const partialHeavy = player(game, match.code, match.hostPlayerId).action;
    expect(partialHeavy.chargeMs).toBeGreaterThanOrEqual(180);
    expect(partialHeavy.chargeMs).toBeLessThan(GAME.heavyMaxChargeMs);
    expect(partialHeavy.lockedFacing?.x).toBeCloseTo(1, 4);
    expect(partialHeavy.lockedFacing?.y).toBeCloseTo(0, 4);
    const heavyHit = await waitForEvent(
      game,
      match.code,
      eventMarker,
      'HIT',
      (event) => event.attackerId === match.hostPlayerId && event.attack === 'HEAVY'
    );
    expect(eventsAfter(game, match.code, eventMarker).some((event) =>
      event.type === 'PULSE_SPAWN' && event.originatingAttackId === partialHeavy.attackId)).toBe(false);
    expect(heavyHit.targetId).toBe(match.guestPlayerId);
    await waitForNeutral(game, match);

    await placePlayers(game, match, { x: 500, y: 260 }, { x: 900, y: 500 });
    eventMarker = marker(game, match.code);
    await match.host.page.keyboard.down('d');
    await match.host.page.keyboard.down('k');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.chargeMs)
      .toBe(GAME.heavyMaxChargeMs);
    await match.host.page.keyboard.up('d');
    await match.host.page.keyboard.up('k');
    const pulseSpawn = await waitForEvent(game, match.code, eventMarker, 'PULSE_SPAWN');
    await expect.poll(() => snapshot(game, match.code).pulses.some(
      (pulse) => pulse.projectileId === pulseSpawn.projectileId
    )).toBe(true);
    await expect.poll(() => eventsAfter(game, match.code, eventMarker).filter((event) =>
      event.type === 'PULSE_SPAWN' && event.originatingAttackId === pulseSpawn.originatingAttackId
    ).length).toBe(1);
    await waitForNeutral(game, match);
    await expect.poll(() => snapshot(game, match.code).pulses).toEqual([]);

    await placePlayers(
      game,
      match,
      { x: 580, y: 360 },
      { x: 715, y: 360 },
      { x: 1, y: 0 },
      { x: -1, y: 0 }
    );
    eventMarker = marker(game, match.code);
    await Promise.all([
      match.host.page.keyboard.down('d'),
      match.host.page.keyboard.down('k'),
      match.guest.page.keyboard.down('a'),
      match.guest.page.keyboard.down('k')
    ]);
    await expect.poll(() => [match.hostPlayerId, match.guestPlayerId].every((playerId) =>
      player(game, match.code, playerId).action.chargeMs >= 220
    )).toBe(true);
    await Promise.all([
      match.host.page.keyboard.up('d'),
      match.guest.page.keyboard.up('a')
    ]);
    await placePlayers(
      game,
      match,
      { x: 580, y: 360 },
      { x: 715, y: 360 },
      { x: 1, y: 0 },
      { x: -1, y: 0 }
    );
    const heldKSequences = [match.hostPlayerId, match.guestPlayerId].map((playerId) =>
      player(game, match.code, playerId).lastProcessedInputSeq
    );
    await expect.poll(() => [match.hostPlayerId, match.guestPlayerId].every((playerId, index) => {
      const charged = player(game, match.code, playerId);
      return charged.lastProcessedInputSeq > heldKSequences[index]! && charged.action.charging;
    })).toBe(true);
    await Promise.all([
      match.guest.page.keyboard.up('k'),
      match.host.page.keyboard.up('k')
    ]);
    const clash = await waitForEvent(game, match.code, eventMarker, 'CLASH');
    expect(clash.strength).toBe('HEAVY');
    expect(eventsAfter(game, match.code, eventMarker).filter((event) =>
      event.type === 'HIT' && event.attack === 'HEAVY')).toEqual([]);
    await waitForNeutral(game, match);
    await expect.poll(() => snapshot(game, match.code).pulses).toEqual([]);

    await placePlayers(game, match, { x: 580, y: 360 }, { x: 680, y: 360 });
    await Promise.all([
      match.host.page.keyboard.down('d'),
      match.guest.page.keyboard.down('a')
    ]);
    await expect.poll(() => [
      player(game, match.code, match.hostPlayerId).facing,
      player(game, match.code, match.guestPlayerId).facing
    ]).toEqual([{ x: 1, y: 0 }, { x: -1, y: 0 }]);
    const directionSequences = [match.hostPlayerId, match.guestPlayerId].map((playerId) =>
      player(game, match.code, playerId).lastProcessedInputSeq
    );
    await Promise.all([
      match.host.page.keyboard.up('d'),
      match.guest.page.keyboard.up('a')
    ]);
    await expect.poll(() => [match.hostPlayerId, match.guestPlayerId].every((playerId, index) =>
      player(game, match.code, playerId).lastProcessedInputSeq > directionSequences[index]!
    )).toBe(true);
    await match.host.page.keyboard.down('k');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.chargeMs).toBeGreaterThanOrEqual(220);
    await placePlayers(game, match, { x: 580, y: 360 }, { x: 680, y: 360 });
    const placedChargeSequence = player(game, match.code, match.hostPlayerId).lastProcessedInputSeq;
    await expect.poll(() => {
      const host = player(game, match.code, match.hostPlayerId);
      return host.lastProcessedInputSeq > placedChargeSequence && host.action.charging;
    }).toBe(true);
    eventMarker = marker(game, match.code);
    await match.host.page.keyboard.up('k');
    await expect.poll(() => {
      const action = player(game, match.code, match.hostPlayerId).action;
      return action.kind === 'HEAVY' && action.phase === 'WINDUP';
    }, { intervals: [5], timeout: 1_000 }).toBe(true);
    const windupTick = snapshot(game, match.code).tick;
    await expect.poll(() => snapshot(game, match.code).tick, {
      intervals: [5], timeout: 1_000
    }).toBeGreaterThanOrEqual(windupTick + 3);
    await match.guest.page.keyboard.down('Space');
    await expect.poll(() => player(game, match.code, match.guestPlayerId).dashCooldownRemainingMs, {
      intervals: [5], timeout: 1_000
    }).toBeGreaterThan(0);
    const dodge = await waitForEvent(game, match.code, eventMarker, 'PERFECT_DODGE');
    await Promise.all([
      release(match.host.page, 'k', 'd'),
      release(match.guest.page, 'a', 'Space')
    ]);
    expect(dodge).toMatchObject({
      playerId: match.guestPlayerId,
      attackerId: match.hostPlayerId
    });
    expect(['HEAVY', 'NEON_PULSE']).toContain(dodge.source);
    expect(dodge.projectileId === null).toBe(dodge.source === 'HEAVY');
    await waitForNeutral(game, match);

    await placePlayers(game, match, { x: 400, y: 200 }, { x: 850, y: 500 });
    const preserved = snapshot(game, match.code);
    const preservedGuest = player(game, match.code, match.guestPlayerId);
    await match.guest.page.keyboard.down('a');
    await expect.poll(() => player(game, match.code, match.guestPlayerId).position.x).toBeLessThan(845);
    game.harness.disconnectPlayer(match.code, match.guestPlayerId);
    await expect.poll(() => game.server.rooms.debugRoom(match.code)?.connectedCount).toBe(1);
    await expect(match.guest.page.getByRole('dialog')).toBeVisible();
    await match.guest.page.getByRole('button', { name: 'Yeniden Dene' }).click();
    await expect.poll(() => game.server.rooms.debugRoom(match.code)?.connectedCount, { timeout: 12_000 }).toBe(2);
    await expect.poll(() => player(game, match.code, match.guestPlayerId).respawnRemainingMs).toBe(0);
    const resumed = player(game, match.code, match.guestPlayerId);
    expect(resumed).toMatchObject({
      playerId: match.guestPlayerId,
      chassis: preservedGuest.chassis,
      accent: preservedGuest.accent,
      overload: preservedGuest.overload,
      stats: preservedGuest.stats,
      action: { kind: null, charging: false }
    });
    expect(snapshot(game, match.code).scores).toEqual(preserved.scores);
    const resumedPosition = resumed.position;
    const resumedTick = snapshot(game, match.code).tick;
    await expect.poll(() => snapshot(game, match.code).tick).toBeGreaterThan(resumedTick + 8);
    expect(player(game, match.code, match.guestPlayerId)).toMatchObject({
      position: resumedPosition,
      velocity: { x: 0, y: 0 },
      action: { kind: null, charging: false }
    });
    await match.guest.page.keyboard.up('a');

    expect(eventsAfter(game, match.code, journeyMarker).some((event) =>
      event.type === 'HIT' || event.type === 'CLASH' || event.type === 'PERFECT_DODGE')).toBe(true);
    for (let knockout = 0; knockout < 5; knockout += 1) {
      const knockoutMarker = marker(game, match.code);
      game.harness.forceKnockout(match.code, match.hostPlayerId, match.guestPlayerId);
      const forced = await waitForEvent(game, match.code, knockoutMarker, 'KNOCKOUT');
      if (knockout < 4) await waitForEvent(game, match.code, forced.eventId, 'RESPAWN');
    }
    await expect(match.host.page.getByRole('heading', { name: 'Ada Kazandı' })).toBeVisible();
    await expect(match.guest.page.getByRole('heading', { name: 'Ada Kazandı' })).toBeVisible();
    await match.host.page.getByRole('button', { name: 'Tekrar Hazır' }).click();
    await match.guest.page.getByRole('button', { name: 'Tekrar Hazır' }).click();
    await expect(match.host.page.getByRole('row', { name: /Ada/ })).toContainText('Hazır');
    await expect(match.host.page.getByRole('row', { name: /Linus/ })).toContainText('Hazır');
    await expect(match.host.page.getByRole('button', { name: 'Rövanşı Başlat' })).toBeEnabled();
    await match.host.page.getByRole('button', { name: 'Rövanşı Başlat' }).click();
    await expect(match.host.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeVisible();
    await expect.poll(() => game.harness.matchSnapshot(match.code)?.scores[match.hostPlayerId]).toBe(0);
    await assertNoUnexpectedErrors(game, match.host, match.guest);
  } finally {
    await match.close();
  }
}, 55_000);

test('rematch still allows consecutive quick attacks without refresh', async ({ browser, game }) => {
  const match = await createTwoPlayerMatch(browser, game);
  try {
    for (let knockout = 0; knockout < 5; knockout += 1) {
      const knockoutMarker = marker(game, match.code);
      game.harness.forceKnockout(match.code, match.hostPlayerId, match.guestPlayerId);
      const forced = await waitForEvent(game, match.code, knockoutMarker, 'KNOCKOUT');
      if (knockout < 4) await waitForEvent(game, match.code, forced.eventId, 'RESPAWN');
    }

    await match.host.page.getByRole('button', { name: 'Tekrar Hazır' }).click();
    await match.guest.page.getByRole('button', { name: 'Tekrar Hazır' }).click();
    await expect(match.host.page.getByRole('button', { name: 'Rövanşı Başlat' })).toBeEnabled();
    await match.host.page.getByRole('button', { name: 'Rövanşı Başlat' }).click();
    await expect(match.host.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeVisible();
    await expect.poll(() => snapshot(game, match.code).phase).toBe('REGULATION');
    await expectLocalAndOpponentTelemetry(match);

    await placePlayers(game, match, { x: 500, y: 360 }, { x: 548, y: 360 });
    const rematchSeq = player(game, match.code, match.hostPlayerId).lastProcessedInputSeq;
    await match.host.page.keyboard.down('d');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).lastProcessedInputSeq).toBeGreaterThan(rematchSeq);
    await expect.poll(() => player(game, match.code, match.hostPlayerId).position.x).toBeGreaterThan(500);
    await release(match.host.page, 'd');
    await waitForNeutral(game, match);
    await placePlayers(game, match, { x: 500, y: 360 }, { x: 548, y: 360 });
    const firstMarker = marker(game, match.code);
    await match.host.page.keyboard.down('j');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.kind).toBe('QUICK_1');
    await match.host.page.keyboard.up('j');
    const firstHit = await waitForEvent(
      game,
      match.code,
      firstMarker,
      'HIT',
      (event) => event.attackerId === match.hostPlayerId && event.targetId === match.guestPlayerId
    );
    await waitForNeutral(game, match);

    await placePlayers(game, match, { x: 500, y: 360 }, { x: 548, y: 360 });
    await match.host.page.keyboard.down('j');
    await expect.poll(() => player(game, match.code, match.hostPlayerId).action.kind).toBe('QUICK_1');
    await match.host.page.keyboard.up('j');
    await waitForEvent(
      game,
      match.code,
      firstHit.eventId,
      'HIT',
      (event) => event.attackerId === match.hostPlayerId && event.targetId === match.guestPlayerId
    );
    await waitForNeutral(game, match);

    await placePlayers(
      game,
      match,
      { x: 548, y: 360 },
      { x: 500, y: 360 },
      { x: -1, y: 0 },
      { x: 1, y: 0 }
    );
    const guestMarker = marker(game, match.code);
    await match.guest.page.keyboard.down('j');
    await expect.poll(() => player(game, match.code, match.guestPlayerId).action.kind).toBe('QUICK_1');
    await match.guest.page.keyboard.up('j');
    await waitForEvent(
      game,
      match.code,
      guestMarker,
      'HIT',
      (event) => event.attackerId === match.guestPlayerId && event.targetId === match.hostPlayerId
    );
    await waitForNeutral(game, match);
    await assertNoUnexpectedErrors(game, match.host, match.guest);
  } finally {
    await match.close();
  }
}, 25_000);

test('result screen preserves ready and departed player statuses', async ({ browser, game }) => {
  const match = await createTwoPlayerMatch(browser, game);
  try {
    for (let knockout = 0; knockout < 5; knockout += 1) {
      const knockoutMarker = marker(game, match.code);
      game.harness.forceKnockout(match.code, match.hostPlayerId, match.guestPlayerId);
      const forced = await waitForEvent(game, match.code, knockoutMarker, 'KNOCKOUT');
      if (knockout < 4) await waitForEvent(game, match.code, forced.eventId, 'RESPAWN');
    }

    await expect(match.host.page.getByRole('heading', { name: 'Ada Kazandı' })).toBeVisible();
    await match.host.page.getByRole('button', { name: 'Tekrar Hazır' }).click();
    await expect(match.host.page.getByRole('row', { name: /Ada/ })).toContainText('Hazır');
    await expect(match.host.page.getByRole('row', { name: /Linus/ })).toContainText('Bekliyor');

    await match.guest.page.getByRole('button', { name: 'Odadan Çık' }).click();
    await expect(match.guest.page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await expect(match.host.page.getByRole('heading', { name: 'Ada Kazandı' })).toBeVisible();
    await expect(match.host.page.getByRole('row', { name: /Ada/ })).toContainText('Hazır');
    await expect(match.host.page.getByRole('row', { name: /Linus/ })).toContainText('Ayrıldı');
    await expect.poll(() => game.server.rooms.debugRoom(match.code)?.playerIds).toEqual([match.hostPlayerId]);
    await assertNoUnexpectedErrors(game, match.host, match.guest);
  } finally {
    await match.close();
  }
});

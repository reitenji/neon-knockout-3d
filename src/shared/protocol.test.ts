import { describe, expect, it } from 'vitest';
import type { Ack, GameEvent, MatchSnapshot, PlayerNetworkTransport, RoomState } from './model.js';
import * as protocol from './protocol.js';
import type { ClientToServerEvents } from './protocol.js';
import { ACCENTS, ARENA, CHASSIS, GAME } from './constants.js';
import { DEFAULT_ROOM_SETTINGS } from './roomSettings.js';
import { snapshotMatch } from '../server/game/simulation.js';
import { createMatchState } from '../server/game/state.js';

const acknowledgedReadyHandler: ClientToServerEvents['lobby:ready'] = (_payload, acknowledge) => {
  acknowledge({ ok: true, data: null });
};

const acknowledgedLeaveHandler: ClientToServerEvents['room:leave'] = (_payload, acknowledge) => {
  acknowledge({ ok: true, data: null });
};

describe('shared input boundary protocol', () => {
  it('includes WebRTC in the network transport contract', () => {
    const transport: PlayerNetworkTransport = 'webrtc';

    expect(transport).toBe('webrtc');
  });

  it('accepts normalized combat input and rejects invalid axes or legacy directional buttons', () => {
    expect(protocol.roomCreateSchema.parse({ name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 7,
        viewTick: 6,
        moveX: 1,
        moveY: 0,
        aimX: 0.6,
        aimY: -0.8,
        quick: true,
        heavy: false,
        dash: false
      }).success
    ).toBe(true);
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 7,
        viewTick: 6,
        moveX: 1,
        moveY: 0,
        aimX: 0.6,
        aimY: -0.8,
        quick: true,
        heavy: false,
        dash: false,
        mouseX: 200
      }).success
    ).toBe(false);
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 8,
        viewTick: 6,
        moveX: 1.01,
        moveY: 0,
        aimX: 1,
        aimY: 0,
        quick: false,
        heavy: false,
        dash: false
      }).success
    ).toBe(false);
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 8,
        viewTick: 6,
        up: true,
        down: false,
        left: false,
        right: false,
        dash: false
      }).success
    ).toBe(false);
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 8,
        viewTick: 6,
        moveX: Number.NaN,
        moveY: 0,
        aimX: 1,
        aimY: 0,
        quick: false,
        heavy: false,
        dash: false
      }).success
    ).toBe(false);
    expect(
      protocol.matchInputSchema.safeParse({
        seq: 8,
        viewTick: 6,
        moveX: 0,
        moveY: 0,
        aimX: Number.POSITIVE_INFINITY,
        aimY: 0,
        quick: false,
        heavy: false,
        dash: false
      }).success
    ).toBe(false);
  });

  it('requires a finite non-negative integer view tick and preserves valid future ticks', () => {
    const validInput = {
      seq: 7,
      viewTick: 50_000,
      moveX: 1,
      moveY: 0,
      aimX: 0.6,
      aimY: -0.8,
      quick: true,
      heavy: false,
      dash: false
    };

    expect(protocol.matchInputSchema.parse(validInput)).toEqual(validInput);
    for (const viewTick of [-1, 2.5, '9', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(protocol.matchInputSchema.safeParse({ ...validInput, viewTick }).success).toBe(false);
    }
    const missingViewTick: Partial<typeof validInput> = { ...validInput };
    delete missingViewTick.viewTick;
    expect(protocol.matchInputSchema.safeParse(missingViewTick).success).toBe(false);
  });

  it('normalizes valid room codes and rejects invalid codes for join and resume', () => {
    expect(protocol.roomJoinSchema.parse({ name: 'Ada', roomCode: ' ab2z ' })).toEqual({
      name: 'Ada',
      roomCode: 'AB2Z',
      role: 'FIGHTER'
    });
    expect(protocol.sessionResumeSchema.parse({ roomCode: ' ab2z ', resumeToken: 'token' })).toEqual({
      roomCode: 'AB2Z',
      resumeToken: 'token'
    });
    expect(protocol.roomJoinSchema.safeParse({ name: 'Ada', roomCode: 'O0I1' }).success).toBe(false);
    expect(protocol.sessionResumeSchema.safeParse({ roomCode: 'bad!', resumeToken: 'token' }).success).toBe(false);
  });

  it('uses a strict chassis selection payload', () => {
    expect(CHASSIS).toEqual(['RIFT', 'BASTION', 'PULSE', 'WRAITH', 'EMBER', 'VOLT', 'TITAN', 'NOVA']);
    expect(protocol.lobbyChassisSchema.parse({ chassis: 'RIFT' })).toEqual({ chassis: 'RIFT' });
    expect(protocol.lobbyChassisSchema.safeParse({ chassis: 'RIFT', ignored: true }).success).toBe(false);
    expect(protocol.lobbyChassisSchema.safeParse({ chassis: 'MAGE' }).success).toBe(false);
  });

  it('accepts every approved room settings pair and rejects unsupported payloads', () => {
    for (const durationMs of [90_000, 120_000, 180_000] as const) {
      for (const knockoutTarget of [3, 5, 7, 10] as const) {
        expect(protocol.lobbySettingsSchema.parse({ durationMs, knockoutTarget })).toEqual({
          durationMs,
          knockoutTarget
        });
      }
    }

    expect(protocol.lobbySettingsSchema.safeParse({ durationMs: 100_000, knockoutTarget: 5 }).success).toBe(false);
    expect(protocol.lobbySettingsSchema.safeParse({ durationMs: 120_000, knockoutTarget: 8 }).success).toBe(false);
    expect(protocol.lobbySettingsSchema.safeParse({ durationMs: 120_000 }).success).toBe(false);
    expect(protocol.lobbySettingsSchema.safeParse({
      durationMs: 120_000,
      knockoutTarget: 5,
      map: 'void'
    }).success).toBe(false);
  });

  it('accepts only an empty acknowledged room leave payload', () => {
    expect(protocol.roomLeaveSchema.parse({})).toEqual({});
    expect(protocol.roomLeaveSchema.safeParse({ reason: 'rage-quit' }).success).toBe(false);

    let acknowledgement: Ack<null> | undefined;
    acknowledgedLeaveHandler({}, (value) => {
      acknowledgement = value;
    });

    expect(acknowledgement).toEqual({ ok: true, data: null });
  });

  it('acknowledges state-changing lobby actions', () => {
    let acknowledgement: Ack<null> | undefined;

    acknowledgedReadyHandler({ ready: true }, (value) => {
      acknowledgement = value;
    });

    expect(acknowledgement).toEqual({ ok: true, data: null });
  });

  it('serializes stable room and match snapshots', () => {
    const room: RoomState = {
      roomCode: 'AB2Z',
      phase: 'MATCH',
      hostPlayerId: 'p1',
      pauseRemainingMs: null, chatMessages: [],
      result: null,
      settings: DEFAULT_ROOM_SETTINGS,
      players: [
        {
          role: 'FIGHTER', botDifficulty: null,
          playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: true, connected: true,
          reconnectRemainingMs: null,
          stats: { knockouts: 1, falls: 0, landedHits: 2, completedAttacks: 3 }
        }
      ]
    };
    const snapshot: MatchSnapshot = {
      tick: 42,
      phase: 'REGULATION',
      remainingMs: GAME.regulationMs,
      platformProgress: 0,
      settings: DEFAULT_ROOM_SETTINGS,
      scores: { p1: 1 },
      network: { p1: { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' } },
      players: [
        {
          playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0,
          position: { x: 640, y: 360 }, velocity: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, overload: 8,
          lastProcessedInputSeq: 7,
          action: {
            kind: 'QUICK_1', phase: 'ACTIVE', comboStep: 1, chargeMs: 0, charging: false,
            attackId: 7, profileId: 'quick-1', lockedFacing: { x: 1, y: 0 }, activeProgress: 0.5,
            hitTargetIds: ['p2']
          },
          dashRemainingMs: 0, dashCooldownRemainingMs: 0, hitstunRemainingMs: 0, respawnRemainingMs: 0,
          protectionRemainingMs: 0,
          stats: { knockouts: 1, falls: 0, landedHits: 2, completedAttacks: 3 }
        }
      ],
      pulses: [],
      winnerPlayerId: null,
      resultReason: null
    };

    expect(JSON.parse(JSON.stringify(room))).toEqual(room);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('serializes authoritative action and pulse metadata in deterministic order', () => {
    const state = createMatchState([
      { playerId: 'p1', name: 'Ada', accent: 0, chassis: 'RIFT' },
      { playerId: 'p2', name: 'Linus', accent: 1, chassis: 'BASTION' }
    ], 0, DEFAULT_ROOM_SETTINGS);
    state.players.p1.attack = {
      attackId: 17,
      viewTick: 0,
      kind: 'HEAVY',
      profileId: 'heavy-melee',
      phase: 'ACTIVE',
      phaseRemainingMs: 10,
      phaseElapsedMs: 999,
      previousActiveProgress: 0.25,
      lockedFacing: { x: 0, y: -1 },
      chargeMs: 640,
      hitPlayerIds: new Set(['z-target', 'a-target']),
      resolvedPlayerIds: new Set(['z-target'])
    };
    state.players.p2.chargeMs = 420;
    state.players.p2.charging = true;
    state.pulses[10] = {
      projectileId: 10,
      ownerPlayerId: 'p1',
      originatingAttackId: 17,
      position: { x: 30, y: 40 },
      previousPosition: { x: 25, y: 40 },
      velocity: { x: 5, y: 0 },
      radius: 12,
      remainingMs: 500,
      hitPlayerIds: new Set(['z-target', 'a-target'])
    };
    state.pulses[2] = {
      projectileId: 2,
      ownerPlayerId: 'p2',
      originatingAttackId: 9,
      position: { x: 10, y: 20 },
      previousPosition: { x: 8, y: 20 },
      velocity: { x: 2, y: 0 },
      radius: 8,
      remainingMs: 300,
      hitPlayerIds: new Set(['p1'])
    };

    const snapshot = snapshotMatch(state);

    expect(snapshot.players[0]?.action).toEqual({
      kind: 'HEAVY',
      phase: 'ACTIVE',
      comboStep: 0,
      chargeMs: 640,
      charging: false,
      attackId: 17,
      profileId: 'heavy-melee',
      lockedFacing: { x: 0, y: -1 },
      activeProgress: 1,
      hitTargetIds: ['a-target', 'z-target']
    });
    expect(snapshot.players[1]?.action).toEqual({
      kind: null,
      phase: 'IDLE',
      comboStep: 0,
      chargeMs: 420,
      charging: true,
      attackId: null,
      profileId: null,
      lockedFacing: null,
      activeProgress: 0,
      hitTargetIds: []
    });
    expect(snapshot.pulses).toEqual([
      {
        projectileId: 2,
        ownerPlayerId: 'p2',
        originatingAttackId: 9,
        position: { x: 10, y: 20 },
        velocity: { x: 2, y: 0 },
        radius: 8,
        remainingMs: 300,
        hitTargetIds: ['p1']
      },
      {
        projectileId: 10,
        ownerPlayerId: 'p1',
        originatingAttackId: 17,
        position: { x: 30, y: 40 },
        velocity: { x: 5, y: 0 },
        radius: 12,
        remainingMs: 500,
        hitTargetIds: ['a-target', 'z-target']
      }
    ]);

    if (!state.players.p1.attack) throw new Error('Expected attack runtime');
    state.players.p1.attack.phaseElapsedMs = -10;
    expect(snapshotMatch(state).players[0]?.action.activeProgress).toBe(0);
  });

  it('round-trips every authoritative combat event shape', () => {
    const events: readonly GameEvent[] = [
      {
        type: 'CLASH', eventId: 11, tick: 21, playerIds: ['p1', 'p2'], attackIds: [7, 8],
        impactPosition: { x: 100, y: 200 }, strength: 'HEAVY'
      },
      {
        type: 'PERFECT_DODGE', eventId: 12, tick: 21, playerId: 'p2', attackerId: 'p1', attackId: 7,
        source: 'NEON_PULSE', projectileId: 3, impactPosition: { x: 110, y: 205 }, refundedMs: 250
      },
      {
        type: 'PULSE_SPAWN', eventId: 13, tick: 21, projectileId: 3, ownerPlayerId: 'p1',
        originatingAttackId: 7, position: { x: 120, y: 210 }
      },
      {
        type: 'PULSE_BREAK', eventId: 14, tick: 22, projectileId: 3, breakerPlayerId: 'p2',
        breakerAttackId: 8, impactPosition: { x: 130, y: 215 }
      },
      {
        type: 'HIT', eventId: 15, tick: 22, attackerId: 'p1', targetId: 'p2', attack: 'NEON_PULSE',
        impactPosition: { x: 140, y: 220 }, impulse: 400, resultingOverload: 35
      }
    ];

    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  it('exports the approved cadence, protection, palette, and arena geometry', () => {
    expect(GAME).toMatchObject({
      tickRate: 60, snapshotRate: 60, regulationMs: 120_000, targetScore: 5, minPlayers: 2,
      maxInputFramesPerSecond: 60, inputRateLimitPerSecond: 90,
      knockoutToControlMs: 600, respawnProtectionMs: 650
    });
    expect(ACCENTS).toHaveLength(8);
    expect(ARENA.regulationVertices).toHaveLength(8);
    expect(ARENA.minimumVertices).toHaveLength(8);
    expect(ARENA.spawnAnchors).toHaveLength(8);
    expect(ARENA.regulationVertices[0]).toEqual({ x: 230, y: 90 });
    expect(ARENA.minimumVertices[0]).toEqual({ x: 330, y: 150 });
    expect(ARENA.spawnAnchors[0]).toEqual({ x: 640, y: 190 });
  });
});

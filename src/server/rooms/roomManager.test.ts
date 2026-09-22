import { describe, expect, it } from 'vitest';
import { GAME } from '../../shared/constants.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { CHASSIS, type Chassis, type InputFrame, type MatchSnapshot, type RoomState } from '../../shared/model.js';
import { DomainError } from './domainError.js';
import { RoomManager, type RoomManagerTestHarness, type RoomPublication } from './roomManager.js';

class FakeClock {
  private value = 1_000;

  readonly now = (): number => this.value;

  advance(elapsedMs: number): void {
    this.value += elapsedMs;
  }
}

class DeterministicBytes {
  private readonly queues = new Map<number, Uint8Array[]>();
  private readonly counters = new Map<number, number>();

  queue(size: number, ...values: number[][]): void {
    this.queues.set(size, values.map((value) => Uint8Array.from(value)));
  }

  readonly next = (size: number): Uint8Array => {
    const queued = this.queues.get(size)?.shift();
    if (queued) return queued;
    const value = this.counters.get(size) ?? 0;
    this.counters.set(size, value + 1);
    return Uint8Array.from({ length: size }, () => value);
  };
}

function fixture(): {
  manager: RoomManager;
  clock: FakeClock;
  bytes: DeterministicBytes;
  publications: RoomPublication[];
  harness: RoomManagerTestHarness;
  roomState: (roomCode: string) => RoomState;
  snapshot: (roomCode: string) => MatchSnapshot;
} {
  const clock = new FakeClock();
  const bytes = new DeterministicBytes();
  const publications: RoomPublication[] = [];
  let harness: RoomManagerTestHarness | null = null;
  const manager = new RoomManager({
    now: clock.now,
    randomBytes: bytes.next,
    publish: (event) => publications.push(event),
    bindTestHarness: (boundHarness) => { harness = boundHarness; }
  });
  const roomState = (roomCode: string): RoomState => {
    const event = [...publications].reverse().find(
      (candidate): candidate is Extract<RoomPublication, { type: 'ROOM_STATE' }> =>
        candidate.type === 'ROOM_STATE' && candidate.roomCode === roomCode
    );
    if (!event) throw new Error(`No room state published for ${roomCode}`);
    return event.state;
  };
  const snapshot = (roomCode: string): MatchSnapshot => {
    const event = [...publications].reverse().find(
      (candidate): candidate is Extract<RoomPublication, { type: 'MATCH_STARTED' | 'MATCH_SNAPSHOT' }> =>
        (candidate.type === 'MATCH_STARTED' || candidate.type === 'MATCH_SNAPSHOT') && candidate.roomCode === roomCode
    );
    if (!event) throw new Error(`No match snapshot published for ${roomCode}`);
    return event.snapshot;
  };
  if (!harness) throw new Error('Room manager test harness was not bound.');
  return { manager, clock, bytes, publications, harness, roomState, snapshot };
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

function readyAndStart(subject: ReturnType<typeof fixture>, playerCount = 2): {
  roomCode: string;
  players: ReturnType<RoomManager['createRoom']>[];
} {
  const host = subject.manager.createRoom('c-1', 'Ada');
  const players = [host];
  for (let index = 2; index <= playerCount; index += 1) {
    players.push(subject.manager.joinRoom(`c-${index}`, host.roomCode, `P${index}`));
  }
  for (let index = 1; index <= playerCount; index += 1) subject.manager.setReady(`c-${index}`, true);
  subject.manager.startMatch('c-1');
  return { roomCode: host.roomCode, players };
}

function advanceCountdown(subject: ReturnType<typeof fixture>): void {
  for (let index = 0; index < 60; index += 1) subject.manager.advance(50);
}

function forceTargetResult(
  subject: ReturnType<typeof fixture>,
  roomCode: string,
  attackerId: string,
  targetId: string,
  knockoutTarget: number
): void {
  for (let knockout = 0; knockout < knockoutTarget; knockout += 1) {
    subject.manager.forceKnockout(roomCode, attackerId, targetId);
    if (knockout < knockoutTarget - 1) {
      for (let index = 0; index < 14; index += 1) subject.manager.advance(50);
    }
  }
}

function spawnFullChargePulse(subject: ReturnType<typeof fixture>): void {
  subject.manager.applyInput('c-1', { ...idleInput(0), heavy: true });
  for (let index = 0; index < 15; index += 1) subject.manager.advance(50);
  subject.manager.applyInput('c-1', idleInput(1));
  for (let index = 0; index < 4; index += 1) subject.manager.advance(50);
}

const idleInput = (seq: number): InputFrame => ({
  seq,
  viewTick: 0,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  quick: false,
  heavy: false,
  dash: false
});

describe('RoomManager FFA lifecycle', () => {
  it('owns a twelve-tick combat history per match and clears it across result, lobby, and epoch replacement', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);

    expect(subject.manager.debugRoom(roomCode)).toMatchObject({
      historyOldestTick: 0,
      historyLatestTick: 0
    });
    advanceCountdown(subject);
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({
      historyOldestTick: 169,
      historyLatestTick: 180
    });

    forceTargetResult(
      subject,
      roomCode,
      players[0].playerId,
      players[1].playerId,
      DEFAULT_ROOM_SETTINGS.knockoutTarget
    );
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({
      phase: 'RESULT',
      historyOldestTick: null,
      historyLatestTick: null
    });

    subject.manager.returnToLobby('c-1');
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({
      phase: 'LOBBY',
      historyOldestTick: null,
      historyLatestTick: null
    });
    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.startMatch('c-1');
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({
      historyOldestTick: 0,
      historyLatestTick: 0
    });
  });

  it('clamps admitted view ticks with stale-neutral, fresh-network, history, and future bounds', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    const hostId = players[0].playerId;
    advanceCountdown(subject);

    subject.manager.applyInput('c-1', { ...idleInput(0), viewTick: 0 });
    subject.manager.advance(17);
    expect(subject.manager.debugRoom(roomCode)?.playerViewTicks?.[hostId]).toBe(176);

    subject.manager.setTransport('c-1', 'webrtc');
    subject.manager.setWebRtcNetworkSample('c-1', 100, 20, subject.clock.now());
    subject.manager.applyInput('c-1', { ...idleInput(1), viewTick: 0 });
    subject.manager.advance(17);
    expect(subject.manager.debugRoom(roomCode)?.playerViewTicks?.[hostId]).toBe(172);

    subject.manager.applyInput('c-1', { ...idleInput(2), viewTick: 999 });
    subject.manager.advance(17);
    expect(subject.manager.debugRoom(roomCode)?.playerViewTicks?.[hostId]).toBe(182);
  });

  it('retries room-code collisions and assigns the lowest unused accent with cycling chassis defaults', () => {
    const subject = fixture();
    subject.bytes.queue(4, [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1]);

    const firstRoom = subject.manager.createRoom('first', 'Ada');
    expect(firstRoom.roomCode).toBe('AAAA');
    expect(subject.manager.createRoom('second', 'Linus').roomCode).toBe('BBBB');

    for (let index = 2; index <= 8; index += 1) {
      subject.manager.joinRoom(`first-${index}`, firstRoom.roomCode, `P${index}`);
    }
    const state = subject.roomState(firstRoom.roomCode);
    expect(state.players.map((player) => player.accent)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(state.players.map((player) => player.chassis)).toEqual([
      'RIFT', 'BASTION', 'PULSE', 'WRAITH', 'EMBER', 'VOLT', 'TITAN', 'NOVA'
    ]);

    subject.manager.disconnect('first-3');
    expectErrorCode(() => subject.manager.joinRoom('ninth', firstRoom.roomCode, 'Ninth'), 'ROOM_FULL');
    subject.clock.advance(GAME.reconnectGraceMs);
    subject.manager.advance(0);
    subject.manager.joinRoom('replacement', firstRoom.roomCode, 'Ninth');
    expect(subject.roomState(firstRoom.roomCode).players.at(-1)).toMatchObject({ accent: 2, chassis: 'RIFT' });
  });

  it('validates chassis changes and resets readiness only when the chassis changes', () => {
    const subject = fixture();
    const room = subject.manager.createRoom('c-1', 'Ada');
    subject.manager.setReady('c-1', true);

    subject.manager.setChassis('c-1', 'PULSE');
    expect(subject.roomState(room.roomCode).players[0]).toMatchObject({ chassis: 'PULSE', ready: false });
    subject.manager.setReady('c-1', true);
    subject.manager.setChassis('c-1', 'PULSE');
    expect(subject.roomState(room.roomCode).players[0].ready).toBe(true);
    expectErrorCode(() => subject.manager.setChassis('c-1', 'CORE' as Chassis), 'INVALID_CHASSIS');
  });

  it('publishes default settings, lets only the host change them in the lobby, and resets readiness only on real changes', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    subject.manager.joinRoom('c-2', host.roomCode, 'Linus');
    expect(subject.roomState(host.roomCode).settings).toEqual(DEFAULT_ROOM_SETTINGS);

    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.setRoomSettings('c-1', { durationMs: 90_000, knockoutTarget: 3 });
    expect(subject.roomState(host.roomCode)).toMatchObject({
      settings: { durationMs: 90_000, knockoutTarget: 3 },
      players: [{ ready: false }, { ready: false }]
    });

    subject.manager.setReady('c-1', true);
    const publicationsBeforeNoOp = subject.publications.length;
    subject.manager.setRoomSettings('c-1', { durationMs: 90_000, knockoutTarget: 3 });
    expect(subject.roomState(host.roomCode).players[0]?.ready).toBe(true);
    expect(subject.publications).toHaveLength(publicationsBeforeNoOp);

    const stateBeforeGuestWrite = subject.roomState(host.roomCode);
    expectErrorCode(() => subject.manager.setRoomSettings('c-2', { durationMs: 120_000, knockoutTarget: 5 }), 'NOT_HOST');
    expect(subject.roomState(host.roomCode)).toEqual(stateBeforeGuestWrite);
    expect(subject.publications).toHaveLength(publicationsBeforeNoOp);
  });

  it('rejects host settings writes in countdown, match, and result without changing the configured pair', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);

    expectErrorCode(() => subject.manager.setRoomSettings('c-1', { durationMs: 90_000, knockoutTarget: 3 }), 'INVALID_PHASE');
    expect(subject.roomState(roomCode).settings).toEqual(DEFAULT_ROOM_SETTINGS);
    advanceCountdown(subject);
    expectErrorCode(() => subject.manager.setRoomSettings('c-1', { durationMs: 90_000, knockoutTarget: 3 }), 'INVALID_PHASE');

    forceTargetResult(subject, roomCode, players[0].playerId, players[1].playerId, DEFAULT_ROOM_SETTINGS.knockoutTarget);
    expect(subject.roomState(roomCode).phase).toBe('RESULT');
    expectErrorCode(() => subject.manager.setRoomSettings('c-1', { durationMs: 90_000, knockoutTarget: 3 }), 'INVALID_PHASE');
    expect(subject.roomState(roomCode).settings).toEqual(DEFAULT_ROOM_SETTINGS);
  });

  it('publishes bounded network telemetry with median consecutive-sample jitter and transport only while a match exists', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    const guest = subject.manager.joinRoom('c-2', host.roomCode, 'Linus');
    const publicationsBeforeLobbySample = subject.publications.length;
    subject.manager.setPing('c-1', 41.6, 'polling', subject.clock.now());
    subject.manager.setTransport('c-1', 'websocket');
    expect(subject.publications).toHaveLength(publicationsBeforeLobbySample);

    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.startMatch('c-1');
    expect(subject.manager.isInActiveMatch('c-1')).toBe(true);
    expect(subject.snapshot(host.roomCode).network).toEqual({
      [host.playerId]: { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' },
      [guest.playerId]: { currentMs: null, medianMs: null, jitterMs: null, transport: 'polling' }
    });

    const publicationsBeforeSamples = subject.publications.length;
    subject.manager.setPing('c-1', 10, 'websocket', subject.clock.now());
    subject.manager.setPing('c-1', 10, 'websocket', subject.clock.now());
    subject.manager.setPing('c-1', 10, 'websocket', subject.clock.now());
    subject.manager.setPing('c-1', 100, 'websocket', subject.clock.now());
    subject.manager.setPing('c-2', 10, 'polling', subject.clock.now());
    subject.manager.setPing('c-2', 30, 'polling', subject.clock.now());
    subject.manager.setPing('c-2', 70, 'polling', subject.clock.now());
    subject.manager.setPing('c-2', GAME.maxPingMs + 500, 'polling', subject.clock.now());
    expect(subject.publications).toHaveLength(publicationsBeforeSamples);
    subject.manager.advance(40);
    expect(subject.snapshot(host.roomCode).network).toEqual({
      [host.playerId]: { currentMs: 100, medianMs: 10, jitterMs: 0, transport: 'websocket' },
      [guest.playerId]: { currentMs: GAME.maxPingMs, medianMs: 50, jitterMs: 40, transport: 'polling' }
    });
  });

  it('computes jitter only from the latest five consecutive RTT samples', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);

    for (const sample of [10, 10, 110, 210, 310, 410, 410, 410, 410]) {
      subject.manager.setPing('c-1', sample, 'polling', subject.clock.now());
    }
    subject.manager.advance(40);

    expect(subject.snapshot(roomCode).network[players[0].playerId]).toMatchObject({
      currentMs: 410,
      medianMs: 410,
      jitterMs: 0
    });
  });

  it('accepts only current-transport RTT samples, expires them after six seconds, and clears them on transport change', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    const hostId = players[0].playerId;

    subject.manager.setTransport('c-1', 'webrtc');
    subject.manager.setPing('c-1', 99, 'websocket', 1_000);
    subject.manager.advance(40);
    expect(subject.snapshot(roomCode).network[hostId]).toEqual({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'webrtc'
    });

    subject.manager.setWebRtcNetworkSample('c-1', 12, 7, 1_000);
    subject.clock.advance(5_999);
    subject.manager.advance(40);
    expect(subject.snapshot(roomCode).network[hostId]).toMatchObject({
      currentMs: 12,
      medianMs: 12,
      jitterMs: 7,
      transport: 'webrtc'
    });

    subject.clock.advance(2);
    subject.manager.advance(40);
    expect(subject.snapshot(roomCode).network[hostId]).toMatchObject({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'webrtc'
    });

    subject.manager.setWebRtcNetworkSample('c-1', 15, 3, subject.clock.now());
    subject.manager.setTransport('c-1', 'websocket');
    subject.manager.advance(40);
    expect(subject.snapshot(roomCode).network[hostId]).toEqual({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'websocket'
    });
  });

  it('publishes one stable epoch through host migration and resume, then increments exactly once for a rematch', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 3);
    const firstStarted = subject.publications.find(
      (publication): publication is Extract<RoomPublication, { type: 'MATCH_STARTED' }> =>
        publication.type === 'MATCH_STARTED'
    );
    expect(firstStarted).toMatchObject({ matchEpoch: 1, eventCursor: 0 });

    advanceCountdown(subject);
    subject.manager.disconnect('c-1');
    expect(subject.roomState(roomCode).hostPlayerId).toBe(players[1].playerId);
    subject.manager.resume('c-4', roomCode, players[0].resumeToken);
    const firstEpochPublications = subject.publications.filter(
      (publication) => publication.type === 'MATCH_STARTED'
        || publication.type === 'MATCH_SNAPSHOT'
        || publication.type === 'MATCH_EVENT'
    );
    expect(firstEpochPublications).not.toHaveLength(0);
    expect(firstEpochPublications.every((publication) => publication.matchEpoch === 1)).toBe(true);

    forceTargetResult(
      subject,
      roomCode,
      players[1].playerId,
      players[2].playerId,
      DEFAULT_ROOM_SETTINGS.knockoutTarget
    );
    subject.manager.setResultReady('c-2', true);
    subject.manager.setResultReady('c-3', true);
    subject.manager.setResultReady('c-4', true);
    subject.manager.startMatch('c-2');

    const starts = subject.publications.filter(
      (publication): publication is Extract<RoomPublication, { type: 'MATCH_STARTED' }> =>
        publication.type === 'MATCH_STARTED'
    );
    expect(starts.map(({ matchEpoch, eventCursor }) => ({ matchEpoch, eventCursor }))).toEqual([
      { matchEpoch: 1, eventCursor: 0 },
      { matchEpoch: 2, eventCursor: 0 }
    ]);
  });

  it('preserves settings and migrated ownership through resume, member removal, result, rematches, and lobby return', () => {
    const subject = fixture();
    const first = subject.manager.createRoom('c-1', 'Ada');
    const second = subject.manager.joinRoom('c-2', first.roomCode, 'Linus');
    subject.manager.joinRoom('c-3', first.roomCode, 'Grace');
    subject.manager.joinRoom('c-4', first.roomCode, 'Edsger');
    const configured = { durationMs: 90_000, knockoutTarget: 3 } as const;
    subject.manager.setRoomSettings('c-1', configured);

    subject.manager.disconnect('c-1');
    expect(subject.roomState(first.roomCode)).toMatchObject({ hostPlayerId: second.playerId, settings: configured });
    subject.manager.resume('c-5', first.roomCode, first.resumeToken);
    expect(subject.roomState(first.roomCode)).toMatchObject({ hostPlayerId: second.playerId, settings: configured });

    subject.manager.leaveRoom('c-3');
    expect(subject.roomState(first.roomCode).hostPlayerId).toBe(second.playerId);
    subject.manager.disconnect('c-4');
    subject.clock.advance(GAME.reconnectGraceMs);
    subject.manager.advance(0);
    expect(subject.roomState(first.roomCode).hostPlayerId).toBe(second.playerId);

    subject.manager.setReady('c-2', true);
    subject.manager.setReady('c-5', true);
    subject.manager.startMatch('c-2');
    expect(subject.snapshot(first.roomCode).settings).toEqual(configured);
    advanceCountdown(subject);
    forceTargetResult(subject, first.roomCode, second.playerId, first.playerId, configured.knockoutTarget);
    expect(subject.roomState(first.roomCode)).toMatchObject({ phase: 'RESULT', settings: configured });

    subject.manager.setResultReady('c-2', true);
    subject.manager.setResultReady('c-5', true);
    subject.manager.startMatch('c-2');
    expect(subject.snapshot(first.roomCode).settings).toEqual(configured);
    advanceCountdown(subject);
    forceTargetResult(subject, first.roomCode, second.playerId, first.playerId, configured.knockoutTarget);
    subject.manager.returnToLobby('c-2');
    expect(subject.roomState(first.roomCode)).toMatchObject({ phase: 'LOBBY', settings: configured });

    subject.manager.setReady('c-2', true);
    subject.manager.setReady('c-5', true);
    subject.manager.startMatch('c-2');
    expect(subject.snapshot(first.roomCode).settings).toEqual(configured);
  });

  it('leaves a lobby immediately, preserves survivor readiness, migrates host, invalidates resume, and closes the empty room', () => {
    const subject = fixture();
    const first = subject.manager.createRoom('c-1', 'Ada');
    const second = subject.manager.joinRoom('c-2', first.roomCode, 'Linus');
    subject.manager.setReady('c-2', true);

    expect(subject.manager.leaveRoom('c-1')).toBe(first.roomCode);
    expect(subject.roomState(first.roomCode)).toMatchObject({
      hostPlayerId: second.playerId,
      players: [{ playerId: second.playerId, ready: true, connected: true }]
    });
    expectErrorCode(() => subject.manager.resume('resume-old', first.roomCode, first.resumeToken), 'INVALID_RESUME_TOKEN');
    expect(subject.manager.createRoom('c-1', 'Yeni Ada').roomCode).not.toBe(first.roomCode);

    expect(subject.manager.leaveRoom('c-2')).toBe(first.roomCode);
    expect(subject.manager.debugRoom(first.roomCode)).toBeNull();
    expect(subject.publications.filter(
      (publication) => publication.type === 'ROOM_CLOSED' && publication.roomCode === first.roomCode
    )).toHaveLength(1);
  });

  it('keeps the result open, preserves survivor readiness, and migrates the host when the winner leaves', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    const guest = subject.manager.joinRoom('c-2', host.roomCode, 'Linus');
    const configured = { durationMs: 90_000, knockoutTarget: 3 } as const;
    subject.manager.setRoomSettings('c-1', configured);
    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.startMatch('c-1');
    advanceCountdown(subject);
    forceTargetResult(subject, host.roomCode, host.playerId, guest.playerId, configured.knockoutTarget);
    subject.manager.setResultReady('c-2', true);

    expect(subject.manager.leaveRoom('c-1')).toBe(host.roomCode);
    expect(subject.roomState(host.roomCode)).toMatchObject({
      phase: 'RESULT',
      hostPlayerId: guest.playerId,
      settings: configured,
      players: [{ playerId: guest.playerId, ready: true }],
      result: {
        winnerPlayerId: host.playerId,
        players: [
          { playerId: host.playerId, resultStatus: 'LEFT' },
          { playerId: guest.playerId, resultStatus: 'READY' }
        ]
      }
    });
    expect(subject.manager.debugRoom(host.roomCode)?.scores).not.toBeNull();
  });

  it('keeps result standings visible and marks leavers after the match ends', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    const guest = subject.manager.joinRoom('c-2', host.roomCode, 'Linus');
    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.startMatch('c-1');
    advanceCountdown(subject);
    forceTargetResult(subject, host.roomCode, host.playerId, guest.playerId, DEFAULT_ROOM_SETTINGS.knockoutTarget);
    subject.manager.setResultReady('c-1', true);

    expect(subject.manager.leaveRoom('c-2')).toBe(host.roomCode);
    expect(subject.roomState(host.roomCode)).toMatchObject({
      phase: 'RESULT',
      hostPlayerId: host.playerId,
      players: [{ playerId: host.playerId, ready: true, connected: true }],
      result: {
        winnerPlayerId: host.playerId,
        reason: 'TARGET_SCORE',
        players: [
          { playerId: host.playerId, resultStatus: 'READY' },
          { playerId: guest.playerId, resultStatus: 'LEFT', connected: false }
        ]
      }
    });
  });

  it('keeps players who join after a match out of the finished standings', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    const guest = subject.manager.joinRoom('c-2', host.roomCode, 'Linus');
    subject.manager.setReady('c-1', true);
    subject.manager.setReady('c-2', true);
    subject.manager.startMatch('c-1');
    advanceCountdown(subject);
    forceTargetResult(subject, host.roomCode, host.playerId, guest.playerId, DEFAULT_ROOM_SETTINGS.knockoutTarget);

    const newcomer = subject.manager.joinRoom('c-3', host.roomCode, 'Grace');
    subject.manager.setResultReady('c-3', true);
    expect(subject.roomState(host.roomCode).phase).toBe('RESULT');
    expect(subject.roomState(host.roomCode).players.find((player) => player.playerId === newcomer.playerId))
      .toMatchObject({ ready: true });
    expect(subject.roomState(host.roomCode).result?.players.map((player) => player.playerId)).toEqual([
      host.playerId,
      guest.playerId
    ]);

    subject.manager.leaveRoom('c-3');
    expect(subject.roomState(host.roomCode).result?.players.map((player) => player.playerId)).toEqual([
      host.playerId,
      guest.playerId
    ]);
  });

  it('removes a leaver, queued input, score entry, and owned pulses while a three-player match continues', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 3);
    advanceCountdown(subject);
    spawnFullChargePulse(subject);
    expect(subject.snapshot(roomCode).pulses.some((pulse) => pulse.ownerPlayerId === players[0].playerId)).toBe(true);

    expect(subject.manager.leaveRoom('c-1')).toBe(roomCode);
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({ phase: 'MATCH', connectedCount: 2, reservedCount: 0 });
    expect(subject.snapshot(roomCode).scores).toEqual({ [players[1].playerId]: 0, [players[2].playerId]: 0 });
    expect(subject.snapshot(roomCode).players.map((player) => player.playerId)).toEqual([
      players[1].playerId,
      players[2].playerId
    ]);
    expect(subject.snapshot(roomCode).pulses.some((pulse) => pulse.ownerPlayerId === players[0].playerId)).toBe(false);
    expectErrorCode(() => subject.manager.applyInput('c-1', idleInput(2)), 'PLAYER_NOT_FOUND');
  });

  it('removes a leaving player immediately, invalidates resume, migrates host, and no-contests an under-populated active match', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    advanceCountdown(subject);

    expect(subject.manager.leaveRoom('c-1')).toBe(roomCode);
    expect(subject.roomState(roomCode)).toMatchObject({
      phase: 'LOBBY',
      hostPlayerId: players[1].playerId,
      players: [{ playerId: players[1].playerId, connected: true }]
    });
    expect(subject.manager.debugRoom(roomCode)?.scores).toBeNull();
    expectErrorCode(() => subject.manager.resume('c-3', roomCode, players[0].resumeToken), 'INVALID_RESUME_TOKEN');
    const noContests = subject.publications.filter(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT' && publication.event.reason === 'NO_CONTEST'
    );
    expect(noContests).toHaveLength(1);
    expect(noContests[0]?.type === 'MATCH_EVENT' && noContests[0].event.type === 'RESULT'
      ? noContests[0].event.scores
      : null).toEqual({ [players[1].playerId]: 0 });
  });

  it('starts FFA matches with two through eight connected ready players and enforces host/start rules', () => {
    const single = fixture();
    single.manager.createRoom('single', 'Ada');
    single.manager.setReady('single', true);
    expectErrorCode(() => single.manager.startMatch('single'), 'NOT_ENOUGH_PLAYERS');

    for (const count of [2, 8]) {
      const subject = fixture();
      const host = subject.manager.createRoom('c-1', 'Ada');
      for (let index = 2; index <= count; index += 1) {
        subject.manager.joinRoom(`c-${index}`, host.roomCode, `P${index}`);
      }
      expectErrorCode(() => subject.manager.startMatch('c-2'), 'NOT_HOST');
      expectErrorCode(() => subject.manager.startMatch('c-1'), 'NOT_READY');
      for (let index = 1; index <= count; index += 1) subject.manager.setReady(`c-${index}`, true);
      subject.manager.startMatch('c-1');
      expect(subject.roomState(host.roomCode).phase).toBe('COUNTDOWN');
      expect(subject.snapshot(host.roomCode).players).toHaveLength(count);
      expectErrorCode(() => subject.manager.joinRoom('late', host.roomCode, 'Late'), 'MATCH_IN_PROGRESS');
    }
  });

  it('simulates and publishes authoritative snapshots at 60 Hz while keeping only monotonic input', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    subject.publications.length = 0;
    subject.manager.applyInput('c-1', idleInput(5));
    subject.manager.applyInput('c-1', { ...idleInput(4), moveX: -1 });

    advanceCountdown(subject);

    const snapshots = subject.publications.filter(
      (publication): publication is Extract<RoomPublication, { type: 'MATCH_SNAPSHOT' }> =>
        publication.type === 'MATCH_SNAPSHOT'
    );
    expect(snapshots).toHaveLength(180);
    expect(snapshots.at(-1)?.snapshot.tick).toBe(180);
    expect(snapshots.at(-1)?.snapshot.players.find((player) => player.playerId === players[0].playerId)?.lastProcessedInputSeq).toBe(5);
    expect(subject.roomState(roomCode).phase).toBe('MATCH');
  });

  it('preserves a 250 ms stall for bounded catch-up without dropping authoritative snapshots', () => {
    const subject = fixture();
    const { roomCode } = readyAndStart(subject);
    advanceCountdown(subject);
    subject.publications.length = 0;
    const startingTick = subject.manager.debugRoom(roomCode)!.tick!;

    subject.manager.advance(250);
    expect(subject.manager.debugRoom(roomCode)?.tick).toBe(startingTick + 5);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)?.tick).toBe(startingTick + 10);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)?.tick).toBe(startingTick + 15);

    const snapshotTicks = subject.publications.flatMap((publication) =>
      publication.type === 'MATCH_SNAPSHOT' ? [publication.snapshot.tick] : []);
    expect(snapshotTicks).toEqual(
      Array.from({ length: 15 }, (_value, index) => startingTick + index + 1)
    );
  });

  it('preserves unprocessed quick and dash pulses through newer neutral frames and consumes each once', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    advanceCountdown(subject);

    subject.manager.applyInput('c-1', { ...idleInput(0), quick: true });
    subject.manager.applyInput('c-1', idleInput(1));
    subject.manager.applyInput('c-2', { ...idleInput(0), dash: true });
    subject.manager.applyInput('c-2', idleInput(1));
    subject.manager.advance(50);

    const onset = subject.snapshot(roomCode);
    expect(onset.players.find((player) => player.playerId === players[0].playerId)?.action.kind).toBe('QUICK_1');
    expect(onset.players.find((player) => player.playerId === players[1].playerId)?.dashCooldownRemainingMs)
      .toBeGreaterThan(0);

    subject.manager.applyInput('c-1', idleInput(2));
    subject.manager.applyInput('c-2', idleInput(2));
    for (let index = 0; index < 40; index += 1) subject.manager.advance(50);
    const settled = subject.snapshot(roomCode);
    expect(settled.players.find((player) => player.playerId === players[0].playerId)?.stats.completedAttacks).toBe(1);
    expect(settled.players.find((player) => player.playerId === players[1].playerId)).toMatchObject({
      dashRemainingMs: 0,
      dashCooldownRemainingMs: 0
    });
    subject.manager.advance(50);
    expect(subject.snapshot(roomCode).players.find((player) => player.playerId === players[0].playerId)?.stats.completedAttacks)
      .toBe(1);
    expect(subject.snapshot(roomCode).players.find((player) => player.playerId === players[1].playerId)?.dashCooldownRemainingMs)
      .toBe(0);
  });

  it('preserves the original bounded view tick when an unprocessed quick edge is followed by a held frame', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    advanceCountdown(subject);
    const attackerId = players[0].playerId;
    const targetId = players[1].playerId;

    subject.harness.placePlayer(roomCode, attackerId, { x: 600, y: 360 }, { x: 1, y: 0 });
    subject.harness.placePlayer(roomCode, targetId, { x: 650, y: 360 }, { x: -1, y: 0 });
    const visibleTick = subject.manager.debugRoom(roomCode)!.tick!;
    subject.manager.advance(67);
    subject.harness.placePlayer(roomCode, targetId, { x: 900, y: 360 }, { x: -1, y: 0 });
    const heldTick = subject.manager.debugRoom(roomCode)!.tick!;
    expect(heldTick).toBeGreaterThan(visibleTick);

    subject.publications.length = 0;
    subject.manager.applyInput('c-1', { ...idleInput(0), quick: true, viewTick: visibleTick });
    subject.manager.applyInput('c-1', { ...idleInput(1), quick: true, viewTick: heldTick });
    subject.manager.advance(50);

    expect(subject.manager.debugRoom(roomCode)?.playerViewTicks?.[attackerId]).toBe(visibleTick);
    expect(subject.snapshot(roomCode).players.find((player) => player.playerId === attackerId)?.action.kind)
      .toBe('QUICK_1');

    subject.manager.applyInput('c-1', { ...idleInput(2), viewTick: heldTick });
    for (let index = 0; index < 40; index += 1) subject.manager.advance(50);
    const hits = subject.publications.flatMap((publication) =>
      publication.type === 'MATCH_EVENT' && publication.event.type === 'HIT'
        ? [publication.event]
        : []);

    expect(hits).toEqual([
      expect.objectContaining({ attackerId, targetId, attack: 'QUICK_1' })
    ]);
    expect(subject.snapshot(roomCode).players.find((player) => player.playerId === attackerId)?.stats.completedAttacks)
      .toBe(1);
  });

  it('continues with two connected players and disconnects without score or statistics penalties', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 3);
    advanceCountdown(subject);
    subject.manager.forceKnockout(roomCode, players[0].playerId, players[1].playerId);
    subject.manager.advance(50);
    const before = subject.manager.debugRoom(roomCode);
    const beforeStats = subject.snapshot(roomCode).players.find((player) => player.playerId === players[1].playerId)?.stats;
    expect(beforeStats?.falls).toBe(1);

    subject.manager.disconnect('c-2');

    expect(subject.manager.debugRoom(roomCode)).toMatchObject({ phase: 'MATCH', connectedCount: 2, reservedCount: 1 });
    expect(subject.manager.debugRoom(roomCode)?.scores).toEqual(before?.scores);
    expect(subject.roomState(roomCode).players.find((player) => player.playerId === players[1].playerId)?.stats).toEqual(beforeStats);
    expect(subject.publications.filter(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'KNOCKOUT'
    )).toHaveLength(1);
  });

  it('pauses below two, keeps reservation clocks authoritative, and resumes identity in place', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    advanceCountdown(subject);
    subject.manager.forceKnockout(roomCode, players[0].playerId, players[1].playerId);
    for (let index = 0; index < 14; index += 1) subject.manager.advance(50);
    const scoreBefore = subject.manager.debugRoom(roomCode)?.scores;
    const statsBefore = subject.snapshot(roomCode).players.find((player) => player.playerId === players[0].playerId)?.stats;
    const positionBefore = subject.snapshot(roomCode).players.find((player) => player.playerId === players[0].playerId)?.position;

    subject.manager.disconnect('c-1');
    const pausedTick = subject.manager.debugRoom(roomCode)?.tick;
    expect(subject.roomState(roomCode).pauseRemainingMs).toBe(GAME.reconnectGraceMs);
    subject.clock.advance(19_999);
    subject.manager.advance(1_000);
    expect(subject.manager.debugRoom(roomCode)?.tick).toBe(pausedTick);
    expect(subject.roomState(roomCode).players.find((player) => player.playerId === players[0].playerId)?.reconnectRemainingMs).toBe(GAME.reconnectGraceMs);

    expect(subject.manager.resume('c-3', roomCode, players[0].resumeToken)).toMatchObject({
      playerId: players[0].playerId,
      resumed: true
    });
    const restored = subject.snapshot(roomCode).players.find((player) => player.playerId === players[0].playerId);
    expect(restored).toMatchObject({ position: positionBefore, respawnRemainingMs: 0, stats: statsBefore });
    expect(subject.manager.debugRoom(roomCode)?.scores).toEqual(scoreBefore);
    expect(subject.roomState(roomCode).pauseRemainingMs).toBeNull();
  });

  it('waits for the last viable opponent reservation before publishing one no-contest result and resetting the lobby', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 3);
    advanceCountdown(subject);
    subject.manager.forceKnockout(roomCode, players[0].playerId, players[2].playerId);
    subject.manager.disconnect('c-3');
    subject.clock.advance(19_000);
    subject.manager.disconnect('c-2');
    const preserved = subject.roomState(roomCode).players.map(({ playerId, chassis, accent }) => ({ playerId, chassis, accent }));
    subject.publications.length = 0;

    subject.clock.advance(1_000);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({ phase: 'MATCH', connectedCount: 1, reservedCount: 1 });
    expect(subject.publications.some(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT'
    )).toBe(false);

    subject.clock.advance(19_000);
    subject.manager.advance(0);
    const noContests = subject.publications.filter(
      (publication): publication is Extract<RoomPublication, { type: 'MATCH_EVENT' }> =>
        publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT' && publication.event.reason === 'NO_CONTEST'
    );
    expect(noContests).toHaveLength(1);
    const noContest = noContests[0];
    if (noContest?.event.type !== 'RESULT') throw new Error('Expected a RESULT event');
    expect(noContest.event.winnerPlayerId).toBeNull();
    expect(subject.roomState(roomCode)).toMatchObject({ phase: 'LOBBY', result: null, pauseRemainingMs: null });
    expect(subject.roomState(roomCode).players.map(({ playerId, chassis, accent }) => ({ playerId, chassis, accent }))).toEqual([
      preserved[0]
    ]);
    expect(subject.roomState(roomCode).players[0].stats).toEqual({ knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 });
    expect(subject.manager.debugRoom(roomCode)?.scores).toBeNull();
  });

  it('ends at the exact deadline where three staggered reservations can no longer restore two players', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 3);
    advanceCountdown(subject);
    subject.manager.forceKnockout(roomCode, players[2].playerId, players[1].playerId);
    const preserved = subject.roomState(roomCode).players.find((player) => player.playerId === players[2].playerId)!;

    subject.manager.disconnect('c-1');
    subject.clock.advance(5_000);
    subject.manager.disconnect('c-2');
    subject.clock.advance(5_000);
    subject.manager.disconnect('c-3');
    subject.publications.length = 0;

    subject.clock.advance(9_999);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({ phase: 'MATCH', connectedCount: 0, reservedCount: 3 });
    expect(subject.publications.some(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT'
    )).toBe(false);

    subject.clock.advance(1);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)).toMatchObject({ phase: 'MATCH', connectedCount: 0, reservedCount: 2 });
    expect(subject.publications.some(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT'
    )).toBe(false);

    subject.clock.advance(4_999);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(roomCode)?.phase).toBe('MATCH');
    subject.clock.advance(1);
    subject.manager.advance(0);

    const noContests = subject.publications.filter(
      (publication): publication is Extract<RoomPublication, { type: 'MATCH_EVENT' }> =>
        publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT' && publication.event.reason === 'NO_CONTEST'
    );
    expect(noContests).toHaveLength(1);
    expect(subject.roomState(roomCode)).toMatchObject({
      phase: 'LOBBY',
      hostPlayerId: players[2].playerId,
      pauseRemainingMs: null,
      result: null,
      players: [{
        playerId: players[2].playerId,
        chassis: preserved.chassis,
        accent: preserved.accent,
        connected: false,
        stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 }
      }]
    });
    expect(subject.manager.debugRoom(roomCode)?.scores).toBeNull();

    subject.manager.advance(0);
    expect(subject.publications.filter(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'RESULT'
    )).toHaveLength(1);
  });

  it('migrates the host immediately and never takes ownership back on resume', () => {
    const subject = fixture();
    const first = subject.manager.createRoom('c-1', 'Ada');
    const second = subject.manager.joinRoom('c-2', first.roomCode, 'Linus');

    subject.manager.disconnect('c-1');
    expect(subject.roomState(first.roomCode).hostPlayerId).toBe(second.playerId);
    subject.manager.resume('c-3', first.roomCode, first.resumeToken);
    expect(subject.roomState(first.roomCode).hostPlayerId).toBe(second.playerId);
  });

  it('removes pulses owned by a disconnected player when its reservation expires', () => {
    const subject = fixture();
    const { roomCode } = readyAndStart(subject, 3);
    advanceCountdown(subject);
    spawnFullChargePulse(subject);
    expect(subject.snapshot(roomCode).pulses).toEqual([
      expect.objectContaining({ projectileId: 1, ownerPlayerId: subject.roomState(roomCode).players[0].playerId })
    ]);

    subject.manager.disconnect('c-1');
    expect(subject.snapshot(roomCode).pulses).toHaveLength(1);
    subject.clock.advance(GAME.reconnectGraceMs);
    subject.manager.advance(50);

    expect(subject.snapshot(roomCode).pulses).toEqual([]);
  });

  it('drops pulse-bearing rooms on server reset without leaving resumable state', () => {
    const subject = fixture();
    const { roomCode } = readyAndStart(subject);
    advanceCountdown(subject);
    spawnFullChargePulse(subject);
    expect(subject.snapshot(roomCode).pulses).toHaveLength(1);

    subject.manager.reset();

    expect(subject.manager.debugRoom(roomCode)).toBeNull();
    expectErrorCode(() => subject.manager.resume('resume', roomCode, '00'.repeat(32)), 'ROOM_NOT_FOUND');
  });

  it('publishes five forced knockouts, records a player result, and resets only match state for a rematch', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject);
    const identities = subject.roomState(roomCode).players.map(({ playerId, chassis, accent }) => ({ playerId, chassis, accent }));
    advanceCountdown(subject);

    for (let knockout = 0; knockout < GAME.targetScore; knockout += 1) {
      subject.manager.forceKnockout(roomCode, players[0].playerId, players[1].playerId);
      if (knockout < GAME.targetScore - 1) {
        for (let index = 0; index < 14; index += 1) subject.manager.advance(50);
      }
    }

    expect(subject.publications.filter(
      (publication) => publication.type === 'MATCH_EVENT' && publication.event.type === 'KNOCKOUT'
    )).toHaveLength(GAME.targetScore);
    expect(subject.roomState(roomCode)).toMatchObject({
      phase: 'RESULT',
      result: { winnerPlayerId: players[0].playerId, reason: 'TARGET_SCORE' }
    });
    expect(subject.roomState(roomCode).players.find((player) => player.playerId === players[0].playerId)?.stats.knockouts).toBe(5);
    expect(subject.roomState(roomCode).players.find((player) => player.playerId === players[1].playerId)?.stats.falls).toBe(5);

    subject.manager.setResultReady('c-1', true);
    subject.manager.setResultReady('c-2', true);
    subject.manager.startMatch('c-1');
    expect(subject.roomState(roomCode).players.map(({ playerId, chassis, accent }) => ({ playerId, chassis, accent }))).toEqual(identities);
    expect(subject.snapshot(roomCode)).toMatchObject({
      tick: 0,
      scores: { [players[0].playerId]: 0, [players[1].playerId]: 0 },
      winnerPlayerId: null,
      resultReason: null
    });
    expect(subject.roomState(roomCode).players.every((player) =>
      !player.ready && Object.values(player.stats).every((value) => value === 0)
    )).toBe(true);
  });

  it('runs eight staged players through ordinary combat for four same-tick hits and resulting ring-outs', () => {
    const subject = fixture();
    const { roomCode, players } = readyAndStart(subject, 8);
    advanceCountdown(subject);
    subject.publications.length = 0;
    subject.harness.runCombatScript(roomCode, {
      players: [
        {
          playerId: players[0].playerId,
          position: { x: 1050, y: 360 },
          facing: { x: 1, y: 0 },
          overload: 0
        },
        {
          playerId: players[1].playerId,
          position: { x: 1110, y: 360 },
          facing: { x: 1, y: 0 },
          overload: GAME.maxOverload
        },
        {
          playerId: players[2].playerId,
          position: { x: 230, y: 360 },
          facing: { x: -1, y: 0 },
          overload: 0
        },
        {
          playerId: players[3].playerId,
          position: { x: 170, y: 360 },
          facing: { x: -1, y: 0 },
          overload: GAME.maxOverload
        },
        {
          playerId: players[4].playerId,
          position: { x: 640, y: 180 },
          facing: { x: 0, y: -1 },
          overload: 0
        },
        {
          playerId: players[5].playerId,
          position: { x: 640, y: 120 },
          facing: { x: 0, y: -1 },
          overload: GAME.maxOverload
        },
        {
          playerId: players[6].playerId,
          position: { x: 640, y: 540 },
          facing: { x: 0, y: 1 },
          overload: 0
        },
        {
          playerId: players[7].playerId,
          position: { x: 640, y: 600 },
          facing: { x: 0, y: 1 },
          overload: GAME.maxOverload
        }
      ],
      steps: [
        {
          elapsedMs: 0,
          inputs: players.map((player, index) => {
            const facing = index < 2 ? { x: 1, y: 0 }
              : index < 4 ? { x: -1, y: 0 }
                : index < 6 ? { x: 0, y: -1 }
                  : { x: 0, y: 1 };
            return {
              playerId: player.playerId,
              input: {
                ...idleInput(0),
                aimX: facing.x,
                aimY: facing.y,
                quick: index % 2 === 0
              }
            };
          })
        },
        {
          elapsedMs: 70,
          inputs: players.map((player, index) => {
            const facing = index < 2 ? { x: 1, y: 0 }
              : index < 4 ? { x: -1, y: 0 }
                : index < 6 ? { x: 0, y: -1 }
                  : { x: 0, y: 1 };
            return {
              playerId: player.playerId,
              input: { ...idleInput(1), aimX: facing.x, aimY: facing.y }
            };
          })
        },
        { elapsedMs: 1_000 / GAME.tickRate },
        { elapsedMs: 1_000 / GAME.tickRate },
        { elapsedMs: 1_000 / GAME.tickRate }
      ]
    });

    const events = subject.publications.flatMap((publication) =>
      publication.type === 'MATCH_EVENT' ? [publication.event] : []);
    const hits = events.filter((event): event is Extract<(typeof events)[number], { type: 'HIT' }> =>
      event.type === 'HIT');
    const knockouts = events.filter((event): event is Extract<(typeof events)[number], { type: 'KNOCKOUT' }> =>
      event.type === 'KNOCKOUT');
    const attackers = players.filter((_player, index) => index % 2 === 0).map((player) => player.playerId);
    const targets = players.filter((_player, index) => index % 2 === 1).map((player) => player.playerId);
    expect(hits).toHaveLength(4);
    expect(new Set(hits.map((event) => event.tick)).size).toBe(1);
    expect(hits.map((event) => event.attackerId)).toEqual(attackers);
    expect(hits.map((event) => event.targetId)).toEqual(targets);
    expect(hits.every((event) =>
      event.attack === 'QUICK_1' && event.impulse > 0 && event.resultingOverload === GAME.maxOverload
    )).toBe(true);
    expect(knockouts).toHaveLength(4);
    expect(new Set(knockouts.map((event) => event.tick)).size).toBe(1);
    expect(knockouts[0]!.tick).toBeGreaterThan(hits[0]!.tick);
    expect(knockouts.map((event) => event.attackerId)).toEqual(attackers);
    expect(knockouts.map((event) => event.targetId)).toEqual(targets);
    expect(knockouts.map((event) => event.scoreAwardedTo)).toEqual(attackers);
    expect(subject.publications.filter((publication) => publication.type === 'MATCH_SNAPSHOT')).toHaveLength(5);
    expect(subject.snapshot(roomCode)).toMatchObject({
      tick: expect.any(Number),
      scores: Object.fromEntries(players.map((player, index) => [player.playerId, index % 2 === 0 ? 1 : 0]))
    });
  });

  it('returns debug copies without tokens or deadlines and closes an empty room at the exact deadline', () => {
    const subject = fixture();
    const host = subject.manager.createRoom('c-1', 'Ada');
    const debug = subject.manager.debugRoom(host.roomCode);
    expect(debug).toMatchObject({ phase: 'LOBBY', connectedCount: 1, reservedCount: 0, tick: null, scores: null });
    expect(JSON.stringify(debug)).not.toMatch(/token|expires|timestamp/iu);
    (debug?.playerIds as string[]).push('tamper');
    expect(subject.manager.debugRoom(host.roomCode)?.playerIds).toEqual([host.playerId]);

    subject.manager.disconnect('c-1');
    subject.clock.advance(GAME.reconnectGraceMs - 1);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(host.roomCode)).not.toBeNull();
    subject.clock.advance(1);
    subject.manager.advance(0);
    expect(subject.manager.debugRoom(host.roomCode)).toBeNull();
    expect(subject.publications.filter(
      (publication) => publication.type === 'ROOM_CLOSED' && publication.roomCode === host.roomCode
    )).toHaveLength(1);
  });
});

describe('bots and spectators', () => {
  function watch(count = 8) {
    const s = fixture();
    const host = s.manager.createRoom('host', 'Watcher');
    s.manager.setRole('host', 'SPECTATOR');
    for (let i = 0; i < count; i++) s.manager.addBot('host', CHASSIS[i % CHASSIS.length]!, 'NORMAL');
    return { ...s, host, code: host.roomCode };
  }

  it('keeps eight fighter slots separate from spectators and prevents overfilling via role changes', () => {
    const s = watch();
    expect(s.roomState(s.code).players.filter(p => p.role === 'FIGHTER')).toHaveLength(8);
    expectErrorCode(() => s.manager.addBot('host', 'RIFT', 'HARD'), 'ROOM_FULL');
    expectErrorCode(() => s.manager.setRole('host', 'FIGHTER'), 'ROOM_FULL');
    for (let i = 0; i < 7; i++) s.manager.joinRoom(`watch${i}`, s.code, `W${i}`, 'SPECTATOR');
    expectErrorCode(() => s.manager.joinRoom('ninth', s.code, 'Extra', 'SPECTATOR'), 'ROOM_FULL');
    const bot = s.roomState(s.code).players.find(p => p.botDifficulty)!;
    s.manager.removeBot('host', bot.playerId);
    s.manager.setRole('host', 'FIGHTER');
    expect(new Set(s.roomState(s.code).players.filter(p => p.role === 'FIGHTER').map(p => p.accent)).size).toBe(8);
  });

  it('restricts bot management to the host and makes bot settings effective', () => {
    const s = watch(2);
    s.manager.joinRoom('guest', s.code, 'Guest', 'SPECTATOR');
    const bot = s.roomState(s.code).players.find(p => p.botDifficulty)!;
    for (const action of [() => s.manager.addBot('guest', 'RIFT', 'EASY'), () => s.manager.removeBot('guest', bot.playerId), () => s.manager.updateBot('guest', bot.playerId, 'PULSE', 'HARD')]) expectErrorCode(action, 'NOT_HOST');
    s.manager.updateBot('host', bot.playerId, 'PULSE', 'HARD');
    expect(s.roomState(s.code).players.find(p => p.playerId === bot.playerId)).toMatchObject({ chassis: 'PULSE', botDifficulty: 'HARD', ready: true });
    s.manager.setRoomSettings('host', { durationMs: 90_000, knockoutTarget: 3 });
    s.manager.startMatch('host');
    expectErrorCode(() => s.manager.removeBot('host', bot.playerId), 'INVALID_PHASE');
  });

  it('excludes spectators from gameplay and supports joining and leaving an active match', () => {
    const s = watch(2);
    s.manager.startMatch('host');
    const joined = s.manager.joinRoom('late', s.code, 'Late', 'SPECTATOR');
    expect(s.manager.currentMatchPublication('late')?.snapshot.players).toHaveLength(2);
    expectErrorCode(() => s.manager.applyInput('late', idleInput(0)), 'SPECTATOR_ACTION');
    expectErrorCode(() => s.manager.setReady('host', true), 'SPECTATOR_ACTION');
    expectErrorCode(() => s.manager.setRole('late', 'FIGHTER'), 'INVALID_PHASE');
    s.manager.disconnect('late');
    expect(s.roomState(s.code).players.some(p => p.playerId === joined.playerId)).toBe(false);
    advanceCountdown(s);
    expect(s.snapshot(s.code).phase).toBe('REGULATION');
    expect(s.snapshot(s.code).players.some(p => p.playerId === s.host.playerId)).toBe(false);
  });

  it('keeps host ownership human and destroys bots when the last human leaves', () => {
    const s = watch(2);
    const guest = s.manager.joinRoom('guest', s.code, 'Guest', 'SPECTATOR');
    s.manager.startMatch('host');
    s.manager.disconnect('host');
    expect(s.roomState(s.code).hostPlayerId).toBe(guest.playerId);
    s.manager.leaveRoom('guest');
    expect(s.manager.debugRoom(s.code)).toBeNull();
  });

  it('runs eight bots through natural combat, scoring, results and a spectator-host rematch', () => {
    const s = watch();
    s.manager.setRoomSettings('host', { durationMs: 90_000, knockoutTarget: 3 });
    s.manager.startMatch('host');
    for (let i = 0; i < 3600 && s.roomState(s.code).phase !== 'RESULT'; i++) {
      s.clock.advance(50); s.manager.advance(50);
    }
    const result = s.roomState(s.code);
    expect(result.phase).toBe('RESULT');
    expect(result.result?.players).toHaveLength(8);
    expect(result.result!.players.reduce((sum, p) => sum + p.stats.landedHits, 0)).toBeGreaterThan(20);
    expect(result.result!.players.reduce((sum, p) => sum + p.stats.knockouts, 0)).toBeGreaterThan(0);
    expect(result.result!.players.every(p => p.ready && p.botDifficulty !== null)).toBe(true);
    expectErrorCode(() => s.manager.setResultReady('host', true), 'SPECTATOR_ACTION');
    s.manager.startMatch('host');
    expect(s.snapshot(s.code).players).toHaveLength(8);
    expect(Object.values(s.snapshot(s.code).scores)).toEqual(Array(8).fill(0));
  });
});

import type { Browser } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import type { Ack, InputFrame, MatchPlayer, ServerError, SessionWelcome } from '../../src/shared/model.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../src/shared/protocol.js';
import { GAME } from '../../src/shared/constants.js';
import {
  assertNoUnexpectedErrors,
  expect,
  openPlayer,
  test,
  type E2eGame,
  type PlayerPage
} from './fixtures.js';

const FRAME_SAMPLES = 181;
const COMPANION_COUNT = 7;
const COMPANION_INPUT_MS = 3_800;
const ACK_TIMEOUT_MS = 2_000;
const RING_OUT_EFFECT_SAMPLE_FRAMES = 72;
const INPUT_LATENCY_SAMPLES = 60;
const MAX_MEDIAN_INPUT_LATENCY_MS = 20;
// Sampling starts after the browser has produced an input frame, so one 60 Hz
// authoritative server boundary is inherent. Bound occasional scheduler and
// event-loop tail separately instead of conflating this metric with Ping.
const MAX_P95_INPUT_LATENCY_MS = 40;

test.use({
  launchOptions: {
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-renderer-backgrounding',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])
    ],
    headless: process.platform !== 'darwin'
  }
});

type GameClient = Socket<ServerToClientEvents, ClientToServerEvents>;
type AckEvent = Exclude<keyof ClientToServerEvents, 'match:input'>;

const COMPANION_LAYOUT = [
  { position: { x: 640, y: 190 }, facing: { x: 0, y: -1 } },
  { position: { x: 820, y: 260 }, facing: { x: 1, y: -1 } },
  { position: { x: 820, y: 460 }, facing: { x: 1, y: 1 } },
  { position: { x: 640, y: 530 }, facing: { x: 0, y: 1 } },
  { position: { x: 460, y: 460 }, facing: { x: -1, y: 1 } },
  { position: { x: 460, y: 260 }, facing: { x: -1, y: -1 } },
  { position: { x: 350, y: 360 }, facing: { x: -1, y: 0 } }
] as const;

async function emitSuccess<T>(socket: GameClient, event: AckEvent, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ACK_TIMEOUT_MS);
    const emit = socket.emit.bind(socket) as (
      eventName: string,
      eventPayload: unknown,
      acknowledge: (acknowledgement: Ack<T>) => void
    ) => void;
    emit(event, payload, (acknowledgement) => {
      clearTimeout(timer);
      if (acknowledgement.ok) resolve(acknowledgement.data);
      else reject(new Error(`${acknowledgement.error.code}: ${acknowledgement.error.message}`));
    });
  });
}

async function connectClient(origin: string): Promise<GameClient> {
  const client: GameClient = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting performance client')), ACK_TIMEOUT_MS);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return client;
}

async function createEightPlayerMatch(
  browser: Browser,
  game: E2eGame,
  companionErrors: ServerError[]
): Promise<Readonly<{ code: string; measured: PlayerPage; companions: readonly GameClient[]; welcomes: readonly SessionWelcome[] }>> {
  const measured = await openPlayer(browser, game.origin, { observeInput: true });
  const companions: GameClient[] = [];
  try {
    await measured.page.getByLabel('Oyuncu adı').fill('Player 1');
    await measured.page.getByRole('button', { name: 'Oda Kur' }).click();
    const code = await measured.page.getByTestId('room-code').textContent();
    if (!code) throw new Error('Measured player room code was not rendered.');

    for (let index = 0; index < COMPANION_COUNT; index += 1) {
      const client = await connectClient(game.origin);
      client.on('server:error', (error) => companionErrors.push(error));
      companions.push(client);
    }
    const welcomes = await Promise.all(companions.map((client, index) => emitSuccess<SessionWelcome>(
      client,
      'room:join',
      { name: `Player ${index + 2}`, roomCode: code }
    )));
    await Promise.all(companions.map((client, index) => emitSuccess<null>(client, 'lobby:chassis', {
      chassis: ['BASTION', 'PULSE', 'WRAITH', 'RIFT'][index % 4]
    })));
    await Promise.all(companions.map((client) => emitSuccess<null>(client, 'lobby:ready', { ready: true })));
    await measured.page.getByRole('button', { name: 'Hazırım' }).click();
    await expect(measured.page.getByRole('button', { name: 'Maçı Başlat' })).toBeEnabled();
    await measured.page.getByRole('button', { name: 'Maçı Başlat' }).click();
    await expect(measured.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeVisible();
    await expect.poll(() => game.harness.matchSnapshot(code)?.phase, { timeout: 12_000 }).toBe('REGULATION');
    return { code, measured, companions, welcomes };
  } catch (error) {
    for (const companion of companions) companion.disconnect();
    await measured.context.close();
    throw error;
  }
}

type BrowserSampler<T> = Readonly<{
  result: Promise<T>;
  stop(): Promise<void>;
}>;

let nextSamplerId = 0;

function sampleFrameDurations(player: PlayerPage): BrowserSampler<number[]> {
  const samplerId = `durations-${nextSamplerId++}`;
  const result = player.page.evaluate(({ sampleCount, id }) => new Promise<number[]>((resolve) => {
    const scope = window as typeof window & { __NEON_E2E_FRAME_SAMPLERS__?: Record<string, { stopped: boolean }> };
    const controls = scope.__NEON_E2E_FRAME_SAMPLERS__ ??= {};
    controls[id] = { stopped: false };
    const durations: number[] = [];
    let previous = performance.now();
    const sample = (now: number): void => {
      durations.push(now - previous);
      previous = now;
      if (durations.length >= sampleCount || controls[id]?.stopped) {
        delete controls[id];
        resolve(durations.slice(1));
      } else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), { sampleCount: FRAME_SAMPLES, id: samplerId });
  return {
    result,
    stop: async () => {
      await player.page.evaluate((id) => {
        const controls = (window as typeof window & {
          __NEON_E2E_FRAME_SAMPLERS__?: Record<string, { stopped: boolean }>;
        }).__NEON_E2E_FRAME_SAMPLERS__;
        if (controls?.[id]) controls[id].stopped = true;
      }, samplerId);
    }
  };
}

type SampledFrame = Readonly<{
  index: number;
  nowMs: number;
  durationMs: number;
  visibilityState: string;
  hasFocus: boolean;
}>;

function sampleFrameTimeline(player: PlayerPage): BrowserSampler<readonly SampledFrame[]> {
  const samplerId = `timeline-${nextSamplerId++}`;
  const result = player.page.evaluate(({ sampleCount, id }) => new Promise<SampledFrame[]>((resolve) => {
    const scope = window as typeof window & { __NEON_E2E_FRAME_SAMPLERS__?: Record<string, { stopped: boolean }> };
    const controls = scope.__NEON_E2E_FRAME_SAMPLERS__ ??= {};
    controls[id] = { stopped: false };
    const frames: SampledFrame[] = [];
    let previous = performance.now();
    const sample = (now: number): void => {
      frames.push({
        index: frames.length,
        nowMs: now,
        durationMs: now - previous,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus()
      });
      previous = now;
      if (frames.length >= sampleCount || controls[id]?.stopped) {
        delete controls[id];
        resolve(frames.slice(1));
      } else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), { sampleCount: FRAME_SAMPLES, id: samplerId });
  return {
    result,
    stop: async () => {
      await player.page.evaluate((id) => {
        const controls = (window as typeof window & {
          __NEON_E2E_FRAME_SAMPLERS__?: Record<string, { stopped: boolean }>;
        }).__NEON_E2E_FRAME_SAMPLERS__;
        if (controls?.[id]) controls[id].stopped = true;
      }, samplerId);
    }
  };
}

async function markAfterAnimationFrames(
  player: PlayerPage,
  frameCount: number
): Promise<Readonly<{ nowMs: number; visibilityState: string; hasFocus: boolean }>> {
  return player.page.evaluate((framesToWait) => new Promise((resolve) => {
    let remaining = framesToWait;
    const sample = (): void => {
      remaining -= 1;
      if (remaining > 0) {
        requestAnimationFrame(sample);
        return;
      }
      resolve({
        nowMs: performance.now(),
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus()
      });
    };
    requestAnimationFrame(sample);
  }), frameCount);
}

function authoritativePlayer(game: E2eGame, code: string, playerId: string): MatchPlayer {
  const player = game.harness.matchSnapshot(code)?.players.find((candidate) => candidate.playerId === playerId);
  if (!player) throw new Error(`Missing performance player ${playerId}.`);
  return player;
}

type InputLatencyObservation = Readonly<{
  inputSequence: number;
  browserSampledAtMs: number;
  browserAcceptedAtMs: number;
  acceptedProcessedSequence: number;
  latencyMs: number;
}>;

type BrowserInputRecord = Readonly<{
  sequence: number;
  sampledAtMs: number;
  moveX: number;
  dash: boolean;
}>;

type BrowserSnapshotRecord = Readonly<{
  lastProcessedInputSeq: number;
  acceptedAtMs: number;
}>;

type BrowserInputObserver = Readonly<{
  inputs: readonly BrowserInputRecord[];
  acceptedSnapshots: readonly BrowserSnapshotRecord[];
  reconciliations?: ReadonlyArray<Readonly<{
    correctionDistancePx: number;
    hardSnap: boolean;
  }>>;
}>;

async function observerSequence(player: PlayerPage): Promise<number> {
  return player.page.evaluate(() => {
    const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
      .__NEON_E2E_INPUT_OBSERVER__;
    return observer?.inputs.at(-1)?.sequence ?? -1;
  });
}

async function waitForBrowserAcceptance(
  player: PlayerPage,
  afterSequence: number,
  moveX: number
): Promise<InputLatencyObservation> {
  await player.page.waitForFunction(({ afterSequence: after, moveX: expectedMoveX }) => {
    const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
      .__NEON_E2E_INPUT_OBSERVER__;
    const input = observer?.inputs.find((candidate) =>
      candidate.sequence > after && candidate.moveX === expectedMoveX);
    return Boolean(input && observer?.acceptedSnapshots.some((snapshot) =>
      snapshot.lastProcessedInputSeq >= input.sequence && snapshot.acceptedAtMs >= input.sampledAtMs));
  }, { afterSequence, moveX }, { timeout: ACK_TIMEOUT_MS });
  return player.page.evaluate(({ afterSequence: after, moveX: expectedMoveX }) => {
    const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
      .__NEON_E2E_INPUT_OBSERVER__;
    const input = observer?.inputs.find((candidate) =>
      candidate.sequence > after && candidate.moveX === expectedMoveX);
    const accepted = input && observer?.acceptedSnapshots.find((snapshot) =>
      snapshot.lastProcessedInputSeq >= input.sequence && snapshot.acceptedAtMs >= input.sampledAtMs);
    if (!input || !accepted) throw new Error('Exact browser input acceptance was not observed.');
    return {
      inputSequence: input.sequence,
      browserSampledAtMs: input.sampledAtMs,
      browserAcceptedAtMs: accepted.acceptedAtMs,
      acceptedProcessedSequence: accepted.lastProcessedInputSeq,
      latencyMs: accepted.acceptedAtMs - input.sampledAtMs
    };
  }, { afterSequence, moveX });
}

async function warmBrowserInputPath(player: PlayerPage): Promise<void> {
  let marker = await observerSequence(player);
  await player.page.keyboard.down('d');
  await waitForBrowserAcceptance(player, marker, 1);
  marker = await observerSequence(player);
  await player.page.keyboard.up('d');
  await waitForBrowserAcceptance(player, marker, 0);
}

async function measureBrowserInputLatency(
  measured: PlayerPage
): Promise<readonly InputLatencyObservation[]> {
  const observations: InputLatencyObservation[] = [];
  for (let index = 0; index < INPUT_LATENCY_SAMPLES; index += 1) {
    const marker = await observerSequence(measured);
    if (index % 2 === 0) await measured.page.keyboard.down('d');
    else await measured.page.keyboard.up('d');
    observations.push(await waitForBrowserAcceptance(measured, marker, index % 2 === 0 ? 1 : 0));
  }
  await measured.page.keyboard.up('d');
  return observations;
}

function latencyMetrics(observations: readonly InputLatencyObservation[]): Readonly<{
  samples: number;
  medianMs: number;
  p95Ms: number;
}> {
  const sorted = observations.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!
  };
}

function companionInput(seq: number, index: number): InputFrame {
  const cycle = seq % 120;
  const facing = COMPANION_LAYOUT[index]!.facing;
  const moving = cycle < 8 || (cycle >= 90 && cycle < 98);
  return {
    seq,
    viewTick: seq,
    moveX: moving ? facing.x : 0,
    moveY: moving ? facing.y : 0,
    aimX: facing.x,
    aimY: facing.y,
    quick: cycle === 12,
    heavy: cycle >= 30 && cycle < 75,
    dash: cycle === 100
  };
}

async function driveCompanions(companions: readonly GameClient[], signal: AbortSignal): Promise<void> {
  const startedAt = performance.now();
  let sequence = 0;
  while (!signal.aborted && performance.now() - startedAt < COMPANION_INPUT_MS) {
    for (let index = 0; index < companions.length; index += 1) {
      companions[index]!.emit('match:input', companionInput(sequence, index));
    }
    sequence += 1;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 1_000 / 60);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function placePlayers(
  game: E2eGame,
  code: string,
  measuredId: string,
  companionIds: readonly string[]
): Promise<void> {
  game.harness.placePlayer(code, measuredId, { x: 640, y: 360 }, { x: 1, y: 0 });
  for (let index = 0; index < companionIds.length; index += 1) {
    const layout = COMPANION_LAYOUT[index]!;
    game.harness.placePlayer(code, companionIds[index]!, layout.position, layout.facing);
  }
  await expect.poll(() => game.harness.matchSnapshot(code)?.players.length).toBe(8);
}

async function retainMeasuredAim(game: E2eGame, code: string, measured: PlayerPage, playerId: string): Promise<void> {
  for (const key of ['w', 'a', 's', 'd', 'j', 'k', 'Space']) await measured.page.keyboard.up(key);
  const before = authoritativePlayer(game, code, playerId).lastProcessedInputSeq;
  await measured.page.keyboard.down('d');
  await expect.poll(() => {
    const current = authoritativePlayer(game, code, playerId);
    return current.lastProcessedInputSeq > before && current.facing.x === 1 && current.facing.y === 0;
  }).toBe(true);
  const releaseSequence = authoritativePlayer(game, code, playerId).lastProcessedInputSeq;
  await measured.page.keyboard.up('d');
  await expect.poll(() => authoritativePlayer(game, code, playerId).lastProcessedInputSeq)
    .toBeGreaterThan(releaseSequence);
}

async function spawnLivePulseThroughMatchInput(
  game: E2eGame,
  code: string,
  client: GameClient,
  playerId: string
): Promise<NonNullable<ReturnType<E2eGame['harness']['matchSnapshot']>>['pulses'][number]> {
  const heldSequence = authoritativePlayer(game, code, playerId).lastProcessedInputSeq + 1;
  client.emit('match:input', {
    seq: heldSequence,
    viewTick: 0,
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    quick: false,
    heavy: true,
    dash: false
  });
  await expect.poll(() => authoritativePlayer(game, code, playerId).action.chargeMs)
    .toBe(GAME.heavyMaxChargeMs);

  client.emit('match:input', {
    seq: heldSequence + 1,
    viewTick: 0,
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    quick: false,
    heavy: false,
    dash: false
  });
  await expect.poll(() => game.harness.matchSnapshot(code)?.pulses.find(
    (pulse) => pulse.ownerPlayerId === playerId
  ) ?? null, { timeout: ACK_TIMEOUT_MS, intervals: [10] }).not.toBeNull();

  const pulse = game.harness.matchSnapshot(code)?.pulses.find((candidate) => candidate.ownerPlayerId === playerId);
  if (!pulse) throw new Error('Production match input did not leave a live pulse.');
  return pulse;
}

function frameMetrics(durations: readonly number[]): Readonly<{
  medianFrameMs: number;
  medianFps: number;
  p95FrameMs: number;
}> {
  const sorted = [...durations].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  return { medianFrameMs: median, medianFps: 1_000 / median, p95FrameMs: p95 };
}

function burstFrameMetrics(frames: readonly SampledFrame[]): Readonly<{
  maxFrameMs: number;
  maxFrameIndex: number;
  p95FrameMs: number;
  medianFps: number;
  surroundingFrames: readonly SampledFrame[];
}> {
  const durations = frames.map((frame) => frame.durationMs);
  const { medianFps, p95FrameMs } = frameMetrics(durations);
  let maxFrameIndex = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.durationMs > frames[maxFrameIndex]!.durationMs) maxFrameIndex = index;
  }
  const windowStart = Math.max(0, maxFrameIndex - 3);
  const windowEnd = Math.min(frames.length, maxFrameIndex + 4);
  return {
    maxFrameMs: frames[maxFrameIndex]?.durationMs ?? 0,
    maxFrameIndex,
    p95FrameMs,
    medianFps,
    surroundingFrames: frames.slice(windowStart, windowEnd)
  };
}

function framesOverlappingInterval(
  frames: readonly SampledFrame[],
  intervalStartedAtMs: number,
  intervalFinishedAtMs: number
): readonly SampledFrame[] {
  return frames.filter((frame) => {
    const frameStartedAtMs = frame.nowMs - frame.durationMs;
    return frameStartedAtMs < intervalFinishedAtMs && frame.nowMs > intervalStartedAtMs;
  });
}

test('holds one LAN viewport frame budget while eight authoritative players fight', async ({ browser, game }, testInfo) => {
  const companionErrors: ServerError[] = [];
  const match = await createEightPlayerMatch(browser, game, companionErrors);
  const driveAbort = new AbortController();
  let companionDrive: Promise<void> | null = null;
  let frameSampler: BrowserSampler<number[]> | null = null;
  try {
    const initial = game.harness.matchSnapshot(match.code);
    if (!initial) throw new Error('Eight-player performance snapshot was not available.');
    const measuredId = initial.players.find((player) => player.name === 'Player 1')?.playerId;
    if (!measuredId) throw new Error('Measured browser player was missing.');
    const companionIds = match.welcomes.map((welcome) => welcome.playerId);
    await placePlayers(game, match.code, measuredId, companionIds);
    await retainMeasuredAim(game, match.code, match.measured, measuredId);
    await expect(match.measured.page.getByRole('list', { name: 'Oyuncu sıralaması' }).getByRole('listitem')).toHaveCount(8);
    await expect.poll(() => game.harness.transportMode(measuredId), { timeout: 10_000 }).toBe('webrtc');
    expect(companionIds.map((playerId) => game.harness.transportMode(playerId)))
      .toEqual(new Array(COMPANION_COUNT).fill('websocket'));

    await warmBrowserInputPath(match.measured);
    const webRtcLatencyObservations = await measureBrowserInputLatency(match.measured);
    for (const observation of webRtcLatencyObservations) {
      expect(game.harness.acceptedInputs(measuredId).find(
        (record) => record.sequence === observation.inputSequence
      )?.source).toBe('webrtc');
    }
    await match.measured.page.evaluate(() => {
      const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
        .__NEON_E2E_INPUT_OBSERVER__;
      if (observer?.reconciliations) (observer.reconciliations as unknown[]).splice(0);
    });

    // Latency sampling moves the fighter; reset the load layout before combat.
    await placePlayers(game, match.code, measuredId, companionIds);
    await retainMeasuredAim(game, match.code, match.measured, measuredId);
    const before = authoritativePlayer(game, match.code, measuredId);
    const eventMarker = game.harness.recentEvents(match.code).at(-1)?.eventId ?? 0;
    companionDrive = driveCompanions(match.companions, driveAbort.signal);
    frameSampler = sampleFrameDurations(match.measured);
    await match.measured.page.keyboard.down('j');
    await match.measured.page.waitForTimeout(120);
    await match.measured.page.keyboard.up('j');
    await expect.poll(() => authoritativePlayer(game, match.code, measuredId).stats.completedAttacks, {
      message: 'the measured WebRTC quick input should complete authoritatively'
    }).toBeGreaterThanOrEqual(before.stats.completedAttacks + 1);
    await match.measured.page.keyboard.down('k');
    await match.measured.page.waitForTimeout(760);
    await expect.poll(() => authoritativePlayer(game, match.code, measuredId).action.chargeMs)
      .toBe(GAME.heavyMaxChargeMs);
    await match.measured.page.keyboard.up('k');
    await expect.poll(() => game.harness.recentEvents(match.code).some(
      (event) => event.eventId > eventMarker && event.type === 'PULSE_SPAWN' && event.ownerPlayerId === measuredId
    ), { message: 'the measured WebRTC heavy release should spawn its pulse authoritatively' }).toBe(true);
    await expect.poll(() => authoritativePlayer(game, match.code, measuredId).action.kind, {
      message: 'the heavy recovery should finish before the dash edge is sampled'
    }).toBe(null);
    const dashObserverMarker = await observerSequence(match.measured);
    await match.measured.page.keyboard.down('Space');
    await match.measured.page.waitForFunction((afterSequence) => {
      const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
        .__NEON_E2E_INPUT_OBSERVER__;
      return observer?.inputs.some((input) => input.sequence > afterSequence && input.dash) ?? false;
    }, dashObserverMarker, { timeout: ACK_TIMEOUT_MS });
    const dashSequence = await match.measured.page.evaluate((afterSequence) => {
      const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
        .__NEON_E2E_INPUT_OBSERVER__;
      const input = observer?.inputs.find((candidate) => candidate.sequence > afterSequence && candidate.dash);
      if (!input) throw new Error('The browser did not sample the dash edge.');
      return input.sequence;
    }, dashObserverMarker);
    await expect.poll(() => game.harness.acceptedInputs(measuredId).find(
      (record) => record.sequence === dashSequence
    )?.source).toBe('webrtc');
    await expect.poll(() => authoritativePlayer(game, match.code, measuredId).dashCooldownRemainingMs, {
      intervals: [10, 20, 40],
      timeout: ACK_TIMEOUT_MS
    }).toBeGreaterThan(0);
    await match.measured.page.waitForTimeout(120);
    await match.measured.page.keyboard.up('Space');
    const durations = await frameSampler.result;
    await companionDrive;

    const after = authoritativePlayer(game, match.code, measuredId);
    const events = game.harness.recentEvents(match.code).filter((event) => event.eventId > eventMarker);
    expect(after.stats.completedAttacks).toBeGreaterThanOrEqual(before.stats.completedAttacks + 2);
    expect(events.some((event) => event.type === 'PULSE_SPAWN' && event.ownerPlayerId === measuredId)).toBe(true);
    expect(companionIds.every((playerId) => authoritativePlayer(game, match.code, playerId).stats.completedAttacks >= 2)).toBe(true);
    expect(new Set(events.filter((event) => event.type === 'PULSE_SPAWN').map((event) => event.ownerPlayerId)))
      .toEqual(new Set([measuredId, ...companionIds]));
    expect(game.server.rooms.debugRoom(match.code)).toMatchObject({ connectedCount: 8, reservedCount: 0 });
    expect(game.harness.matchSnapshot(match.code)?.players).toHaveLength(8);
    await expect(match.measured.page.getByRole('list', { name: 'Oyuncu sıralaması' }).getByRole('listitem')).toHaveCount(8);

    await game.harness.dropWebRtc(measuredId);
    await expect.poll(() => game.harness.transportMode(measuredId), { timeout: 10_000 }).toBe('websocket');
    await warmBrowserInputPath(match.measured);
    const socketIoLatencyObservations = await measureBrowserInputLatency(match.measured);
    for (const observation of socketIoLatencyObservations) {
      expect(game.harness.acceptedInputs(measuredId).find(
        (record) => record.sequence === observation.inputSequence
      )?.source).toBe('websocket');
    }
    const transportLatency = {
      metric: 'browser input sampler to browser-accepted authoritative snapshot',
      methodology: 'same browser page and keyboard path; exact sampled sequence is matched to the first accepted snapshot whose local lastProcessedInputSeq reaches it; each mode is warmed up; WebRTC is measured first, then forced in-place Socket.IO fallback',
      order: ['webrtc', 'socket.io-fallback'],
      physicalLanClaim: false,
      webRtc: latencyMetrics(webRtcLatencyObservations),
      socketIo: latencyMetrics(socketIoLatencyObservations),
      observations: {
        webRtc: webRtcLatencyObservations,
        socketIo: socketIoLatencyObservations
      }
    };
    await testInfo.attach('transport-latency-comparison', {
      body: Buffer.from(JSON.stringify(transportLatency, null, 2)),
      contentType: 'application/json'
    });
    console.info(`TRANSPORT_LATENCY_METRICS ${JSON.stringify(transportLatency)}`);

    const { medianFrameMs, medianFps, p95FrameMs } = frameMetrics(durations);
    const reconciliations = await match.measured.page.evaluate(() => {
      const observer = (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: BrowserInputObserver })
        .__NEON_E2E_INPUT_OBSERVER__;
      return observer?.reconciliations ?? [];
    });
    const metrics = {
      browserContexts: 1,
      authoritativePlayers: 8,
      loadGameplayTransport: 'webrtc',
      socketIoCompanions: COMPANION_COUNT,
      viewport: '1280x720',
      samples: durations.length,
      medianFrameMs: Number(medianFrameMs.toFixed(2)),
      medianFps: Number(medianFps.toFixed(2)),
      p95FrameMs: Number(p95FrameMs.toFixed(2)),
      inputLatency: {
        webRtc: {
          samples: transportLatency.webRtc.samples,
          medianMs: Number(transportLatency.webRtc.medianMs.toFixed(2)),
          p95Ms: Number(transportLatency.webRtc.p95Ms.toFixed(2))
        },
        socketIo: {
          samples: transportLatency.socketIo.samples,
          medianMs: Number(transportLatency.socketIo.medianMs.toFixed(2)),
          p95Ms: Number(transportLatency.socketIo.p95Ms.toFixed(2))
        }
      }
    };
    testInfo.annotations.push({ type: 'performance', description: JSON.stringify(metrics) });
    console.info(`PERFORMANCE_METRICS ${JSON.stringify(metrics)}`);
    expect(medianFps).toBeGreaterThanOrEqual(58);
    expect(p95FrameMs).toBeLessThan(25);
    expect(transportLatency.webRtc.medianMs).toBeLessThanOrEqual(MAX_MEDIAN_INPUT_LATENCY_MS);
    expect(transportLatency.webRtc.p95Ms).toBeLessThan(MAX_P95_INPUT_LATENCY_MS);
    expect(transportLatency.socketIo.medianMs).toBeLessThanOrEqual(MAX_MEDIAN_INPUT_LATENCY_MS);
    expect(transportLatency.socketIo.p95Ms).toBeLessThan(MAX_P95_INPUT_LATENCY_MS);
    expect(reconciliations.filter((entry) => !entry.hardSnap)
      .every((entry) => entry.correctionDistancePx < 160)).toBe(true);
    const roster = match.measured.page.getByRole('region', { name: 'Oyuncu listesi' });
    await expect(roster).not.toContainText(/RTT|Delay|Rollback|\bRB\b/);
    expect(companionErrors).toEqual([]);
    await assertNoUnexpectedErrors(game, match.measured);
  } finally {
    driveAbort.abort();
    if (frameSampler) await frameSampler.stop().catch(() => undefined);
    await Promise.allSettled([
      ...(companionDrive ? [companionDrive] : []),
      ...(frameSampler ? [frameSampler.result] : [])
    ]);
    for (const companion of match.companions) companion.disconnect();
    await match.measured.context.close();
  }
}, 60_000);

test('holds browser frame time below 50 ms through four simultaneous hit-driven ring-out effects', async ({ browser, game }, testInfo) => {
  const companionErrors: ServerError[] = [];
  const match = await createEightPlayerMatch(browser, game, companionErrors);
  let frameSampler: BrowserSampler<readonly SampledFrame[]> | null = null;
  try {
    const initial = game.harness.matchSnapshot(match.code);
    if (!initial) throw new Error('Eight-player ring-out burst snapshot was not available.');
    const attackerA = initial.players.find((player) => player.name === 'Player 1')?.playerId;
    if (!attackerA) throw new Error('Measured browser attacker was missing.');
    const companionIds = match.welcomes.map((welcome) => welcome.playerId);
    if (companionIds.length !== 7) {
      throw new Error(`Expected 7 companion players, received ${match.welcomes.length}.`);
    }
    await expect(match.measured.page.getByRole('list', { name: 'Oyuncu sıralaması' }).getByRole('listitem')).toHaveCount(8);

    const eventMarker = game.harness.recentEvents(match.code).at(-1)?.eventId ?? 0;
    const pulseOwnerId = companionIds[0]!;
    const safePositions = [
      { x: 360, y: 180 },
      { x: 360, y: 540 },
      { x: 520, y: 180 },
      { x: 520, y: 540 },
      { x: 760, y: 180 },
      { x: 760, y: 540 },
      { x: 920, y: 180 }
    ] as const;
    game.harness.placePlayer(match.code, pulseOwnerId, { x: 360, y: 360 }, { x: 1, y: 0 });
    [attackerA, ...companionIds.filter((playerId) => playerId !== pulseOwnerId)].forEach((playerId, index) => {
      game.harness.placePlayer(match.code, playerId, safePositions[index]!, { x: 1, y: 0 });
    });
    const livePulse = await spawnLivePulseThroughMatchInput(
      game,
      match.code,
      match.companions[0]!,
      pulseOwnerId
    );
    expect(livePulse.remainingMs).toBeGreaterThan(250);

    frameSampler = sampleFrameTimeline(match.measured);
    // BASTION targets start 10 px nearer the fall boundary to compensate for armor.
    const pairs = [
      { attackerId: attackerA, targetId: companionIds[0]!, attacker: { x: 1139, y: 360 }, target: { x: 1208, y: 360 }, facing: { x: 1, y: 0 } },
      { attackerId: companionIds[1]!, targetId: companionIds[2]!, attacker: { x: 141, y: 360 }, target: { x: 82, y: 360 }, facing: { x: -1, y: 0 } },
      { attackerId: companionIds[3]!, targetId: companionIds[4]!, attacker: { x: 640, y: 91 }, target: { x: 640, y: 22 }, facing: { x: 0, y: -1 } },
      { attackerId: companionIds[5]!, targetId: companionIds[6]!, attacker: { x: 640, y: 629 }, target: { x: 640, y: 688 }, facing: { x: 0, y: 1 } }
    ] as const;
    const targetIds = new Set(pairs.map((pair) => pair.targetId));
    const combatants = pairs.flatMap((pair) => [
      { playerId: pair.attackerId, position: pair.attacker, facing: pair.facing, overload: 0, attacking: true },
      { playerId: pair.targetId, position: pair.target, facing: pair.facing, overload: GAME.maxOverload, attacking: false }
    ]);
    const burstDispatchStarted = await match.measured.page.evaluate(() => ({
      nowMs: performance.now(),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus()
    }));

    game.harness.runCombatScript(match.code, {
      preservePulses: true,
      players: combatants.map(({ playerId, position, facing, overload }) => ({
        playerId,
        position,
        facing,
        overload
      })),
      steps: [
        {
          elapsedMs: 0,
          inputs: combatants.map((player) => ({
            playerId: player.playerId,
            input: { seq: 0, viewTick: 0, moveX: 0, moveY: 0, aimX: player.facing.x, aimY: player.facing.y, quick: player.attacking, heavy: false, dash: false }
          }))
        },
        {
          elapsedMs: 70,
          inputs: combatants.map((player) => ({
            playerId: player.playerId,
            input: { seq: 1, viewTick: 0, moveX: 0, moveY: 0, aimX: player.facing.x, aimY: player.facing.y, quick: false, heavy: false, dash: false }
          }))
        },
        { elapsedMs: 1_000 / GAME.tickRate },
        { elapsedMs: 1_000 / GAME.tickRate },
        { elapsedMs: 1_000 / GAME.tickRate }
      ]
    });
    const pulseAfterBurst = game.harness.matchSnapshot(match.code)?.pulses.find(
      (pulse) => pulse.projectileId === livePulse.projectileId
    );
    expect(pulseAfterBurst).toMatchObject({
      projectileId: livePulse.projectileId,
      ownerPlayerId: pulseOwnerId,
      originatingAttackId: livePulse.originatingAttackId
    });
    expect(pulseAfterBurst?.remainingMs).toBeGreaterThan(0);
    expect(pulseAfterBurst?.remainingMs).toBeLessThan(livePulse.remainingMs);
    const burstDispatchFinished = await match.measured.page.evaluate(() => ({
      nowMs: performance.now(),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus()
    }));

    const attackerNames = pairs.map((pair) => initial.players.find((player) => player.playerId === pair.attackerId)?.name);
    if (attackerNames.some((name) => !name)) throw new Error('Ring-out attacker name was missing.');
    for (const name of attackerNames) await expect(match.measured.page.getByLabel(`${name} skoru: 1 knockout`)).toBeVisible();
    await expect(match.measured.page.locator('.game-stage canvas')).toBeVisible();
    const ringOutEffectWindowCompleted = await markAfterAnimationFrames(
      match.measured,
      RING_OUT_EFFECT_SAMPLE_FRAMES
    );

    await expect.poll(() => {
      const events = game.harness.recentEvents(match.code).filter((event) => event.eventId > eventMarker);
      return events.filter((event) => event.type === 'KNOCKOUT' && targetIds.has(event.targetId)).length;
    }, { timeout: 12_000 }).toBe(4);

    const frames = await frameSampler.result;
    const events = game.harness.recentEvents(match.code).filter((event) => event.eventId > eventMarker);
    const hits = events.filter((event): event is Extract<(typeof events)[number], { type: 'HIT' }> =>
      event.type === 'HIT' && targetIds.has(event.targetId));
    const knockouts = events.filter((event): event is Extract<(typeof events)[number], { type: 'KNOCKOUT' }> =>
      event.type === 'KNOCKOUT' && targetIds.has(event.targetId));
    const hitTick = hits[0]?.tick ?? null;
    const knockoutTick = knockouts[0]?.tick ?? null;
    const pulseSpawn = events.find((event): event is Extract<(typeof events)[number], { type: 'PULSE_SPAWN' }> =>
      event.type === 'PULSE_SPAWN' && event.projectileId === livePulse.projectileId);
    const globalMetrics = burstFrameMetrics(frames);
    const correlatedFrames = framesOverlappingInterval(
      frames,
      burstDispatchStarted.nowMs,
      ringOutEffectWindowCompleted.nowMs
    );
    expect(correlatedFrames).not.toHaveLength(0);
    const correlatedMetrics = burstFrameMetrics(correlatedFrames);

    const metrics = {
      browserContexts: 1,
      authoritativePlayers: 8,
      preExistingPulseId: livePulse.projectileId,
      simultaneousHits: hits.length,
      sameTickRingOuts: knockouts.length,
      hitTick,
      knockoutTick,
      burstDispatchStarted,
      burstDispatchFinished,
      ringOutEffectWindowCompleted,
      ringOutEffectSampleFrames: RING_OUT_EFFECT_SAMPLE_FRAMES,
      sampledFrames: frames.length,
      correlatedFrames: correlatedFrames.length,
      correlatedMaxFrameMs: Number(correlatedMetrics.maxFrameMs.toFixed(2)),
      correlatedMaxFrameIndex: correlatedMetrics.maxFrameIndex,
      correlatedSurroundingFrames: correlatedMetrics.surroundingFrames,
      globalMaxFrameMs: Number(globalMetrics.maxFrameMs.toFixed(2)),
      globalMaxFrameIndex: globalMetrics.maxFrameIndex,
      globalP95FrameMs: Number(globalMetrics.p95FrameMs.toFixed(2)),
      globalMedianFps: Number(globalMetrics.medianFps.toFixed(2)),
      globalSurroundingFrames: globalMetrics.surroundingFrames
    };
    testInfo.annotations.push({ type: 'performance', description: JSON.stringify(metrics) });
    console.info(`RING_OUT_BURST_METRICS ${JSON.stringify(metrics)}`);

    expect(hits).toHaveLength(4);
    expect(pulseSpawn).toMatchObject({
      ownerPlayerId: pulseOwnerId,
      projectileId: livePulse.projectileId,
      originatingAttackId: livePulse.originatingAttackId
    });
    expect(pulseSpawn?.tick).toBeLessThan(hitTick ?? Number.NEGATIVE_INFINITY);
    expect(new Set(hits.map((event) => event.tick))).toEqual(new Set([hitTick]));
    expect(hits.every((event) =>
      event.attack === 'QUICK_1' && event.resultingOverload === GAME.maxOverload
    )).toBe(true);
    expect(new Set(hits.map((event) => event.attackerId))).toEqual(new Set(pairs.map((pair) => pair.attackerId)));
    expect(new Set(hits.map((event) => event.targetId))).toEqual(new Set(pairs.map((pair) => pair.targetId)));
    expect(knockouts).toHaveLength(4);
    expect(events.filter((event) => event.type === 'KNOCKOUT')).toHaveLength(4);
    expect(new Set(knockouts.map((event) => event.tick))).toEqual(new Set([knockoutTick]));
    expect(knockoutTick).toBeGreaterThan(hitTick ?? Number.POSITIVE_INFINITY);
    expect(new Set(knockouts.map((event) => event.attackerId))).toEqual(new Set(pairs.map((pair) => pair.attackerId)));
    expect(new Set(knockouts.map((event) => event.targetId))).toEqual(new Set(pairs.map((pair) => pair.targetId)));
    expect(game.harness.matchSnapshot(match.code)?.scores).toMatchObject(
      Object.fromEntries(pairs.map((pair) => [pair.attackerId, 1]))
    );
    expect(events.some((event) => event.type === 'RESULT')).toBe(false);
    expect(burstDispatchStarted.visibilityState).toBe('visible');
    expect(burstDispatchStarted.hasFocus).toBe(true);
    expect(burstDispatchFinished.visibilityState).toBe('visible');
    expect(burstDispatchFinished.hasFocus).toBe(true);
    expect(ringOutEffectWindowCompleted.visibilityState).toBe('visible');
    expect(ringOutEffectWindowCompleted.hasFocus).toBe(true);
    expect(ringOutEffectWindowCompleted.nowMs).toBeGreaterThanOrEqual(burstDispatchStarted.nowMs);
    expect(correlatedFrames.every((frame) => frame.visibilityState === 'visible' && frame.hasFocus)).toBe(true);
    expect(correlatedMetrics.maxFrameMs).toBeLessThan(50);
    expect(companionErrors).toEqual([]);
    await assertNoUnexpectedErrors(game, match.measured);
  } finally {
    if (frameSampler) await frameSampler.stop().catch(() => undefined);
    await Promise.allSettled(frameSampler ? [frameSampler.result] : []);
    for (const companion of match.companions) companion.disconnect();
    await match.measured.context.close();
  }
}, 60_000);

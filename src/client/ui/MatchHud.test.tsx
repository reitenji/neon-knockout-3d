import { FIGHTERS } from '../../shared/fighters.js';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchPlayer, MatchSnapshot } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { GamePresentationBridge } from '../game/GamePresentationBridge.js';
import { ThreeArena } from '../game/ThreeArena.js';
import { MatchHud } from './MatchHud.js';

const idleAction = {
  kind: null, phase: 'IDLE', comboStep: 0, chargeMs: 0, charging: false,
  attackId: null, profileId: null, lockedFacing: null, activeProgress: 0, hitTargetIds: []
} as const;

function player(overrides: Partial<MatchPlayer> = {}): MatchPlayer {
  return {
    playerId: 'p-local',
    name: 'Ada',
    chassis: 'RIFT',
    accent: 0,
    position: { x: 640, y: 360 },
    velocity: { x: 0, y: 0 },
    facing: { x: 1, y: 0 },
    overload: 84,
    lastProcessedInputSeq: 0,
    action: { ...idleAction, chargeMs: 350, charging: true },
    dashRemainingMs: 0,
    dashCooldownRemainingMs: FIGHTERS.RIFT.dashCooldownMs / 2,
    hitstunRemainingMs: 0,
    respawnRemainingMs: 0,
    protectionRemainingMs: 0,
    stats: { knockouts: 2, falls: 1, landedHits: 4, completedAttacks: 6 },
    ...overrides
  };
}

function snapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  const local = player();
  const rival = player({
    playerId: 'p-rival',
    name: 'Linus',
    chassis: 'BASTION',
    accent: 1,
    overload: 22,
    action: idleAction,
    stats: { knockouts: 4, falls: 0, landedHits: 8, completedAttacks: 10 }
  });
  return {
    tick: 12,
    phase: 'COUNTDOWN',
    remainingMs: 2_200,
    platformProgress: 0,
    settings: DEFAULT_ROOM_SETTINGS,
    scores: { 'p-local': 2, 'p-rival': 4 },
    network: {
      'p-local': { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' },
      'p-rival': { currentMs: 48, medianMs: 48, jitterMs: 3, transport: 'websocket' }
    },
    players: [local, rival],
    pulses: [],
    winnerPlayerId: null,
    resultReason: null,
    ...overrides
  };
}

class PresentationBridge implements GamePresentationBridge {
  current: MatchSnapshot | null = snapshot();
  connected = true;
  presentationDelayMs: number | null = null;
  rollbackFrames: number | null = null;
  readonly snapshotListeners = new Set<(value: MatchSnapshot) => void>();
  readonly connectionListeners = new Set<(connected: boolean) => void>();
  readonly presentationDelayListeners = new Set<(delayMs: number | null) => void>();
  readonly rollbackFrameListeners = new Set<(frames: number | null) => void>();

  getSnapshot = (): MatchSnapshot | null => this.current;
  isConnected = (): boolean => this.connected;
  subscribeSnapshot = (listener: (value: MatchSnapshot) => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };
  subscribeConnected = (listener: (connected: boolean) => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  };
  getPresentationDelayMs = (): number | null => this.presentationDelayMs;
  getRollbackFrames = (): number | null => this.rollbackFrames;
  subscribePresentationDelay = (listener: (delayMs: number | null) => void): (() => void) => {
    this.presentationDelayListeners.add(listener);
    return () => this.presentationDelayListeners.delete(listener);
  };
  subscribeRollbackFrames = (listener: (frames: number | null) => void): (() => void) => {
    this.rollbackFrameListeners.add(listener);
    return () => this.rollbackFrameListeners.delete(listener);
  };
  subscribeEvent = (): (() => void) => () => undefined;
  subscribeMuted = (): (() => void) => () => undefined;
  sendInput = (): void => undefined;

  publish(next: MatchSnapshot): void {
    this.current = next;
    for (const listener of this.snapshotListeners) listener(next);
  }

  setConnected(next: boolean): void {
    this.connected = next;
    for (const listener of this.connectionListeners) listener(next);
  }

  setPresentationDelay(next: number | null): void {
    this.presentationDelayMs = next;
    for (const listener of this.presentationDelayListeners) listener(next);
  }

  setRollbackFrames(next: number | null): void {
    this.rollbackFrames = next;
    for (const listener of this.rollbackFrameListeners) listener(next);
  }
}

describe('MatchHud', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('makes countdown, ranking, local combat state, connection, and every control discoverable', () => {
    const bridge = new PresentationBridge();
    render(
      <ThreeArena
        bridge={bridge}
        localPlayerId="p-local"
        createGame={() => ({ destroy() {} })}
        reducedMotion
      />
    );

    expect(screen.getByRole('complementary', { name: 'Maç bilgileri' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Kalan süre' })).toHaveTextContent('00:03');
    expect(screen.getByRole('status', { name: 'Geri sayım' })).toHaveTextContent('3');
    expect(screen.getByLabelText('Kazanma hedefi')).toHaveTextContent('İlk 5 knockout');

    const ranking = screen.getByRole('list', { name: 'Oyuncu sıralaması' });
    const rows = within(ranking).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Linus');
    expect(within(rows[0]).getByLabelText('Linus skoru: 4 knockout')).toHaveTextContent('4');
    expect(rows[1]).toHaveTextContent('AdaSen');
    expect(within(rows[1]).getByLabelText('Ada skoru: 2 knockout')).toHaveTextContent('2');

    expect(screen.getByRole('meter', { name: 'Overload' })).toHaveAttribute('aria-valuenow', '84');
    expect(screen.getByText('84%')).toBeVisible();
    expect(screen.getByRole('meter', { name: 'Dash dolumu' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('ŞARJ 78%')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Bağlantı durumu' })).toHaveTextContent('Bağlı');

    const controls = screen.getByLabelText('Kontroller');
    expect(controls).toHaveTextContent('WASD');
    expect(controls).toHaveTextContent('J');
    expect(controls).toHaveTextContent('K');
    expect(controls).toHaveTextContent('Space');
    expect(controls).not.toHaveTextContent(/oklar|shift|tık|fare|mouse/i);
  });

  it('shows one median Ping value for every player without transport diagnostics', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      players: [
        player(),
        player({ playerId: 'p-rival', name: 'Linus', accent: 1 }),
        player({ playerId: 'p-medium', name: 'Mina', accent: 2 }),
        player({ playerId: 'p-high', name: 'Kerem', accent: 3 })
      ],
      scores: { 'p-local': 2, 'p-rival': 4, 'p-medium': 3, 'p-high': 1 },
      network: {
        'p-local': { currentMs: 16, medianMs: 15, jitterMs: 2, transport: 'websocket' },
        'p-rival': { currentMs: 20, medianMs: 18, jitterMs: 4, transport: 'websocket' },
        'p-medium': { currentMs: 51, medianMs: 42, jitterMs: 12, transport: 'polling' },
        'p-high': { currentMs: 144, medianMs: 109, jitterMs: 30, transport: 'websocket' }
      }
    });

    render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    const roster = screen.getByRole('region', { name: 'Oyuncu listesi' });
    expect(within(roster).getAllByRole('listitem')).toHaveLength(4);
    expect(within(roster).getByText('KO')).toBeVisible();
    expect(within(roster).getByText('PING')).toBeVisible();
    expect(within(roster).queryByText('MEDYAN')).not.toBeInTheDocument();

    const localTelemetry = screen.getByLabelText('Ada ağ telemetrisi: Ping 15 ms');
    expect(within(localTelemetry).getByText('Ping 15 ms')).toBeVisible();
    expect(localTelemetry).toHaveClass('is-good');

    const goodTelemetry = screen.getByLabelText('Linus ağ telemetrisi: Ping 18 ms');
    expect(within(goodTelemetry).getByText('Ping 18 ms')).toBeVisible();
    expect(goodTelemetry).toHaveClass('is-good');

    const mediumTelemetry = screen.getByLabelText('Mina ağ telemetrisi: Ping 42 ms');
    expect(within(mediumTelemetry).getByText('Ping 42 ms')).toBeVisible();
    expect(mediumTelemetry).toHaveClass('is-medium');

    const highTelemetry = screen.getByLabelText('Kerem ağ telemetrisi: Ping 109 ms');
    expect(within(highTelemetry).getByText('Ping 109 ms')).toBeVisible();
    expect(highTelemetry).toHaveClass('is-high');
    const pendingTelemetry = screen.getByLabelText('Ada ağ telemetrisi: Ping 15 ms');
    expect(pendingTelemetry).not.toHaveTextContent('—');
    expect(roster).not.toHaveTextContent(/RTT|Delay|Rollback|\bRB\b/);
    expect(screen.getByLabelText('Linus skoru: 4 knockout')).toBeVisible();
  });

  it('uses only median Ping for threshold styling and shows an em dash when it is unavailable', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      network: {
        'p-local': { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' },
        'p-rival': { currentMs: 2_000, medianMs: 18, jitterMs: 4, transport: 'websocket' }
      }
    });

    render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    const telemetry = screen.getByLabelText('Linus ağ telemetrisi: Ping 18 ms');
    expect(telemetry).toHaveClass('is-good');
    const pending = screen.getByLabelText('Ada ağ telemetrisi: Ping —');
    expect(pending).toHaveTextContent('Ping —');
    expect(pending).toHaveClass('is-pending');
  });

  it('shows the same player Ping values to every client and never renders bridge diagnostics', () => {
    const sharedSnapshot = snapshot({
      network: {
        'p-local': { currentMs: 47, medianMs: 42, jitterMs: 6, transport: 'polling' },
        'p-rival': { currentMs: 21, medianMs: 18, jitterMs: 4, transport: 'websocket' }
      }
    });
    const adaBridge = new PresentationBridge();
    adaBridge.current = sharedSnapshot;
    adaBridge.setPresentationDelay(16);
    adaBridge.setRollbackFrames(3);
    const linusBridge = new PresentationBridge();
    linusBridge.current = sharedSnapshot;
    linusBridge.setPresentationDelay(40);
    linusBridge.setRollbackFrames(1);

    const adaClient = render(<MatchHud bridge={adaBridge} localPlayerId="p-local" />);
    const linusClient = render(<MatchHud bridge={linusBridge} localPlayerId="p-rival" />);

    expect(within(adaClient.container).getByLabelText('Ada ağ telemetrisi: Ping 42 ms')).toBeVisible();
    expect(within(adaClient.container).getByLabelText('Linus ağ telemetrisi: Ping 18 ms')).toBeVisible();
    expect(adaClient.container).not.toHaveTextContent(/RTT|Delay|Rollback|\bRB\b/);
    expect(within(adaClient.container).queryByRole('status', { name: 'Sunum arabelleği' })).not.toBeInTheDocument();

    expect(within(linusClient.container).getByLabelText('Linus ağ telemetrisi: Ping 18 ms')).toBeVisible();
    expect(within(linusClient.container).getByLabelText('Ada ağ telemetrisi: Ping 42 ms')).toBeVisible();
    expect(linusClient.container).not.toHaveTextContent(/RTT|Delay|Rollback|\bRB\b/);
    expect(within(linusClient.container).queryByRole('status', { name: 'Sunum arabelleği' })).not.toBeInTheDocument();
  });

  it('shows exact charge readiness and the authoritative 78-second contraction warning', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      phase: 'REGULATION',
      remainingMs: 78_000,
      settings: DEFAULT_ROOM_SETTINGS,
      players: [player({ action: { ...idleAction, chargeMs: 700, charging: true } })]
    });

    render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    expect(screen.getByRole('status', { name: 'Aksiyon durumu' })).toHaveTextContent('PULSE READY');
    expect(screen.getByRole('status', { name: 'Arena daralma uyarısı' })).toHaveTextContent('ARENA DARALIYOR');
  });

  it('derives the knockout label and contraction warning from each match settings snapshot', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      phase: 'REGULATION',
      remainingMs: 58_501,
      settings: { durationMs: 90_000, knockoutTarget: 3 }
    });

    render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    expect(screen.getByLabelText('Kazanma hedefi')).toHaveTextContent('İlk 3 knockout');
    expect(screen.queryByRole('status', { name: 'Arena daralma uyarısı' })).not.toBeInTheDocument();

    act(() => bridge.publish(snapshot({
      phase: 'REGULATION',
      remainingMs: 58_500,
      settings: { durationMs: 90_000, knockoutTarget: 3 }
    })));
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole('status', { name: 'Arena daralma uyarısı' })).toBeVisible();

    act(() => bridge.publish(snapshot({
      phase: 'REGULATION',
      remainingMs: 117_001,
      settings: { durationMs: 180_000, knockoutTarget: 10 }
    })));
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByLabelText('Kazanma hedefi')).toHaveTextContent('İlk 10 knockout');
    expect(screen.queryByRole('status', { name: 'Arena daralma uyarısı' })).not.toBeInTheDocument();

    act(() => bridge.publish(snapshot({
      phase: 'REGULATION',
      remainingMs: 117_000,
      settings: { durationMs: 180_000, knockoutTarget: 10 }
    })));
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole('status', { name: 'Arena daralma uyarısı' })).toBeVisible();
  });

  it('tracks live phase, combat, and connection changes without remounting the arena', () => {
    const bridge = new PresentationBridge();
    const createGame = vi.fn(() => ({ destroy() {} }));
    const view = render(
      <ThreeArena bridge={bridge} localPlayerId="p-local" createGame={createGame} reducedMotion />
    );

    act(() => bridge.publish(snapshot({
      phase: 'REGULATION',
      remainingMs: 119_650,
      players: [player({ action: idleAction, overload: 120, dashCooldownRemainingMs: 0 })],
      scores: { 'p-local': 3 },
      network: { 'p-local': { currentMs: 132, medianMs: 109, jitterMs: 18, transport: 'polling' } }
    })));

    expect(screen.getByRole('status', { name: 'Raunt başlangıcı' })).toHaveTextContent('FIGHT');
    expect(screen.getByRole('timer', { name: 'Kalan süre' })).toHaveTextContent('02:00');
    expect(screen.getByText('Hazır')).toBeVisible();
    expect(screen.getByText('Beklemede')).toBeVisible();
    expect(screen.getByLabelText('Ada ağ telemetrisi: Ping 109 ms')).toBeVisible();
    expect(createGame).toHaveBeenCalledOnce();

    act(() => bridge.setConnected(false));
    expect(screen.getByRole('status', { name: 'Bağlantı durumu' })).toHaveTextContent('Bağlantı kesildi');

    view.unmount();
    expect(bridge.snapshotListeners).toHaveLength(0);
    expect(bridge.connectionListeners).toHaveLength(0);
  });

  it('paces combat-only HUD snapshots while applying connection changes immediately', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      phase: 'REGULATION',
      remainingMs: 90_000,
      players: [player({ overload: 20 })],
      scores: { 'p-local': 0 }
    });
    render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    expect(screen.getByRole('meter', { name: 'Overload' })).toHaveAttribute('aria-valuenow', '20');
    act(() => bridge.publish(snapshot({
      tick: 13,
      phase: 'REGULATION',
      remainingMs: 89_983,
      players: [player({ overload: 80 })],
      scores: { 'p-local': 0 }
    })));
    expect(screen.getByRole('meter', { name: 'Overload' })).toHaveAttribute('aria-valuenow', '20');

    act(() => bridge.setConnected(false));
    expect(screen.getByRole('status', { name: 'Bağlantı durumu' })).toHaveTextContent('Bağlantı kesildi');

    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole('meter', { name: 'Overload' })).toHaveAttribute('aria-valuenow', '80');
  });

  it('shows the short authoritative respawn wait without making the knockout feel longer', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({
      phase: 'REGULATION',
      remainingMs: 90_000,
      players: [player({
        action: { ...idleAction, kind: 'RESPAWNING' },
        respawnRemainingMs: 650
      })]
    });

    render(<ThreeArena bridge={bridge} localPlayerId="p-local" createGame={() => ({ destroy() {} })} reducedMotion />);

    expect(screen.getByRole('status', { name: 'Aksiyon durumu' })).toHaveTextContent('Geri dönüş 0.7 sn');
  });

  it('shows sudden death once for 1100ms despite repeated snapshots while retaining the phase header', () => {
    const bridge = new PresentationBridge();
    render(
      <ThreeArena bridge={bridge} localPlayerId="p-local" createGame={() => ({ destroy() {} })} reducedMotion />
    );

    act(() => bridge.publish(snapshot({ phase: 'REGULATION', remainingMs: 90_000 })));
    expect(screen.queryByRole('status', { name: 'Raunt durumu' })).not.toBeInTheDocument();

    act(() => bridge.publish(snapshot({ phase: 'SUDDEN_DEATH', remainingMs: 30_000 })));
    const announcement = screen.getByRole('status', { name: 'Raunt durumu' });
    expect(announcement).toHaveTextContent('SON VURUŞ');
    expect(announcement).toHaveClass('match-hud__announcement--sudden-death');
    expect(announcement.closest('.match-hud__announcement-slot')).toBeInTheDocument();

    act(() => bridge.publish(snapshot({ phase: 'SUDDEN_DEATH', remainingMs: 29_500 })));
    act(() => vi.advanceTimersByTime(1_099));
    expect(screen.getByRole('status', { name: 'Raunt durumu' })).toHaveTextContent('SON VURUŞ');

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status', { name: 'Raunt durumu' })).not.toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Kalan süre' }).closest('header')).toHaveTextContent('SON VURUŞ');
  });

  it('keeps paused announcements persistent and clears a pending sudden-death timeout on unmount', () => {
    const bridge = new PresentationBridge();
    bridge.current = snapshot({ phase: 'PAUSED', remainingMs: 30_000 });
    const pausedView = render(<MatchHud bridge={bridge} localPlayerId="p-local" />);

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('status', { name: 'Raunt durumu' })).toHaveTextContent('BEKLE');
    pausedView.unmount();

    bridge.current = snapshot({ phase: 'REGULATION', remainingMs: 90_000 });
    const suddenDeathView = render(<MatchHud bridge={bridge} localPlayerId="p-local" />);
    act(() => bridge.publish(snapshot({ phase: 'SUDDEN_DEATH', remainingMs: 30_000 })));
    expect(vi.getTimerCount()).toBe(1);

    suddenDeathView.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.runOnlyPendingTimers());
  });
});

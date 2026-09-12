import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomPlayer, RoomState } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { ClientState } from '../state/gameStore.js';
import { LobbyScreen } from './LobbyScreen.js';

function player(overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    role: 'FIGHTER', botDifficulty: null,
    playerId: 'player-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
    reconnectRemainingMs: null,
    stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 },
    ...overrides
  };
}
function room(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: 'AB2Z', phase: 'LOBBY', hostPlayerId: 'player-1', pauseRemainingMs: null, result: null,
    settings: DEFAULT_ROOM_SETTINGS,
    players: [player(), player({ role: 'FIGHTER', botDifficulty: null, playerId: 'player-2', name: 'Linus', chassis: 'BASTION', accent: 1, ready: true })],
    ...overrides
  };
}
function state(overrides: Partial<ClientState> = {}): ClientState {
  return {
    screen: 'LOBBY', connectionState: 'connected', room: room(), match: null,
    session: { playerId: 'player-1', roomCode: 'AB2Z', resumeToken: 'a'.repeat(64) },
    pendingAction: null, lastError: null, errorAction: null, copyFeedback: 'idle', toasts: [],
    soundMuted: false, reconnectRemainingMs: null, ...overrides
  };
}
function renderLobby(clientState = state(), handlers: Partial<Parameters<typeof LobbyScreen>[0]> = {}) {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
  const props: Parameters<typeof LobbyScreen>[0] = {
    state: clientState,
    onSetRole: vi.fn(async () => undefined),
    onAddBot: vi.fn(async () => undefined),
    onUpdateBot: vi.fn(async () => undefined),
    onRemoveBot: vi.fn(async () => undefined),
    onSetChassis: vi.fn(async () => undefined),
    onToggleReady: vi.fn(async () => undefined),
    onSetRoomSettings: vi.fn(async () => undefined),
    onStart: vi.fn(async () => undefined),
    onCopyRoomCode: vi.fn(async () => undefined),
    ...handlers
  };
  return { ...render(<LobbyScreen {...props} />), props };
}

describe('LobbyScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renders four meaningful chassis silhouette buttons and no grouped color columns', () => {
    renderLobby();
    for (const chassis of ['RIFT', 'BASTION', 'PULSE', 'WRAITH']) {
      const button = screen.getByRole('button', { name: `${chassis} gövdesini seç` });
      expect(button.querySelector('.chassis-silhouette')).not.toBeNull();
    }
    expect(screen.queryByRole('heading', { name: /Camgöbeği/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Kehribar/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Maçı Başlat' })).toBeDisabled();
  });

  it('requests a chassis change without changing canonical ready presentation', () => {
    const onSetChassis = vi.fn(async () => undefined);
    renderLobby(state({ room: room({ players: [player({ ready: true }), player({ playerId: 'player-2', ready: true })] }) }), { onSetChassis });
    fireEvent.click(screen.getByRole('button', { name: 'PULSE gövdesini seç' }));
    expect(onSetChassis).toHaveBeenCalledWith('PULSE');
    expect(screen.getByRole('button', { name: 'Hazır Değilim' })).toBeVisible();
  });

  it('shows player identity, host, connection reservation, chassis, accent, and ready state', () => {
    renderLobby(state({
      room: room({ players: [
        player({ ready: true }),
        player({ playerId: 'player-2', name: 'Linus', chassis: 'WRAITH', accent: 4, connected: false, reconnectRemainingMs: 8_000 })
      ] })
    }));
    expect(screen.getByLabelText('Oda sahibi')).toBeVisible();
    expect(screen.getByText('Bağlantı bekleniyor')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Oyuncular' })).getByText('WRAITH')).toBeVisible();
    expect(screen.getAllByText('Hazır')).not.toHaveLength(0);
  });

  it('shows host start only when all connected players are ready', () => {
    const readyRoom = room({ players: [player({ ready: true }), player({ playerId: 'player-2', ready: true })] });
    renderLobby(state({ room: readyRoom }));
    expect(screen.getByRole('button', { name: 'Maçı Başlat' })).toBeEnabled();
    cleanup();
    renderLobby(state({ room: { ...readyRoom, hostPlayerId: 'player-2' } }));
    expect(screen.queryByRole('button', { name: 'Maçı Başlat' })).toBeNull();
  });

  it('shows LAN sharing only to the room host while keeping the room code primary', () => {
    renderLobby();
    expect(screen.getByTestId('room-code')).toHaveTextContent('AB2Z');
    expect(screen.getByRole('complementary', { name: 'LAN bağlantısı' })).toBeVisible();
    cleanup();

    renderLobby(state({ room: room({ hostPlayerId: 'player-2' }) }));
    expect(screen.getByTestId('room-code')).toHaveTextContent('AB2Z');
    expect(screen.queryByRole('complementary', { name: 'LAN bağlantısı' })).toBeNull();
  });

  it('shows the authoritative room settings as enabled native selects for the host', () => {
    renderLobby(state({
      room: room({ settings: { durationMs: 120_000, knockoutTarget: 5 } })
    }));

    const duration = screen.getByRole('combobox', { name: 'Maç süresi' });
    const target = screen.getByRole('combobox', { name: 'Kazanma hedefi' });
    expect(duration).toBeEnabled();
    expect(duration).toHaveValue('120000');
    expect(Array.from((duration as HTMLSelectElement).options, (option) => option.text)).toEqual([
      '90 sn', '2 dk', '3 dk'
    ]);
    expect(target).toBeEnabled();
    expect(target).toHaveValue('5');
    expect(Array.from((target as HTMLSelectElement).options, (option) => option.text)).toEqual([
      '3 knockout', '5 knockout', '7 knockout', '10 knockout'
    ]);
  });

  it('submits a complete authoritative settings pair for each host change', () => {
    const onSetRoomSettings = vi.fn(async () => undefined);
    renderLobby(state(), { onSetRoomSettings });
    fireEvent.change(screen.getByLabelText('Maç süresi'), { target: { value: '90000' } });
    expect(onSetRoomSettings).toHaveBeenCalledWith({ durationMs: 90_000, knockoutTarget: 5 });
    fireEvent.change(screen.getByLabelText('Kazanma hedefi'), { target: { value: '7' } });
    expect(onSetRoomSettings).toHaveBeenNthCalledWith(2, { durationMs: 120_000, knockoutTarget: 7 });
  });

  it('keeps the authoritative room settings visible but read-only for guests', () => {
    renderLobby(state({
      room: room({
        hostPlayerId: 'player-2',
        settings: { durationMs: 180_000, knockoutTarget: 10 }
      })
    }));

    expect(screen.getByLabelText('Maç süresi')).toHaveValue('180000');
    expect(screen.getByLabelText('Maç süresi')).toBeDisabled();
    expect(screen.getByLabelText('Kazanma hedefi')).toHaveValue('10');
    expect(screen.getByLabelText('Kazanma hedefi')).toBeDisabled();
  });

  it.each([
    ['settings', 'true'],
    ['ready', 'false']
  ] as const)('disables room settings while %s is pending', (pendingAction, ariaBusy) => {
    renderLobby(state({ pendingAction }));

    expect(screen.getByRole('group', { name: 'Oda Ayarları' })).toHaveAttribute('aria-busy', ariaBusy);
    expect(screen.getByLabelText('Maç süresi')).toBeDisabled();
    expect(screen.getByLabelText('Kazanma hedefi')).toBeDisabled();
  });

  it('disables room settings when the session player is missing from the roster', () => {
    renderLobby(state({ room: room({ players: [player({ playerId: 'player-2' })] }) }));

    expect(screen.getByLabelText('Maç süresi')).toBeDisabled();
    expect(screen.getByLabelText('Kazanma hedefi')).toBeDisabled();
  });

  it('shows a recoverable room settings failure in the lobby error surface', () => {
    renderLobby(state({
      lastError: { code: 'INVALID_SETTINGS', message: 'Oda ayarları geçersiz.', recoverable: true },
      errorAction: 'settings'
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('Oda ayarları geçersiz.');
  });

  it('shows copy feedback and adjacent chassis rejection without mutating the room code', () => {
    const onCopyRoomCode = vi.fn(async () => undefined);
    renderLobby(state({
      copyFeedback: 'copied',
      lastError: { code: 'INVALID_CHASSIS', message: 'Gövde seçimi geçersiz.', recoverable: true },
      errorAction: 'chassis'
    }), { onCopyRoomCode });
    const copy = screen.getByRole('button', { name: 'Kodu Kopyala' });
    expect(screen.getByTestId('room-code')).toHaveTextContent('AB2Z');
    expect(copy).toHaveTextContent('✓');
    expect(screen.getByRole('alert')).toHaveTextContent('Gövde seçimi geçersiz.');
    fireEvent.click(copy);
    expect(onCopyRoomCode).toHaveBeenCalledOnce();
  });
});


describe('Sites room invitations', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('copies the full invite URL for a guest when native sharing is unavailable', async () => {
    vi.stubEnv('MODE', 'sites');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderLobby(state({ room: room({ hostPlayerId: 'player-2' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Oda Linkini Paylaş' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Link kopyalandı');
    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/room/AB2Z');
  });

  it('shares the invite URL through the device share menu', async () => {
    vi.stubEnv('MODE', 'sites');
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { share });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Oda Linkini Paylaş' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Paylaşım tamamlandı');
    expect(share).toHaveBeenCalledWith({ title: 'Neon Knockout 3D', url: 'http://localhost:3000/room/AB2Z' });
  });

  it('leaves the link selectable when clipboard access fails', async () => {
    vi.stubEnv('MODE', 'sites');
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Oda Linkini Paylaş' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/linki seçip kopyalayabilirsin/i);
    expect(screen.getByRole('textbox', { name: 'Oda linki' })).toHaveValue('http://localhost:3000/room/AB2Z');
  });

  it('does not copy or claim success when the share menu is cancelled', async () => {
    vi.stubEnv('MODE', 'sites');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText }, share: async () => { throw new DOMException('cancelled', 'AbortError'); } });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Oda Linkini Paylaş' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Paylaşım iptal edildi');
    expect(writeText).not.toHaveBeenCalled();
  });
});

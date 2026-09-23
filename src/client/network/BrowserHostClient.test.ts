import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./browserIdentity.js', () => ({ browserIdentity: async () => 'b'.repeat(32) }));
import { createBrowserHostClient } from './BrowserHostClient.js';
import { HostRuntime, LOCAL_HOST, type HostCommand } from './browserHost/HostRuntime.js';
import { createGameStore } from '../state/gameStore.js';

vi.mock('./browserHost/PeerLink.js', async importOriginal => ({
  ...await importOriginal<typeof import('./browserHost/PeerLink.js')>(),
  description: async () => 'local description',
  signal: async () => ({id: 'peer', answer: 'remote description'}),
  waitForChannel: async () => {}
}));
afterEach(() => vi.unstubAllGlobals());

it('creates another visible room after leaving the previous hosted room', async () => {
  const client = createBrowserHostClient();
  const storage = new Map<string, string>();
  const game = createGameStore({client, storage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: key => { storage.delete(key); }
  }, clipboard: {writeText: async () => {}}});
  try {
    game.actions.connect();
    await game.actions.createRoom('First');
    await vi.waitFor(() => expect(game.getSnapshot().screen).toBe('LOBBY'));
    await game.actions.leaveRoom();
    expect(game.getSnapshot().screen).toBe('LANDING');
    await game.actions.createRoom('Second');
    await vi.waitFor(() => expect(game.getSnapshot().screen).toBe('LOBBY'));
  } finally { client.disconnect(); }
});

it.each(['LOBBY', 'MATCH'] as const)('synchronizes a new guest directly into %s after its welcome', async screen => {
  let onmessage: ((message: {data: string}) => void) | null = null;
  const host = new HostRuntime((connection, event) => {
    if (connection === 'peer') onmessage?.({data: JSON.stringify(event)});
  });
  const created = host.create('Owner');
  if (!created.ok) throw new Error('Host creation failed');
  if (screen === 'MATCH') {
    host.handle(LOCAL_HOST, 'role', {role: 'SPECTATOR'});
    for (let i = 0; i < 2; i++) host.handle(LOCAL_HOST, 'addBot', {chassis: 'RIFT', difficulty: 'NORMAL'});
    expect(host.handle(LOCAL_HOST, 'start', {})).toMatchObject({ok: true});
    host.advance(50);
  }
  vi.stubGlobal('RTCPeerConnection', class {
    createDataChannel() {
      return {
        readyState: 'open', bufferedAmount: 0,
        set onmessage(callback: typeof onmessage) { onmessage = callback; },
        send(data: string) {
          const request = JSON.parse(data) as {id: number; command: HostCommand; payload: unknown};
          const ack = host.handle('peer', request.command, request.payload);
          onmessage?.({data: JSON.stringify({id: request.id, ack})});
        }
      };
    }
    async setRemoteDescription() {}
    close() {}
  });
  const storage = new Map<string, string>();
  const client = createBrowserHostClient();
  const game = createGameStore({client, storage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: key => { storage.delete(key); }
  }, clipboard: {writeText: async () => {}}});
  game.actions.connect();
  await game.actions.joinRoom('Guest', created.data.roomCode, screen === 'MATCH' ? 'SPECTATOR' : 'FIGHTER');
  await vi.waitFor(() => expect(game.getSnapshot()).toMatchObject({screen, room: {roomCode: created.data.roomCode}}));
  if (screen === 'MATCH') expect(game.getLatestMatch()?.players).toHaveLength(2);
  if (screen === 'LOBBY') {
    await game.actions.leaveRoom();
    await game.actions.joinRoom('Guest again', created.data.roomCode);
    await vi.waitFor(() => expect(game.getSnapshot().screen).toBe('LOBBY'));
  }
  const guestId = game.getSnapshot().session!.playerId;
  expect(host.handle(LOCAL_HOST, 'kick', { playerId: guestId })).toMatchObject({ ok: true });
  expect(game.getSnapshot()).toMatchObject({ screen: 'LANDING', session: null, room: null });
  expect([...storage.keys()].some(key => key.endsWith(':resume'))).toBe(false);
  expect(game.getSnapshot().toasts.at(-1)?.message).toContain('çıkardı');
  await game.actions.createRoom('New host');
  await vi.waitFor(() => expect(game.getSnapshot().screen).toBe('LOBBY'));
  client.disconnect();
});

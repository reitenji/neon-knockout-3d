import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RoomManager, type RoomPublication } from './roomManager.js';

function setup() {
  let now = 1000;
  const events: RoomPublication[] = [];
  const rooms = new RoomManager({ now: () => now, randomBytes, publish: event => events.push(event) });
  const host = rooms.createRoom('host', 'Owner');
  const guest = rooms.joinRoom('guest', host.roomCode, 'Guest');
  const state = () => events.filter(e => e.type === 'ROOM_STATE').at(-1)!.state;
  return { rooms, host, guest, state, advance: () => { now += 1000; } };
}

describe('lobby chat and host removal', () => {
  it('uses authoritative identity, trims text, bounds history and throttles messages', () => {
    const s = setup();
    s.rooms.sendChat('guest', '  Merhaba  ');
    expect(s.state().chatMessages).toEqual([{ id: 1, playerId: s.guest.playerId, name: 'Guest', text: 'Merhaba', sentAt: 1000 }]);
    expect(() => s.rooms.sendChat('guest', 'again')).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }));
    expect(() => s.rooms.sendChat('stranger', 'hello')).toThrow();
    s.advance();
    expect(() => s.rooms.sendChat('guest', ' '.repeat(3))).toThrow();
    expect(() => s.rooms.sendChat('guest', 'x'.repeat(241))).toThrow();
    for (let i = 0; i < 55; i++) { s.advance(); s.rooms.sendChat('guest', `message ${i}`); }
    expect(s.state().chatMessages).toHaveLength(50);
    expect(s.state().chatMessages.at(-1)?.text).toBe('message 54');
  });
  it('allows spectators to chat but rejects chat after the match starts', () => {
    const s = setup();
    s.rooms.joinRoom('watcher', s.host.roomCode, 'Watcher', 'SPECTATOR');
    s.rooms.sendChat('watcher', '<script>hello</script>');
    expect(s.state().chatMessages[0]?.name).toBe('Watcher');
    s.rooms.setReady('host', true); s.rooms.setReady('guest', true); s.rooms.startMatch('host');
    expect(() => s.rooms.sendChat('guest', 'hello')).toThrow();
  });
  it('keeps room chat available in results and preserves history on return to lobby', () => {
    const s = setup();
    s.rooms.sendChat('host', 'Başlayalım');
    s.rooms.setRoomSettings('host', { durationMs: 180000, knockoutTarget: 3 });
    s.rooms.setReady('host', true); s.rooms.setReady('guest', true); s.rooms.startMatch('host');
    for (let i = 0; i < 50; i++) s.rooms.advance(250);
    expect(() => s.rooms.sendChat('guest', 'Oyun sürüyor')).toThrow();
    for (let score = 0; score < 3; score++) {
      s.rooms.forceKnockout(s.host.roomCode, s.host.playerId, s.guest.playerId);
      for (let i = 0; i < 30; i++) s.rooms.advance(250);
    }
    expect(s.state().phase).toBe('RESULT');
    s.rooms.setResultReady('guest', true);
    s.rooms.sendChat('guest', 'İyi oyundu');
    expect(s.state().players.find(p => p.playerId === s.guest.playerId)?.ready).toBe(true);
    expect(s.state().chatMessages.map(m => m.text)).toEqual(['Başlayalım', 'İyi oyundu']);
    s.rooms.returnToLobby('host');
    expect(s.state().chatMessages.map(m => m.text)).toEqual(['Başlayalım', 'İyi oyundu']);
  });
  it('rejects guests, self-removal and targets in another room; revokes kicked sessions', () => {
    const s = setup();
    const other = s.rooms.createRoom('other', 'Other');
    expect(() => s.rooms.kickPlayer('guest', s.host.playerId)).toThrow();
    expect(() => s.rooms.kickPlayer('host', s.host.playerId)).toThrow();
    expect(() => s.rooms.kickPlayer('host', other.playerId)).toThrow();
    expect(s.rooms.kickPlayer('host', s.guest.playerId)).toEqual({ connectionId: 'guest', roomCode: s.host.roomCode });
    expect(s.rooms.debugRoom(s.host.roomCode)?.playerIds).toEqual([s.host.playerId]);
    expect(() => s.rooms.resume('new', s.host.roomCode, s.guest.resumeToken)).toThrow();
    expect(() => s.rooms.sendChat('guest', 'hello')).toThrow();
  });
  it('removes disconnected reservations and reconciles an active match', () => {
    const s = setup();
    s.rooms.setReady('host', true); s.rooms.setReady('guest', true); s.rooms.startMatch('host');
    s.rooms.disconnect('guest');
    expect(s.rooms.kickPlayer('host', s.guest.playerId).connectionId).toBeNull();
    expect(s.rooms.debugRoom(s.host.roomCode)?.playerIds).toEqual([s.host.playerId]);
    expect(() => s.rooms.resume('new', s.host.roomCode, s.guest.resumeToken)).toThrow();
  });
});

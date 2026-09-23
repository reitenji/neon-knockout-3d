import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { RoomManager } from './roomManager.js';

const browserA = 'a'.repeat(32), browserB = 'b'.repeat(32);
function setup() {
  const rooms = new RoomManager({ now: Date.now, randomBytes, publish: () => {} });
  const host = rooms.createRoom('host', 'Owner', browserA);
  return { rooms, host };
}
it('rejects another name or spectator from the same browser without disturbing the first player', () => {
  const { rooms, host } = setup();
  for (const role of ['FIGHTER', 'SPECTATOR'] as const) {
    expect(() => rooms.joinRoom('tab-2', host.roomCode, 'Other name', role, browserA)).toThrow(expect.objectContaining({ code: 'BROWSER_ALREADY_IN_ROOM' }));
  }
  expect(rooms.debugRoom(host.roomCode)?.playerIds).toEqual([host.playerId]);
  const guest = rooms.joinRoom('guest', host.roomCode, 'Guest', 'FIGHTER', browserB);
  expect(() => rooms.joinRoom('tab-3', host.roomCode, 'Third', 'FIGHTER', browserB)).toThrow();
  expect(rooms.debugRoom(host.roomCode)?.playerIds).toEqual([host.playerId, guest.playerId]);
});
it('reuses the disconnected player instead of creating a second identity and allows rejoining after leaving', () => {
  const { rooms, host } = setup();
  const guest = rooms.joinRoom('guest', host.roomCode, 'Guest', 'FIGHTER', browserB);
  rooms.disconnect('guest');
  const resumed = rooms.joinRoom('new-tab', host.roomCode, 'Changed', 'SPECTATOR', browserB);
  expect(resumed).toEqual({ ...guest, resumed: true });
  expect(rooms.debugRoom(host.roomCode)?.playerIds).toHaveLength(2);
  rooms.leaveRoom('new-tab');
  expect(rooms.joinRoom('rejoin', host.roomCode, 'New name', 'FIGHTER', browserB).resumed).toBe(false);
});
it('scopes the membership rule to each room', () => {
  const { rooms, host } = setup();
  const other = rooms.createRoom('other', 'Other', browserB);
  expect(rooms.joinRoom('tab-2', other.roomCode, 'Owner', 'FIGHTER', browserA).roomCode).toBe(other.roomCode);
  expect(rooms.debugRoom(host.roomCode)?.playerIds).toEqual([host.playerId]);
});

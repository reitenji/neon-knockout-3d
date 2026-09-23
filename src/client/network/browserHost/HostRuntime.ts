import { z } from 'zod';
import { RoomManager, type RoomPublication } from '../../../server/rooms/roomManager.js';
import { DomainError } from '../../../server/rooms/domainError.js';
import type { Ack, ServerError, SessionWelcome } from '../../../shared/model.js';
import * as protocol from '../../../shared/protocol.js';
import { RTT_SAMPLE_LIMIT } from '../../../shared/gameplayTransport.js';

const payloads = {
  chat: protocol.lobbyChatSchema, kick: protocol.roomKickSchema,
  join: protocol.roomJoinSchema, resume: protocol.sessionResumeSchema,
  role: protocol.lobbyRoleSchema, addBot: protocol.lobbyBotAddSchema, updateBot: protocol.lobbyBotUpdateSchema,
  removeBot: protocol.lobbyBotRemoveSchema, chassis: protocol.lobbyChassisSchema, ready: protocol.lobbyReadySchema,
  settings: protocol.lobbySettingsSchema, start: protocol.matchStartSchema, input: protocol.matchInputSchema,
  resultReady: protocol.resultReadySchema, lobby: protocol.resultLobbySchema, leave: protocol.roomLeaveSchema,
  pong: z.object({ nonce: z.number().int().positive() }).strict()
} as const;
export type HostCommand = keyof typeof payloads;
export type HostEvent = { event: 'room:kicked' | 'room:state' | 'match:started' | 'match:snapshot' | 'match:event' | 'server:error' | 'network:probe'; data: unknown };
export const LOCAL_HOST = 'local-host';
export const requestSchema = z.object({ id: z.number().int().nonnegative(), command: z.enum(Object.keys(payloads) as [HostCommand, ...HostCommand[]]), payload: z.unknown() }).strict();
const failure = (code: string, message: string): Ack<never> => ({ ok: false, error: { code, message, recoverable: true } });
type PeerTiming = { pending: { nonce: number; sentAt: number } | null; nextAt: number; samples: number[] };
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The browser owner runs the same authoritative room rules as the Node LAN server. */
export class HostRuntime {
  readonly rooms: RoomManager;
  private members = new Set<string>();
  private latestRoom: Extract<RoomPublication, { type: 'ROOM_STATE' }> | null = null;
  private code: string | null = null;
  private timings = new Map<string, PeerTiming>();
  private probeNonce = 0;

  constructor(private readonly send: (connection: string, event: HostEvent) => void) {
    this.rooms = new RoomManager({ now: () => Date.now(), randomBytes: size => crypto.getRandomValues(new Uint8Array(size)), publish: event => this.publish(event) });
  }

  create(name: string, browserId?: string): Ack<SessionWelcome> {
    try {
      if (this.code) return failure('ALREADY_IN_ROOM', 'Zaten bir odadasın.');
      const parsed = protocol.roomCreateSchema.safeParse({ name, browserId });
      if (!parsed.success) return failure('INVALID_PAYLOAD', 'Oyuncu adı geçersiz.');
      const welcome = this.rooms.createRoom(LOCAL_HOST, parsed.data.name, parsed.data.browserId);
      this.code = welcome.roomCode; this.members.add(LOCAL_HOST); this.sync(LOCAL_HOST);
      this.rooms.setTransport(LOCAL_HOST, 'webrtc');
      return { ok: true, data: welcome };
    } catch (error) { return this.error(error); }
  }

  handle(connection: string, command: HostCommand, payload: unknown): Ack<SessionWelcome | null> {
    try {
      const parsed = payloads[command]?.safeParse(payload);
      if (!parsed?.success) return failure('INVALID_PAYLOAD', 'İstek biçimi geçersiz.');
      if (!this.code) return failure('ROOM_NOT_FOUND', 'Oda sahibi odayı kapattı.');
      if (!this.members.has(connection) && command !== 'join' && command !== 'resume') return failure('NOT_IN_ROOM', 'Önce odaya katıl.');
      if (command === 'join' || command === 'resume') {
        if (connection === LOCAL_HOST) return failure('ALREADY_IN_ROOM', 'Zaten bir odadasın.');
        const welcome = command === 'join'
          ? (() => { const p = protocol.roomJoinSchema.parse(payload); return this.rooms.joinRoom(connection, p.roomCode, p.name, p.role, p.browserId); })()
          : (() => { const p = protocol.sessionResumeSchema.parse(payload); return this.rooms.resume(connection, p.roomCode, p.resumeToken, 'webrtc'); })();
        this.members.add(connection); this.rooms.setTransport(connection, 'webrtc'); this.sync(connection);
        this.timings.set(connection, { pending: null, nextAt: 0, samples: [] });
        return { ok: true, data: welcome };
      }
      switch (command) {
        case 'chat': this.rooms.sendChat(connection, protocol.lobbyChatSchema.parse(payload).text); break;
        case 'kick': {
          const target = this.rooms.kickPlayer(connection, protocol.roomKickSchema.parse(payload).playerId);
          if (target.connectionId) {
            this.members.delete(target.connectionId); this.timings.delete(target.connectionId);
            this.send(target.connectionId, { event: 'room:kicked', data: { roomCode: target.roomCode } });
          }
          break;
        }
        case 'role': this.rooms.setRole(connection, protocol.lobbyRoleSchema.parse(payload).role); break;
        case 'addBot': { const p = protocol.lobbyBotAddSchema.parse(payload); this.rooms.addBot(connection, p.chassis, p.difficulty); break; }
        case 'updateBot': { const p = protocol.lobbyBotUpdateSchema.parse(payload); this.rooms.updateBot(connection, p.playerId, p.chassis, p.difficulty); break; }
        case 'removeBot': this.rooms.removeBot(connection, protocol.lobbyBotRemoveSchema.parse(payload).playerId); break;
        case 'chassis': this.rooms.setChassis(connection, protocol.lobbyChassisSchema.parse(payload).chassis); break;
        case 'ready': this.rooms.setReady(connection, protocol.lobbyReadySchema.parse(payload).ready); break;
        case 'settings': this.rooms.setRoomSettings(connection, protocol.lobbySettingsSchema.parse(payload)); break;
        case 'start': this.rooms.startMatch(connection); break;
        case 'input': this.rooms.applyInput(connection, protocol.matchInputSchema.parse(payload)); break;
        case 'resultReady': this.rooms.setResultReady(connection, protocol.resultReadySchema.parse(payload).ready); break;
        case 'lobby': this.rooms.returnToLobby(connection); break;
        case 'leave': this.rooms.leaveRoom(connection); this.members.delete(connection); this.timings.delete(connection); break;
        case 'pong': this.acceptPong(connection, payloads.pong.parse(payload).nonce); break;
      }
      return { ok: true, data: null };
    } catch (error) { return this.error(error); }
  }

  disconnect(connection: string): void { this.rooms.disconnect(connection); this.members.delete(connection); this.timings.delete(connection); }
  advance(elapsed: number): void {
    // The owner executes locally, so there is no network round trip for this player.
    if (this.members.has(LOCAL_HOST)) this.rooms.setWebRtcNetworkSample(LOCAL_HOST, 0, 0, Date.now());
    const now = performance.now();
    for (const [connection, timing] of this.timings) {
      if (timing.pending && now - timing.pending.sentAt >= 2000) {
        timing.pending = null; timing.samples = [];
        this.rooms.clearWebRtcNetworkSample(connection);
      }
      if (timing.pending || now < timing.nextAt) continue;
      const nonce = ++this.probeNonce;
      timing.pending = { nonce, sentAt: now }; timing.nextAt = now + 1000;
      this.send(connection, { event: 'network:probe', data: { nonce } });
    }
    this.rooms.advance(elapsed);
  }
  private acceptPong(connection: string, nonce: number): void {
    const timing = this.timings.get(connection), probe = timing?.pending;
    if (!timing || !probe || nonce !== probe.nonce) return;
    const elapsed = performance.now() - probe.sentAt;
    if (elapsed < 0 || elapsed >= 2000) return;
    timing.pending = null;
    timing.samples.push(elapsed);
    if (timing.samples.length > RTT_SAMPLE_LIMIT) timing.samples.shift();
    const differences = timing.samples.slice(1).map((value, index) => Math.abs(value - timing.samples[index]!));
    this.rooms.setWebRtcNetworkSample(connection, median(timing.samples), median(differences), Date.now());
  }
  private error(error: unknown): Ack<never> {
    return error instanceof DomainError ? { ok: false, error: { code: error.code, message: error.safeMessage, recoverable: error.recoverable } } : failure('INTERNAL_ERROR', 'Oda işlemi tamamlanamadı.');
  }
  private sync(connection: string): void {
    if (this.latestRoom) this.send(connection, { event: 'room:state', data: this.latestRoom.state });
    const match = this.rooms.currentMatchPublication(connection);
    if (match) this.send(connection, { event: 'match:started', data: match.snapshot });
  }
  private publish(publication: RoomPublication): void {
    if (publication.type === 'ROOM_STATE') this.latestRoom = publication;
    let event: HostEvent;
    switch (publication.type) {
      case 'ROOM_STATE': event = { event: 'room:state', data: publication.state }; break;
      case 'MATCH_STARTED': event = { event: 'match:started', data: publication.snapshot }; break;
      case 'MATCH_SNAPSHOT': event = { event: 'match:snapshot', data: publication.snapshot }; break;
      case 'MATCH_EVENT': event = { event: 'match:event', data: publication.event }; break;
      case 'ROOM_CLOSED': event = { event: 'server:error', data: { code: 'ROOM_NOT_FOUND', message: 'Oda kapandı.', recoverable: true } satisfies ServerError }; break;
    }
    for (const connection of this.members) this.send(connection, event);
  }
}

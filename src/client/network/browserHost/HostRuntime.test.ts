import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostRuntime, LOCAL_HOST, type HostEvent } from './HostRuntime.js';

function fixture() {
  const events: Array<{connection: string; event: HostEvent}> = [];
  const host = new HostRuntime((connection, event) => events.push({connection, event}));
  const created = host.create('Owner');
  if (!created.ok) throw new Error(created.error.message);
  return {host, events, welcome:created.data};
}

describe('browser host authority', () => {
  it('denies unidentified commands, malformed inputs and guest bot management', () => {
    const {host,welcome} = fixture();
    expect(host.handle('peer','addBot',{chassis:'RIFT',difficulty:'HARD'})).toMatchObject({ok:false,error:{code:'NOT_IN_ROOM'}});
    expect(host.handle('peer','join',{roomCode:welcome.roomCode,name:'Guest'})).toMatchObject({ok:true});
    expect(host.handle('peer','addBot',{chassis:'RIFT',difficulty:'HARD'})).toMatchObject({ok:false,error:{code:'NOT_HOST'}});
    expect(host.handle('peer','input',{moveX:Infinity})).toMatchObject({ok:false,error:{code:'INVALID_PAYLOAD'}});
  });
  it('runs bot-only gameplay for a spectator host and synchronizes a late spectator', () => {
    const {host,welcome,events} = fixture();
    expect(host.handle(LOCAL_HOST,'role',{role:'SPECTATOR'})).toMatchObject({ok:true});
    for(let i=0;i<8;i++) expect(host.handle(LOCAL_HOST,'addBot',{chassis:'RIFT',difficulty:'NORMAL'})).toMatchObject({ok:true});
    expect(host.handle(LOCAL_HOST,'start',{})).toMatchObject({ok:true});
    for(let i=0;i<100;i++) host.advance(50);
    expect(host.handle('late','join',{roomCode:welcome.roomCode,name:'Watcher',role:'SPECTATOR'})).toMatchObject({ok:true});
    const started=events.find(e=>e.connection==='late'&&e.event.event==='match:started');
    expect(started?.event.data).toMatchObject({phase:'REGULATION',players:expect.any(Array)});
    expect((started!.event.data as {players:unknown[]}).players).toHaveLength(8);
    expect(host.handle('late','ready',{ready:true})).toMatchObject({ok:false,error:{code:'SPECTATOR_ACTION'}});
    expect(events.some(e=>e.connection==='unjoined')).toBe(false);
  });
  it('resumes a disconnected guest and rejects a forged resume credential', () => {
    const {host,welcome}=fixture();
    const joined=host.handle('old','join',{roomCode:welcome.roomCode,name:'Guest'});
    if(!joined.ok||!joined.data) throw new Error('join failed');
    host.disconnect('old');
    expect(host.handle('new','resume',{roomCode:welcome.roomCode,resumeToken:'0'.repeat(64)})).toMatchObject({ok:false});
    expect(host.handle('new','resume',{roomCode:welcome.roomCode,resumeToken:joined.data.resumeToken})).toMatchObject({ok:true,data:{playerId:joined.data.playerId}});
  });
});


describe('browser-host gameplay ping', () => {
  afterEach(() => vi.useRealTimers());
  function playing() {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const subject = fixture();
    const joined = subject.host.handle('peer', 'join', { roomCode: subject.welcome.roomCode, name: 'Guest' });
    if (!joined.ok || !joined.data) throw new Error('join failed');
    subject.host.handle(LOCAL_HOST, 'ready', { ready: true });
    subject.host.handle('peer', 'ready', { ready: true });
    subject.host.handle(LOCAL_HOST, 'start', {});
    const network = () => subject.host.rooms.currentMatchPublication(LOCAL_HOST)!.snapshot.network;
    const probe = () => subject.events.filter(e => e.connection === 'peer' && e.event.event === 'network:probe').at(-1)?.event.data as { nonce: number } | undefined;
    return { ...subject, guestId: joined.data.playerId, network, probe };
  }

  it('publishes measured peer RTT to both clients and zero for the local host', () => {
    const s = playing();
    s.host.advance(17);
    expect(s.probe()).toEqual({ nonce: expect.any(Number) });
    vi.advanceTimersByTime(50);
    s.host.handle('peer', 'pong', s.probe());
    expect(s.network()[s.guestId]).toMatchObject({ medianMs: 50, jitterMs: 0 });
    expect(s.network()[s.welcome.playerId]).toMatchObject({ medianMs: 0 });
    vi.advanceTimersByTime(950);
    s.host.advance(17);
    vi.advanceTimersByTime(70);
    s.host.handle('peer', 'pong', s.probe());
    expect(s.network()[s.guestId]).toMatchObject({ medianMs: 60, jitterMs: 20 });
    expect(s.host.rooms.currentMatchPublication('peer')!.snapshot.network).toEqual(s.network());
  });

  it('ignores forged, duplicate and expired replies and clears stale measurements', () => {
    const s = playing();
    s.host.advance(17);
    const first = s.probe();
    expect(first).toBeDefined();
    s.host.handle('peer', 'pong', { nonce: 999 });
    expect(s.network()[s.guestId]?.medianMs).toBeNull();
    vi.advanceTimersByTime(40);
    s.host.handle('peer', 'pong', first);
    vi.advanceTimersByTime(20);
    s.host.handle('peer', 'pong', first);
    expect(s.network()[s.guestId]?.medianMs).toBe(40);
    vi.advanceTimersByTime(940);
    s.host.advance(17);
    const expired = s.probe();
    vi.advanceTimersByTime(2000);
    s.host.handle('peer', 'pong', expired);
    s.host.advance(17);
    expect(s.network()[s.guestId]?.medianMs).toBeNull();
    vi.advanceTimersByTime(25);
    s.host.handle('peer', 'pong', s.probe());
    expect(s.network()[s.guestId]?.medianMs).toBe(25);
    s.host.disconnect('peer');
    expect(s.host.handle('peer', 'pong', s.probe())).toMatchObject({ ok: false });
  });
});

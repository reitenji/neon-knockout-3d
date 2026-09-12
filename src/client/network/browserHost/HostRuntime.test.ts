import { describe, expect, it } from 'vitest';
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

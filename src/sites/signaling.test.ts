import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteSignalStore } from '../../scripts/lib/sqlite-signal-store.js';
import { signalFetch } from './signaling.js';
const stores:Array<ReturnType<typeof sqliteSignalStore>>=[];
afterEach(()=>{for(const store of stores)store.close();stores.length=0;vi.useRealTimers();});
function setup(source='192.0.2.1'){
  const store=sqliteSignalStore();stores.push(store);
  return async(path:string,method='GET',token?:string,data?:unknown,requestSource=source)=>{
    const res=await signalFetch(new Request(`https://example.test/api/peer-rooms${path}`,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':requestSource,...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined}),{DB:store.db});
    return {status:res.status,data:await res.json() as Record<string,unknown>};
  };
}
const owner='a'.repeat(64),guest='b'.repeat(64),stranger='c'.repeat(64);
const sdp='v=0\r\ns=private peer connection\r\n';
describe('Sites connection mailbox',()=>{
  it('reserves room codes atomically and restricts host and guest descriptions to their credentials',async()=>{
    const api=setup();expect((await api('','POST',undefined,{roomCode:'ABCD',ownerToken:owner})).status).toBe(201);
    expect((await api('','POST',undefined,{roomCode:'ABCD',ownerToken:stranger})).status).toBe(409);
    expect((await api('/ABCD','GET',stranger)).status).toBe(403);
    const offer=await api('/ABCD/offers','POST',undefined,{guestToken:guest,offer:sdp});expect(offer.status).toBe(201);
    const path=`/ABCD/offers/${offer.data.id}`;
    expect((await api(path,'GET',stranger)).status).toBe(404);
    expect((await api(path,'PUT',stranger,{answer:sdp})).status).toBe(403);
    expect((await api(path,'PUT',owner,{answer:sdp})).status).toBe(200);
    expect((await api(path,'GET',guest)).data.answer).toBe(sdp);
    expect((await api('/ABCD','DELETE',stranger)).status).toBe(403);
    expect((await api('/ABCD','DELETE',owner)).status).toBe(200);
    expect((await api(path,'GET',guest)).status).toBe(404);
  });
  it('bounds pending offers and rejects oversized or malformed descriptions',async()=>{
    const api=setup();await api('','POST',undefined,{roomCode:'ABCD',ownerToken:owner});
    expect((await api('/ABCD/offers','POST',undefined,{guestToken:guest,offer:'v=0'+'x'.repeat(33000)})).status).toBe(400);
    for(let i=0;i<16;i++)expect((await api('/ABCD/offers','POST',undefined,{guestToken:guest,offer:sdp})).status).toBe(201);
    expect((await api('/ABCD/offers','POST',undefined,{guestToken:guest,offer:sdp})).status).toBe(429);
  });
  it('limits active room reservations per source without consuming global capacity',async()=>{
    const api=setup();
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for(let i=0;i<8;i++)expect((await api('','POST',undefined,{roomCode:`ABC${alphabet[i]}`,ownerToken:owner})).status).toBe(201);
    expect((await api('','POST',undefined,{roomCode:'ABCJ',ownerToken:owner})).status).toBe(409);
    expect((await api('','POST',undefined,{roomCode:'ABCJ',ownerToken:owner},'198.51.100.2')).status).toBe(201);
  });
  it('expires offers and rooms and permits reusing a code after host expiry',async()=>{
    vi.useFakeTimers();const api=setup();await api('','POST',undefined,{roomCode:'ABCD',ownerToken:owner});
    const offer=await api('/ABCD/offers','POST',undefined,{guestToken:guest,offer:sdp});
    vi.setSystemTime(Date.now()+31000);
    expect((await api(`/ABCD/offers/${offer.data.id}`,'GET',guest)).status).toBe(404);
    vi.setSystemTime(Date.now()+60000);
    expect((await api('/ABCD','GET',owner)).status).toBe(404);
    expect((await api('','POST',undefined,{roomCode:'ABCD',ownerToken:stranger})).status).toBe(201);
  });
});

it('preserves unexpired signaling leases when adding source quotas', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('drizzle/0000_tired_iron_man.sql', 'utf8'));
    sqlite.prepare('INSERT INTO peer_rooms(code, owner_hash, expires_at) VALUES (?, ?, ?)')
      .run('ABCD', 'owner', Date.now() + 90_000);
    sqlite.exec(readFileSync('drizzle/0001_polite_ma_gnuci.sql', 'utf8'));
    expect(sqlite.prepare('SELECT code FROM peer_rooms').get()?.code).toBe('ABCD');
  } finally { sqlite.close(); }
});

it('serves invite HTML without triggering asset canonical redirects that discard the room code', async () => {
  const ASSETS = { fetch: async (request: Request) => new URL(request.url).pathname === '/'
    ? new Response('<html>game</html>', { headers: { 'Content-Type': 'text/html' } })
    : Response.redirect('https://example.test/', 307) };
  for (const path of ['/room/ABCD', '/room/abcd/']) {
    const response = await signalFetch(new Request(`https://example.test${path}`), { ASSETS } as Parameters<typeof signalFetch>[1]);
    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toContain('game');
  }
});

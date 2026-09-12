/** Only connection descriptions live here; gameplay never traverses this mailbox. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface SignalDatabase { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown>; }
export interface SignalEnv { DB: SignalDatabase; ASSETS?: { fetch(request: Request): Promise<Response> }; }
const TTL = 90_000;
const codePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const json = (value: unknown, status = 200) => Response.json(value, {status,headers:{'Cache-Control':'no-store'}});
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const tokenOf = (request: Request) => request.headers.get('Authorization')?.replace(/^Bearer /,'') ?? '';
function validSdp(value: unknown): value is string { return typeof value === 'string' && value.length > 10 && value.length <= 32_000 && value.startsWith('v=0'); }
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('BODY');
  const reader=request.body?.getReader(); if(!reader) throw new Error('BODY');
  let size=0; const chunks:Uint8Array[]=[];
  for (;;) { const part=await reader.read(); if(part.done) break; size+=part.value.byteLength; if(size>40_000) {await reader.cancel();throw new Error('BODY');} chunks.push(part.value); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value:unknown=JSON.parse(new TextDecoder().decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('BODY');
  return value as Record<string,unknown>;
}

export async function signalFetch(request: Request, env: SignalEnv): Promise<Response> {
  const url=new URL(request.url);
  const base='/api/peer-rooms';
  if(!url.pathname.startsWith(base)) {
    if(url.pathname==='/health') return json({ok:true,mode:'browser-host'});
    if(url.pathname==='/api/lan-addresses') return json({addresses:[]});
    if(env.ASSETS) return env.ASSETS.fetch(/^\/room\/[A-Z0-9]{4}\/?$/.test(url.pathname) ? new Request(new URL('/index.html',url),request) : request);
    return json({error:'NOT_FOUND'},404);
  }
  try {
    const rest=url.pathname.slice(base.length).split('/').filter(Boolean);
    const now=Date.now(); const db=env.DB;
    if(rest.length===0&&request.method==='POST') {
      const p=await body(request);
      if(typeof p.roomCode!=='string'||!codePattern.test(p.roomCode)||typeof p.ownerToken!=='string'||!tokenPattern.test(p.ownerToken)) return json({error:'INVALID_REQUEST'},400);
      await db.batch([
        db.prepare('DELETE FROM peer_offers WHERE id IN (SELECT id FROM peer_offers WHERE expires_at <= ? LIMIT 100)').bind(now),
        db.prepare('DELETE FROM peer_rooms WHERE code IN (SELECT code FROM peer_rooms WHERE expires_at <= ? LIMIT 100)').bind(now)
      ]);
      const inserted=await db.prepare('INSERT OR IGNORE INTO peer_rooms(code, owner_hash, expires_at) SELECT ?, ?, ? WHERE (SELECT count(*) FROM peer_rooms) < 1000').bind(p.roomCode,await hash(p.ownerToken),now+TTL).run();
      return inserted.meta.changes?json({roomCode:p.roomCode},201):json({error:'ROOM_UNAVAILABLE'},409);
    }
    const code=rest[0];
    if(!code||!codePattern.test(code)) return json({error:'NOT_FOUND'},404);
    const room=await db.prepare('SELECT owner_hash FROM peer_rooms WHERE code = ? AND expires_at > ?').bind(code,now).first<{owner_hash:string}>();
    if(!room) return json({error:'ROOM_CLOSED'},404);
    const token=tokenOf(request); const credential=tokenPattern.test(token)?await hash(token):null;
    const owner=credential===room.owner_hash;
    if(rest.length===1) {
      if(!owner) return json({error:'FORBIDDEN'},403);
      if(request.method==='DELETE') { await db.prepare('DELETE FROM peer_rooms WHERE code = ? AND owner_hash = ?').bind(code,credential).run();return json({ok:true}); }
      if(request.method==='GET') {
        await db.prepare('UPDATE peer_rooms SET expires_at = ? WHERE code = ? AND owner_hash = ?').bind(now+TTL,code,credential).run();
        const offers=await db.prepare('SELECT id, offer FROM peer_offers WHERE room_code = ? AND expires_at > ? AND answer IS NULL ORDER BY created_at LIMIT 16').bind(code,now).all<{id:string;offer:string}>();
        return json({offers:offers.results});
      }
    }
    if(rest[1]==='offers'&&rest.length===2&&request.method==='POST') {
      const p=await body(request);
      if(typeof p.guestToken!=='string'||!tokenPattern.test(p.guestToken)||!validSdp(p.offer)) return json({error:'INVALID_REQUEST'},400);
      const id=crypto.randomUUID();
      await db.prepare('DELETE FROM peer_offers WHERE room_code = ? AND expires_at <= ?').bind(code,now).run();
      const added=await db.prepare('INSERT INTO peer_offers(id, room_code, guest_hash, offer, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM peer_offers WHERE room_code = ?) < 16').bind(id,code,await hash(p.guestToken),p.offer,now,now+30_000,code).run();
      return added.meta.changes?json({id},201):json({error:'ROOM_BUSY'},429);
    }
    const id=rest[2];
    if(rest[1]==='offers'&&rest.length===3&&id&&/^[0-9a-f-]{36}$/.test(id)) {
      if(request.method==='PUT') {
        if(!owner) return json({error:'FORBIDDEN'},403);
        const p=await body(request);if(!validSdp(p.answer)) return json({error:'INVALID_REQUEST'},400);
        const changed=await db.prepare('UPDATE peer_offers SET answer = ? WHERE id = ? AND room_code = ? AND expires_at > ? AND answer IS NULL').bind(p.answer,id,code,now).run();
        return changed.meta.changes?json({ok:true}):json({error:'OFFER_EXPIRED'},404);
      }
      if(request.method==='GET') {
        if(!credential) return json({error:'FORBIDDEN'},403);
        const offer=await db.prepare('SELECT answer FROM peer_offers WHERE id = ? AND room_code = ? AND guest_hash = ? AND expires_at > ?').bind(id,code,credential,now).first<{answer:string|null}>();
        return offer?json({answer:offer.answer}):json({error:'OFFER_EXPIRED'},404);
      }
    }
    return json({error:'NOT_FOUND'},404);
  } catch(error) {
    return error instanceof SyntaxError || (error instanceof Error && error.message==='BODY') ? json({error:'INVALID_REQUEST'},400) : json({error:'UNAVAILABLE'},503);
  }
}
export default { fetch: signalFetch };

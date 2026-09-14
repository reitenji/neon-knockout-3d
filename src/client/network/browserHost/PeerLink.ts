export const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function signal<T>(path:string, method='GET', token?:string, payload?:unknown):Promise<T> {
  const response=await fetch(`/api/peer-rooms${path}`, {method, headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw new Error(response.status===404?'Oda sahibi odayı kapattı veya oda kodu geçersiz.':response.status===409?'ROOM_CODE_TAKEN':response.status===429?'Odaya aynı anda çok fazla bağlantı deneniyor.':'Oda bağlantısı kurulamadı.');
  return response.json() as Promise<T>;
}
export async function description(peer:RTCPeerConnection, kind:'offer'|'answer'):Promise<string> {
  await peer.setLocalDescription(kind==='offer'?await peer.createOffer():await peer.createAnswer());
  if(peer.iceGatheringState!=='complete') await new Promise<void>(resolve=>{
    const done=()=>{if(peer.iceGatheringState==='complete'){cleanup();resolve();}};
    // A blocked STUN endpoint must not discard already gathered direct LAN candidates.
    const timer=window.setTimeout(()=>{cleanup();resolve();},8000);
    const cleanup=()=>{window.clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',done);};
    peer.addEventListener('icegatheringstatechange',done);done();
  });
  if(!peer.localDescription?.sdp||!/^a=candidate:/m.test(peer.localDescription.sdp)) throw new Error('Bağlantı adresi alınamadı.');
  return peer.localDescription.sdp;
}
export async function waitForChannel(channel:RTCDataChannel):Promise<void> {
  if(channel.readyState==='open') return;
  await new Promise<void>((resolve,reject)=>{
    const opened=()=>{cleanup();resolve();};
    const failed=()=>{cleanup();reject(new Error('Doğrudan bağlantı kurulamadı. Bazı modemler ve mobil ağlar bu denemeyi desteklemeyebilir. Aynı Wi-Fi/LAN üzerinden de deneyebilirsin.'));};
    const timer=window.setTimeout(failed,12000);
    const cleanup=()=>{window.clearTimeout(timer);channel.removeEventListener('open',opened);channel.removeEventListener('close',failed);channel.removeEventListener('error',failed);};
    channel.addEventListener('open',opened);channel.addEventListener('close',failed);channel.addEventListener('error',failed);
  });
}
export function sendPeer(channel:RTCDataChannel, message:unknown, transient=false):void {
  if(channel.readyState!=='open') return;
  if(transient&&channel.bufferedAmount>128_000) return;
  if(channel.bufferedAmount>1_000_000) {channel.close();return;}
  channel.send(JSON.stringify(message));
}
/** STUN discovers a direct route; no TURN endpoint or relay credentials are configured. */
export function createDirectPeer():RTCPeerConnection {
  return new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
}

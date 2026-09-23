import { browserIdentity } from './browserIdentity.js';
import type { GameClient, GameClientConnectionState, GameClientEvents } from './GameClient.js';
import type { Ack, SessionWelcome, MatchSnapshot } from '../../shared/model.js';
import { HostRuntime, LOCAL_HOST, requestSchema, type HostCommand, type HostEvent } from './browserHost/HostRuntime.js';
import { createDirectPeer, description, randomToken, signal, waitForChannel, sendPeer } from './browserHost/PeerLink.js';

const failed=(message:string):Ack<never>=>({ok:false,error:{code:'HOST_CONNECTION_FAILED',message,recoverable:true}});
const asError=(error:unknown)=>error instanceof Error?error.message:'Oda bağlantısı kurulamadı.';

export function createBrowserHostClient():GameClient {
  const listeners=new Map<keyof GameClientEvents,Set<(value:never)=>void>>();
  let state:GameClientConnectionState='idle';
  let runtime:HostRuntime|null=null, roomCode:string|null=null, ownerToken:string|null=null;
  let guestPeer:RTCPeerConnection|null=null, guestChannel:RTCDataChannel|null=null;
  const peers=new Map<string,{peer:RTCPeerConnection;channel:RTCDataChannel|null}>();
  const pending=new Map<number,{resolve:(ack:Ack<SessionWelcome|null>)=>void;timer:number}>();
  let sequence=1, generation=0, ticker:number|undefined, mailbox:number|undefined, polling=false;
  let lastTick=0, lastSnapshot=-1;
  let joiningEvents:HostEvent[]|null=null;
  const emit=<E extends keyof GameClientEvents>(event:E,value:Parameters<GameClientEvents[E]>[0])=>{for(const listener of listeners.get(event)??[])listener(value as never);};
  const connection=(next:GameClientConnectionState)=>{state=next;emit('connection',next);};
  const receive=(event:HostEvent)=>{
    if(event.event==='room:kicked') { clear(); emit('room:kicked',event.data as {roomCode:string}); connection('connected'); return; }
    if(event.event==='network:probe') {
      if(guestChannel)sendPeer(guestChannel,{id:0,command:'pong',payload:event.data});
      return;
    }
    if(event.event==='match:snapshot') {
      const snapshot=event.data as MatchSnapshot;if(snapshot.tick<=lastSnapshot)return;lastSnapshot=snapshot.tick;
    }
    if(event.event==='match:started')lastSnapshot=-1;
    emit(event.event,event.data as never);
  };
  const clear=()=>{
    generation++;window.clearInterval(ticker);window.clearTimeout(mailbox);polling=false;
    runtime=null;roomCode=null;ownerToken=null;lastSnapshot=-1;joiningEvents=null;
    for(const {peer,channel} of peers.values()){if(channel)channel.onclose=null;peer.close();}peers.clear();
    if(guestChannel)guestChannel.onclose=null;guestPeer?.close();guestPeer=null;guestChannel=null;
    for(const request of pending.values()){window.clearTimeout(request.timer);request.resolve(failed('Oda bağlantısı kapandı.'));}pending.clear();
  };
  const command=(name:HostCommand,payload:unknown):Promise<Ack<SessionWelcome|null>>=>{
    if(runtime)return Promise.resolve(runtime.handle(LOCAL_HOST,name,payload));
    if(!guestChannel||guestChannel.readyState!=='open')return Promise.resolve(failed('Oda sahibine bağlı değilsin.'));
    const id=sequence++;
    return new Promise(resolve=>{
      const timer=window.setTimeout(()=>{pending.delete(id);resolve(failed('Oda sahibi yanıt vermedi.'));},5000);
      pending.set(id,{resolve,timer});sendPeer(guestChannel!,{id,command:name,payload});
    });
  };
  const action=async(name:HostCommand,payload:unknown):Promise<Ack<null>>=>await command(name,payload) as Ack<null>;
  const accept=async(id:string,offer:string,current:number)=>{
    if(!runtime||peers.has(id)||peers.size>=15)return;
    const peer=createDirectPeer();
    const entry={peer,channel:null as RTCDataChannel|null};peers.set(id,entry);
    const expire=window.setTimeout(()=>{if(entry.channel?.readyState!=='open'){peers.delete(id);peer.close();}},20000);
    peer.ondatachannel=event=>{
      if(entry.channel||event.channel.label!=='game'){event.channel.close();return;}
      const channel=event.channel;entry.channel=channel;
      channel.onopen=()=>window.clearTimeout(expire);
      let windowStarted=performance.now(), messages=0;
      channel.onmessage=message=>{
        if(performance.now()-windowStarted>1000){windowStarted=performance.now();messages=0;}
        if(++messages>180){channel.close();return;}
        if(typeof message.data!=='string'||message.data.length>40000){channel.close();return;}
        try {
          const parsed=requestSchema.safeParse(JSON.parse(message.data));
          if(!parsed.success){channel.close();return;}
          const request=parsed.data;
          const ack=runtime?.handle(id,request.command,request.payload)??failed('Oda kapandı.');
          if(request.command!=='input'&&request.command!=='pong')sendPeer(channel,{id:request.id,ack});
          if(request.command==='leave'&&ack.ok){channel.close();peer.close();peers.delete(id);}
        } catch {channel.close();}
      };
      channel.onclose=()=>{window.clearTimeout(expire);runtime?.disconnect(id);peers.delete(id);peer.close();};
    };
    try {
      await peer.setRemoteDescription({type:'offer',sdp:offer});
      const answer=await description(peer,'answer');
      if(current!==generation){peer.close();return;}
      await signal(`/${roomCode}/offers/${id}`,'PUT',ownerToken!,{answer});
    } catch {window.clearTimeout(expire);peers.delete(id);peer.close();}
  };
  const pollHost=async(current:number)=>{
    if(current!==generation||!roomCode||!ownerToken||polling)return;
    polling=true;
    try {
      const reply=await signal<{offers:Array<{id:string;offer:string}>}>(`/${roomCode}`,'GET',ownerToken);
      if(current===generation)await Promise.all(reply.offers.map(offer=>accept(offer.id,offer.offer,current)));
    } catch {if(current===generation)emit('server:error',{code:'SIGNALING_UNAVAILABLE',message:'Yeni oyuncular için oda bağlantısı geçici olarak kullanılamıyor. Devam eden maç doğrudan bağlantıyla sürüyor.',recoverable:true});}
    finally {if(current===generation){polling=false;mailbox=window.setTimeout(()=>void pollHost(current),1500);}}
  };
  const connectGuest=async(code:string)=>{
    const current=generation;
    const peer=createDirectPeer();guestPeer=peer;
    const channel=peer.createDataChannel('game',{ordered:true});guestChannel=channel;
    channel.onmessage=message=>{
      if(typeof message.data!=='string'||message.data.length>150000)return;
      try {
        const packet=JSON.parse(message.data) as {id?:number;ack?:Ack<SessionWelcome|null>;event?:HostEvent['event'];data?:unknown};
        if(packet.id!==undefined&&packet.ack){const request=pending.get(packet.id);if(request){window.clearTimeout(request.timer);pending.delete(packet.id);request.resolve(packet.ack);}}
        else if(packet.event==='network:probe')receive({event:packet.event,data:packet.data});
        else if(packet.event&&['room:kicked','room:state','match:started','match:snapshot','match:event','server:error'].includes(packet.event)) {
          const event={event:packet.event,data:packet.data};
          if(joiningEvents) {if(joiningEvents.length<64)joiningEvents.push(event);} else receive(event);
        }
      }catch {/* Ignore malformed owner packets without executing content. */}
    };
    channel.onclose=()=>{
      if(current!==generation)return;
      connection('disconnected');
      emit('server:error',{code:'HOST_CONNECTION_LOST',message:'Oda sahibi bağlantısı kesildi. Host sekmesi açıkken sayfayı yenileyerek yeniden katılabilirsin.',recoverable:true});
    };
    const token=randomToken();
    const offer=await description(peer,'offer');
    const {id}=await signal<{id:string}>(`/${code}/offers`,'POST',undefined,{guestToken:token,offer});
    const until=Date.now()+16000;
    while(current===generation&&Date.now()<until){
      const answer=await signal<{answer:string|null}>(`/${code}/offers/${id}`,'GET',token);
      if(answer.answer){await peer.setRemoteDescription({type:'answer',sdp:answer.answer});await waitForChannel(channel);roomCode=code;connection('connected');return;}
      await new Promise(resolve=>window.setTimeout(resolve,500));
    }
    throw new Error('Oda sahibine ulaşılamadı. Host sekmesi açık kalmalı; farklı ağlardan bağlantı bu denemede her zaman kurulamayabilir.');
  };
  const join=async(code:string,nameOrToken:string,resume:boolean,role?:'FIGHTER'|'SPECTATOR'):Promise<Ack<SessionWelcome>>=>{
    clear();joiningEvents=[];connection('connecting');
    try {
      const browserId = await browserIdentity();
      await connectGuest(code);
      const ack=await command(resume?'resume':'join',resume?{roomCode:code,resumeToken:nameOrToken}:{roomCode:code,name:nameOrToken,role:role??'FIGHTER',browserId});
      if(ack.ok&&ack.data){
        // Let the action acknowledgement establish the new identity after a prior leave.
        const current=generation, session=ack.data;
        window.setTimeout(()=>{
          if(current!==generation)return;
          emit('session:welcome',session);
          const events=joiningEvents;joiningEvents=null;for(const event of events??[])receive(event);
        },0);
        return {ok:true,data:ack.data};
      }
      clear();connection('connected');return ack as Ack<SessionWelcome>;
    }catch(error){clear();connection('connected');return failed(asError(error));}
  };
  return {
    connect(){connection('connected');},
    disconnect(){if(ownerToken&&roomCode)void signal(`/${roomCode}`,'DELETE',ownerToken).catch(()=>{});clear();connection('disconnected');},
    getConnectionState(){return state;},
    subscribe(event,listener){const set=listeners.get(event)??new Set();set.add(listener as (value:never)=>void);listeners.set(event,set);return()=>{set.delete(listener as (value:never)=>void);};},
    async createRoom(name){
      clear();
      try {
        const browserId = await browserIdentity();
        for(let attempt=0;attempt<5;attempt++){
          const buffered:HostEvent[]=[];let registered=false;
          runtime=new HostRuntime((id,event)=>{if(id===LOCAL_HOST){if(registered)receive(event);else buffered.push(event);}else {const channel=peers.get(id)?.channel;if(channel){sendPeer(channel,event,event.event==='match:snapshot');if(event.event==='room:kicked')channel.close();}}});
          const created=runtime.create(name, browserId);if(!created.ok)return created;
          roomCode=created.data.roomCode;ownerToken=randomToken();
          try{await signal('','POST',undefined,{roomCode,ownerToken});}
          catch(error){if(asError(error)==='ROOM_CODE_TAKEN')continue;throw error;}
          const current=generation, session=created.data;
          window.setTimeout(()=>{
            if(current!==generation)return;
            emit('session:welcome',session);registered=true;for(const event of buffered)receive(event);
          },0);
          connection('connected');
          lastTick=performance.now();ticker=window.setInterval(()=>{const now=performance.now();runtime?.advance(Math.min(250,now-lastTick));lastTick=now;},1000/60);
          void pollHost(generation);return created;
        }
        throw new Error('Oda kodu ayrılamadı. Tekrar dene.');
      }catch(error){clear();return failed(asError(error));}
    },
    joinRoom(name,code,role){return join(code,name,false,role);},
    resumeSession(code,token){return join(code,token,true);},
    sendChat:text=>action('chat',{text}),kickPlayer:playerId=>action('kick',{playerId}),
    setRole:role=>action('role',{role}),addBot:(chassis,difficulty)=>action('addBot',{chassis,difficulty}),
    updateBot:(playerId,chassis,difficulty)=>action('updateBot',{playerId,chassis,difficulty}),removeBot:playerId=>action('removeBot',{playerId}),
    setChassis:chassis=>action('chassis',{chassis}),setReady:ready=>action('ready',{ready}),setRoomSettings:settings=>action('settings',settings),
    startMatch:()=>action('start',{}),setResultReady:ready=>action('resultReady',{ready}),returnToLobby:()=>action('lobby',{}),
    async leaveRoom(){
      if(runtime){if(roomCode&&ownerToken)void signal(`/${roomCode}`,'DELETE',ownerToken).catch(()=>{});clear();connection('connected');return {ok:true,data:null};}
      if(guestChannel?.readyState==='open')await action('leave',{});clear();connection('connected');return {ok:true,data:null};
    },
    sendInput(input){if(runtime)runtime.handle(LOCAL_HOST,'input',input);else if(guestChannel)sendPeer(guestChannel,{id:0,command:'input',payload:input},true);}
  };
}

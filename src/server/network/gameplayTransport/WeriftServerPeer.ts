import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import {
  FAST_CHANNEL_LABEL,
  FAST_CHANNEL_MAX_BUFFERED_BYTES,
  RELIABLE_CHANNEL_LABEL,
  type RtcAnswer,
  type RtcOffer
} from '../../../shared/gameplayTransport.js';
import type { PeerSendResult, ServerPeer, ServerPeerFactory } from './ServerPeer.js';

const DEFAULT_UDP_PORT_MIN = 53140;
const DEFAULT_UDP_PORT_MAX = 53171;

type Environment = Readonly<Record<string, string | undefined>>;
type MessageListener = (serialized: string) => void;
type ClosedListener = () => void;

function readUdpPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('Invalid WebRTC UDP port range. Ports must be decimal integers.');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error('Invalid WebRTC UDP port range. Ports must be between 1 and 65535.');
  }
  return port;
}

export function readWebRtcUdpPortRange(environment: Environment): readonly [number, number] {
  const minimum = readUdpPort(environment.GAME_WEBRTC_UDP_PORT_MIN, DEFAULT_UDP_PORT_MIN);
  const maximum = readUdpPort(environment.GAME_WEBRTC_UDP_PORT_MAX, DEFAULT_UDP_PORT_MAX);
  if (minimum === maximum) {
    throw new Error('WebRTC UDP port range bounds must be different.');
  }
  if (minimum > maximum) {
    throw new Error('Invalid WebRTC UDP port range. The minimum must be lower than the maximum.');
  }
  return [minimum, maximum];
}

class WeriftServerPeer implements ServerPeer {
  readonly generationId: string;
  private readonly peer: RTCPeerConnection;
  private readonly subscriptions: Array<() => void> = [];
  private readonly fastListeners = new Set<MessageListener>();
  private readonly reliableListeners = new Set<MessageListener>();
  private readonly closedListeners = new Set<ClosedListener>();
  private fastChannel: RTCDataChannel | null = null;
  private reliableChannel: RTCDataChannel | null = null;
  private disposed = false;
  private closureNotified = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: Parameters<ServerPeerFactory>[0]) {
    this.generationId = options.generationId;
    this.peer = new RTCPeerConnection({
      iceServers: [],
      icePortRange: [options.udpPortRange[0], options.udpPortRange[1]],
      iceUseIpv4: true,
      iceUseTcp: false
    });
    this.subscriptions.push(
      this.peer.onDataChannel.subscribe((channel) => this.acceptChannel(channel)).unSubscribe,
      this.peer.connectionStateChange.subscribe((state) => {
        if (state === 'closed' || state === 'failed' || state === 'disconnected') this.notifyClosed();
      }).unSubscribe
    );
  }

  async negotiate(offer: RtcOffer): Promise<RtcAnswer> {
    await this.peer.setRemoteDescription(offer);
    const answer = await this.peer.createAnswer();
    const local = await this.peer.setLocalDescription(answer);
    return { type: 'answer', sdp: local.toJSON().sdp };
  }

  isReady(): boolean {
    return !this.disposed
      && this.fastChannel?.readyState === 'open'
      && this.reliableChannel?.readyState === 'open';
  }

  sendFast(serialized: string): PeerSendResult {
    return this.send(this.fastChannel, serialized);
  }

  sendReliable(serialized: string): PeerSendResult {
    return this.send(this.reliableChannel, serialized);
  }

  onFastMessage(listener: MessageListener): () => void {
    return this.addListener(this.fastListeners, listener);
  }

  onReliableMessage(listener: MessageListener): () => void {
    return this.addListener(this.reliableListeners, listener);
  }

  onClosed(listener: ClosedListener): () => void {
    return this.addListener(this.closedListeners, listener);
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.dispose();
    return this.closePromise;
  }

  private acceptChannel(channel: RTCDataChannel): void {
    if (this.disposed) {
      channel.close();
      return;
    }

    if (channel.label === FAST_CHANNEL_LABEL) {
      if (this.fastChannel || channel.ordered !== false || channel.maxRetransmits !== 0) {
        channel.close();
        return;
      }
      this.fastChannel = channel;
      this.subscribeToMessages(channel, this.fastListeners);
      return;
    }

    if (channel.label === RELIABLE_CHANNEL_LABEL) {
      if (
        this.reliableChannel
        || channel.ordered !== true
        || channel.maxRetransmits !== null
        || channel.maxPacketLifeTime !== null
      ) {
        channel.close();
        return;
      }
      this.reliableChannel = channel;
      this.subscribeToMessages(channel, this.reliableListeners);
      return;
    }

    channel.close();
  }

  private subscribeToMessages(channel: RTCDataChannel, listeners: Set<MessageListener>): void {
    const subscription = channel.onMessage.subscribe((message) => {
      if (typeof message !== 'string' || this.disposed) return;
      for (const listener of [...listeners]) listener(message);
    });
    this.subscriptions.push(subscription.unSubscribe);
  }

  private send(channel: RTCDataChannel | null, serialized: string): PeerSendResult {
    if (this.disposed || channel?.readyState !== 'open') return 'closed';
    if (channel.bufferedAmount > FAST_CHANNEL_MAX_BUFFERED_BYTES) return 'backpressured';
    try {
      channel.send(serialized);
      return 'sent';
    } catch {
      return 'closed';
    }
  }

  private addListener<T>(listeners: Set<T>, listener: T): () => void {
    if (this.disposed) return () => undefined;
    listeners.add(listener);
    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      listeners.delete(listener);
    };
  }

  private notifyClosed(): void {
    if (this.disposed || this.closureNotified) return;
    this.closureNotified = true;
    for (const listener of [...this.closedListeners]) listener();
  }

  private async dispose(): Promise<void> {
    this.disposed = true;
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Continue releasing the remaining subscriptions and UDP resources.
      }
    }
    for (const channel of [this.fastChannel, this.reliableChannel]) {
      try {
        channel?.close();
      } catch {
        // Peer closure below remains the authoritative resource cleanup.
      }
    }
    this.fastChannel = null;
    this.reliableChannel = null;
    this.fastListeners.clear();
    this.reliableListeners.clear();
    this.closedListeners.clear();
    await this.peer.close();
  }
}

export function createWeriftServerPeer(options: Parameters<ServerPeerFactory>[0]): ServerPeer {
  return new WeriftServerPeer(options);
}

// @vitest-environment node

import { chromium, type Browser, type Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAST_CHANNEL_MAX_BUFFERED_BYTES } from '../../../shared/gameplayTransport.js';

type Listener<T extends unknown[]> = (...values: T) => void;
type BrowserChannelForTest = {
  readonly label: string;
  readonly readyState: string;
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  send(serialized: string): void;
};
type BrowserPeerForTest = {
  readonly iceGatheringState: string;
  readonly localDescription: Readonly<{ type: string; sdp: string }> | null;
  createDataChannel(label: string, options: Readonly<{ ordered: boolean; maxRetransmits?: number }>): BrowserChannelForTest;
  createOffer(): Promise<Readonly<{ type: string; sdp: string }>>;
  setLocalDescription(description: Readonly<{ type: string; sdp: string }>): Promise<void>;
  setRemoteDescription(description: Readonly<{ type: 'answer'; sdp: string }>): Promise<void>;
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  close(): void;
};
type BrowserGlobalsForTest = typeof globalThis & {
  RTCPeerConnection: new (configuration: Readonly<{ iceServers: unknown[] }>) => BrowserPeerForTest;
  task4Peer?: BrowserPeerForTest;
  task4Fast?: BrowserChannelForTest;
  task4Reliable?: BrowserChannelForTest;
  task4Messages?: string[];
};

class FakeEvent<T extends unknown[]> {
  private readonly listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>) {
    this.listeners.add(listener);
    let subscribed = true;
    return {
      unSubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.listeners.delete(listener);
      },
      disposer: () => undefined
    };
  }

  emit(...values: T): void {
    for (const listener of [...this.listeners]) listener(...values);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

class FakeDataChannel {
  readonly onMessage = new FakeEvent<[string | Uint8Array]>();
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  bufferedAmount = 0;
  closeCalls = 0;
  readonly sent: string[] = [];
  sendError: Error | null = null;

  constructor(
    readonly label: string,
    readonly ordered: boolean,
    readonly maxRetransmits: number | null,
    readonly maxPacketLifeTime: number | null = null
  ) {}

  send(serialized: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(serialized);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.closeCalls += 1;
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly onDataChannel = new FakeEvent<[FakeDataChannel]>();
  readonly connectionStateChange = new FakeEvent<[string]>();
  readonly calls: string[] = [];
  readonly remoteDescriptions: unknown[] = [];
  closeCalls = 0;

  constructor(readonly configuration: unknown) {
    FakePeerConnection.instances.push(this);
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.calls.push('setRemoteDescription');
    this.remoteDescriptions.push(description);
  }

  async createAnswer(): Promise<Readonly<{ type: 'answer'; sdp: string }>> {
    this.calls.push('createAnswer');
    return { type: 'answer', sdp: 'draft-answer' };
  }

  async setLocalDescription(): Promise<Readonly<{ toJSON: () => Readonly<{ type: 'answer'; sdp: string }> }>> {
    this.calls.push('setLocalDescription');
    return { toJSON: () => ({ type: 'answer', sdp: 'complete-answer' }) };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

async function loadFakeAdapter() {
  FakePeerConnection.instances = [];
  vi.resetModules();
  vi.doMock('werift', () => ({ RTCPeerConnection: FakePeerConnection }));
  const adapter = await import('./WeriftServerPeer.js');
  const serverPeer = adapter.createWeriftServerPeer({
    generationId: '2f8ca1f2-7e6e-4ea7-90e2-e6a955892574',
    udpPortRange: [53100, 53131]
  });
  const peer = FakePeerConnection.instances[0];
  if (!peer) throw new Error('Expected the adapter to construct one peer connection.');
  return { adapter, serverPeer, peer };
}

function acceptedChannels(peer: FakePeerConnection): {
  fast: FakeDataChannel;
  reliable: FakeDataChannel;
} {
  const fast = new FakeDataChannel('match-fast', false, 0);
  const reliable = new FakeDataChannel('match-reliable', true, null);
  peer.onDataChannel.emit(fast);
  peer.onDataChannel.emit(reliable);
  return { fast, reliable };
}

afterEach(() => {
  vi.doUnmock('werift');
  vi.resetModules();
});

describe.sequential('readWebRtcUdpPortRange', () => {
  it('uses the documented default range and ignores unrelated environment variables', async () => {
    const { readWebRtcUdpPortRange } = await import('./WeriftServerPeer.js');

    expect(readWebRtcUdpPortRange({})).toEqual([53140, 53171]);
    expect(readWebRtcUdpPortRange({ WEBRTC_PORT_MIN: '54000', WEBRTC_PORT_MAX: '54031' })).toEqual([53140, 53171]);
  });

  it('reads only the two supported overrides, with defaults for omitted bounds', async () => {
    const { readWebRtcUdpPortRange } = await import('./WeriftServerPeer.js');

    expect(readWebRtcUdpPortRange({ GAME_WEBRTC_UDP_PORT_MIN: '53139' })).toEqual([53139, 53171]);
    expect(readWebRtcUdpPortRange({ GAME_WEBRTC_UDP_PORT_MAX: '53172' })).toEqual([53140, 53172]);
    expect(readWebRtcUdpPortRange({
      GAME_WEBRTC_UDP_PORT_MIN: '54000',
      GAME_WEBRTC_UDP_PORT_MAX: '54031'
    })).toEqual([54000, 54031]);
  });

  it.each([
    ['empty', { GAME_WEBRTC_UDP_PORT_MIN: '' }],
    ['non-decimal', { GAME_WEBRTC_UDP_PORT_MIN: '53e3' }],
    ['fractional', { GAME_WEBRTC_UDP_PORT_MAX: '53131.5' }],
    ['zero', { GAME_WEBRTC_UDP_PORT_MIN: '0' }],
    ['above UDP range', { GAME_WEBRTC_UDP_PORT_MAX: '65536' }],
    ['reversed', { GAME_WEBRTC_UDP_PORT_MIN: '54031', GAME_WEBRTC_UDP_PORT_MAX: '54000' }]
  ])('rejects %s UDP port configuration', async (_label, environment) => {
    const { readWebRtcUdpPortRange } = await import('./WeriftServerPeer.js');

    expect(() => readWebRtcUdpPortRange(environment)).toThrow(/UDP port range/i);
  });

  it('rejects equal bounds because Werift requires different ports', async () => {
    const { readWebRtcUdpPortRange } = await import('./WeriftServerPeer.js');

    expect(() => readWebRtcUdpPortRange({
      GAME_WEBRTC_UDP_PORT_MIN: '53100',
      GAME_WEBRTC_UDP_PORT_MAX: '53100'
    })).toThrow(/different/i);
  });
});

describe.sequential('createWeriftServerPeer', () => {
  it('constructs the host-only UDP peer and completes offer/answer negotiation', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();
    const offer = { type: 'offer' as const, sdp: 'browser-offer' };

    try {
      expect(serverPeer.generationId).toBe('2f8ca1f2-7e6e-4ea7-90e2-e6a955892574');
      expect(peer.configuration).toEqual({
        iceServers: [],
        icePortRange: [53100, 53131],
        iceUseIpv4: true,
        iceUseTcp: false
      });
      await expect(serverPeer.negotiate(offer)).resolves.toEqual({
        type: 'answer',
        sdp: 'complete-answer'
      });
      expect(peer.remoteDescriptions).toEqual([offer]);
      expect(peer.calls).toEqual(['setRemoteDescription', 'createAnswer', 'setLocalDescription']);
    } finally {
      await serverPeer.close();
    }
  });

  it('accepts exactly one correctly configured fast and reliable channel', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();

    try {
      const unknown = new FakeDataChannel('match-other', true, null);
      const wrongFast = new FakeDataChannel('match-fast', true, 0);
      const wrongReliable = new FakeDataChannel('match-reliable', true, 1);
      peer.onDataChannel.emit(unknown);
      peer.onDataChannel.emit(wrongFast);
      peer.onDataChannel.emit(wrongReliable);
      expect([unknown.closeCalls, wrongFast.closeCalls, wrongReliable.closeCalls]).toEqual([1, 1, 1]);

      const { fast, reliable } = acceptedChannels(peer);
      const duplicateFast = new FakeDataChannel('match-fast', false, 0);
      const duplicateReliable = new FakeDataChannel('match-reliable', true, null);
      peer.onDataChannel.emit(duplicateFast);
      peer.onDataChannel.emit(duplicateReliable);
      expect([duplicateFast.closeCalls, duplicateReliable.closeCalls]).toEqual([1, 1]);

      fast.readyState = 'open';
      expect(serverPeer.isReady()).toBe(false);
      reliable.readyState = 'open';
      expect(serverPeer.isReady()).toBe(true);
      expect([fast.closeCalls, reliable.closeCalls]).toEqual([0, 0]);
    } finally {
      await serverPeer.close();
    }
  });

  it('rejects a reliable-label channel with a finite packet lifetime', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();

    try {
      const timeLimitedReliable = new FakeDataChannel('match-reliable', true, null, 500);
      peer.onDataChannel.emit(timeLimitedReliable);

      expect(timeLimitedReliable.closeCalls).toBe(1);
      const { fast, reliable } = acceptedChannels(peer);
      fast.readyState = 'open';
      reliable.readyState = 'open';
      expect(serverPeer.isReady()).toBe(true);
    } finally {
      await serverPeer.close();
    }
  });

  it('delivers only string messages from both accepted channels and honors listener disposal', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();
    const fastMessages: string[] = [];
    const reliableMessages: string[] = [];
    const stopFast = serverPeer.onFastMessage((message) => fastMessages.push(message));
    const stopReliable = serverPeer.onReliableMessage((message) => reliableMessages.push(message));

    try {
      const { fast, reliable } = acceptedChannels(peer);
      fast.onMessage.emit('fast-1');
      reliable.onMessage.emit('reliable-1');
      fast.onMessage.emit(new Uint8Array([1]));
      reliable.onMessage.emit(new Uint8Array([2]));
      stopFast();
      stopReliable();
      fast.onMessage.emit('fast-2');
      reliable.onMessage.emit('reliable-2');

      expect(fastMessages).toEqual(['fast-1']);
      expect(reliableMessages).toEqual(['reliable-1']);
    } finally {
      await serverPeer.close();
    }
  });

  it('reports sent, exact-threshold sent, backpressure, unavailable, and send-failure states', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();

    try {
      expect(serverPeer.sendFast('before-open')).toBe('closed');
      expect(serverPeer.sendReliable('before-open')).toBe('closed');
      const { fast, reliable } = acceptedChannels(peer);
      fast.readyState = 'open';
      reliable.readyState = 'open';

      fast.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES;
      reliable.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES;
      expect(serverPeer.sendFast('fast-at-limit')).toBe('sent');
      expect(serverPeer.sendReliable('reliable-at-limit')).toBe('sent');

      fast.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES + 1;
      reliable.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES + 1;
      expect(serverPeer.sendFast('fast-over-limit')).toBe('backpressured');
      expect(serverPeer.sendReliable('reliable-over-limit')).toBe('backpressured');
      expect(fast.sent).toEqual(['fast-at-limit']);
      expect(reliable.sent).toEqual(['reliable-at-limit']);

      fast.bufferedAmount = 0;
      reliable.bufferedAmount = 0;
      fast.sendError = new Error('fast send failed');
      reliable.sendError = new Error('reliable send failed');
      expect(serverPeer.sendFast('fast-error')).toBe('closed');
      expect(serverPeer.sendReliable('reliable-error')).toBe('closed');

      fast.readyState = 'closed';
      reliable.readyState = 'closed';
      fast.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES + 1;
      reliable.bufferedAmount = FAST_CHANNEL_MAX_BUFFERED_BYTES + 1;
      expect(serverPeer.sendFast('closed-fast')).toBe('closed');
      expect(serverPeer.sendReliable('closed-reliable')).toBe('closed');
    } finally {
      await serverPeer.close();
    }
  });

  it('notifies closure once for terminal connection states and honors listener disposal', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();
    const first = vi.fn();
    const removed = vi.fn();
    serverPeer.onClosed(first);
    const stopRemoved = serverPeer.onClosed(removed);
    stopRemoved();

    try {
      peer.connectionStateChange.emit('connected');
      peer.connectionStateChange.emit('failed');
      peer.connectionStateChange.emit('closed');

      expect(first).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
    } finally {
      await serverPeer.close();
    }
  });

  it('closes channels, subscriptions, and the UDP peer exactly once', async () => {
    const { serverPeer, peer } = await loadFakeAdapter();
    const { fast, reliable } = acceptedChannels(peer);
    const closeListener = vi.fn();
    serverPeer.onClosed(closeListener);

    await Promise.all([serverPeer.close(), serverPeer.close()]);
    await serverPeer.close();

    expect(peer.closeCalls).toBe(1);
    expect(fast.closeCalls).toBe(1);
    expect(reliable.closeCalls).toBe(1);
    expect(peer.onDataChannel.subscriberCount).toBe(0);
    expect(peer.connectionStateChange.subscriberCount).toBe(0);
    expect(fast.onMessage.subscriberCount).toBe(0);
    expect(reliable.onMessage.subscriberCount).toBe(0);
    expect(closeListener).not.toHaveBeenCalled();
  });

});

describe.sequential('Chromium interoperability', () => {
  it('negotiates both channels and exchanges messages in both directions', async () => {
    vi.doUnmock('werift');
    vi.resetModules();
    const { createWeriftServerPeer } = await import('./WeriftServerPeer.js');
    const serverPeer = createWeriftServerPeer({
      generationId: '8948bbda-0fd2-46ee-a512-5e67a25cf9c3',
      udpPortRange: [53100, 53131]
    });
    let browser: Browser | undefined;
    let page: Page | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      const offer = await page.evaluate(async () => {
        const state = globalThis as BrowserGlobalsForTest;
        const peer = new state.RTCPeerConnection({ iceServers: [] });
        const fast = peer.createDataChannel('match-fast', { ordered: false, maxRetransmits: 0 });
        const reliable = peer.createDataChannel('match-reliable', { ordered: true });
        Object.assign(state, { task4Peer: peer, task4Fast: fast, task4Reliable: reliable });
        const draft = await peer.createOffer();
        await peer.setLocalDescription(draft);
        if (peer.iceGatheringState !== 'complete') {
          await new Promise<void>((resolve, reject) => {
            const timeout = globalThis.setTimeout(() => reject(new Error('Chromium ICE gathering timed out.')), 3_000);
            peer.addEventListener('icegatheringstatechange', () => {
              if (peer.iceGatheringState !== 'complete') return;
              globalThis.clearTimeout(timeout);
              resolve();
            });
          });
        }
        if (!peer.localDescription) throw new Error('Chromium did not produce a local description.');
        return { type: 'offer' as const, sdp: peer.localDescription.sdp };
      });

      const fastFromBrowser = new Promise<string>((resolve) => serverPeer.onFastMessage(resolve));
      const reliableFromBrowser = new Promise<string>((resolve) => serverPeer.onReliableMessage(resolve));
      const answer = await serverPeer.negotiate(offer);
      expect(answer.sdp).toMatch(/^v=/);
      await page.evaluate(async (remoteAnswer) => {
        const state = globalThis as BrowserGlobalsForTest;
        if (!state.task4Peer || !state.task4Fast || !state.task4Reliable) {
          throw new Error('Chromium peer fixture was not initialized.');
        }
        await state.task4Peer.setRemoteDescription(remoteAnswer);
        await Promise.all([state.task4Fast, state.task4Reliable].map((channel) => {
          if (channel.readyState === 'open') return Promise.resolve();
          return new Promise<void>((resolve, reject) => {
            const timeout = globalThis.setTimeout(() => reject(new Error(`${channel.label} did not open.`)), 5_000);
            channel.addEventListener('open', () => {
              globalThis.clearTimeout(timeout);
              resolve();
            }, { once: true });
          });
        }));
        const messages: string[] = [];
        state.task4Fast.addEventListener('message', (event) => messages.push(`fast:${String(event.data)}`));
        state.task4Reliable.addEventListener('message', (event) => messages.push(`reliable:${String(event.data)}`));
        state.task4Messages = messages;
        state.task4Fast.send('browser-fast');
        state.task4Reliable.send('browser-reliable');
      }, answer);

      expect(serverPeer.isReady()).toBe(true);
      await expect(fastFromBrowser).resolves.toBe('browser-fast');
      await expect(reliableFromBrowser).resolves.toBe('browser-reliable');
      expect(serverPeer.sendFast('server-fast')).toBe('sent');
      expect(serverPeer.sendReliable('server-reliable')).toBe('sent');
      await expect.poll(async () => page?.evaluate(() => {
        const state = globalThis as BrowserGlobalsForTest;
        return state.task4Messages ?? [];
      })).toEqual(['fast:server-fast', 'reliable:server-reliable']);
    } finally {
      if (page) {
        await page.evaluate(() => {
          const state = globalThis as BrowserGlobalsForTest;
          state.task4Peer?.close();
        }).catch(() => undefined);
      }
      await Promise.allSettled([
        serverPeer.close(),
        page?.close() ?? Promise.resolve(),
        browser?.close() ?? Promise.resolve()
      ]);
    }
  }, 15_000);
});

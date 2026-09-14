import { afterEach, expect, it, vi } from 'vitest';
import { createDirectPeer, description } from './PeerLink.js';

afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});

it('uses only the free STUN endpoint for direct connections without relay credentials', () => {
  const constructor = vi.fn(function () {});
  vi.stubGlobal('RTCPeerConnection', constructor);
  createDirectPeer();
  expect(constructor).toHaveBeenCalledWith({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
});

function gatheringPeer(sdp: string) {
  return Object.assign(new EventTarget(), {
    iceGatheringState: 'gathering',
    localDescription: {sdp},
    createOffer: async () => ({type: 'offer', sdp}),
    setLocalDescription: async () => {}
  }) as unknown as RTCPeerConnection;
}

it('keeps a usable LAN candidate when STUN gathering stalls', async () => {
  vi.useFakeTimers();
  const sdp = 'v=0\r\na=candidate:1 1 udp 1 192.0.2.1 1234 typ host\r\n';
  const result = expect(description(gatheringPeer(sdp), 'offer')).resolves.toBe(sdp);
  await Promise.all([result, vi.advanceTimersByTimeAsync(8_000)]);
});

it('fails within the gathering deadline when no network candidate is available', async () => {
  vi.useFakeTimers();
  const result = expect(description(gatheringPeer('v=0\r\n'), 'offer')).rejects.toThrow('Bağlantı adresi alınamadı.');
  await Promise.all([result, vi.advanceTimersByTimeAsync(8_000)]);
});

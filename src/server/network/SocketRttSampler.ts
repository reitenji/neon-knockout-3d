import type { NetworkProbe, NetworkProbeAcknowledgement } from '../../shared/protocol.js';

type SocketRttSample = Readonly<{ rttMs: number; sampledAtMs: number }>;

type SocketRttSamplerOptions = Readonly<{
  now: () => number;
  send: (
    probe: NetworkProbe,
    acknowledge: (acknowledgement: NetworkProbeAcknowledgement) => void
  ) => void;
  onSample: (sample: SocketRttSample) => void;
  onUnavailable: () => void;
}>;

const SAMPLE_INTERVAL_MS = 1_000;
export const PROBE_TIMEOUT_MS = 2_000;

export class SocketRttSampler {
  private active = false;
  private nonce = 0;
  private pendingNonce: number | null = null;
  private nextProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SocketRttSamplerOptions) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.sendProbe();
  }

  stop(): void {
    this.active = false;
    this.pendingNonce = null;
    if (this.nextProbeTimer !== null) clearTimeout(this.nextProbeTimer);
    if (this.probeTimeout !== null) clearTimeout(this.probeTimeout);
    this.nextProbeTimer = null;
    this.probeTimeout = null;
  }

  private sendProbe(): void {
    if (!this.active || this.pendingNonce !== null) return;
    const nonce = ++this.nonce;
    const sentAtMs = this.options.now();
    this.pendingNonce = nonce;
    this.probeTimeout = setTimeout(() => {
      if (!this.active || this.pendingNonce !== nonce) return;
      this.pendingNonce = null;
      this.probeTimeout = null;
      this.options.onUnavailable();
      this.scheduleNext(sentAtMs);
    }, PROBE_TIMEOUT_MS);
    this.options.send({ nonce }, (acknowledgement) => {
      if (
        !this.active
        || this.pendingNonce !== nonce
        || acknowledgement?.nonce !== nonce
      ) return;
      if (this.probeTimeout !== null) clearTimeout(this.probeTimeout);
      this.probeTimeout = null;
      this.pendingNonce = null;
      const sampledAtMs = this.options.now();
      this.options.onSample({ rttMs: Math.max(0, sampledAtMs - sentAtMs), sampledAtMs });
      this.scheduleNext(sentAtMs);
    });
  }

  private scheduleNext(previousSentAtMs: number): void {
    if (!this.active) return;
    const delayMs = Math.max(0, previousSentAtMs + SAMPLE_INTERVAL_MS - this.options.now());
    if (delayMs === 0) {
      this.sendProbe();
      return;
    }
    this.nextProbeTimer = setTimeout(() => {
      this.nextProbeTimer = null;
      this.sendProbe();
    }, delayMs);
  }
}

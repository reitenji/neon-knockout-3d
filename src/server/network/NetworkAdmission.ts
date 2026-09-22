export type NetworkResourceLimits = Readonly<{
  maxConnections: number;
  maxConnectionsPerSource: number;
  maxRooms: number;
  roomCreationsPerMinutePerSource: number;
}>;

export const DEFAULT_NETWORK_RESOURCE_LIMITS: NetworkResourceLimits = {
  maxConnections: 256,
  maxConnectionsPerSource: 16,
  maxRooms: 128,
  roomCreationsPerMinutePerSource: 6
};

type SourceState = {
  connections: number;
  roomCreationTimestamps: number[];
};

/** Server-wide admission accounting shared by every socket. */
export class NetworkAdmission {
  private readonly sources = new Map<string, SourceState>();
  private connections = 0;

  constructor(
    private readonly limits: NetworkResourceLimits,
    private readonly now: () => number,
    private readonly liveRoomCount: () => number
  ) {}

  admitConnection(source: string): boolean {
    if (this.connections >= this.limits.maxConnections) return false;
    const existing = this.sources.get(source);
    if ((existing?.connections ?? 0) >= this.limits.maxConnectionsPerSource) return false;
    const state = existing ?? this.sourceState(source);
    this.connections++;
    state.connections++;
    return true;
  }

  releaseConnection(source: string): void {
    const state = this.sources.get(source);
    if (!state || state.connections === 0) return;
    this.connections--;
    state.connections--;
    const windowStart = this.now() - 60_000;
    state.roomCreationTimestamps = state.roomCreationTimestamps.filter((timestamp) => timestamp > windowStart);
    this.removeSourceIfEmpty(source, state);
  }

  admitRoomCreation(source: string): boolean {
    if (this.liveRoomCount() >= this.limits.maxRooms) return false;
    const state = this.sourceState(source);
    const windowStart = this.now() - 60_000;
    state.roomCreationTimestamps = state.roomCreationTimestamps.filter((timestamp) => timestamp > windowStart);
    if (state.roomCreationTimestamps.length >= this.limits.roomCreationsPerMinutePerSource) return false;
    state.roomCreationTimestamps.push(this.now());
    return true;
  }

  private sourceState(source: string): SourceState {
    const existing = this.sources.get(source);
    if (existing) return existing;
    const created = { connections: 0, roomCreationTimestamps: [] };
    this.sources.set(source, created);
    return created;
  }

  private removeSourceIfEmpty(source: string, state: SourceState): void {
    if (state.connections === 0 && state.roomCreationTimestamps.length === 0) this.sources.delete(source);
  }
}

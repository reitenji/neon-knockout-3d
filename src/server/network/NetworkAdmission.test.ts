import { describe, expect, it } from 'vitest';
import { NetworkAdmission, type NetworkResourceLimits } from './NetworkAdmission.js';

const limits: NetworkResourceLimits = {
  maxConnections: 3,
  maxConnectionsPerSource: 2,
  maxRooms: 2,
  roomCreationsPerMinutePerSource: 2
};

describe('NetworkAdmission', () => {
  it('enforces server-wide and per-source connection limits and releases capacity', () => {
    const admission = new NetworkAdmission(limits, () => 0, () => 0);

    expect(admission.admitConnection('a')).toBe(true);
    expect(admission.admitConnection('a')).toBe(true);
    expect(admission.admitConnection('a')).toBe(false);
    expect(admission.admitConnection('b')).toBe(true);
    expect(admission.admitConnection('c')).toBe(false);

    admission.releaseConnection('a');
    expect(admission.admitConnection('c')).toBe(true);
  });

  it('bounds retained source quotas and reclaims them after their rate window', () => {
    let now = 0;
    const admission = new NetworkAdmission(limits, () => now, () => 0);
    for (const source of ['a', 'b', 'c']) {
      expect(admission.admitConnection(source)).toBe(true);
      expect(admission.admitRoomCreation(source)).toBe(true);
      admission.releaseConnection(source);
    }
    expect(admission.admitConnection('d')).toBe(false);
    now = 60_001;
    expect(admission.admitConnection('d')).toBe(true);
    expect(admission.admitRoomCreation('d')).toBe(true);
  });

  it('limits room allocation per source and across the server', () => {
    let now = 1_000;
    let rooms = 0;
    const admission = new NetworkAdmission(limits, () => now, () => rooms);

    expect(admission.admitRoomCreation('a')).toBe(true);
    expect(admission.admitRoomCreation('a')).toBe(true);
    expect(admission.admitRoomCreation('a')).toBe(false);
    expect(admission.admitRoomCreation('b')).toBe(true);

    now += 60_001;
    expect(admission.admitRoomCreation('a')).toBe(true);
    rooms = 2;
    expect(admission.admitRoomCreation('c')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { fighterMotion } from './fighterMotion.js';

describe('fighter choreography', () => {
  it('shows distinct anticipation, contact and recovery without moving the gameplay root', () => {
    const anticipation = fighterMotion('RIFT', 'quick-1', 0, 0, false);
    const contact = fighterMotion('RIFT', 'quick-1', 0.4, 0, false);
    const recovery = fighterMotion('RIFT', 'quick-1', 1, 0, false);
    expect(contact.leftArm).not.toBe(anticipation.leftArm);
    expect(Math.abs(recovery.lean)).toBeLessThan(Math.abs(contact.lean));
  });
  it('gives heavy and spectral fighters different movement and respects reduced motion', () => {
    const heavy = fighterMotion('BASTION', 'move', 0.35, 1, false);
    const ghost = fighterMotion('WRAITH', 'move', 0.35, 1, false);
    const reduced = fighterMotion('WRAITH', 'idle', 0.35, 0, true);
    expect(heavy.leg).not.toBe(ghost.leg);
    expect(reduced.bob).toBe(0);
  });
});

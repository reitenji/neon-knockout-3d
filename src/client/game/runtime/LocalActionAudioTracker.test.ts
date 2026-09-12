import { describe, expect, it } from 'vitest';
import { GAME } from '../../../shared/constants.js';
import type { MatchAction } from '../../../shared/model.js';
import { LocalActionAudioTracker } from './LocalActionAudioTracker.js';

const neutralMetadata = {
  charging: false, attackId: null, profileId: null, lockedFacing: null, activeProgress: 0, hitTargetIds: []
} as const;

const quick = (kind: 'QUICK_1' | 'QUICK_2' | 'QUICK_3' = 'QUICK_1'): MatchAction => ({
  kind,
  phase: 'WINDUP',
  comboStep: kind === 'QUICK_1' ? 1 : kind === 'QUICK_2' ? 2 : 3,
  chargeMs: 0,
  ...neutralMetadata
});

const heavy = (
  chargeMs: number,
  charging = true,
  attackId: number | null = null
): MatchAction => ({
  kind: 'HEAVY',
  phase: 'WINDUP',
  comboStep: 0,
  chargeMs,
  ...neutralMetadata,
  charging,
  attackId,
  profileId: attackId === null ? null : 'heavy-melee',
  lockedFacing: attackId === null ? null : { x: 1, y: 0 }
});

const dash: MatchAction = {
  kind: 'DASH',
  phase: 'ACTIVE',
  comboStep: 0,
  chargeMs: 0,
  ...neutralMetadata
};

describe('LocalActionAudioTracker', () => {
  it('emits quick and dash only when their predicted action starts', () => {
    const tracker = new LocalActionAudioTracker();

    expect(tracker.consume(quick())).toEqual(['quick']);
    expect(tracker.consume(quick())).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(quick('QUICK_2'))).toEqual(['quick']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(dash)).toEqual(['dash']);
    expect(tracker.consume(dash)).toEqual([]);
  });

  it('emits one charge cue while held and one release cue after a committed charge', () => {
    const tracker = new LocalActionAudioTracker();

    expect(tracker.consume(heavy(16))).toEqual(['heavy-charge']);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs / 2))).toEqual([]);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs - 1))).toEqual([]);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs - 1, false))).toEqual(['heavy-release']);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs - 1, false))).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
  });

  it('binds one predicted cue to its authoritative attack ID without replaying it', () => {
    const tracker = new LocalActionAudioTracker();

    expect(tracker.consume(quick())).toEqual(['quick']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume({
      ...quick(), attackId: 12, profileId: 'quick-1', lockedFacing: { x: 1, y: 0 }
    })).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume({
      ...quick(), phase: 'ACTIVE', attackId: 12, profileId: 'quick-1', lockedFacing: { x: 1, y: 0 }
    })).toEqual([]);
  });

  it('cues distinct same-kind predictions once and binds both acknowledgements without replay', () => {
    const tracker = new LocalActionAudioTracker();
    const firstAcknowledgement = {
      ...quick(), attackId: 14, profileId: 'quick-1' as const, lockedFacing: { x: 1, y: 0 }
    };
    const secondAcknowledgement = { ...firstAcknowledgement, attackId: 15 };

    expect(tracker.consume(quick())).toEqual(['quick']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(quick())).toEqual(['quick']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(firstAcknowledgement)).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(secondAcknowledgement)).toEqual([]);
  });

  it('emits a new cue for a new authoritative attack ID of the same kind', () => {
    const tracker = new LocalActionAudioTracker();
    const first = { ...quick(), attackId: 20, profileId: 'quick-1' as const, lockedFacing: { x: 1, y: 0 } };
    const second = { ...first, attackId: 21 };

    expect(tracker.consume(first)).toEqual(['quick']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(first)).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(second)).toEqual(['quick']);
  });

  it('does not replay charge or release when a predicted heavy receives its attack ID', () => {
    const tracker = new LocalActionAudioTracker();

    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs / 2))).toEqual(['heavy-charge']);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs / 2, false))).toEqual(['heavy-release']);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs / 2, false, 30))).toEqual([]);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(heavy(GAME.heavyMaxChargeMs / 2, false, 30))).toEqual([]);
  });

  it('emits release for a positive tap but not for a charge cancelled into dash', () => {
    const tracker = new LocalActionAudioTracker();

    expect(tracker.consume(heavy(1))).toEqual(['heavy-charge']);
    expect(tracker.consume(heavy(1, false))).toEqual(['heavy-release']);
    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(heavy(1))).toEqual(['heavy-charge']);
    expect(tracker.consume(dash)).toEqual(['dash']);
    expect(tracker.consume(null)).toEqual([]);
  });

  it('can reset without turning a held charge into a release', () => {
    const tracker = new LocalActionAudioTracker();

    tracker.consume(heavy(180));
    tracker.reset();

    expect(tracker.consume(null)).toEqual([]);
    expect(tracker.consume(quick())).toEqual(['quick']);
  });
});

import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { CHASSIS } from '../../../shared/model.js';
import { createFighterModel } from './FighterModel.js';

describe('authored fighter models', () => {
  it('gives every fighter a unique silhouette and articulated strike limbs', () => {
    const sizes = CHASSIS.map((chassis) => {
      const fighter = createFighterModel(chassis);
      const bounds = new Box3().setFromObject(fighter.root);
      const signature = [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z].map(Math.round).join(',');
      expect(fighter.leftArm.children.length).toBeGreaterThan(0);
      expect(fighter.rightArm.children.length).toBeGreaterThan(0);
      fighter.dispose();
      return signature;
    });
    expect(new Set(sizes).size).toBe(4);
  });
});

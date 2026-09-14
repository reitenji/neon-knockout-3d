import { describe, expect, it } from 'vitest';

import { ARENA, GAME } from '../../shared/constants.js';
import {
  distanceToPolygon,
  isKnockedOut,
  nearestEdgeNormal,
  pointInConvexPolygon
} from './geometry.js';
import { platformAt } from './movement.js';

describe('deterministic knockout geometry', () => {
  it('uses all eight regulation and minimum platform vertices', () => {
    expect(platformAt(0).vertices).toEqual(ARENA.regulationVertices);
    expect(platformAt(1).vertices).toEqual(ARENA.minimumVertices);
    expect(platformAt(0).vertices).toHaveLength(8);
    expect(platformAt(1).vertices).toHaveLength(8);
  });

  it('interpolates each platform vertex without rounding', () => {
    expect(platformAt(0.5).vertices[0]).toEqual({ x: 280, y: 120 });
    expect(platformAt(0.5).vertices[3]).toEqual({ x: 1080, y: 520 });
  });

  it('reports zero distance inside the polygon and exact outside segment distance', () => {
    const vertices = platformAt(0).vertices;

    expect(pointInConvexPolygon({ x: 640, y: 360 }, vertices)).toBe(true);
    expect(pointInConvexPolygon({ x: 640, y: 0 }, vertices)).toBe(false);
    expect(distanceToPolygon({ x: 640, y: 360 }, vertices)).toBe(0);
    expect(distanceToPolygon({ x: 640, y: 50 }, vertices)).toBe(40);
  });

  it('uses the nearest outward edge normal and visible platform edge', () => {
    const platform = platformAt(0);

    expect(nearestEdgeNormal({ x: 640, y: 50 }, platform.vertices)).toEqual({ x: 0, y: -1 });
    expect(isKnockedOut({ x: 640, y: 90 }, platform)).toBe(false);
    expect(isKnockedOut({ x: 640, y: 89.9 }, platform)).toBe(true);
    expect(GAME.knockoutDistance).toBe(0);
  });
});

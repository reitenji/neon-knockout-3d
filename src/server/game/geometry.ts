import type { Vec2 } from '../../shared/model.js';

export type Segment = Readonly<{ start: Vec2; end: Vec2 }>;
export type PolygonGeometry = Readonly<{ vertices: readonly Vec2[] }>;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y);
}

export function normalize(vector: Vec2, fallback: Vec2 = { x: 0, y: 0 }): Vec2 {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return fallback;
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

export function add(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x + right.x, y: left.y + right.y };
}

export function subtract(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x - right.x, y: left.y - right.y };
}

export function scale(vector: Vec2, scalar: number): Vec2 {
  return { x: vector.x * scalar, y: vector.y * scalar };
}

export function dot(left: Vec2, right: Vec2): number {
  return left.x * right.x + left.y * right.y;
}

export function distance(left: Vec2, right: Vec2): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function lerp(left: Vec2, right: Vec2, alpha: number): Vec2 {
  return {
    x: left.x + (right.x - left.x) * alpha,
    y: left.y + (right.y - left.y) * alpha
  };
}

export function polygonSegments(vertices: readonly Vec2[]): readonly Segment[] {
  return vertices.map((start, index) => ({
    start,
    end: vertices[(index + 1) % vertices.length]
  }));
}

function closestPointOnSegment(point: Vec2, segment: Segment): Vec2 {
  const segmentVector = subtract(segment.end, segment.start);
  const segmentLengthSquared = dot(segmentVector, segmentVector);
  if (segmentLengthSquared <= 1e-9) return segment.start;
  const projection = dot(subtract(point, segment.start), segmentVector) / segmentLengthSquared;
  return lerp(segment.start, segment.end, clamp(projection, 0, 1));
}

export function pointInConvexPolygon(point: Vec2, vertices: readonly Vec2[]): boolean {
  if (vertices.length < 3) return false;

  let direction = 0;
  for (const segment of polygonSegments(vertices)) {
    const cross =
      (segment.end.x - segment.start.x) * (point.y - segment.start.y) -
      (segment.end.y - segment.start.y) * (point.x - segment.start.x);
    if (Math.abs(cross) <= 1e-9) continue;
    const currentDirection = Math.sign(cross);
    if (direction !== 0 && currentDirection !== direction) return false;
    direction = currentDirection;
  }

  return true;
}

export function closestPointOnPolygon(point: Vec2, vertices: readonly Vec2[]): Vec2 {
  const segments = polygonSegments(vertices);
  let best = segments[0] ? closestPointOnSegment(point, segments[0]) : point;
  let bestDistance = distance(point, best);
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = closestPointOnSegment(point, segments[index]);
    const candidateDistance = distance(point, candidate);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

export function distanceToPolygon(point: Vec2, vertices: readonly Vec2[]): number {
  if (pointInConvexPolygon(point, vertices)) return 0;
  return distance(point, closestPointOnPolygon(point, vertices));
}

export function nearestEdgeNormal(point: Vec2, vertices: readonly Vec2[]): Vec2 {
  if (vertices.length < 2) return { x: 0, y: -1 };

  const segments = polygonSegments(vertices);
  let nearest = segments[0]!;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const edgePoint = closestPointOnSegment(point, segment);
    const edgeDistance = distance(point, edgePoint);
    if (edgeDistance < nearestDistance) {
      nearest = segment;
      nearestDistance = edgeDistance;
    }
  }

  const signedArea = vertices.reduce(
    (total, vertex, index) => {
      const next = vertices[(index + 1) % vertices.length];
      return total + vertex.x * next.y - next.x * vertex.y;
    },
    0
  );
  const edge = subtract(nearest.end, nearest.start);
  return normalize(
    signedArea >= 0 ? { x: edge.y, y: -edge.x } : { x: -edge.y, y: edge.x },
    { x: 0, y: -1 }
  );
}

export function isKnockedOut(point: Vec2, platform: PolygonGeometry, threshold = 0): boolean {
  return distanceToPolygon(point, platform.vertices) > threshold;
}

/** Anchor the fall at the crossed visible edge, including a fast tick's overshoot. */
export function platformExitPoint(from: Vec2, to: Vec2, vertices: readonly Vec2[]): Vec2 {
  if (!pointInConvexPolygon(from, vertices)) return closestPointOnPolygon(to, vertices);
  let inside = from;
  let outside = to;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const midpoint = lerp(inside, outside, 0.5);
    if (pointInConvexPolygon(midpoint, vertices)) inside = midpoint;
    else outside = midpoint;
  }
  return closestPointOnPolygon(inside, vertices);
}

export function separateCircles(
  left: Vec2,
  right: Vec2,
  radius: number
): Readonly<{ left: Vec2; right: Vec2 }> {
  const delta = subtract(right, left);
  const gap = radius * 2 - length(delta);
  if (gap <= 0) return { left, right };
  const direction = normalize(delta, { x: 1, y: 0 });
  const correction = scale(direction, gap / 2);
  return {
    left: subtract(left, correction),
    right: add(right, correction)
  };
}

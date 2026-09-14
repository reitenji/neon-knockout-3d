import * as THREE from 'three';
import type { FighterModel } from './FighterModel.js';

const down = new THREE.Vector3(0, -1, 0);
const rootTarget = new THREE.Vector3();
const target = new THREE.Vector3();
const axis = new THREE.Vector3();
const bend = new THREE.Vector3();
const kneePoint = new THREE.Vector3();
const upperRotation = new THREE.Quaternion();
const lowerRotation = new THREE.Quaternion();
const footRotation = new THREE.Quaternion();

/** Two-bone IK anchors the soles to root-local ground despite torso weight transfer. */
export function placeGroundedFeet(model: FighterModel, phase: number, moving: boolean, direction: { x: number; z: number }, bulky: boolean, weight = 1): void {
  model.root.updateMatrixWorld(true);
  const stride = bulky ? 16 : 22;
  for (const [index, leg, knee, foot] of [
    [0, model.leftLeg, model.leftKnee, model.leftFoot],
    [1, model.rightLeg, model.rightKnee, model.rightFoot]
  ] as const) {
    const cycle = ((phase + index * 0.5) % 1 + 1) % 1;
    const planted = cycle < 0.6;
    const swing = (cycle - 0.6) / 0.4;
    // During stance the foot travels backwards at root speed; only the free foot lifts.
    const offset = moving ? weight * stride * (planted ? 0.5 - cycle / 0.6 : -0.5 + swing) : 0;
    const lift = moving && !planted ? weight * Math.sin(swing * Math.PI) * (bulky ? 5 : 8) : 0;
    rootTarget.set(leg.position.x + direction.x * offset, 3.5 + lift, direction.z * offset);
    model.root.localToWorld(rootTarget);
    target.copy(rootTarget); model.body.worldToLocal(target); target.sub(leg.position);
    const length = Math.min(22.95, Math.max(3.05, target.length()));
    axis.copy(target).normalize();
    bend.set(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
    const along = (13 * 13 - 10 * 10 + length * length) / (2 * length);
    kneePoint.copy(axis).multiplyScalar(along).addScaledVector(bend, Math.sqrt(Math.max(0, 13 * 13 - along * along)));
    upperRotation.setFromUnitVectors(down, kneePoint.clone().normalize());
    lowerRotation.setFromUnitVectors(down, target.clone().addScaledVector(axis, length - target.length()).sub(kneePoint).normalize());
    leg.quaternion.copy(upperRotation);
    knee.quaternion.copy(upperRotation).invert().multiply(lowerRotation);
    model.root.updateMatrixWorld(true);
    knee.getWorldQuaternion(footRotation).invert();
    foot.quaternion.copy(footRotation).multiply(model.root.getWorldQuaternion(lowerRotation));
  }
}

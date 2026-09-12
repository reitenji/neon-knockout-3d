import * as THREE from 'three';
import type { MatchPulse } from '../../../shared/model.js';
import { worldPoint } from './ArenaWorld.js';
import { disposeObject } from './FighterModel.js';

export function createPulseView(scene: THREE.Scene, pulse: MatchPulse) {
  const root = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(11, 12, 8), new THREE.MeshBasicMaterial({ color: 0xe5fcff }));
  const shell = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 8), new THREE.MeshBasicMaterial({ color: 0x5cdeef, transparent: true, opacity: 0.35, depthWrite: false }));
  const tail = new THREE.Mesh(new THREE.ConeGeometry(12, 50, 8), new THREE.MeshBasicMaterial({ color: 0x43b8da, transparent: true, opacity: 0.45, depthWrite: false }));
  tail.rotation.x = -Math.PI / 2; tail.position.z = -25;
  root.add(core, shell, tail); scene.add(root);
  const apply = (next: MatchPulse): void => { root.position.copy(worldPoint(next.position, 34)); root.rotation.y = Math.atan2(next.velocity.x, next.velocity.y); };
  apply(pulse);
  return { apply, destroy: () => disposeObject(root) };
}
export type PulseView = ReturnType<typeof createPulseView>;

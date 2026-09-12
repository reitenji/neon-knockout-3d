import * as THREE from 'three';
import type { Chassis } from '../../../shared/model.js';

export const FIGHTER_COLORS: Readonly<Record<Chassis, number>> = {
  RIFT: 0x58dced, BASTION: 0xf6b65d, PULSE: 0xff668d, WRAITH: 0xb79aff
};

export interface FighterModel {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftElbow: THREE.Group;
  rightElbow: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  ornaments: THREE.Group;
  glow: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  materials: readonly THREE.MeshStandardMaterial[];
  dispose(): void;
}

export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  root.removeFromParent();
}

/** Original, articulated robot silhouettes. Forward is local +Z, floor is Y=0. */
export function createFighterModel(chassis: Chassis): FighterModel {
  const root = new THREE.Group();
  root.name = `fighter-${chassis}`;
  const body = new THREE.Group();
  root.add(body);
  const armor = new THREE.MeshStandardMaterial({ color: chassis === 'PULSE' ? 0xe0e4e1 : FIGHTER_COLORS[chassis], roughness: 0.42, metalness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x152332, roughness: 0.56, metalness: 0.7 });
  const pale = new THREE.MeshStandardMaterial({ color: 0xe4edf2, roughness: 0.35, metalness: 0.5 });
  const glow = new THREE.MeshStandardMaterial({ color: FIGHTER_COLORS[chassis], emissive: FIGHTER_COLORS[chassis], emissiveIntensity: 1.6, roughness: 0.25 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x303e50, roughness: 0.7, metalness: 0.5 });
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = material !== glow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const box = (parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, x = 0, y = 0, z = 0) => add(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z);
  const sphere = (parent: THREE.Object3D, r: number, material: THREE.Material, x = 0, y = 0, z = 0) => add(parent, new THREE.SphereGeometry(r, 12, 8), material, x, y, z);
  const pivot = (parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Group => {
    const group = new THREE.Group(); group.position.set(x, y, z); parent.add(group); return group;
  };
  const bulky = chassis === 'BASTION';
  const floating = chassis === 'PULSE' || chassis === 'WRAITH';
  const shoulder = bulky ? 24 : chassis === 'PULSE' ? 23 : 16;
  const torsoHeight = bulky ? 43 : floating ? 48 : 44;
  const head = pivot(body, 0, bulky ? 64 : 68);
  const leftArm = pivot(body, shoulder, torsoHeight + 8);
  const rightArm = pivot(body, -shoulder, torsoHeight + 8);
  const leftElbow = pivot(leftArm, 0, -15);
  const rightElbow = pivot(rightArm, 0, -15);
  const leftLeg = pivot(body, bulky ? 12 : 9, 25);
  const rightLeg = pivot(body, bulky ? -12 : -9, 25);
  const ornaments = pivot(body, 0, torsoHeight);

  for (const [arm, elbow] of [[leftArm, leftElbow], [rightArm, rightElbow]]) {
    sphere(arm!, bulky ? 9 : 6, joint);
    box(arm!, bulky ? 17 : 9, 15, bulky ? 19 : 10, armor, 0, -7);
    sphere(elbow!, 5, joint);
    box(elbow!, bulky ? 20 : 10, bulky ? 20 : 17, bulky ? 24 : 13, dark, 0, -9, 2);
    box(elbow!, bulky ? 21 : 11, 6, bulky ? 25 : 14, armor, 0, -8, 2);
    box(elbow!, bulky ? 14 : 6, 3, 2, glow, 0, -13, bulky ? 15 : 9);
  }

  if (!floating) {
    for (const leg of [leftLeg, rightLeg]) {
      sphere(leg, bulky ? 7 : 5, joint);
      box(leg, bulky ? 15 : 9, 12, bulky ? 16 : 10, armor, 0, -6);
      sphere(leg, 4, joint, 0, -13);
      box(leg, bulky ? 16 : 9, 10, bulky ? 16 : 11, dark, 0, -18);
      box(leg, bulky ? 19 : 12, 7, bulky ? 27 : 20, armor, 0, -23, 4);
      box(leg, bulky ? 12 : 6, 2, 2, glow, 0, -22, bulky ? 18 : 15);
    }
  }

  if (chassis === 'RIFT') {
    add(body, new THREE.CylinderGeometry(13, 9, 26, 5), armor, 0, 43).rotation.y = Math.PI / 5;
    box(body, 18, 10, 15, dark, 0, 28);
    box(body, 17, 6, 4, pale, 0, 49, 11).rotation.z = -0.13;
    box(body, 4, 12, 3, glow, 0, 42, 12);
    add(head, new THREE.IcosahedronGeometry(10, 0), dark, 0, 0, 1).scale.set(0.8, 1.1, 1);
    box(head, 14, 3, 3, glow, 0, 1, 9);
    for (const sign of [-1, 1]) {
      const fin = box(body, 4, 25, 11, pale, sign * 17, 60, -7); fin.rotation.z = sign * -0.38;
      const blade = add(sign === 1 ? leftElbow : rightElbow, new THREE.ConeGeometry(5, 28, 3), pale, 0, -3, 17);
      blade.rotation.x = Math.PI / 2;
      box(sign === 1 ? leftElbow : rightElbow, 2, 2, 24, glow, 0, -3, 16);
    }
  } else if (chassis === 'BASTION') {
    box(body, 38, 32, 27, dark, 0, 43);
    box(body, 40, 16, 10, armor, 0, 50, 12);
    box(body, 30, 11, 8, armor, 0, 35, 13);
    box(body, 11, 9, 4, glow, 0, 50, 19);
    for (const sign of [-1, 1]) {
      box(body, 21, 13, 30, armor, sign * 25, 62).rotation.z = sign * -0.1;
      box(body, 12, 4, 20, pale, sign * 25, 69);
      for (let i = 0; i < 3; i++) box(body, 3, 7, 2, dark, sign * 25 + (i - 1) * 4, 62, 16);
    }
    box(head, 19, 16, 18, dark, 0, 4);
    box(head, 20, 5, 20, armor, 0, 13);
    box(head, 15, 3, 2, glow, 0, 5, 10);
    box(body, 29, 22, 12, armor, 0, 47, -20);
  } else if (chassis === 'PULSE') {
    sphere(body, 19, dark, 0, 48);
    sphere(body, 12, glow, 0, 48, 10);
    const ring = add(body, new THREE.TorusGeometry(21, 4, 6, 24), armor, 0, 48, 7);
    ring.rotation.y = 0;
    add(body, new THREE.ConeGeometry(13, 23, 8), armor, 0, 26).rotation.z = Math.PI;
    add(body, new THREE.ConeGeometry(6, 16, 8), glow, 0, 13).rotation.z = Math.PI;
    sphere(head, 8, pale, 0, 1);
    box(head, 13, 4, 3, dark, 0, 2, 7);
    sphere(head, 2.5, glow, 0, 2, 9);
    for (let i = 0; i < 3; i++) {
      const orbit = pivot(ornaments, Math.cos(i * Math.PI * 2 / 3) * 29, Math.sin(i * Math.PI * 2 / 3) * 15, -9);
      box(orbit, 7, 18, 11, armor).rotation.z = -i * Math.PI * 2 / 3;
      sphere(orbit, 3, glow, 0, 0, 7);
    }
    for (const elbow of [leftElbow, rightElbow]) {
      add(elbow, new THREE.CylinderGeometry(7, 8, 15, 12), pale, 0, -8, 8).rotation.x = Math.PI / 2;
      sphere(elbow, 5, glow, 0, -8, 17);
    }
  } else {
    add(body, new THREE.CylinderGeometry(12, 6, 26, 5), dark, 0, 44);
    add(body, new THREE.ConeGeometry(21, 39, 5), armor, 0, 28).rotation.z = Math.PI;
    box(body, 5, 22, 4, glow, 0, 43, 10);
    const hood = add(head, new THREE.ConeGeometry(15, 26, 5), armor, 0, 4, -3);
    hood.rotation.x = -0.18;
    add(head, new THREE.SphereGeometry(9, 8, 6), dark, 0, 0, 6).scale.set(0.85, 1, 0.7);
    box(head, 11, 2, 2, glow, 0, 1, 12);
    for (const sign of [-1, 1]) {
      const panel = box(ornaments, 9, 45, 3, dark, sign * 10, -15, -12); panel.rotation.z = sign * 0.17;
      box(ornaments, 2, 28, 2, glow, sign * 11, -17, -14);
      const elbow = sign === 1 ? leftElbow : rightElbow;
      for (let i = 0; i < 3; i++) {
        const claw = add(elbow, new THREE.ConeGeometry(1.6, 17, 4), pale, (i - 1) * 4, -20, 6);
        claw.rotation.x = -0.4;
      }
    }
  }
  root.updateMatrixWorld(true);
  return { root, body, head, leftArm, rightArm, leftElbow, rightElbow, leftLeg, rightLeg, ornaments, glow, armor, materials: [armor, dark, pale, glow, joint], dispose: () => disposeObject(root) };
}

import * as THREE from 'three';
import { CHASSIS, type Chassis } from '../../../shared/model.js';
import { FIGHTERS } from '../../../shared/fighters.js';

export const FIGHTER_COLORS = Object.fromEntries(CHASSIS.map(chassis =>
  [chassis, new THREE.Color(FIGHTERS[chassis].color).getHex()])) as Readonly<Record<Chassis, number>>;

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
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  leftFoot: THREE.Group;
  rightFoot: THREE.Group;
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
  const armor = new THREE.MeshStandardMaterial({ color: FIGHTER_COLORS[chassis], roughness: 0.42, metalness: 0.55 });
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
  const bulky = chassis === 'BASTION' || chassis === 'TITAN';
  const floating = chassis === 'PULSE' || chassis === 'WRAITH' || chassis === 'NOVA';
  const shoulder = bulky ? 24 : chassis === 'PULSE' ? 23 : 16;
  const torsoHeight = bulky ? 43 : floating ? 48 : 44;
  const head = pivot(body, 0, bulky ? 64 : 68);
  const leftArm = pivot(body, shoulder, torsoHeight + 8);
  const rightArm = pivot(body, -shoulder, torsoHeight + 8);
  const leftElbow = pivot(leftArm, 0, -15);
  const rightElbow = pivot(rightArm, 0, -15);
  const leftLeg = pivot(body, bulky ? 12 : 9, 25);
  const rightLeg = pivot(body, bulky ? -12 : -9, 25);
  const leftKnee = pivot(leftLeg, 0, -13);
  const rightKnee = pivot(rightLeg, 0, -13);
  const leftFoot = pivot(leftKnee, 0, -10);
  const rightFoot = pivot(rightKnee, 0, -10);
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
    for (const [leg, knee, foot] of [[leftLeg, leftKnee, leftFoot], [rightLeg, rightKnee, rightFoot]]) {
      sphere(leg!, bulky ? 7 : 5, joint);
      box(leg!, bulky ? 15 : 9, 12, bulky ? 16 : 10, armor, 0, -6);
      sphere(knee!, 4, joint);
      box(knee!, bulky ? 16 : 9, 9, bulky ? 16 : 11, dark, 0, -5);
      box(foot!, bulky ? 19 : 12, 7, bulky ? 27 : 20, armor, 0, 0, 4);
      box(foot!, bulky ? 12 : 6, 2, 2, glow, 0, 1, bulky ? 18 : 15);
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
  } else if (chassis === 'WRAITH') {
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
  if (chassis === 'EMBER') {
    // Furnace chest, two chimney stacks and piston fists.
    add(body, new THREE.CylinderGeometry(18, 15, 31, 8), armor, 0, 43);
    box(body, 23, 20, 7, dark, 0, 45, 15);
    for (let i = -1; i <= 1; i++) box(body, 4, 15, 3, glow, i * 7, 45, 20);
    sphere(head, 11, armor, 0, 1);
    box(head, 16, 5, 4, dark, 0, 2, 9);
    box(head, 10, 2, 3, glow, 0, 2, 12);
    for (const sign of [-1, 1]) {
      add(body, new THREE.CylinderGeometry(5, 7, 35, 8), dark, sign * 15, 66, -14);
      add(body, new THREE.CylinderGeometry(6, 6, 4, 8), glow, sign * 15, 85, -14);
      const elbow = sign === 1 ? leftElbow : rightElbow;
      add(elbow, new THREE.CylinderGeometry(11, 9, 22, 8), armor, 0, -8, 6).rotation.x = Math.PI / 2;
      sphere(elbow, 7, glow, 0, -8, 18);
    }
  } else if (chassis === 'VOLT') {
    // Lean runner with a lightning crest and swept ankle fins.
    add(body, new THREE.CylinderGeometry(10, 7, 27, 3), armor, 0, 44);
    box(body, 5, 19, 4, glow, 0, 44, 10).rotation.z = -0.25;
    add(head, new THREE.OctahedronGeometry(12), armor, 0, 2).scale.set(0.7, 1, 1.1);
    box(head, 17, 3, 4, glow, 0, 2, 9);
    const crest = add(head, new THREE.ConeGeometry(7, 25, 3), pale, 0, 22, -3);
    crest.rotation.z = -0.25;
    for (const sign of [-1, 1]) {
      box(body, 4, 29, 8, dark, sign * 14, 47, -11).rotation.z = sign * -0.55;
      const foot = sign === 1 ? leftFoot : rightFoot;
      add(foot, new THREE.ConeGeometry(5, 24, 3), armor, sign * 6, 9, -9).rotation.x = -0.7;
      box(sign === 1 ? leftElbow : rightElbow, 3, 4, 27, glow, 0, -7, 10);
    }
  } else if (chassis === 'TITAN') {
    // Tall riveted tank with massive hexagonal shoulder shields.
    box(body, 43, 42, 31, armor, 0, 48);
    box(body, 30, 27, 5, dark, 0, 50, 18);
    box(body, 5, 22, 3, glow, 0, 50, 22);
    box(body, 22, 5, 3, glow, 0, 50, 22);
    box(head, 23, 20, 22, armor, 0, 17);
    box(head, 15, 4, 3, glow, 0, 19, 13);
    for (const sign of [-1, 1]) {
      add(body, new THREE.CylinderGeometry(17, 17, 19, 6), dark, sign * 31, 65).rotation.z = Math.PI / 2;
      const elbow = sign === 1 ? leftElbow : rightElbow;
      box(elbow, 26, 27, 30, armor, sign * 3, -10, 5);
      for (const z of [-3, 7, 17]) sphere(elbow, 2, pale, sign * 17, -4, z);
    }
  } else if (chassis === 'NOVA') {
    // Satellite body suspended between four solar vanes and twin orbit rings.
    add(body, new THREE.OctahedronGeometry(20), armor, 0, 49).scale.set(0.8, 1.15, 0.8);
    sphere(body, 8, glow, 0, 48, 16);
    sphere(head, 10, dark, 0, 10);
    sphere(head, 5, glow, 0, 10, 9);
    for (const sign of [-1, 1]) {
      const ring = add(ornaments, new THREE.TorusGeometry(34, 1.8, 6, 40), glow, 0, 3);
      ring.rotation.x = sign * 0.8;
      for (const y of [-13, 13]) {
        box(ornaments, 16, 20, 4, armor, sign * 31, y, -5).rotation.z = sign * -0.22;
        box(ornaments, 11, 14, 2, dark, sign * 31, y, -2).rotation.z = sign * -0.22;
      }
    }
    add(body, new THREE.ConeGeometry(8, 22, 8), glow, 0, 16).rotation.z = Math.PI;
  }
  root.updateMatrixWorld(true);
  return { root, body, head, leftArm, rightArm, leftElbow, rightElbow, leftLeg, rightLeg, leftKnee, rightKnee, leftFoot, rightFoot, ornaments, glow, armor, materials: [armor, dark, pale, glow, joint], dispose: () => disposeObject(root) };
}

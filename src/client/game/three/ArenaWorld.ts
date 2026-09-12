import * as THREE from 'three';
import { ARENA } from '../../../shared/constants.js';
import type { Vec2 } from '../../../shared/model.js';
import { interpolateArenaVertices } from '../runtime/arenaVisualPlan.js';
import { disposeObject } from './FighterModel.js';

export function worldPoint(point: Vec2, height = 0): THREE.Vector3 {
  return new THREE.Vector3(point.x - ARENA.width / 2, height, point.y - ARENA.height / 2);
}

function platformGeometry(vertices: readonly Vec2[]): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  vertices.forEach((point, index) => {
    const x = point.x - ARENA.width / 2;
    const y = ARENA.height / 2 - point.y;
    if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 28, bevelEnabled: true, bevelSize: 3, bevelThickness: 3, bevelSegments: 1, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -31, 0);
  return geometry;
}

export function createArenaWorld(): {
  scene: THREE.Scene; camera: THREE.OrthographicCamera;
  resize(width: number, height: number): void; update(progress: number): void; dispose(): void;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060b16);
  scene.fog = new THREE.Fog(0x060b16, 1400, 2900);
  const camera = new THREE.OrthographicCamera(-680, 680, 420, -420, 1, 4000);
  camera.position.set(0, 950, 850);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xc0e3ff, 0x233246, 2.1));
  const key = new THREE.DirectionalLight(0xffeed8, 3.3);
  key.position.set(-320, 700, 280);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -650, right: 650, top: 550, bottom: -550, near: 100, far: 1600 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 1.2;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x59cce2, 1.7);
  rim.position.set(200, 200, -500); scene.add(rim);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x283b4c, roughness: 0.85, metalness: 0.2 });
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x111f30, roughness: 0.62, metalness: 0.55 });
  const platform = new THREE.Mesh(platformGeometry(ARENA.regulationVertices), [floorMaterial, wallMaterial]);
  platform.receiveShadow = true; scene.add(platform);
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ARENA.regulationVertices.map((p) => worldPoint(p, 3))), new THREE.LineBasicMaterial({ color: 0x89e4ed }));
  scene.add(edge);
  const decorations = new THREE.Group(); scene.add(decorations);
  const ink = new THREE.MeshBasicMaterial({ color: 0x66818d, transparent: true, opacity: 0.22, depthWrite: false });
  for (const radius of [90, 210]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 2, 64), ink);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 1; decorations.add(ring);
  }
  for (let i = 0; i < 8; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(34, 4), ink);
    const angle = i * Math.PI / 4;
    tick.rotation.x = -Math.PI / 2; tick.rotation.z = -angle;
    tick.position.set(Math.cos(angle) * 190, 1.2, Math.sin(angle) * 190); decorations.add(tick);
  }
  const center = new THREE.Mesh(new THREE.RingGeometry(19, 23, 4), new THREE.MeshBasicMaterial({ color: 0xb9d3d9, transparent: true, opacity: 0.65 }));
  center.rotation.x = -Math.PI / 2; center.position.y = 1.5; decorations.add(center);
  const pillars = new THREE.Group(); scene.add(pillars);
  for (let i = 0; i < 8; i++) {
    const angle = (i + 0.5) * Math.PI / 4;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(38, 200 + (i % 3) * 80, 38), wallMaterial);
    tower.position.set(Math.cos(angle) * 820, -140, Math.sin(angle) * 670);
    pillars.add(tower);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(39, 5, 39), new THREE.MeshBasicMaterial({ color: 0x3b94a8 }));
    beacon.position.copy(tower.position); beacon.position.y += 104 + (i % 3) * 40; pillars.add(beacon);
  }
  let lastProgress = -1;
  return {
    scene, camera,
    resize(width, height) {
      const aspect = width / Math.max(1, height);
      const viewHeight = Math.max(780, 1330 / aspect);
      camera.left = -viewHeight * aspect / 2; camera.right = -camera.left;
      camera.top = viewHeight / 2; camera.bottom = -camera.top; camera.updateProjectionMatrix();
    },
    update(progress) {
      if (Math.abs(progress - lastProgress) < 0.003) return;
      lastProgress = progress;
      const vertices = interpolateArenaVertices(progress);
      platform.geometry.dispose(); platform.geometry = platformGeometry(vertices);
      edge.geometry.dispose(); edge.geometry = new THREE.BufferGeometry().setFromPoints(vertices.map((p) => worldPoint(p, 3)));
      edge.material.color.set(progress > 0.1 ? 0xffa066 : 0x89e4ed);
      decorations.scale.setScalar(1 - progress * 0.65);
    },
    dispose() { disposeObject(scene); }
  };
}

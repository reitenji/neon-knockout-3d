import * as THREE from 'three';
import type { GameEvent, MatchSnapshot } from '../../../shared/model.js';
import { worldPoint } from './ArenaWorld.js';
import { disposeObject } from './FighterModel.js';

type Effect = { root: THREE.Group; ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>; sparks: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>[]; born: number; lifetime: number; size: number };
export class CombatEffects {
  private effects: Effect[] = [];
  constructor(private readonly scene: THREE.Scene, private readonly reducedMotion: boolean) {}
  ingest(event: GameEvent, snapshot: MatchSnapshot): void {
    const position = 'impactPosition' in event ? event.impactPosition : event.type === 'KNOCKOUT' ? snapshot.players.find((player) => player.playerId === event.targetId)?.position : event.type === 'RESPAWN' ? event.position : null;
    if (!position) return;
    const knockout = event.type === 'KNOCKOUT';
    const dodge = event.type === 'PERFECT_DODGE';
    const heavy = event.type === 'HIT' && (event.attack === 'HEAVY' || event.impulse >= 450);
    const root = new THREE.Group();
    root.position.copy(worldPoint(position, knockout ? 6 : 35));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, heavy ? 0.09 : 0.055, 4, 32), new THREE.MeshBasicMaterial({ color: knockout || heavy ? 0xffbd72 : dodge ? 0xc3a4ff : 0xedfaff, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.rotation.x = knockout || event.type === 'RESPAWN' ? -Math.PI / 2 : -Math.PI / 4;
    root.add(ring);
    const sparks: Effect['sparks'] = [];
    if (event.type === 'HIT' && !this.reducedMotion) {
      root.name = 'contact-sparks';
      const attacker = snapshot.players.find(player => player.playerId === event.attackerId);
      const heading = attacker ? Math.atan2(position.x - attacker.position.x, position.y - attacker.position.y) : 0;
      root.rotation.y = heading;
      for (let i = 0; i < (heavy ? 8 : 5); i++) {
        const spark = new THREE.Mesh(new THREE.ConeGeometry(heavy ? 1.6 : 1, heavy ? 15 : 10, 4), ring.material);
        const fan = (i / ((heavy ? 8 : 5) - 1) - 0.5) * 1.7;
        spark.userData.direction = new THREE.Vector3(Math.sin(fan) * 0.8, (i % 3 - 1) * 0.3 + 0.1, Math.cos(fan));
        spark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), (spark.userData.direction as THREE.Vector3).clone().normalize());
        root.add(spark); sparks.push(spark);
      }
    }
    this.scene.add(root);
    this.effects.push({ root, ring, sparks, born: performance.now(), lifetime: knockout ? 450 : heavy ? 290 : 220, size: knockout ? 80 : dodge ? 40 : heavy ? 38 : 24 });
    if (this.effects.length > 32) disposeObject(this.effects.shift()!.root);
  }
  update(now: number): void {
    this.effects = this.effects.filter((effect) => {
      const t = Math.max(0, (now - effect.born) / effect.lifetime);
      if (t >= 1) { disposeObject(effect.root); return false; }
      effect.ring.scale.setScalar(effect.size * (this.reducedMotion ? 0.7 : 0.25 + t));
      effect.ring.material.opacity = (1 - t) * 0.85;
      for (const spark of effect.sparks) {
        spark.position.copy(spark.userData.direction as THREE.Vector3).multiplyScalar(5 + t * effect.size * 1.8);
        spark.scale.setScalar(1 - t * 0.65);
      }
      return true;
    });
  }
  dispose(): void { this.effects.forEach(({ root }) => disposeObject(root)); this.effects = []; }
}

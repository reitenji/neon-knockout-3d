import * as THREE from 'three';
import type { GameEvent, MatchSnapshot } from '../../../shared/model.js';
import { worldPoint } from './ArenaWorld.js';
import { disposeObject } from './FighterModel.js';

export class CombatEffects {
  private effects: Array<{ mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>; born: number; lifetime: number; size: number }> = [];
  constructor(private readonly scene: THREE.Scene, private readonly reducedMotion: boolean) {}
  ingest(event: GameEvent, snapshot: MatchSnapshot): void {
    const position = 'impactPosition' in event ? event.impactPosition : event.type === 'KNOCKOUT' ? snapshot.players.find((player) => player.playerId === event.targetId)?.position : event.type === 'RESPAWN' ? event.position : null;
    if (!position) return;
    const knockout = event.type === 'KNOCKOUT';
    const dodge = event.type === 'PERFECT_DODGE';
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.055, 4, 40), new THREE.MeshBasicMaterial({ color: knockout ? 0xffb76d : dodge ? 0xc3a4ff : 0xedfaff, transparent: true, opacity: 0.9, depthWrite: false }));
    mesh.position.copy(worldPoint(position, knockout ? 6 : 35));
    mesh.rotation.x = knockout || event.type === 'RESPAWN' ? -Math.PI / 2 : -Math.PI / 4;
    this.scene.add(mesh);
    this.effects.push({ mesh, born: performance.now(), lifetime: knockout ? 450 : 220, size: knockout ? 80 : dodge ? 40 : 29 });
    if (this.effects.length > 32) disposeObject(this.effects.shift()!.mesh);
  }
  update(now: number): void {
    this.effects = this.effects.filter((effect) => {
      const t = (now - effect.born) / effect.lifetime;
      if (t >= 1) { disposeObject(effect.mesh); return false; }
      effect.mesh.scale.setScalar(effect.size * (this.reducedMotion ? 0.7 : 0.2 + t));
      effect.mesh.material.opacity = (1 - t) * 0.8;
      return true;
    });
  }
  dispose(): void { this.effects.forEach(({ mesh }) => disposeObject(mesh)); this.effects = []; }
}

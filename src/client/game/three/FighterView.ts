import { FIGHTERS } from '../../../shared/fighters.js';
import * as THREE from 'three';
import { ACCENTS, GAME } from '../../../shared/constants.js';
import type { GameEvent, MatchAction, MatchPlayer, Vec2 } from '../../../shared/model.js';
import { buildAttackCapsule } from '../../../shared/combat/geometry.js';
import { profileForAttack, type AttackProfileId } from '../../../shared/combat/profiles.js';
import type { AttackTelegraph } from '../runtime/attackTelegraphTracker.js';
import { createFighterModel, disposeObject, FIGHTER_COLORS } from './FighterModel.js';
import { blendMotion, fighterMotion, type FighterMotion, type MotionState } from './fighterMotion.js';
import { placeGroundedFeet } from './groundedFeet.js';
import { worldPoint } from './ArenaWorld.js';

export type ChargeIndicatorState = Readonly<{ facing: Vec2; progress: number; pulseReady: boolean }>;

function attackKind(profile: AttackProfileId) {
  return ({ 'quick-1': 'QUICK_1', 'quick-2': 'QUICK_2', 'quick-3': 'QUICK_3', 'heavy-melee': 'HEAVY' } as const)[profile];
}

export function createFighterView(
  scene: THREE.Scene, camera: THREE.Camera, parent: HTMLElement, player: MatchPlayer, local: boolean, reducedMotion: boolean
) {
  const model = createFighterModel(player.chassis);
  scene.add(model.root);
  const accent = new THREE.Color(ACCENTS[player.accent]);
  const marker = new THREE.Mesh(new THREE.RingGeometry(local ? 30 : 27, local ? 33 : 29, 40), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: local ? 0.95 : 0.6, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2; scene.add(marker);
  const charge = new THREE.Mesh(new THREE.TorusGeometry(36, 1.5, 5, 48), new THREE.MeshBasicMaterial({ color: 0xf6d743, transparent: true, opacity: 0.85 }));
  const ability = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 48), new THREE.MeshBasicMaterial({ color: FIGHTER_COLORS[player.chassis], transparent: true, opacity: 0.5, depthWrite: false }));
  ability.rotation.x = -Math.PI / 2; ability.visible = false; scene.add(ability);
  charge.rotation.x = -Math.PI / 2; charge.visible = false; scene.add(charge);
  const trail = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), new THREE.MeshBasicMaterial({ color: FIGHTER_COLORS[player.chassis], transparent: true, opacity: 0.42, depthWrite: false }));
  scene.add(trail); trail.visible = false;
  const label = document.createElement('div');
  label.className = `fighter-label${local ? ' is-local' : ''}`;
  label.style.setProperty('--fighter-accent', ACCENTS[player.accent]);
  const name = document.createElement('span'); name.textContent = player.name;
  const overload = document.createElement('b');
  label.append(name, overload); parent.append(label);
  const shield = new THREE.Mesh(new THREE.RingGeometry(36, 39, 48), new THREE.MeshBasicMaterial({ color: 0xdce8ed, transparent: true, opacity: 0.9, depthWrite: false }));
  shield.name = 'spawn-protection'; shield.rotation.x = -Math.PI / 2; shield.visible = false; scene.add(shield);
  let wasRespawning = player.respawnRemainingMs > 0;
  let returnStarted: number | null = null;
  let state: MotionState = 'idle';
  let started = performance.now();
  let attackId: number | null = null;
  let disposed = false;
  let lastPosition: Vec2 | null = null;
  let gaitPhase = 0;
  let gaitWeight = 0;
  let gaitBlendFrom = 0;
  let gaitBlendStarted = -100;
  let gaitDirection = { x: 0, z: 1 };
  let pose: FighterMotion = fighterMotion(player.chassis, 'idle', 0, 0, reducedMotion);
  let transitionFrom = pose;
  let transitionStarted = -100;
  let holdUntil = 0;
  let heldPose = pose;
  let contactId = -1;
  let hitStarted = -1000;
  let hitDirection: Vec2 = { x: 0, y: 1 };
  let hitStrength = 1;
  const up = new THREE.Vector3(0, 1, 0);
  const labelPoint = new THREE.Vector3();
  return {
    model,
    contact(event: Extract<GameEvent, { type: 'HIT' }>, attackerPosition: Vec2): void {
      if (disposed || event.eventId <= contactId) return;
      contactId = event.eventId;
      const now = performance.now();
      heldPose = event.attackerId === player.playerId && (state.startsWith('quick') || state === 'heavy-release')
        ? fighterMotion(player.chassis, state, 0.48, 0, reducedMotion) : pose;
      holdUntil = now + (reducedMotion ? 0 : event.attack === 'HEAVY' || event.attack === 'NEON_PULSE' ? 65 : 35);
      if (event.targetId === player.playerId) {
        hitStarted = now;
        const dx = event.impactPosition.x - attackerPosition.x;
        const dy = event.impactPosition.y - attackerPosition.y;
        const length = Math.hypot(dx, dy);
        hitDirection = length > 0.01 ? { x: dx / length, y: dy / length } : { ...player.facing };
        hitStrength = Math.min(1.4, 0.75 + event.impulse / 1000);
      }
    },
    apply(next: MatchPlayer, position: Vec2, facing: Vec2, predicted: MatchAction | null, telegraph: AttackTelegraph | null = null, chargeState: ChargeIndicatorState | null = null): void {
      const now = performance.now();
      const action = predicted ?? next.action;
      if (wasRespawning && next.respawnRemainingMs <= 0) returnStarted = now;
      wasRespawning = next.respawnRemainingMs > 0;
      if (wasRespawning || next.hitstunRemainingMs > 0 || action.charging || action.kind !== null) returnStarted = null;
      let nextState: MotionState = Math.hypot(next.velocity.x, next.velocity.y) > 12 ? 'move' : 'idle';
      let attackTiming: ReturnType<typeof profileForAttack> | null = null;
      let duration = nextState === 'move' ? player.chassis === 'BASTION' ? 650 : 440 : 1800;
      if (next.respawnRemainingMs > 0) { nextState = 'knockout'; duration = 260; }
      else if (next.hitstunRemainingMs > 0) { nextState = 'hit'; duration = 180; }
      else if (action.charging) { nextState = 'heavy-charge'; duration = GAME.heavyMaxChargeMs; }
      else if (action.kind?.startsWith('QUICK') || action.kind === 'HEAVY') {
        nextState = action.kind === 'HEAVY' ? 'heavy-release' : action.kind.toLowerCase().replace('_', '-') as MotionState;
        const profile = profileForAttack(action.kind as 'QUICK_1' | 'QUICK_2' | 'QUICK_3' | 'HEAVY');
        attackTiming = profile;
        duration = profile.windupMs + profile.activeMs + profile.recoveryMs;
      } else if (next.dashRemainingMs > 0 || action.kind === 'DASH') { nextState = 'dash'; duration = FIGHTERS[player.chassis].dashDurationMs; }
      else if (returnStarted !== null && now - returnStarted < 340) { nextState = 'respawn'; duration = 340; }
      const newAttack = action.attackId !== null && attackId !== null && action.attackId !== attackId;
      if (state !== nextState || newAttack) {
        if ((state === 'move') !== (nextState === 'move')) { gaitBlendFrom = gaitWeight; gaitBlendStarted = now; }
        transitionFrom = pose; transitionStarted = now;
        state = nextState; started = now;
      }
      attackId = action.attackId;
      const looping = state === 'idle' || state === 'move';
      let progress = state === 'heavy-charge' ? action.chargeMs / duration : looping ? ((now - started) % duration) / duration : Math.min(1, (now - started) / duration);
      if (attackTiming) {
        const elapsed = Math.min(duration, now - started);
        progress = elapsed <= attackTiming.windupMs
          ? elapsed / attackTiming.windupMs * 0.44
          : elapsed <= attackTiming.windupMs + attackTiming.activeMs
            ? 0.44 + (elapsed - attackTiming.windupMs) / attackTiming.activeMs * 0.11
            : 0.55 + (elapsed - attackTiming.windupMs - attackTiming.activeMs) / attackTiming.recoveryMs * 0.45;
      }
      const direction = telegraph?.facing ?? action.lockedFacing ?? facing;
      const yaw = Math.atan2(direction.x, direction.y);
      if (lastPosition && state === 'move') {
        const dx = position.x - lastPosition.x, dz = position.y - lastPosition.y;
        const distance = Math.hypot(dx, dz);
        // Teleports/respawns do not wind up a walk cycle.
        if (distance > 0.001 && distance < 80) {
          gaitPhase += distance / ((player.chassis === 'BASTION' ? 16 : 22) / 0.6);
          gaitDirection = { x: (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / distance, z: (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / distance };
        }
      }
      lastPosition = { ...position };
      gaitWeight = gaitBlendFrom + ((state === 'move' ? 1 : 0) - gaitBlendFrom) * Math.min(1, (now - gaitBlendStarted) / 65);
      if (state === 'move') progress = gaitPhase;
      const targetPose = fighterMotion(player.chassis, state, progress, Math.min(1, Math.hypot(next.velocity.x, next.velocity.y) / FIGHTERS[player.chassis].moveSpeed), reducedMotion);
      // Return/KO animation must use the authoritative spawn boundary immediately.
      pose = state === 'knockout' || state === 'respawn' || transitionFrom.opacity < 1
        ? targetPose : blendMotion(transitionFrom, targetPose, (now - transitionStarted) / (reducedMotion ? 25 : 65));
      if (now < holdUntil && state !== 'knockout' && state !== 'respawn') pose = heldPose;
      const hitAge = now - hitStarted;
      if (hitAge >= 0 && hitAge < 200 && state !== 'knockout' && state !== 'respawn') {
        const recoil = Math.pow(1 - hitAge / 200, 2) * hitStrength * (reducedMotion ? 0.45 : 1);
        const forward = hitDirection.x * direction.x + hitDirection.y * direction.y;
        const side = hitDirection.x * direction.y - hitDirection.y * direction.x;
        pose = { ...pose, lean: recoil * forward * 0.3, roll: -recoil * side * 0.32, twist: recoil * side * 0.22,
          leftArm: 0.35 * recoil, rightArm: 0.35 * recoil, shift: recoil * forward * 3 };
      }
      model.root.position.copy(worldPoint(position));
      model.root.rotation.y = yaw;
      model.body.position.set(0, pose.bob, pose.shift);
      model.body.rotation.set(pose.lean, pose.twist, pose.roll);
      model.body.scale.setScalar(pose.scale);
      model.leftArm.rotation.set(pose.leftArm, 0, pose.leftSweep); model.rightArm.rotation.set(pose.rightArm, 0, pose.rightSweep);
      model.leftElbow.rotation.x = pose.elbow; model.rightElbow.rotation.x = pose.rightElbow;
      if ((player.chassis === 'RIFT' || player.chassis === 'BASTION') && state !== 'knockout' && state !== 'respawn') {
        placeGroundedFeet(model, gaitPhase, gaitWeight > 0, gaitDirection, player.chassis === 'BASTION', gaitWeight);
      } else { model.leftLeg.rotation.x = pose.leg; model.rightLeg.rotation.x = -pose.leg; }
      model.ornaments.rotation.y = player.chassis === 'PULSE' && !reducedMotion ? now * 0.0008 : 0;
      for (const material of model.materials) { material.transparent = pose.opacity < 1; material.opacity = pose.opacity; }
      ability.visible = state === 'dash';
      ability.position.copy(worldPoint(position, 4));
      ability.scale.setScalar(player.chassis === 'PULSE' ? 35 + 90 * progress : player.chassis === 'BASTION' ? 35 : 30);
      ability.material.opacity = (1 - progress) * 0.6;
      const offensiveAction = action.kind?.startsWith('QUICK') || (action.kind === 'HEAVY' && !action.charging) || (player.chassis === 'PULSE' && action.kind === 'DASH');
      shield.visible = next.respawnRemainingMs <= 0 && next.protectionRemainingMs > 0 && !offensiveAction;
      shield.position.copy(worldPoint(position, 3));
      model.glow.emissiveIntensity = action.charging ? 1.5 + progress * 1.6 : 1.4;
      model.root.visible = pose.opacity > 0.02;
      marker.position.copy(worldPoint(position, 2));
      marker.visible = next.respawnRemainingMs <= 0;
      charge.position.copy(worldPoint(position, 4)); charge.visible = Boolean(chargeState);
      charge.scale.setScalar(chargeState ? 0.85 + chargeState.progress * 0.3 : 1);
      charge.material.color.set(chargeState?.pulseReady ? 0xffde77 : FIGHTER_COLORS[player.chassis]);
      trail.visible = Boolean(telegraph?.active);
      if (telegraph?.active) {
        const capsule = buildAttackCapsule(position, telegraph.facing, profileForAttack(attackKind(telegraph.profileId)), telegraph.previousProgress, telegraph.currentProgress);
        const from = worldPoint(capsule.from, 30); const to = worldPoint(capsule.to, 30);
        const delta = to.clone().sub(from);
        trail.position.copy(from).add(to).multiplyScalar(0.5);
        trail.scale.set(capsule.radius, Math.max(1, delta.length()), capsule.radius);
        trail.quaternion.setFromUnitVectors(up, delta.normalize());
      }
      labelPoint.copy(model.root.position); labelPoint.y += 99 + Math.max(0, pose.bob); labelPoint.project(camera);
      label.style.left = `${(labelPoint.x * 0.5 + 0.5) * 100}%`;
      label.style.top = `${(-labelPoint.y * 0.5 + 0.5) * 100}%`;
      label.style.opacity = String(Math.max(0, pose.opacity));
      overload.textContent = `${Math.round(next.overload)}%`;
    },
    destroy(): void { if (disposed) return; disposed = true; label.remove(); model.dispose(); disposeObject(marker); disposeObject(charge); disposeObject(trail); disposeObject(ability); disposeObject(shield); }
  };
}

export type FighterView = ReturnType<typeof createFighterView>;

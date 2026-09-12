import { ARENA, GAME } from '../../shared/constants.js';
import { profileForAttack } from '../../shared/combat/profiles.js';
import { FIGHTERS } from '../../shared/fighters.js';
import type { BotDifficulty, InputFrame, MatchSnapshot, Vec2 } from '../../shared/model.js';
import { closestPointOnPolygon, distance, pointInConvexPolygon } from './geometry.js';
import { platformAt } from './movement.js';

export const BOT_REACTION_MS: Readonly<Record<BotDifficulty, number>> = { EASY: 300, NORMAL: 180, HARD: 110 };
const DODGE_CHANCE = { EASY: 0.2, NORMAL: 0.45, HARD: 0.7 };
const direction = (from: Vec2, to: Vec2): Vec2 => {
  const length = distance(from, to);
  return length > 0 ? { x: (to.x - from.x) / length, y: (to.y - from.y) / length } : { x: 0, y: 0 };
};

/** Receives public snapshots only. Opponent decisions use a delayed observation;
 * immediate self-position feedback merely executes the previously chosen movement. */
export class BotController {
  private sequence = 0;
  private randomState: number;
  private observation: MatchSnapshot | null = null;
  private decisionTick = 0;
  private targetPosition: Vec2 | null = null;
  private heavyUntilTick = 0;
  private aim: Vec2 = { x: 1, y: 0 };
  private dodge: Vec2 | null = null;

  constructor(private readonly playerId: string, private readonly difficulty: BotDifficulty, seed: number) {
    this.randomState = [...playerId].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), seed ^ 2166136261) >>> 0;
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  nextInput(snapshot: MatchSnapshot): InputFrame {
    const self = snapshot.players.find((player) => player.playerId === this.playerId);
    const input = { seq: this.sequence++, viewTick: snapshot.tick, moveX: 0, moveY: 0,
      aimX: this.aim.x, aimY: this.aim.y, quick: false, heavy: false, dash: false };
    if (!self || snapshot.phase === 'FINISHED' || snapshot.phase === 'PAUSED') return input;
    if (!this.observation) {
      this.observation = snapshot;
      this.decisionTick = snapshot.tick + Math.ceil(BOT_REACTION_MS[this.difficulty] * GAME.tickRate / 1000) + Math.floor(this.random() * 5);
    }
    if (snapshot.tick >= this.decisionTick) {
      const observed = this.observation;
      const knownSelf = observed.players.find((player) => player.playerId === this.playerId)!;
      const target = observed.players.filter((player) => player.playerId !== this.playerId && player.respawnRemainingMs <= 0)
        .sort((a, b) => distance(knownSelf.position, a.position) - distance(knownSelf.position, b.position))[0];
      this.dodge = null;
      this.targetPosition = target?.position ?? null;
      if (target) {
        this.aim = direction(knownSelf.position, target.position);
        const range = distance(knownSelf.position, target.position);
        const telegraph = (target.action.phase === 'WINDUP' || target.action.charging) && range < 160;
        const pulseThreat = observed.pulses.some((pulse) => pulse.ownerPlayerId !== this.playerId && distance(pulse.position, knownSelf.position) < 170);
        if ((telegraph || pulseThreat) && this.random() < DODGE_CHANCE[this.difficulty]) {
          const side = this.random() < 0.5 ? 1 : -1;
          this.dodge = { x: -this.aim.y * side, y: this.aim.x * side };
          input.dash = true;
        }
        const quickReach = profileForAttack('QUICK_1').reach + GAME.collisionRadius;
        if (range < quickReach + 10 && snapshot.tick >= this.heavyUntilTick) {
          // A combo commits to ordinary quick presses; heavy selection waits for its end.
          const inCombo = self.action.kind?.startsWith('QUICK') && self.action.comboStep < 3;
          if (!inCombo && self.action.phase === 'IDLE' && this.random() < 0.28) {
            this.heavyUntilTick = snapshot.tick + Math.ceil((200 + this.random() * 250) * GAME.tickRate / 1000);
          } else input.quick = true;
        }
        if (self.dashCooldownRemainingMs <= 0 && !input.dash) {
          const fighter = FIGHTERS[self.chassis];
          const ability = fighter.burstRadius !== undefined ? range < fighter.burstRadius
            : fighter.armoredDashKnockbackMultiplier !== undefined ? range < 125 && telegraph
              : range > 180 && range < 310 && this.random() < 0.18;
          if (ability) input.dash = true;
        }
      }
      this.observation = snapshot;
      this.decisionTick = snapshot.tick + Math.ceil(BOT_REACTION_MS[this.difficulty] * GAME.tickRate / 1000);
    }
    let move: Vec2 = { x: 0, y: 0 };
    if (this.targetPosition) {
      const range = distance(self.position, this.targetPosition);
      const toward = direction(self.position, this.targetPosition);
      // Stop within weapon contact range instead of orbiting or pushing past the target.
      if (range > 58) move = toward;
      else if (range < 43) move = { x: -toward.x * 0.5, y: -toward.y * 0.5 };
      this.aim = toward.x || toward.y ? toward : this.aim;
    }
    if (input.dash && this.dodge) move = this.dodge;
    const platform = platformAt(snapshot.platformProgress).vertices;
    const forecast = { x: self.position.x + self.velocity.x * 0.2, y: self.position.y + self.velocity.y * 0.2 };
    const edgeDistance = distance(forecast, closestPointOnPolygon(forecast, platform));
    const outside = !pointInConvexPolygon(forecast, platform);
    if (outside || edgeDistance < 48) {
      move = direction(self.position, { x: ARENA.width / 2, y: ARENA.height / 2 });
      input.dash = outside && self.dashCooldownRemainingMs <= 0 && self.hitstunRemainingMs <= 0;
      input.quick = false;
      this.heavyUntilTick = 0;
    } else if (input.dash) {
      const fighter = FIGHTERS[self.chassis];
      const end = { x: self.position.x + move.x * fighter.dashSpeed * fighter.dashDurationMs / 1000,
        y: self.position.y + move.y * fighter.dashSpeed * fighter.dashDurationMs / 1000 };
      if (!pointInConvexPolygon(end, platform)) input.dash = false;
    }
    input.moveX = move.x;
    input.moveY = move.y;
    input.aimX = this.aim.x;
    input.aimY = this.aim.y;
    input.heavy = snapshot.tick < this.heavyUntilTick;
    if (input.heavy) input.quick = false;
    if (self.respawnRemainingMs > 0 || snapshot.phase === 'COUNTDOWN') {
      input.quick = false; input.heavy = false; input.dash = false;
    }
    return input;
  }
}

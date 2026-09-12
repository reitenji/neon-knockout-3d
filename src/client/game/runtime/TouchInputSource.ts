import type { ArenaInputSource } from './ArenaInput.js';

const DEFAULT_DEAD_ZONE = 0.22;

/** Mutable browser-pointer state; ArenaInput remains responsible for edge detection and normalized axes. */
export class TouchInputSource implements ArenaInputSource {
  private readonly deadZone: number;
  private joystickX = 0;
  private joystickY = 0;
  private quickHeld = false;
  private heavyHeld = false;
  private dashHeld = false;
  private quickPressPending = false;
  private dashPressPending = false;

  constructor(deadZone = DEFAULT_DEAD_ZONE) {
    this.deadZone = clamp(Number.isFinite(deadZone) ? deadZone : DEFAULT_DEAD_ZONE, 0, 1);
  }

  setJoystick(x: number, y: number): void {
    this.joystickX = finiteUnit(x);
    this.joystickY = finiteUnit(y);
  }

  setQuickHeld(held: boolean): void {
    if (held && !this.quickHeld) this.quickPressPending = true;
    this.quickHeld = held;
  }

  setHeavyHeld(held: boolean): void {
    this.heavyHeld = held;
  }

  setDashHeld(held: boolean): void {
    if (held && !this.dashHeld) this.dashPressPending = true;
    this.dashHeld = held;
  }

  movement(): ReturnType<ArenaInputSource['movement']> {
    return {
      up: this.joystickY < -this.deadZone,
      down: this.joystickY > this.deadZone,
      left: this.joystickX < -this.deadZone,
      right: this.joystickX > this.deadZone,
      dash: this.dashHeld
    };
  }

  attack(): ReturnType<ArenaInputSource['attack']> {
    return { quick: this.quickHeld, heavy: this.heavyHeld };
  }

  consumePressEdges(): Readonly<{ quick: boolean; dash: boolean }> {
    const pending = { quick: this.quickPressPending, dash: this.dashPressPending };
    this.quickPressPending = false;
    this.dashPressPending = false;
    return pending;
  }

  reset(): void {
    this.joystickX = 0;
    this.joystickY = 0;
    this.quickHeld = false;
    this.heavyHeld = false;
    this.dashHeld = false;
    this.quickPressPending = false;
    this.dashPressPending = false;
  }
}

export function combineArenaInputSources(...sources: readonly ArenaInputSource[]): ArenaInputSource {
  let disposed = false;
  return {
    movement: () => sources.reduce<ReturnType<ArenaInputSource['movement']>>(
      (combined, source) => {
        const movement = source.movement();
        return {
          up: combined.up || movement.up,
          down: combined.down || movement.down,
          left: combined.left || movement.left,
          right: combined.right || movement.right,
          dash: combined.dash || movement.dash
        };
      },
      { up: false, down: false, left: false, right: false, dash: false }
    ),
    attack: () => sources.reduce<ReturnType<ArenaInputSource['attack']>>(
      (combined, source) => {
        const attack = source.attack();
        return { quick: combined.quick || attack.quick, heavy: combined.heavy || attack.heavy };
      },
      { quick: false, heavy: false }
    ),
    consumePressEdges: () => sources.reduce<{ quick: boolean; dash: boolean }>(
      (combined, source) => {
        const pending = source.consumePressEdges?.() ?? { quick: false, dash: false };
        return { quick: combined.quick || pending.quick, dash: combined.dash || pending.dash };
      },
      { quick: false, dash: false }
    ),
    reset: () => {
      for (const source of sources) source.reset();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const source of sources) source.dispose?.();
    },
    onSuspend: (listener) => {
      const removeListeners = sources.flatMap((source) => {
        const remove = source.onSuspend?.(listener);
        return remove ? [remove] : [];
      });
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        for (const remove of removeListeners) remove();
      };
    }
  };
}

function finiteUnit(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { TouchInputSource } from '../game/runtime/TouchInputSource.js';

const STICK_TRAVEL = 30;

function knobStyle(stick: Readonly<{ x: number; y: number }>): CSSProperties {
  return {
    '--touch-stick-x': `${Math.round(stick.x * STICK_TRAVEL)}px`,
    '--touch-stick-y': `${Math.round(stick.y * STICK_TRAVEL)}px`
  } as CSSProperties;
}

type TouchControlsProps = Readonly<{ source: TouchInputSource; abilityName?: string }>;
type Action = 'quick' | 'heavy' | 'dash';

function setActionHeld(source: TouchInputSource, action: Action, held: boolean): void {
  if (action === 'quick') source.setQuickHeld(held);
  else if (action === 'heavy') source.setHeavyHeld(held);
  else source.setDashHeld(held);
}

function actionHandlers(
  source: TouchInputSource,
  action: Action,
  setActive: (action: Action, active: boolean) => void
) {
  const release = (): void => {
    setActionHeld(source, action, false);
    setActive(action, false);
  };
  return {
    onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setActionHeld(source, action, true);
      setActive(action, true);
    },
    onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
      event.preventDefault();
      release();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    onPointerCancel: release,
    onLostPointerCapture: release,
    onPointerLeave(event: ReactPointerEvent<HTMLButtonElement>) {
      if (event.buttons === 0) release();
    }
  };
}

function prefersTouchControls(): boolean {
  return (window.matchMedia?.('(pointer: coarse)').matches ?? false) || navigator.maxTouchPoints > 0;
}

export function TouchControls({ source, abilityName = 'Dash' }: TouchControlsProps) {
  const enabled = prefersTouchControls();
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState<Record<Action, boolean>>({ quick: false, heavy: false, dash: false });
  const activePointerId = useRef<number | null>(null);

  useEffect(() => {
    const reset = (): void => {
      activePointerId.current = null;
      source.reset();
      setStick({ x: 0, y: 0 });
      setActive({ quick: false, heavy: false, dash: false });
    };
    window.addEventListener('blur', reset);
    window.addEventListener('orientationchange', reset);
    return () => {
      window.removeEventListener('blur', reset);
      window.removeEventListener('orientationchange', reset);
      source.reset();
    };
  }, [source]);

  if (!enabled) return null;

  const updateStick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
    const rawX = (event.clientX - centerX) / radius;
    const rawY = (event.clientY - centerY) / radius;
    const magnitude = Math.hypot(rawX, rawY);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const next = { x: rawX * scale, y: rawY * scale };
    source.setJoystick(next.x, next.y);
    setStick(next);
  };

  const clearStick = (): void => {
    activePointerId.current = null;
    source.setJoystick(0, 0);
    setStick({ x: 0, y: 0 });
  };

  const updateActive = (action: Action, held: boolean): void => {
    setActive((current) => current[action] === held ? current : { ...current, [action]: held });
  };

  return (
    <section className="touch-controls" aria-label="Dokunmatik kontroller">
      <div
        className="touch-controls__pad"
        role="application"
        aria-label="Yön pedi"
        onPointerDown={(event) => {
          event.preventDefault();
          activePointerId.current = event.pointerId;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          updateStick(event);
        }}
        onPointerMove={(event) => {
          if (activePointerId.current !== event.pointerId) return;
          updateStick(event);
        }}
        onPointerUp={(event) => {
          if (activePointerId.current !== event.pointerId) return;
          clearStick();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={clearStick}
        onLostPointerCapture={clearStick}
      >
        <div className="touch-controls__pad-ring" aria-hidden="true" />
        <div className="touch-controls__pad-thumb" aria-hidden="true" style={knobStyle(stick)} />
      </div>

      <div className="touch-controls__actions">
        <button
          className={`touch-controls__button touch-controls__button--quick${active.quick ? ' is-active' : ''}`}
          type="button"
          aria-label="Hızlı saldırı"
          {...actionHandlers(source, 'quick', updateActive)}
        >
          <strong>J</strong>
          <span>Hızlı</span>
        </button>
        <button
          className={`touch-controls__button touch-controls__button--heavy${active.heavy ? ' is-active' : ''}`}
          type="button"
          aria-label="Charge saldırı"
          {...actionHandlers(source, 'heavy', updateActive)}
        >
          <strong>K</strong>
          <span>Charge</span>
        </button>
        <button
          className={`touch-controls__button touch-controls__button--dash${active.dash ? ' is-active' : ''}`}
          type="button"
          aria-label="Dash"
          {...actionHandlers(source, 'dash', updateActive)}
        >
          <strong>Space</strong>
          <span>{abilityName}</span>
        </button>
      </div>
    </section>
  );
}

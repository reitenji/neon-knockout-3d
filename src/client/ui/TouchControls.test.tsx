import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TouchInputSource } from '../game/runtime/TouchInputSource.js';
import { TouchControls } from './TouchControls.js';

describe('TouchControls', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    vi.restoreAllMocks();
  });

  it('captures the left pointer, clamps its joystick vector, and releases on cancel or lost capture', () => {
    const source = new TouchInputSource();
    render(<TouchControls source={source} />);
    const pad = screen.getByRole('application', { name: 'Yön pedi' });
    Object.defineProperty(pad, 'setPointerCapture', { configurable: true, value: vi.fn() });
    vi.spyOn(pad, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120, toJSON: () => ({})
    });

    fireEvent.pointerDown(pad, { pointerId: 7, clientX: 120, clientY: 60 });
    expect(source.movement()).toMatchObject({ right: true, left: false, up: false, down: false });
    expect(pad.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerMove(pad, { pointerId: 7, clientX: 60, clientY: 0 });
    expect(source.movement()).toMatchObject({ right: false, up: true });
    fireEvent.lostPointerCapture(pad, { pointerId: 7 });
    expect(source.movement()).toMatchObject({ right: false, up: false });

    fireEvent.pointerDown(pad, { pointerId: 8, clientX: 0, clientY: 60 });
    fireEvent.pointerCancel(pad, { pointerId: 8 });
    expect(source.movement()).toMatchObject({ left: false });
  });

  it('holds and safely releases quick, heavy, and dash actions', () => {
    const source = new TouchInputSource();
    render(<TouchControls source={source} />);
    const quick = screen.getByRole('button', { name: 'Hızlı saldırı' });
    const heavy = screen.getByRole('button', { name: 'Charge saldırı' });
    const dash = screen.getByRole('button', { name: 'Dash' });

    fireEvent.pointerDown(quick, { pointerId: 1 });
    fireEvent.pointerDown(heavy, { pointerId: 2 });
    fireEvent.pointerDown(dash, { pointerId: 3 });
    expect(source.attack()).toEqual({ quick: true, heavy: true });
    expect(source.movement().dash).toBe(true);
    expect(quick).toHaveClass('is-active');
    expect(heavy).toHaveClass('is-active');
    expect(dash).toHaveClass('is-active');

    fireEvent.pointerUp(quick, { pointerId: 1 });
    fireEvent.pointerCancel(heavy, { pointerId: 2 });
    fireEvent.lostPointerCapture(dash, { pointerId: 3 });
    expect(source.attack()).toEqual({ quick: false, heavy: false });
    expect(source.movement().dash).toBe(false);
  });

  it('clears every held control on blur, orientation change, and unmount', () => {
    const source = new TouchInputSource();
    const reset = vi.spyOn(source, 'reset');
    const view = render(<TouchControls source={source} />);
    const heavy = screen.getByRole('button', { name: 'Charge saldırı' });
    fireEvent.pointerDown(heavy, { pointerId: 4 });
    fireEvent(window, new Event('blur'));
    expect(source.attack().heavy).toBe(false);

    fireEvent.pointerDown(heavy, { pointerId: 5 });
    fireEvent(window, new Event('orientationchange'));
    expect(source.attack().heavy).toBe(false);

    view.unmount();
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('does not render touch controls on a fine-pointer desktop', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    });

    render(<TouchControls source={new TouchInputSource()} />);
    expect(screen.queryByLabelText('Dokunmatik kontroller')).toBeNull();
  });
});

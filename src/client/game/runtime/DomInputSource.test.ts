import { describe, expect, it } from 'vitest';
import { createDomInputSource } from './DomInputSource.js';

describe('DOM gameplay controls', () => {
  it('captures gameplay keys once, preserves press edges and releases on blur', () => {
    const source = createDomInputSource();
    const down = new KeyboardEvent('keydown', { code: 'KeyJ', cancelable: true });
    window.dispatchEvent(down);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
    expect(down.defaultPrevented).toBe(true);
    expect(source.consumePressEdges?.().quick).toBe(true);
    expect(source.consumePressEdges?.().quick).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(source.movement().up).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(source.movement().up).toBe(false);
    source.dispose?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(source.movement().up).toBe(false);
  });
});

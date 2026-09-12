import type { ArenaInputSource } from './ArenaInput.js';

const CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'Space']);

export function createDomInputSource(target: Window = window): ArenaInputSource {
  const held = new Set<string>();
  let quickEdge = false;
  let dashEdge = false;
  const down = (event: KeyboardEvent): void => {
    if (!CODES.has(event.code)) return;
    const element = event.target as HTMLElement | null;
    if (element instanceof Element && element.matches('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    if (!held.has(event.code)) {
      if (event.code === 'KeyJ') quickEdge = true;
      if (event.code === 'Space') dashEdge = true;
    }
    held.add(event.code);
  };
  const up = (event: KeyboardEvent): void => { held.delete(event.code); };
  const reset = (): void => { held.clear(); quickEdge = false; dashEdge = false; };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', reset);
  return {
    movement: () => ({ up: held.has('KeyW'), down: held.has('KeyS'), left: held.has('KeyA'), right: held.has('KeyD'), dash: held.has('Space') }),
    attack: () => ({ quick: held.has('KeyJ'), heavy: held.has('KeyK') }),
    consumePressEdges: () => { const edges = { quick: quickEdge, dash: dashEdge }; quickEdge = false; dashEdge = false; return edges; },
    reset,
    dispose: () => { reset(); target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', reset); }
  };
}

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchSnapshot } from '../../shared/model.js';
import type { GamePresentationBridge, NeonGameFactory } from './GamePresentationBridge.js';
import { ThreeArena } from './ThreeArena.js';

function bridge(): GamePresentationBridge & {
  snapshotListeners: Set<(snapshot: MatchSnapshot) => void>;
  connectionListeners: Set<(connected: boolean) => void>;
} {
  const snapshotListeners = new Set<(snapshot: MatchSnapshot) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  return {
    snapshotListeners,
    connectionListeners,
    getSnapshot: () => null,
    isConnected: () => true,
    subscribeSnapshot(listener) { snapshotListeners.add(listener); return () => snapshotListeners.delete(listener); },
    subscribeConnected(listener) { connectionListeners.add(listener); return () => connectionListeners.delete(listener); },
    subscribeEvent() { return () => undefined; },
    subscribeMuted() { return () => undefined; },
    sendInput() { return undefined; }
  };
}

describe('ThreeArena', () => {
  afterEach(cleanup);

  it('creates one game for a stable mount and destroys it exactly once with removeCanvas=true', () => {
    const presentation = bridge();
    const destroy = vi.fn();
    let touchInput: GamePresentationBridge['inputSource'];
    const factory = vi.fn<NeonGameFactory>((_parent, receivedBridge) => {
      touchInput = receivedBridge.inputSource;
      const unsubscribe = receivedBridge.subscribeSnapshot(() => undefined);
      return { destroy(removeCanvas?: boolean) { unsubscribe(); destroy(removeCanvas); } };
    });
    const view = render(<ThreeArena bridge={presentation} localPlayerId="p-local" createGame={factory} reducedMotion />);

    expect(factory).toHaveBeenCalledOnce();
    expect(touchInput).toBeDefined();
    expect(touchInput?.movement()).toEqual({ up: false, down: false, left: false, right: false, dash: false });
    expect(touchInput?.attack()).toEqual({ quick: false, heavy: false });
    expect(screen.getByRole('complementary', { name: 'Maç bilgileri' })).toBeVisible();
    expect(presentation.snapshotListeners).toHaveLength(2);
    expect(presentation.connectionListeners).toHaveLength(1);
    view.rerender(<ThreeArena bridge={presentation} localPlayerId="p-local" createGame={factory} reducedMotion />);
    expect(factory).toHaveBeenCalledOnce();
    expect(presentation.snapshotListeners).toHaveLength(2);
    expect(presentation.connectionListeners).toHaveLength(1);

    view.unmount();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(true);
    expect(presentation.snapshotListeners).toHaveLength(0);
    expect(presentation.connectionListeners).toHaveLength(0);
  });

  it('suppresses the context menu inside the arena without changing the rest of the document', () => {
    render(<ThreeArena bridge={bridge()} localPlayerId="p-local" createGame={() => ({ destroy() {} })} />);
    const arena = screen.getByLabelText('Neon Knockout oyun alanı');
    const outside = document.createElement('button');
    document.body.append(outside);
    expect(fireEvent.contextMenu(arena)).toBe(false);
    expect(fireEvent.contextMenu(outside)).toBe(true);
  });
});

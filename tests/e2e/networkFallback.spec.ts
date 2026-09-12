import type { ConsoleMessage } from '@playwright/test';
import { assertNoUnexpectedErrors, expect, openPlayer, test } from './fixtures.js';

test('the shipped browser client falls back to polling when WebSocket is unavailable', async ({ browser, game }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: class BlockedWebSocket {
        binaryType = 'blob';
        readyState = 0;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: Event) => void) | null = null;
        onmessage: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor() {
          window.setTimeout(() => this.onerror?.(new Event('error')), 0);
        }

        close(): void { this.readyState = 3; }
        send(): void {}
      }
    });
  });
  const page = await context.newPage();
  const issues = { pageErrors: [] as string[], consoleErrors: [] as string[] };
  const pollingRequests: string[] = [];
  page.on('pageerror', (error) => issues.pageErrors.push(error.message));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') issues.consoleErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/socket.io') && url.searchParams.get('transport') === 'polling') {
      pollingRequests.push(request.url());
    }
  });

  try {
    await page.goto(game.origin);
    await expect(page.getByText('Bağlı', { exact: true })).toBeVisible();
    await page.getByLabel('Oyuncu adı').fill('Fallback Ada');
    await page.getByRole('button', { name: 'Oda Kur' }).click();
    await expect(page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    expect(pollingRequests.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Odadan Çık' }).click();
    await expect(page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await assertNoUnexpectedErrors(game, { context, page, issues });
  } finally {
    await context.close();
  }
});

test('a browser without RTCPeerConnection joins and keeps playing through Socket.IO', async ({ browser, game }) => {
  const unsupported = await openPlayer(browser, game.origin, {
    initScript: () => {
      Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined });
    }
  });
  const guest = await openPlayer(browser, game.origin);
  try {
    await unsupported.page.getByLabel('Oyuncu adı').fill('Fallback Ada');
    await unsupported.page.getByRole('button', { name: 'Oda Kur' }).click();
    const code = await unsupported.page.getByTestId('room-code').textContent();
    if (!code) throw new Error('Unsupported-browser room code was not rendered.');

    await guest.page.getByLabel('Oyuncu adı').fill('Linus');
    await guest.page.getByLabel('Oda kodu').fill(code);
    await guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
    await unsupported.page.getByRole('button', { name: 'WRAITH gövdesini seç' }).click();
    await guest.page.getByRole('button', { name: 'PULSE gövdesini seç' }).click();
    await unsupported.page.getByRole('button', { name: 'Hazırım' }).click();
    await guest.page.getByRole('button', { name: 'Hazırım' }).click();
    await unsupported.page.getByRole('button', { name: 'Maçı Başlat' }).click();
    await expect.poll(() => game.harness.matchSnapshot(code)?.phase, { timeout: 12_000 }).toBe('REGULATION');

    const initial = game.harness.matchSnapshot(code);
    const unsupportedPlayer = initial?.players.find((player) => player.name === 'Fallback Ada');
    if (!unsupportedPlayer) throw new Error('Unsupported-browser player was missing from the match.');
    expect(['websocket', 'polling']).toContain(game.harness.transportMode(unsupportedPlayer.playerId));

    const sequenceBeforeInput = unsupportedPlayer.lastProcessedInputSeq;
    const positionBeforeInput = unsupportedPlayer.position.x;
    await unsupported.page.keyboard.down('d');
    await expect.poll(() => {
      const player = game.harness.matchSnapshot(code)?.players.find((candidate) =>
        candidate.playerId === unsupportedPlayer.playerId
      );
      return Boolean(player && player.lastProcessedInputSeq > sequenceBeforeInput && player.position.x > positionBeforeInput);
    }).toBe(true);
    await unsupported.page.keyboard.up('d');
    await unsupported.page.keyboard.down('j');
    await expect.poll(() => game.harness.matchSnapshot(code)?.players.find((candidate) =>
      candidate.playerId === unsupportedPlayer.playerId
    )?.action.kind).toBe('QUICK_1');
    await unsupported.page.keyboard.up('j');

    await expect(unsupported.page.getByRole('alert')).toHaveCount(0);
    await expect(guest.page.getByRole('alert')).toHaveCount(0);
    await assertNoUnexpectedErrors(game, unsupported, guest);
  } finally {
    await Promise.all([unsupported.context.close(), guest.context.close()]);
  }
});

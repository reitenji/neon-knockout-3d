import { mkdir } from 'node:fs/promises';
import type { BoundingBox, Browser, CDPSession, ConsoleMessage } from '@playwright/test';
import type { MatchPlayer } from '../../src/shared/model.js';
import {
  assertNoUnexpectedErrors,
  expect,
  openPlayer,
  sampleAnimationFrameDurations,
  test,
  type E2eGame,
  type PlayerPage
} from './fixtures.js';

test.use({
  launchOptions: {
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-renderer-backgrounding',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])
    ],
    headless: process.platform !== 'darwin'
  },
  gameplayTransportOptions: {
    impairment: {
      oneWayDelayMs: 25,
      jitterSequenceMs: [0, 2, -1, 3],
      dropEveryNthPacket: null,
      reorderWindow: 0
    }
  }
});

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

async function openMobilePlayer(browser: Browser, origin: string): Promise<PlayerPage> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  const issues = { pageErrors: [] as string[], consoleErrors: [] as string[] };
  page.on('pageerror', (error) => issues.pageErrors.push(error.message));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') issues.consoleErrors.push(`${message.type()}: ${message.text()}`);
  });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
  return { context, page, issues };
}

function player(game: E2eGame, roomCode: string, playerId: string): MatchPlayer {
  const candidate = game.harness.matchSnapshot(roomCode)?.players.find((value) => value.playerId === playerId);
  if (!candidate) throw new Error(`Missing authoritative mobile player ${playerId}.`);
  return candidate;
}

async function waitForNeutral(game: E2eGame, roomCode: string, playerId: string): Promise<void> {
  await expect.poll(() => {
    const candidate = player(game, roomCode, playerId);
    return candidate.action.kind === null && candidate.hitstunRemainingMs === 0 &&
      candidate.dashRemainingMs === 0 && candidate.respawnRemainingMs === 0;
  }).toBe(true);
}

function touchPoint(box: BoundingBox, id: number, offsetX = 0, offsetY = 0) {
  return {
    x: box.x + box.width / 2 + offsetX,
    y: box.y + box.height / 2 + offsetY,
    id,
    radiusX: 2,
    radiusY: 2,
    force: 1
  };
}

async function dispatchTouch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: readonly ReturnType<typeof touchPoint>[] = []
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

test('portrait phone lobby rotates into a real touch-controlled authoritative match', async ({ browser, game }) => {
  const host = await openMobilePlayer(browser, game.origin);
  const guest = await openPlayer(browser, game.origin);
  const cdp = await host.context.newCDPSession(host.page);
  try {
    await host.page.bringToFront();
    await expect(host.page.getByRole('button', { name: 'Oda Kur' })).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Odaya Katıl' })).toBeVisible();
    await expect(host.page.getByRole('alert')).toHaveCount(0);

    await host.page.getByLabel('Oyuncu adı').fill('Mobil Ada');
    await host.page.getByRole('button', { name: 'Oda Kur' }).click();
    await expect(host.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    const code = await host.page.getByTestId('room-code').textContent();
    if (!code) throw new Error('Mobile host room code was not rendered.');

    await guest.page.getByLabel('Oyuncu adı').fill('Linus');
    await guest.page.getByLabel('Oda kodu').fill(code);
    await guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
    await expect(guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();

    await host.page.getByRole('button', { name: 'WRAITH gövdesini seç' }).click();
    await guest.page.getByRole('button', { name: 'PULSE gövdesini seç' }).click();
    await host.page.getByRole('button', { name: 'Hazırım' }).click();
    await guest.page.getByRole('button', { name: 'Hazırım' }).click();
    await host.page.bringToFront();
    await expect(host.page.getByRole('button', { name: 'Maçı Başlat' })).toBeEnabled();
    await host.page.getByRole('button', { name: 'Maçı Başlat' }).click();

    await expect(host.page.getByRole('dialog', { name: 'Telefonu yatay çevir' })).toBeVisible();
    await expect(host.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeAttached();
    await expect.poll(() => game.harness.matchSnapshot(code)?.phase, { timeout: 12_000 }).toBe('REGULATION');
    const initial = game.harness.matchSnapshot(code);
    const hostPlayerId = initial?.players.find((candidate) => candidate.name === 'Mobil Ada')?.playerId;
    const guestPlayerId = initial?.players.find((candidate) => candidate.name === 'Linus')?.playerId;
    if (!hostPlayerId || !guestPlayerId) throw new Error('Mobile match players were not available.');
    await expect.poll(() => game.harness.transportMode(hostPlayerId), { timeout: 10_000 }).toBe('webrtc');

    await host.page.setViewportSize({ width: 667, height: 375 });
    await expect(host.page.getByRole('dialog', { name: 'Telefonu yatay çevir' })).toHaveCount(0);
    const touchControls = host.page.getByLabel('Dokunmatik kontroller');
    await expect(touchControls).toBeVisible();
    await expect(host.page.getByRole('application', { name: 'Yön pedi' })).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Hızlı saldırı' })).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Charge saldırı' })).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Dash' })).toBeVisible();
    await host.page.bringToFront();
    const frameDurations = await sampleAnimationFrameDurations(host.page);
    expect(percentile95(frameDurations)).toBeLessThan(33);

    game.harness.placePlayer(code, hostPlayerId, { x: 520, y: 360 }, { x: 1, y: 0 });
    game.harness.placePlayer(code, guestPlayerId, { x: 900, y: 360 }, { x: -1, y: 0 });
    await waitForNeutral(game, code, hostPlayerId);

    const pad = host.page.getByRole('application', { name: 'Yön pedi' });
    const padBox = await pad.boundingBox();
    if (!padBox) throw new Error('Touch joystick was not measurable.');
    const sequenceBeforeTouch = player(game, code, hostPlayerId).lastProcessedInputSeq;
    const movementStart = player(game, code, hostPlayerId).position.x;
    await dispatchTouch(cdp, 'touchStart', [touchPoint(padBox, 1)]);
    await dispatchTouch(cdp, 'touchMove', [touchPoint(padBox, 1, padBox.width / 2 - 3)]);
    await expect.poll(() => player(game, code, hostPlayerId).position.x).toBeGreaterThan(movementStart + 12);
    await expect.poll(() => player(game, code, hostPlayerId).lastProcessedInputSeq).toBeGreaterThan(sequenceBeforeTouch);
    await dispatchTouch(cdp, 'touchEnd');

    await waitForNeutral(game, code, hostPlayerId);
    const quick = host.page.getByRole('button', { name: 'Hızlı saldırı' });
    const quickBox = await quick.boundingBox();
    if (!quickBox) throw new Error('Quick touch button was not measurable.');
    await dispatchTouch(cdp, 'touchStart', [touchPoint(quickBox, 2)]);
    await expect.poll(() => player(game, code, hostPlayerId).action.kind).toBe('QUICK_1');
    await dispatchTouch(cdp, 'touchEnd');

    await waitForNeutral(game, code, hostPlayerId);
    const heavy = host.page.getByRole('button', { name: 'Charge saldırı' });
    const heavyBox = await heavy.boundingBox();
    if (!heavyBox) throw new Error('Heavy touch button was not measurable.');
    await dispatchTouch(cdp, 'touchStart', [touchPoint(heavyBox, 3)]);
    await expect.poll(() => player(game, code, hostPlayerId).action.chargeMs).toBeGreaterThanOrEqual(180);
    await dispatchTouch(cdp, 'touchEnd');
    await expect.poll(() => player(game, code, hostPlayerId).action.kind).toBe('HEAVY');

    await waitForNeutral(game, code, hostPlayerId);
    const dash = host.page.getByRole('button', { name: 'Dash' });
    const dashBox = await dash.boundingBox();
    if (!dashBox) throw new Error('Dash touch button was not measurable.');
    await dispatchTouch(cdp, 'touchStart', [touchPoint(dashBox, 4)]);
    await expect.poll(() => {
      const candidate = player(game, code, hostPlayerId);
      return candidate.dashRemainingMs > 0 || candidate.dashCooldownRemainingMs > 0;
    }).toBe(true);
    await dispatchTouch(cdp, 'touchCancel');

    expect(player(game, code, hostPlayerId).lastProcessedInputSeq).toBeGreaterThan(0);
    await mkdir('artifacts/qa', { recursive: true });
    await host.page.screenshot({ path: 'artifacts/qa/match-mobile.png' });
    await assertNoUnexpectedErrors(game, host, guest);
  } finally {
    await Promise.all([host.context.close(), guest.context.close()]);
  }
});

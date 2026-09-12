import type { Browser } from '@playwright/test';
import {
  assertNoUnexpectedErrors,
  expect,
  openPlayer,
  test,
  type PlayerPage
} from './fixtures.js';

async function openInvitePlayer(browser: Browser, inviteUrl: string): Promise<PlayerPage> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const issues = { pageErrors: [] as string[], consoleErrors: [] as string[] };
  page.on('pageerror', (error) => issues.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.consoleErrors.push(`${message.type()}: ${message.text()}`);
  });
  await page.goto(inviteUrl);
  await expect(page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
  return { context, page, issues };
}

test('an invite link opens a name-only join flow and preserves its room URL', async ({ browser, game }) => {
  const host = await openPlayer(browser, game.origin);
  let guest: PlayerPage | null = null;

  try {
    await host.page.route('**/api/runtime/network', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          port: Number(new URL(game.origin).port),
          localUrl: game.origin,
          lanAddresses: [{ interfaceName: 'fixture', address: '127.0.0.1', url: game.origin }]
        })
      });
    });

    await host.page.getByLabel('Oyuncu adı').fill('Ada');
    await host.page.getByRole('button', { name: 'Oda Kur' }).click();
    await expect(host.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();

    const code = await host.page.getByTestId('room-code').textContent();
    if (!code) throw new Error('Host room code was not rendered.');
    const inviteUrl = `${game.origin}/room/${code}`;
    const inviteLink = host.page.getByRole('link', { name: inviteUrl });
    await expect(inviteLink).toBeVisible();
    await expect(inviteLink).toHaveAttribute('href', inviteUrl);

    const hostPlayerId = game.server.rooms.debugRoom(code)?.playerIds[0];
    if (!hostPlayerId) throw new Error('Host player was not registered in the fixture room.');

    guest = await openInvitePlayer(browser, inviteUrl);
    await expect.poll(() => new URL(guest!.page.url()).pathname).toBe(`/room/${code}`);
    await expect(guest.page.getByText(/oda daveti/i)).toBeVisible();
    await expect(guest.page.getByText(code, { exact: true })).toBeVisible();
    await expect(guest.page.getByLabel('Oyuncu adı')).toBeVisible();
    await expect(guest.page.getByLabel('Oda kodu')).toHaveCount(0);
    await expect(guest.page.getByRole('button', { name: 'Oda Kur' })).toHaveCount(0);

    await guest.page.getByLabel('Oyuncu adı').fill('Linus');
    await guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
    await expect(guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    await expect(host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toBeVisible();
    await expect.poll(() => game.server.rooms.debugRoom(code)).toMatchObject({
      connectedCount: 2,
      reservedCount: 0
    });

    const joinedPlayerIds = game.server.rooms.debugRoom(code)?.playerIds ?? [];
    const guestPlayerId = joinedPlayerIds.find((playerId) => playerId !== hostPlayerId);
    if (!guestPlayerId) throw new Error('Invited player was not registered in the fixture room.');

    await guest.page.reload();
    await expect(guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    await expect.poll(() => new URL(guest!.page.url()).pathname).toBe(`/room/${code}`);
    await expect.poll(() => {
      const room = game.server.rooms.debugRoom(code);
      return room ? {
        connectedCount: room.connectedCount,
        reservedCount: room.reservedCount,
        playerIds: room.playerIds
      } : null;
    }).toEqual({
      connectedCount: 2,
      reservedCount: 0,
      playerIds: [hostPlayerId, guestPlayerId]
    });
    await expect(host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toHaveCount(1);

    await guest.page.getByRole('button', { name: 'Odadan Çık' }).click();
    await expect(guest.page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    await expect.poll(() => new URL(guest!.page.url()).pathname).toBe('/');
    await expect(host.page.getByRole('list', { name: 'Oyuncular' }).getByText('Linus')).toHaveCount(0);
    await expect.poll(() => game.server.rooms.debugRoom(code)?.playerIds).toEqual([hostPlayerId]);
    await assertNoUnexpectedErrors(game, host, guest);
  } finally {
    await Promise.all([
      host.context.close(),
      guest?.context.close() ?? Promise.resolve()
    ]);
  }
});

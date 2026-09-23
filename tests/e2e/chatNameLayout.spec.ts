import { openPlayer, assertNoUnexpectedErrors, expect, test } from './fixtures.js';

for (const mobile of [false, true]) {
  test(`chat timestamps and long names keep their columns on ${mobile ? 'mobile' : 'desktop'}`, async ({ browser, game }, info) => {
    const hostName = 'W'.repeat(16), guestName = '界'.repeat(16);
    const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    const host = await openPlayer(browser, game.origin, { contextOptions: { viewport, isMobile: mobile, hasTouch: mobile } });
    const guest = await openPlayer(browser, game.origin);
    try {
      await host.page.getByLabel('Oyuncu adı').fill(hostName);
      await host.page.getByRole('button', { name: 'Oda Kur' }).click();
      const code = await host.page.getByTestId('room-code').innerText();
      await guest.page.getByLabel('Oyuncu adı').fill(guestName);
      await guest.page.getByLabel('Oda kodu').fill(code);
      await guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
      await guest.page.getByRole('region', { name: 'Oda lobisi' }).waitFor();
      await host.page.getByLabel('Mesaj', { exact: true }).fill('Hazırsanız başlayalım.');
      await host.page.getByRole('button', { name: 'Gönder', exact: true }).click();
      await guest.page.getByLabel('Mesaj', { exact: true }).fill('UzunMesaj'.repeat(20));
      await guest.page.getByRole('button', { name: 'Gönder', exact: true }).click();
      const rows = host.page.locator('.lobby-chat__message');
      await expect(rows).toHaveCount(2);
      await expect(rows.first().locator('time')).toHaveText(/^\d{2}:\d{2}$/);
      const columns = await rows.evaluateAll(elements => elements.map(row => Array.from(row.children).map(cell => cell.getBoundingClientRect().x)));
      expect(columns[0]).toEqual(columns[1]);
      await expect(host.page.locator('.lobby-chat__sender').first()).toHaveAttribute('title', hostName);
      expect(await host.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const boundedNames = async (selector: string) => host.page.locator(selector).evaluateAll(elements => elements.every(element => {
        const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect();
        return box.right <= parent.right + 1 && box.left >= parent.left - 1;
      }));
      expect(await boundedNames('.player-row__identity strong')).toBe(true);
      await host.page.locator('.lobby-chat').scrollIntoViewIfNeeded();
      await host.page.screenshot({ animations: 'disabled', path: info.outputPath('chat.png') });
      await host.page.getByLabel('Kazanma hedefi').selectOption('3');
      await host.page.getByRole('button', { name: 'Hazırım', exact: true }).click();
      await guest.page.getByRole('button', { name: 'Hazırım', exact: true }).click();
      await host.page.getByRole('button', { name: 'Maçı Başlat', exact: true }).click();
      if (mobile) await host.page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(() => game.harness.matchSnapshot(code)?.phase).toBe('REGULATION');
      expect(await boundedNames('.match-hud__player-name')).toBe(true);
      await host.page.screenshot({ animations: 'disabled', path: info.outputPath('match.png') });
      const players = game.harness.matchSnapshot(code)!.players;
      const hostId = players.find(player => player.name === hostName)!.playerId;
      const guestId = players.find(player => player.name === guestName)!.playerId;
      for (let i = 0; i < 3; i++) {
        game.harness.forceKnockout(code, hostId, guestId);
        await expect.poll(() => game.harness.matchSnapshot(code)?.scores[hostId]).toBe(i + 1);
        const knockout = game.harness.recentEvents(code).filter(event => event.type === 'KNOCKOUT').at(-1)!;
        if (i < 2) await expect.poll(() => game.harness.recentEvents(code).some(event => event.eventId > knockout.eventId && event.type === 'RESPAWN' && event.playerId === guestId)).toBe(true);
      }
      await host.page.getByRole('heading', { name: `${hostName} Kazandı` }).waitFor();
      if (mobile) await host.page.setViewportSize(viewport);
      expect(await host.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await host.page.locator('.result-frame').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(host.page.getByRole('rowheader', { name: hostName })).toHaveAttribute('title', hostName);
      expect((await host.page.getByRole('rowheader', { name: hostName }).boundingBox())!.width).toBeGreaterThan(70);
      await host.page.screenshot({ animations: 'disabled', path: info.outputPath('result.png') });
      await host.page.getByRole('button', { name: 'Lobiye Dön', exact: true }).click();
      await expect(guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
      await assertNoUnexpectedErrors(game, host, guest);
    } finally { await host.context.close(); await guest.context.close(); }
  });
}

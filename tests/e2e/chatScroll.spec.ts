import { openPlayer, assertNoUnexpectedErrors, expect, test } from './fixtures.js';

test('chat follows the latest message, pauses while reading, and resumes on request', async ({ browser, game }) => {
  const host = await openPlayer(browser, game.origin, { contextOptions: { viewport: { width: 390, height: 844 } } });
  const guest = await openPlayer(browser, game.origin);
  try {
    await host.page.getByLabel('Oyuncu adı').fill('Owner');
    await host.page.getByRole('button', { name: 'Oda Kur', exact: true }).click();
    const code = await host.page.getByTestId('room-code').innerText();
    await guest.page.getByLabel('Oyuncu adı').fill('Guest');
    await guest.page.getByLabel('Oda kodu').fill(code);
    await guest.page.getByRole('button', { name: 'Odaya Katıl', exact: true }).click();
    await guest.page.getByRole('region', { name: 'Oda lobisi' }).waitFor();
    const log = host.page.getByRole('log');
    const send = async (prefix: string) => {
      const text = prefix + 'x'.repeat(230);
      await guest.page.getByLabel('Mesaj', { exact: true }).fill(text);
      await guest.page.getByRole('button', { name: 'Gönder', exact: true }).click();
      await expect(host.page.locator('.lobby-chat__text').last()).toHaveText(text);
    };
    await send('İlk: ');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await send('Devam: ');
    await expect.poll(() => log.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const distanceFromEnd = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await host.page.getByLabel('Mesaj', { exact: true }).fill('Taslak');
    // Room chat accepts one message per player per second.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await send('İkinci: ');
    await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(0);
    await expect(host.page.getByLabel('Mesaj', { exact: true })).toHaveValue('Taslak');
    await expect(host.page.getByLabel('Mesaj', { exact: true })).toBeFocused();
    await host.page.getByRole('button', { name: 'Son mesaja git', exact: true }).click();
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await send('Üçüncü: ');
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await assertNoUnexpectedErrors(game, host, guest);
  } finally { await host.context.close(); await guest.context.close(); }
});

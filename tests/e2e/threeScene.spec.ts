import { mkdir } from 'node:fs/promises';
import { CHASSIS } from '../../src/shared/model.js';
import { FIGHTERS } from '../../src/shared/fighters.js';
import { assertNoUnexpectedErrors, createTwoPlayerMatch, expect, openPlayer, test } from './fixtures.js';

test('shows all four 3D fighters and their actual ability descriptions in the lobby', async ({ browser, game }) => {
  const host = await openPlayer(browser, game.origin);
  try {
    await host.page.getByLabel('Oyuncu adı').fill('Atlas');
    await host.page.getByRole('button', { name: 'Oda Kur', exact: true }).click();
    const preview = host.page.locator('.fighter-showcase__canvas canvas');
    await expect(preview).toBeVisible();
    for (const chassis of CHASSIS) {
      const choice = host.page.getByRole('button', { name: `${chassis} gövdesini seç` });
      if (await choice.isEnabled()) await choice.click();
      await expect(host.page.locator('.fighter-showcase__ability')).toContainText(FIGHTERS[chassis].abilityName);
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
    }
    await mkdir('artifacts/qa', { recursive: true });
    await host.page.screenshot({ path: 'artifacts/qa/lobby-desktop.png' });
    const start = await host.page.getByRole('button', { name: 'Maçı Başlat' }).boundingBox();
    expect(start!.y + start!.height).toBeLessThanOrEqual(720);
    await assertNoUnexpectedErrors(game, host);
  } finally { await host.context.close(); }
});

test('renders a synchronized 2.5D match and responds to real movement and ability input', async ({ browser, game }) => {
  const match = await createTwoPlayerMatch(browser, game, undefined, { observeInput: true });
  try {
    const canvas = match.host.page.locator('canvas[data-renderer="three"]');
    await expect(canvas).toHaveAttribute('data-fighters', '2');
    const before = await match.host.page.locator('.fighter-label.is-local').getAttribute('style');
    await match.host.page.keyboard.down('KeyD');
    await expect.poll(() => match.host.page.locator('.fighter-label.is-local').getAttribute('style')).not.toBe(before);
    await match.host.page.keyboard.up('KeyD');
    await match.host.page.keyboard.press('Space');
    await expect.poll(() => match.host.page.getByRole('meter', { name: 'Dash dolumu' }).getAttribute('aria-valuenow')).not.toBe('100');
    await mkdir('artifacts/qa', { recursive: true });
    await match.host.page.screenshot({ path: 'artifacts/qa/match-desktop.png' });
    game.harness.forceKnockout(match.code, match.guestPlayerId, match.hostPlayerId);
    await match.host.page.waitForTimeout(900);
    await match.host.page.screenshot({ path: 'artifacts/qa/respawn-desktop.png' });
    await assertNoUnexpectedErrors(game, match.host, match.guest);
  } finally { await match.close(); }
});

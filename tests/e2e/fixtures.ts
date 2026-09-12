import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type ConsoleMessage,
  type Page
} from '@playwright/test';
import { createGameServer, type GameServer } from '../../src/server/network/createGameServer.js';
import {
  createWeriftServerPeer,
  readWebRtcUdpPortRange
} from '../../src/server/network/gameplayTransport/WeriftServerPeer.js';
import type { TransportImpairment } from '../../src/server/network/gameplayTransport/ServerPeer.js';
import type { MatchSnapshot } from '../../src/shared/model.js';
import type { RoomSettings } from '../../src/shared/roomSettings.js';

const REGULATION_TIMEOUT_MS = 12_000;

export type BrowserIssueLog = Readonly<{ pageErrors: string[]; consoleErrors: string[] }>;

export type E2eGame = Readonly<{
  origin: string;
  server: GameServer;
  harness: NonNullable<GameServer['testHarness']>;
  serverErrors: readonly string[];
}>;

export type E2eGameplayTransportOptions = Readonly<{
  impairment?: TransportImpairment;
  outboundFastReorderWindow?: number;
}> | null;

export const test = base.extend<{ game: E2eGame; gameplayTransportOptions: E2eGameplayTransportOptions }>({
  gameplayTransportOptions: [null, { option: true, scope: 'worker' }],
  game: [async ({ gameplayTransportOptions }, provideGame) => {
    const serverErrors: string[] = [];
    const impairment = gameplayTransportOptions?.impairment;
    const outboundFastReorderWindow = gameplayTransportOptions?.outboundFastReorderWindow;
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      enableTestHarness: true,
      ...(impairment
        ? {
            testGameplayTransport: {
              peerFactory: createWeriftServerPeer,
              udpPortRange: readWebRtcUdpPortRange(process.env),
              impairment: outboundFastReorderWindow === undefined
                ? impairment
                : ({ channel, direction }) => ({
                    ...impairment,
                    reorderWindow: channel === 'fast' && direction === 'outbound'
                      ? outboundFastReorderWindow
                      : 0
                  })
            }
          }
        : {}),
      logger: {
        error: (...values: unknown[]): void => {
          serverErrors.push(values.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(' '));
        }
      }
    });
    const { origin } = await server.start();
    if (!server.testHarness) throw new Error('E2E server requires its in-process test harness.');
    try {
      await provideGame({ origin, server, harness: server.testHarness, serverErrors });
    } finally {
      await server.stop();
    }
  }, { scope: 'worker' }]
});

export { expect };

export type PlayerPage = Readonly<{
  context: BrowserContext;
  page: Page;
  issues: BrowserIssueLog;
}>;

export type MatchPages = Readonly<{
  code: string;
  host: PlayerPage;
  guest: PlayerPage;
  hostPlayerId: string;
  guestPlayerId: string;
  close(): Promise<void>;
}>;

export type OpenPlayerOptions = Readonly<{
  contextOptions?: BrowserContextOptions;
  initScript?: () => void;
  observeInput?: boolean;
}>;

function errorText(message: ConsoleMessage): string {
  return `${message.type()}: ${message.text()}`;
}

export async function openPlayer(
  browser: Browser,
  origin: string,
  options: OpenPlayerOptions = {}
): Promise<PlayerPage> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...options.contextOptions });
  if (options.observeInput) {
    await context.addInitScript(() => {
      (window as typeof window & { __NEON_E2E_INPUT_OBSERVER__?: unknown }).__NEON_E2E_INPUT_OBSERVER__ = {
        inputs: [],
        acceptedSnapshots: [],
        reconciliations: [],
        localPresentations: [],
        timelineSamples: [],
        fallbackReasons: []
      };
    });
  }
  if (options.initScript) await context.addInitScript(options.initScript);
  const page = await context.newPage();
  const issues = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (error) => issues.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.consoleErrors.push(errorText(message));
  });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
  return { context, page, issues };
}

async function chooseChassisAndReady(player: PlayerPage, chassis: string): Promise<void> {
  await player.page.getByRole('button', { name: `${chassis} gövdesini seç` }).click();
  await player.page.getByRole('button', { name: 'Hazırım' }).click();
}

async function applyRoomSettings(
  host: PlayerPage,
  guest: PlayerPage,
  settings: RoomSettings
): Promise<void> {
  const hostDuration = host.page.getByLabel('Maç süresi');
  const hostTarget = host.page.getByLabel('Kazanma hedefi');
  const guestDuration = guest.page.getByLabel('Maç süresi');
  const guestTarget = guest.page.getByLabel('Kazanma hedefi');

  await expect(hostDuration).toBeEnabled();
  await expect(hostTarget).toBeEnabled();
  await expect(guestDuration).toBeDisabled();
  await expect(guestTarget).toBeDisabled();

  if (await hostDuration.inputValue() !== String(settings.durationMs)) {
    await hostDuration.selectOption(String(settings.durationMs));
  }
  await expect(hostDuration).toHaveValue(String(settings.durationMs));
  await expect(guestDuration).toHaveValue(String(settings.durationMs));

  if (await hostTarget.inputValue() !== String(settings.knockoutTarget)) {
    await hostTarget.selectOption(String(settings.knockoutTarget));
  }
  await expect(hostTarget).toHaveValue(String(settings.knockoutTarget));
  await expect(guestTarget).toHaveValue(String(settings.knockoutTarget));
  await expect(guestDuration).toBeDisabled();
  await expect(guestTarget).toBeDisabled();
}

function playerId(snapshot: MatchSnapshot, name: string): string {
  const player = snapshot.players.find((candidate) => candidate.name === name);
  if (!player) throw new Error(`Missing ${name} in match snapshot.`);
  return player.playerId;
}

export async function createTwoPlayerMatch(
  browser: Browser,
  game: E2eGame,
  settings?: RoomSettings,
  options: Readonly<{
    observeInput?: boolean;
    hostInitScript?: () => void;
    guestInitScript?: () => void;
    waitForWebRtcBeforeStart?: boolean;
  }> = {}
): Promise<MatchPages> {
  const host = await openPlayer(browser, game.origin, {
    observeInput: options.observeInput,
    initScript: options.hostInitScript
  });
  const guest = await openPlayer(browser, game.origin, {
    observeInput: options.observeInput,
    initScript: options.guestInitScript
  });
  try {
    await host.page.getByLabel('Oyuncu adı').fill('Ada');
    await host.page.getByRole('button', { name: 'Oda Kur' }).click();
    await expect(host.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();
    const code = await host.page.getByTestId('room-code').textContent();
    if (!code) throw new Error('Host room code was not rendered.');

    await guest.page.getByLabel('Oyuncu adı').fill('Linus');
    await guest.page.getByLabel('Oda kodu').fill(code);
    await guest.page.getByRole('button', { name: 'Odaya Katıl' }).click();
    await expect(guest.page.getByRole('region', { name: 'Oda lobisi' })).toBeVisible();

    if (options.waitForWebRtcBeforeStart) {
      const lobbyPlayerIds = game.server.rooms.debugRoom(code)?.playerIds;
      if (!lobbyPlayerIds || lobbyPlayerIds.length !== 2) {
        throw new Error('Two lobby player identities were not available to the E2E harness.');
      }
      try {
        await expect.poll(() => lobbyPlayerIds.map((id) => game.harness.transportMode(id)), {
          timeout: 10_000
        }).toEqual(['webrtc', 'webrtc']);
      } catch (error) {
        const fallbackReasons = await Promise.all([host.page, guest.page].map((page) => page.evaluate(() => {
          const candidate = (window as typeof window & {
            __NEON_E2E_INPUT_OBSERVER__?: { fallbackReasons?: unknown[] };
          }).__NEON_E2E_INPUT_OBSERVER__;
          return candidate?.fallbackReasons ?? [];
        })));
        throw new Error(`WebRTC lobby activation failed: ${JSON.stringify({
          modes: lobbyPlayerIds.map((id) => game.harness.transportMode(id)),
          fallbackReasons
        })}`, { cause: error });
      }
    }

    if (settings) await applyRoomSettings(host, guest, settings);

    await chooseChassisAndReady(host, 'WRAITH');
    await chooseChassisAndReady(guest, 'PULSE');
    await host.page.bringToFront();
    await expect(host.page.getByRole('button', { name: 'Maçı Başlat' })).toBeEnabled();
    await host.page.getByRole('button', { name: 'Maçı Başlat' }).click();
    await expect(host.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeVisible();
    await expect(guest.page.getByRole('img', { name: 'Neon Knockout oyun alanı' })).toBeVisible();
    await expect.poll(() => game.harness.matchSnapshot(code)?.phase, { timeout: REGULATION_TIMEOUT_MS }).toBe('REGULATION');
    const snapshot = game.harness.matchSnapshot(code);
    if (!snapshot) throw new Error('Match snapshot was not available after the countdown.');
    return {
      code,
      host,
      guest,
      hostPlayerId: playerId(snapshot, 'Ada'),
      guestPlayerId: playerId(snapshot, 'Linus'),
      close: async () => { await Promise.all([host.context.close(), guest.context.close()]); }
    };
  } catch (error) {
    await Promise.all([host.context.close(), guest.context.close()]);
    throw error;
  }
}

export async function assertNoUnexpectedErrors(game: E2eGame, ...players: readonly PlayerPage[]): Promise<void> {
  for (const player of players) {
    expect(player.issues.pageErrors, `page errors for ${await player.page.title()}`).toEqual([]);
    expect(player.issues.consoleErrors, `console errors for ${await player.page.title()}`).toEqual([]);
  }
  expect(game.serverErrors, 'unexpected server logger errors').toEqual([]);
}

export function sampleAnimationFrameDurations(page: Page, sampleCount = 121): Promise<number[]> {
  return page.evaluate((count) => new Promise<number[]>((resolve) => {
    const durations: number[] = [];
    let previous = performance.now();
    const sample = (now: number): void => {
      durations.push(now - previous);
      previous = now;
      if (durations.length >= count) resolve(durations.slice(1));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), sampleCount);
}

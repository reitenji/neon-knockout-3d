import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGameServer } from './network/createGameServer.js';
import { discoverLanUrls } from './runtime/lanAddresses.js';

export function parsePort(value: string | undefined): number {
  if (value === undefined) return 4175;
  if (!/^\d+$/u.test(value)) throw new Error(`Geçersiz PORT: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Geçersiz PORT: ${value}`);
  return port;
}

export async function runGameServer(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = createGameServer({ host, port });
  const address = await server.start();

  console.log('⚡ Neon Knockout 3D — LAN Arena');
  for (const candidate of discoverLanUrls(address.port, networkInterfaces())) {
    const label = candidate.kind === 'local'
      ? 'Bu bilgisayar'
      : candidate.kind === 'virtual'
        ? 'Olası sanal/VPN arayüzü'
        : 'Yerel ağ';
    console.log(`  ${label}: ${candidate.url}`);
  }
  console.log(`Yerel bağlantı çalışıp diğer cihazlar bağlanamıyorsa güvenlik duvarında ${address.port} portuna izin verin.`);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = server.stop().catch((error: unknown) => {
      console.error('Neon Knockout 3D kapatılırken hata oluştu.', error);
      process.exitCode = 1;
    });
    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  runGameServer().catch((error: unknown) => {
    console.error('Neon Knockout 3D başlatılamadı.', error);
    process.exitCode = 1;
  });
}

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { resumeRoomPreferenceFromLocation } from './inviteRoute.js';
import { createSocketGameClient } from './network/GameClient.js';
import { createGameStore } from './state/gameStore.js';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/game.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('MISSING_ROOT');
}

const client = import.meta.env.MODE === 'sites'
  ? (await import('./network/BrowserHostClient.js')).createBrowserHostClient()
  : createSocketGameClient();
const clipboard: Pick<Clipboard, 'writeText'> = {
  async writeText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Plain HTTP LAN origins may not expose the secure Clipboard API.
      }
    }

    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('COPY_FAILED');
  }
};
const store = createGameStore({
  client,
  storage: window.sessionStorage,
  clipboard,
  getPreferredResumeRoomCode: () =>
    resumeRoomPreferenceFromLocation(window.location.pathname, window.history.state)
});

createRoot(rootElement).render(<App store={store} />);

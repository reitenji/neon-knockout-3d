import { useState } from 'react';

export function RoomSharePanel({ roomCode }: Readonly<{ roomCode: string }>) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const url = `${window.location.origin}/room/${roomCode}`;

  async function copyLink(): Promise<void> {
    setPending(true);
    setFeedback('');
    try {
      await navigator.clipboard.writeText(url);
      setFeedback('Link kopyalandı. Arkadaşına gönderebilirsin.');
    } catch {
      setFeedback('Otomatik kopyalanamadı. Aşağıdaki linki seçip kopyalayabilirsin.');
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="browser-host-share" aria-label="Oda daveti">
      <button className="chrome-button focus-ring" type="button" disabled={pending}
        aria-busy={pending} onClick={() => void copyLink()}>Oda Linkini Kopyala</button>
      <input className="room-share-link focus-ring" aria-label="Oda linki" readOnly value={url}
        onFocus={(event) => event.currentTarget.select()} />
      <span role="status">{feedback}</span>
      <span>Arkadaşın linki açıp adını yazarak katılabilir. Oda sahibinin sekmesi açık kalmalı.</span>
    </aside>
  );
}

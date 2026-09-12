import { useState } from 'react';

export function RoomSharePanel({ roomCode }: Readonly<{ roomCode: string }>) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const url = `${window.location.origin}/room/${roomCode}`;

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setFeedback('Link kopyalandı. Arkadaşına gönderebilirsin.');
    } catch {
      setFeedback('Otomatik kopyalanamadı. Aşağıdaki linki seçip kopyalayabilirsin.');
    }
  }

  async function shareLink(): Promise<void> {
    setPending(true);
    setFeedback('');
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Neon Knockout 3D', url });
        setFeedback('Paylaşım tamamlandı.');
      } else {
        await copyLink();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setFeedback('Paylaşım iptal edildi.');
      } else {
        await copyLink();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="browser-host-share" aria-label="Oda daveti">
      <button className="chrome-button focus-ring" type="button" disabled={pending}
        aria-busy={pending} onClick={() => void shareLink()}>Oda Linkini Paylaş</button>
      <input className="room-share-link focus-ring" aria-label="Oda linki" readOnly value={url}
        onFocus={(event) => event.currentTarget.select()} />
      <span role="status">{feedback}</span>
      <span>Arkadaşın linki açıp adını yazarak katılabilir. Oda sahibinin sekmesi açık kalmalı.</span>
    </aside>
  );
}

import { useRef, useState } from 'react';
import type { LobbyChatMessage } from '../../shared/model.js';

type Props = Readonly<{
  messages: readonly LobbyChatMessage[];
  onSend: (text: string) => Promise<boolean>;
  disabled: boolean;
  error?: string;
}>;

export function LobbyChat({ messages, onSend, disabled, error }: Props) {
  const [draft, setDraft] = useState('');
  const history = useRef<HTMLDivElement>(null);
  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    if (await onSend(text)) setDraft(current => current === draft ? '' : current);
  };
  return <section className="lobby-chat" aria-labelledby="lobby-chat-title">
    <div className="lobby-chat__heading">
      <h2 id="lobby-chat-title">Lobi sohbeti</h2>
      <button type="button" className="chrome-button focus-ring" onClick={() => { if (history.current) history.current.scrollTop = history.current.scrollHeight; }}>Son mesaja git</button>
    </div>
    <div className="lobby-chat__history focus-ring" ref={history} role="log" aria-label="Lobi mesajları" aria-live="polite" tabIndex={0}>
      {messages.length === 0 ? <p className="lobby-chat__empty">Takım arkadaşlarına merhaba de. Son 50 mesaj burada görünür.</p> : messages.map(message => <p key={message.id} className="lobby-chat__message"><strong>{message.name}</strong><span>{message.text}</span></p>)}
    </div>
    <form className="lobby-chat__form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor="lobby-chat-input">Mesaj</label>
      <div className="lobby-chat__compose">
        <input id="lobby-chat-input" className="focus-ring" value={draft} maxLength={240} autoComplete="off" placeholder="Lobiye bir mesaj yaz…" onChange={event => setDraft(event.currentTarget.value)} />
        <button className="chrome-button focus-ring" type="submit" disabled={disabled || !draft.trim()}>Gönder</button>
      </div>
      <small>{draft.length}/240 · Yalnızca bu lobideki kişiler görür.</small>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </form>
  </section>;
}

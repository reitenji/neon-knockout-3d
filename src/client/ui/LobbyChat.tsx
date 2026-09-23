import { useRef, useState } from 'react';
import type { LobbyChatMessage } from '../../shared/model.js';

type Props = Readonly<{
  messages: readonly LobbyChatMessage[];
  onSend: (text: string) => Promise<boolean>;
  disabled: boolean;
  error?: string;
  title?: string;
}>;

const messageTime = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false });
const messageDate = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long', timeStyle: 'short' });

export function LobbyChat({ messages, onSend, disabled, error, title = 'Lobi sohbeti' }: Props) {
  const [draft, setDraft] = useState('');
  const history = useRef<HTMLDivElement>(null);
  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    if (await onSend(text)) setDraft(current => current === draft ? '' : current);
  };
  return <section className="lobby-chat" aria-labelledby="lobby-chat-title">
    <div className="lobby-chat__heading">
      <h2 id="lobby-chat-title">{title}</h2>
      <button type="button" className="lobby-chat__latest focus-ring" disabled={messages.length === 0} onClick={() => { if (history.current) history.current.scrollTop = history.current.scrollHeight; }}>Son mesaja git</button>
    </div>
    <div className="lobby-chat__history focus-ring" ref={history} role="log" aria-label="Oda mesajları" aria-live="polite" tabIndex={0}>
      {messages.length === 0 ? <p className="lobby-chat__empty">Takım arkadaşlarına merhaba de. Son 50 mesaj burada görünür.</p> : messages.map(message => <div key={message.id} className="lobby-chat__message">
        <strong className="lobby-chat__sender" title={message.name}>{message.name}</strong>
        <time dateTime={new Date(message.sentAt).toISOString()} title={`${messageDate.format(message.sentAt)} · Yerel saat`}>{messageTime.format(message.sentAt)}</time>
        <span className="lobby-chat__text">{message.text}</span>
      </div>)}
    </div>
    <form className="lobby-chat__form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor="lobby-chat-input">Mesaj</label>
      <div className="lobby-chat__compose">
        <input id="lobby-chat-input" className="focus-ring" value={draft} maxLength={240} autoComplete="off" placeholder="Odaya bir mesaj yaz…" onChange={event => setDraft(event.currentTarget.value)} />
        <button className="chrome-button focus-ring" type="submit" disabled={disabled || !draft.trim()}>Gönder</button>
      </div>
      <div className="lobby-chat__footer"><small>Yalnızca bu odadaki kişiler görür.</small><small>{draft.length}/240</small></div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </form>
  </section>;
}

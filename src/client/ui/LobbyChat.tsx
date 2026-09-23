import { useLayoutEffect, useRef, useState } from 'react';
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
  const followLatest = useRef(true);
  const readingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const scrollToLatest = () => {
    followLatest.current = true;
    readingAnchor.current = null;
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  };
  const rememberScrollPosition = () => {
    const log = history.current;
    if (!log) return;
    followLatest.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    const top = log.getBoundingClientRect().top;
    const firstVisible = Array.from(log.children).find(row => row.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    readingAnchor.current = !followLatest.current && firstVisible?.dataset.messageId
      ? { id: firstVisible.dataset.messageId, offset: firstVisible.getBoundingClientRect().top - top }
      : null;
  };
  useLayoutEffect(() => {
    const log = history.current;
    if (!log) return;
    if (followLatest.current) {
      log.scrollTop = log.scrollHeight;
    } else if (readingAnchor.current) {
      // Keep the visible message in place when the server trims the 50-message history.
      const anchor = readingAnchor.current;
      const row = Array.from(log.children).find(child => (child as HTMLElement).dataset.messageId === anchor.id);
      if (row) log.scrollTop += row.getBoundingClientRect().top - log.getBoundingClientRect().top - anchor.offset;
    }
  }, [messages]);
  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    if (await onSend(text)) {
      setDraft(current => current === draft ? '' : current);
      scrollToLatest();
    }
  };
  return <section className="lobby-chat" aria-labelledby="lobby-chat-title">
    <div className="lobby-chat__heading">
      <h2 id="lobby-chat-title">{title}</h2>
      <button type="button" className="lobby-chat__latest focus-ring" disabled={messages.length === 0} onClick={scrollToLatest}>Son mesaja git</button>
    </div>
    <div className="lobby-chat__history focus-ring" ref={history} onScroll={rememberScrollPosition} role="log" aria-label="Oda mesajları" aria-live="polite" tabIndex={0}>
      {messages.length === 0 ? <p className="lobby-chat__empty">Takım arkadaşlarına merhaba de. Son 50 mesaj burada görünür.</p> : messages.map(message => <div key={message.id} data-message-id={message.id} className="lobby-chat__message">
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

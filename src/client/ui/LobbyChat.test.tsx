import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LobbyChat } from './LobbyChat.js';
afterEach(cleanup);
const message = { id: 1, playerId: 'peer', name: 'Guest', text: '<script>hello</script>', sentAt: 1000 };
it('preserves draft, focus and scroll on incoming messages and renders text safely', () => {
  const onSend = vi.fn(async () => true);
  const view = render(<LobbyChat messages={[]} onSend={onSend} disabled={false} />);
  const input = screen.getByLabelText('Mesaj'); input.focus();
  fireEvent.change(input, { target: { value: 'Taslak' } });
  const log = screen.getByRole('log');
  Object.defineProperties(log, { scrollHeight: { value: 500, configurable: true }, clientHeight: { value: 180 } });
  log.scrollTop = 20; fireEvent.scroll(log);
  view.rerender(<LobbyChat messages={[message]} onSend={onSend} disabled={false} />);
  expect(input).toHaveValue('Taslak'); expect(input).toHaveFocus(); expect(log.scrollTop).toBe(20);
  expect(screen.getByText(message.text)).toBeVisible(); expect(log.querySelector('script')).toBeNull();
});
it('keeps failed drafts and clears only the successfully submitted draft', async () => {
  const onSend = vi.fn(async () => false);
  render(<LobbyChat messages={[]} onSend={onSend} disabled={false} />);
  const input = screen.getByLabelText('Mesaj');
  fireEvent.change(input, { target: { value: 'Merhaba' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Gönder' })));
  expect(input).toHaveValue('Merhaba');
  onSend.mockResolvedValue(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Gönder' })));
  expect(input).toHaveValue('');
});

it('shows sender, local hour and minute, and message in each row with an exact timestamp', () => {
  const sentAt = new Date(2026, 8, 23, 9, 7, 35).getTime();
  render(<LobbyChat messages={[{ ...message, sentAt }]} onSend={async () => true} disabled={false} />);
  const time = screen.getByText('09:07');
  expect(time.tagName).toBe('TIME');
  expect(time).toHaveAttribute('datetime', new Date(sentAt).toISOString());
  expect(time.parentElement).toHaveTextContent('Guest');
  expect(time.parentElement).toHaveTextContent(message.text);
});

it('follows incoming messages at the bottom, including replacement in the 50-message history', () => {
  const onSend = vi.fn(async () => true);
  const view = render(<LobbyChat messages={[]} onSend={onSend} disabled={false} />);
  const log = screen.getByRole('log');
  let height = 300;
  Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 180 } });
  view.rerender(<LobbyChat messages={[message]} onSend={onSend} disabled={false} />);
  expect(log.scrollTop).toBe(height);
  const full = Array.from({ length: 50 }, (_, i) => ({ ...message, id: i + 1 }));
  view.rerender(<LobbyChat messages={full} onSend={onSend} disabled={false} />);
  log.scrollTop = height - 180; fireEvent.scroll(log);
  height = 400;
  view.rerender(<LobbyChat messages={full.map(m => ({ ...m, id: m.id + 1 }))} onSend={onSend} disabled={false} />);
  expect(log.scrollTop).toBe(height);
});

it('resumes following after the latest-message button is clicked', () => {
  const onSend = vi.fn(async () => true);
  const view = render(<LobbyChat messages={[message]} onSend={onSend} disabled={false} />);
  const log = screen.getByRole('log');
  let height = 500;
  Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 180 } });
  log.scrollTop = 20; fireEvent.scroll(log);
  view.rerender(<LobbyChat messages={[message, { ...message, id: 2 }]} onSend={onSend} disabled={false} />);
  expect(log.scrollTop).toBe(20);
  fireEvent.click(screen.getByRole('button', { name: 'Son mesaja git' }));
  expect(log.scrollTop).toBe(500);
  height = 600;
  view.rerender(<LobbyChat messages={[message, { ...message, id: 2 }, { ...message, id: 3 }]} onSend={onSend} disabled={false} />);
  expect(log.scrollTop).toBe(600);
});

it('scrolls after sending successfully but preserves the reading position on failure', async () => {
  const onSend = vi.fn(async () => false);
  render(<LobbyChat messages={[message]} onSend={onSend} disabled={false} />);
  const log = screen.getByRole('log');
  Object.defineProperties(log, { scrollHeight: { value: 500 }, clientHeight: { value: 180 } });
  log.scrollTop = 20; fireEvent.scroll(log);
  fireEvent.change(screen.getByLabelText('Mesaj'), { target: { value: 'Merhaba' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Gönder' })));
  expect(log.scrollTop).toBe(20);
  onSend.mockResolvedValue(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Gönder' })));
  expect(log.scrollTop).toBe(500);
});

it('keeps the visible message anchored when old messages are trimmed', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ ...message, id: i + 1 }));
  const onSend = async () => true;
  const view = render(<LobbyChat messages={messages} onSend={onSend} disabled={false} />);
  const log = screen.getByRole('log');
  Object.defineProperties(log, { scrollHeight: { value: 1000 }, clientHeight: { value: 180 } });
  vi.spyOn(log, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
  const visibleRow = log.querySelector('[data-message-id="10"]')!;
  let rowTop = 110;
  vi.spyOn(visibleRow, 'getBoundingClientRect').mockImplementation(() => ({ top: rowTop, bottom: rowTop + 30 }) as DOMRect);
  log.scrollTop = 300; fireEvent.scroll(log);
  rowTop = 80;
  view.rerender(<LobbyChat messages={[...messages.slice(1), { ...message, id: 51 }]} onSend={onSend} disabled={false} />);
  expect(log.scrollTop).toBe(270);
});

it('uses each sender’s assigned player color for chat names', () => {
  render(<LobbyChat messages={[
    { ...message, name: 'Cyan', accent: 0 },
    { ...message, id: 2, name: 'Orange', accent: 1 }
  ]} onSend={async () => true} disabled={false} />);
  expect(screen.getByText('Cyan')).toHaveStyle({ color: '#6EE7F2' });
  expect(screen.getByText('Orange')).toHaveStyle({ color: '#FF8A5B' });
});

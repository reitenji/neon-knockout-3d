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
  const log = screen.getByRole('log'); log.scrollTop = 20;
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

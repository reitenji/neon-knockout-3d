import { describe, expect, it } from 'vitest';
import { parsePort } from '../main.js';

describe('parsePort', () => {
  it('uses 4175 by default and accepts integer TCP ports', () => {
    expect(parsePort(undefined)).toBe(4175);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it.each(['0', '65536', '1.5', '4173x', ''])('rejects invalid PORT value %j', (value) => {
    expect(() => parsePort(value)).toThrow(`Geçersiz PORT: ${value}`);
  });
});

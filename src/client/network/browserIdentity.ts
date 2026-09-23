const BROWSER_ID_KEY = 'neon-knockout:browser-id';

// Shared by tabs on this origin; session storage remains tab-specific for resume tokens.
export async function browserIdentity(): Promise<string> {
  const readOrCreate = (): string => {
    const existing = window.localStorage.getItem(BROWSER_ID_KEY);
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(BROWSER_ID_KEY, id);
    return id;
  };
  // Serialize first use across tabs where Web Locks are available (including Sites).
  return navigator.locks ? navigator.locks.request(BROWSER_ID_KEY, readOrCreate) : readOrCreate();
}

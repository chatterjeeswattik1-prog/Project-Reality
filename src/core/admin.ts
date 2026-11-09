// Admin-only modes (Close-quarters test, Sandbox). There are no accounts: the admin unlocks a browser once by opening
// the game with ?admin=<key> (kept in that browser; ?admin=off forgets it). Only the key's SHA-256 is in the code, so the
// public repository does not give it away. A local copy (dev server, test scripts) is always admin.
// Note: the modes run in the player's own browser and affect nobody else; this hides them, it is not a lock against
// someone editing the page's code.

const HASH = 'dfcb84d94a1ead847c196040bb6aa84dbe0c86aa9a620dfcd2ed66da5398d7c8';
const LS = 'pr.admin';

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function isAdmin(): Promise<boolean> {
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return true;
  const url = new URL(location.href), given = url.searchParams.get('admin');
  if (given !== null) {
    // Take the key out of the address bar (and so out of the history and of shared links).
    url.searchParams.delete('admin'); history.replaceState(null, '', url);
    try { if (given === 'off') localStorage.removeItem(LS); else localStorage.setItem(LS, given.trim()); } catch { /* private mode */ }
  }
  let key: string | null = null;
  try { key = localStorage.getItem(LS); } catch { /* private mode */ }
  if (!key) return false;
  try { return (await sha256(key)) === HASH; } catch { return false; } // crypto.subtle needs https (or localhost)
}

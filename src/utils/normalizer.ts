/**
 * Normalization utilities for Candidate Deduplication per ADR-0007 and DEC-07.
 */

export function normalizeEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeProfileUrl(rawUrl?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  try {
    let urlString = trimmed;
    if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
      urlString = `https://${urlString}`;
    }

    const parsed = new URL(urlString);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }

    // Strip tracking parameters
    const forbiddenPrefixes = ['utm_', 'trk', 'ref', 'fbclid', 'gclid', 'source', 'share'];
    const searchParams = new URLSearchParams(parsed.search);
    const keysToDelete: string[] = [];
    for (const key of searchParams.keys()) {
      const lowerKey = key.toLowerCase();
      if (forbiddenPrefixes.some((prefix) => lowerKey === prefix || lowerKey.startsWith(prefix))) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      searchParams.delete(key);
    }

    let pathname = parsed.pathname;
    while (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const queryString = searchParams.toString();
    return `${parsed.protocol}//${host}${pathname}${queryString ? `?${queryString}` : ''}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

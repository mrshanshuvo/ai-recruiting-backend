import dns from 'dns/promises';
import * as cheerio from 'cheerio';
import net from 'net';

export class SafeFetchError extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export function parseDecimalIp(host: string): string | null {
  // If host is pure numeric (e.g. 2130706433 or 0)
  if (/^\d+$/.test(host)) {
    const num = Number(host);
    if (!Number.isNaN(num) && num >= 0 && num <= 4294967295) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255,
      ].join('.');
    }
  }
  return null;
}

export function isPrivateIp(ip: string): boolean {
  const cleanIp = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();

  // IPv6 localhost / unspecified / private / link-local
  if (cleanIp === '::1' || cleanIp === '::' || cleanIp === '0:0:0:0:0:0:0:1' || cleanIp === '0:0:0:0:0:0:0:0') {
    return true;
  }
  if (cleanIp.startsWith('fe80:') || cleanIp.startsWith('fc00:') || cleanIp.startsWith('fd00:')) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (cleanIp.startsWith('::ffff:')) {
    return isPrivateIp(cleanIp.replace('::ffff:', ''));
  }

  // Check IPv4
  const parts = cleanIp.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !Number.isNaN(p) && p >= 0 && p <= 255)) {
    const [p0, p1] = parts;
    // 0.0.0.0/8 (current network)
    if (p0 === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (p0 === 127) return true;
    // 10.0.0.0/8 (private)
    if (p0 === 10) return true;
    // 172.16.0.0/12 (private: 172.16.x.x - 172.31.x.x)
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (p0 === 192 && p1 === 168) return true;
    // 169.254.0.0/16 (link-local & AWS/GCP cloud metadata)
    if (p0 === 169 && p1 === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;
  }

  return false;
}

export async function validateUrlHost(urlStr: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new SafeFetchError('INVALID_URL', 'Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeFetchError('INVALID_SCHEME', `Scheme ${parsed.protocol} is not supported. Only HTTP and HTTPS are allowed.`);
  }

  let hostname = parsed.hostname.replace(/^\[|\]$/g, '').trim();

  // Check localhost keyword
  if (hostname.toLowerCase() === 'localhost') {
    throw new SafeFetchError('SSRF_BLOCKED', 'Access to localhost is forbidden');
  }

  // Check decimal IP encoding (e.g. 2130706433 -> 127.0.0.1)
  const decimalIp = parseDecimalIp(hostname);
  if (decimalIp) {
    hostname = decimalIp;
  }

  // If already a literal IP address
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SafeFetchError('SSRF_BLOCKED', `Access to private/internal IP (${hostname}) is forbidden`);
    }
    return parsed;
  }

  // DNS pre-resolution guard
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new SafeFetchError('DNS_LOOKUP_FAILED', `Could not resolve hostname ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SafeFetchError('DNS_LOOKUP_FAILED', `No IP address found for hostname ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new SafeFetchError('SSRF_BLOCKED', `Access to private/internal IP (${addr.address}) via ${hostname} is forbidden`);
    }
  }

  return parsed;
}

export async function fetchSafeJdUrl(urlStr: string, maxRedirects = 3, timeoutMs = 10000): Promise<string> {
  let currentUrl = urlStr;
  let redirectsCount = 0;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    while (true) {
      const parsedUrl = await validateUrlHost(currentUrl);

      let res: Response;
      try {
        res = await fetch(parsedUrl.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'AIRecruitingCoWorker/1.0',
            Accept: 'text/html,text/plain',
          },
        });
      } catch (err: any) {
        if (err.name === 'AbortError') {
          throw new SafeFetchError('TIMEOUT', 'Fetch request timed out after 10 seconds');
        }
        throw new SafeFetchError('FETCH_ERROR', `Failed to fetch URL: ${err.message}`);
      }

      // Check redirect hops (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        redirectsCount++;
        if (redirectsCount > maxRedirects) {
          throw new SafeFetchError('REDIRECT_LIMIT', `Too many redirects (max ${maxRedirects} allowed)`);
        }

        const location = res.headers.get('location');
        if (!location) {
          throw new SafeFetchError('FETCH_ERROR', 'Redirect response missing Location header');
        }

        // Resolve relative redirects against current URL
        const nextUrl = new URL(location, parsedUrl).toString();
        currentUrl = nextUrl;
        continue;
      }

      if (!res.ok) {
        throw new SafeFetchError('HTTP_ERROR', `HTTP error ${res.status}: ${res.statusText}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 500 * 1024) {
        throw new SafeFetchError('PAYLOAD_TOO_LARGE', 'Payload exceeds max 500KB limit');
      }

      const bodyText = await res.text();
      if (bodyText.length > 500 * 1024) {
        throw new SafeFetchError('PAYLOAD_TOO_LARGE', 'Payload exceeds max 500KB limit');
      }

      // Strip HTML tags using Cheerio
      const $ = cheerio.load(bodyText);
      $('script, style, nav, footer, header, noscript, svg').remove();
      const text = $('body').text().replace(/\s+/g, ' ').trim();

      return text || bodyText.slice(0, 5000);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}


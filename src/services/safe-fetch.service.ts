import dns from 'dns/promises';
import * as cheerio from 'cheerio';

function isPrivateIp(ip: string): boolean {
  // IPv6 localhost
  if (ip === '::1' || ip === '::') return true;

  // Check IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    const [p0, p1] = parts;
    // 127.0.0.0/8 (loopback)
    if (p0 === 127) return true;
    // 10.0.0.0/8 (private)
    if (p0 === 10) return true;
    // 172.16.0.0/12 (private)
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (p0 === 192 && p1 === 168) return true;
    // 169.254.0.0/16 (link-local & AWS/cloud metadata)
    if (p0 === 169 && p1 === 254) return true;
    // 0.0.0.0
    if (p0 === 0) return true;
  }

  return false;
}

export async function fetchSafeJdUrl(urlStr: string): Promise<string> {
  const parsed = new URL(urlStr);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }

  // DNS pre-resolution SSRF guard
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new Error(`Access to private/internal network IP (${addr.address}) is forbidden.`);
    }
  }

  // Fetch with 10s timeout and 500KB cap
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AIRecruitingCoWorker/1.0',
        Accept: 'text/html,text/plain',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 500 * 1024) {
      throw new Error('Payload exceeds max 500KB limit');
    }

    const html = await res.text();
    if (html.length > 500 * 1024) {
      throw new Error('Payload exceeds max 500KB limit');
    }

    // Strip HTML using Cheerio
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}


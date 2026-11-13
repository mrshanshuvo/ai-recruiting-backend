import { describe, it, expect, vi } from 'vitest';
import dns from 'dns/promises';
import {
  validateUrlHost,
  fetchSafeJdUrl,
  isPrivateIp,
  parseDecimalIp,
  SafeFetchError,
} from '../services/safe-fetch.service';

describe('A1: SafeFetch Service SSRF Guard Unit Tests', () => {
  it('identifies private IPv4 and IPv6 addresses correctly', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);

    // Public IPs should not be private
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });

  it('correctly converts decimal IP integer to IPv4 string', () => {
    // 2130706433 = (127 << 24) + 1 = 127.0.0.1
    expect(parseDecimalIp('2130706433')).toBe('127.0.0.1');
    expect(parseDecimalIp('0')).toBe('0.0.0.0');
    expect(parseDecimalIp('not-a-number')).toBeNull();
  });

  it('rejects forbidden private hosts and IPs at validateUrlHost level', async () => {
    const forbiddenUrls = [
      'http://localhost',
      'http://127.0.0.1',
      'http://0.0.0.0',
      'http://[::1]',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://169.254.169.254',
      'http://2130706433', // decimal representation of 127.0.0.1
    ];

    for (const url of forbiddenUrls) {
      await expect(validateUrlHost(url)).rejects.toThrow(SafeFetchError);
      await expect(validateUrlHost(url)).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
    }
  });

  it('rejects non-HTTP schemes (file://, ftp://)', async () => {
    await expect(validateUrlHost('file:///etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_SCHEME',
    });
    await expect(validateUrlHost('ftp://example.com/job.txt')).rejects.toMatchObject({
      code: 'INVALID_SCHEME',
    });
  });

  it('rejects a public hostname that resolves via DNS to a private IP (DNS rebinding guard)', async () => {
    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '10.200.0.5', family: 4 },
    ] as any);

    await expect(validateUrlHost('http://malicious-internal-rebinding.com/jd')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });

    lookupSpy.mockRestore();
  });

  it('rejects redirect hops pointing to private/internal IPs', async () => {
    // Mock global fetch to return a 302 redirecting to http://169.254.169.254/latest/meta-data
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({
        Location: 'http://169.254.169.254/latest/meta-data',
      }),
    } as any);

    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 }, // public IP for initial url
    ] as any);

    await expect(fetchSafeJdUrl('http://public-redirector.com/link')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });

    lookupSpy.mockRestore();
    global.fetch = originalFetch;
  });

  it('rejects payloads exceeding the 500 KB limit', async () => {
    const originalFetch = global.fetch;
    const hugePayload = 'A'.repeat(501 * 1024);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(hugePayload.length),
      }),
      text: async () => hugePayload,
    } as any);

    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as any);

    await expect(fetchSafeJdUrl('http://public-site.com/huge-jd')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });

    lookupSpy.mockRestore();
    global.fetch = originalFetch;
  });

  it('rejects requests that time out after 10 seconds', async () => {
    const originalFetch = global.fetch;

    global.fetch = vi.fn().mockImplementationOnce((_url, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const abortError = new Error('AbortError');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    });

    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as any);

    // Fast test with timeoutMs parameter
    const fetchPromise = fetchSafeJdUrl('http://public-site.com/slow-jd', 3, 100);
    await expect(fetchPromise).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    lookupSpy.mockRestore();
    global.fetch = originalFetch;
  }, 2000);
});

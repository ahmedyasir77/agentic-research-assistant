import { describe, expect, it } from 'vitest';

import { assertSafeUrl, blockedReason, BlockedUrlError, type DnsResolver } from './ssrf.ts';

/** Every hostname resolves to whatever the test says, so no DNS is consulted. */
function dnsReturning(...addresses: string[]): DnsResolver {
  return () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
}

const PUBLIC_DNS = dnsReturning('93.184.216.34');

describe('blockedReason', () => {
  const blocked = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.254', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'unique local'],
    ['fc00::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:7f00:1', 'loopback'],
  ] as const;

  it.each(blocked)('blocks %s', (address) => {
    expect(blockedReason(address)).toBeDefined();
  });

  const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:2800:220:1::1'];

  it.each(allowed)('allows the public address %s', (address) => {
    expect(blockedReason(address)).toBeUndefined();
  });
});

describe('assertSafeUrl', () => {
  it('allows a public https url', async () => {
    const { url, addresses } = await assertSafeUrl('https://example.com/page', PUBLIC_DNS);
    expect(url.hostname).toBe('example.com');
    expect(addresses).toStrictEqual(['93.184.216.34']);
  });

  it('rejects a scheme outside the allowlist', async () => {
    await expect(assertSafeUrl('file:///etc/passwd', PUBLIC_DNS)).rejects.toThrow(BlockedUrlError);
    await expect(assertSafeUrl('gopher://example.com', PUBLIC_DNS)).rejects.toThrow(/scheme/u);
  });

  it('rejects credentials embedded in the url', async () => {
    await expect(assertSafeUrl('https://admin:hunter2@example.com', PUBLIC_DNS)).rejects.toThrow(
      /credentials/u,
    );
  });

  it('rejects localhost by name, not just by address', async () => {
    await expect(
      assertSafeUrl('http://localhost:8080/', dnsReturning('127.0.0.1')),
    ).rejects.toThrow(/loopback/u);
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(
      assertSafeUrl('http://169.254.169.254/latest/meta-data/', PUBLIC_DNS),
    ).rejects.toThrow(/link-local/u);
  });

  it('rejects a public name that resolves into a private range', async () => {
    // This is the attack the hostname check alone would miss: the name looks fine,
    // and the attacker controls what it resolves to.
    await expect(
      assertSafeUrl('https://evil.example.com/', dnsReturning('10.0.0.5')),
    ).rejects.toThrow(/10\.0\.0\.5/u);
  });

  it('rejects a name where only one of several answers is private', async () => {
    await expect(
      assertSafeUrl('https://evil.example.com/', dnsReturning('93.184.216.34', '127.0.0.1')),
    ).rejects.toThrow(/loopback/u);
  });

  it('rejects a name that does not resolve', async () => {
    const failing: DnsResolver = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://nope.example.com/', failing)).rejects.toThrow(/resolve/u);
  });

  it('rejects a name that resolves to nothing', async () => {
    await expect(assertSafeUrl('https://empty.example.com/', dnsReturning())).rejects.toThrow(
      /no addresses/u,
    );
  });

  it('rejects a relative url', async () => {
    await expect(assertSafeUrl('/etc/passwd', PUBLIC_DNS)).rejects.toThrow(/valid absolute URL/u);
  });

  it('checks bracketed ipv6 literals without consulting dns', async () => {
    const exploding: DnsResolver = () => {
      throw new Error('DNS should not be consulted for an address literal');
    };
    await expect(assertSafeUrl('http://[::1]:9200/', exploding)).rejects.toThrow(/loopback/u);
  });
});

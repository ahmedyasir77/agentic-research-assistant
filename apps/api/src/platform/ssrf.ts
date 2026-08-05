import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

import { redactUrlCredentials } from './redact.ts';

/**
 * `http_get` lets a language model choose a URL for a server we control to fetch.
 * Unguarded, that is a request forgery primitive: the model can be talked into
 * reading a cloud metadata endpoint, an internal admin page, or localhost.
 *
 * The guard is a DNS-resolving allowlist. Checking the hostname is not enough —
 * an attacker-controlled name can resolve to 169.254.169.254 — so the decision is
 * made on the resolved addresses, and again after every redirect.
 */
export class BlockedUrlError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    // The URL is echoed back to the model and written into the trace, so any
    // credentials in it are stripped first — the refusal must not publish the
    // very secret it refused to send.
    const safe = redactUrlCredentials(url);
    super(`Refused to fetch ${safe}: ${reason}`);
    this.name = 'BlockedUrlError';
    this.url = safe;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Injected so the SSRF matrix is a unit test rather than a network test. */
export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemDnsResolver: DnsResolver = async (hostname) => lookup(hostname, { all: true });

export interface SafeUrl {
  readonly url: URL;
  readonly addresses: readonly string[];
}

export async function assertSafeUrl(rawUrl: string, resolve: DnsResolver): Promise<SafeUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(rawUrl, 'not a valid absolute URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(rawUrl, `scheme "${url.protocol}" is not allowed (http/https only)`);
  }

  // Credentials in a URL are either a leak in the making or an attempt to
  // authenticate against something internal. Neither is a fetch we want to make.
  if (url.username !== '' || url.password !== '') {
    throw new BlockedUrlError(rawUrl, 'credentials in the URL are not allowed');
  }

  const literal = stripBrackets(url.hostname);
  const addresses =
    isIPv4(literal) || isIPv6(literal)
      ? [literal]
      : await resolveHost(url.hostname, rawUrl, resolve);

  // Every address the name resolves to must be safe. One bad answer in a
  // round-robin set is enough for an attacker, so a single bad address blocks.
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason !== undefined) {
      throw new BlockedUrlError(rawUrl, `${url.hostname} resolves to ${address} (${reason})`);
    }
  }

  return { url, addresses };
}

async function resolveHost(
  hostname: string,
  rawUrl: string,
  resolve: DnsResolver,
): Promise<readonly string[]> {
  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await resolve(hostname);
  } catch {
    throw new BlockedUrlError(rawUrl, `could not resolve ${hostname}`);
  }
  if (resolved.length === 0) throw new BlockedUrlError(rawUrl, `${hostname} has no addresses`);
  return resolved.map((entry) => entry.address);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Returns why an address is off limits, or undefined if it is a public address. */
export function blockedReason(address: string): string | undefined {
  if (isIPv4(address)) return blockedIPv4Reason(address);
  if (isIPv6(address)) return blockedIPv6Reason(address);
  return 'unrecognised address format';
}

function blockedIPv4Reason(address: string): string | undefined {
  const octets = address.split('.').map(Number);
  const [a = 0, b = 0] = octets;

  if (a === 0) return 'unspecified / this-network';
  if (a === 10) return 'private range 10.0.0.0/8';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local (cloud metadata lives here)';
  if (a === 172 && b >= 16 && b <= 31) return 'private range 172.16.0.0/12';
  if (a === 192 && b === 168) return 'private range 192.168.0.0/16';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT 100.64.0.0/10';
  if (a === 192 && b === 0) return 'IETF protocol assignments 192.0.0.0/24';
  if (a >= 224) return 'multicast / reserved / broadcast';
  return undefined;
}

function blockedIPv6Reason(address: string): string | undefined {
  const normalised = address.toLowerCase();

  // ::ffff:127.0.0.1 is loopback wearing an IPv6 costume — judge it as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalised);
  if (mapped?.[1] !== undefined) return blockedIPv4Reason(mapped[1]);

  // The same address can be written in hex (::ffff:7f00:1). Same rule applies.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalised);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return blockedIPv4Reason(dotted);
  }

  if (normalised === '::') return 'unspecified';
  if (normalised === '::1') return 'loopback';
  if (normalised.startsWith('fe80')) return 'link-local';
  if (/^f[cd]/u.test(normalised)) return 'unique local address';
  if (normalised.startsWith('ff')) return 'multicast';
  return undefined;
}

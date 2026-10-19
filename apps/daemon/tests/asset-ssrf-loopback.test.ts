import { describe, it, expect } from 'vitest';
import {
  assertExternalAssetUrl,
  assertAndFetchExternalAsset,
  validateBaseUrlResolved,
  createAssetValidatingLookup,
} from '../src/connectionTest.js';
import type { DnsLookupFn } from '../src/connectionTest.js';

// Fork policy (local-first BYOK): localhost/LAN/private hosts are valid
// user-configured provider AND provider-asset endpoints, so the upstream
// internal-IP/loopback blocks (issue #5478/#3225) are removed. These specs
// lock in the permissive behavior and the DNS-pinning plumbing that remains.

describe('assertExternalAssetUrl — permissive asset policy (fork)', () => {
  it('accepts loopback, private, metadata-range, and public asset URLs', async () => {
    for (const url of [
      'http://127.0.0.1:8080/image.png',
      'http://localhost:3000/image.png',
      'http://[::1]:8080/video.mp4',
      'http://127.1.2.3:9999/data',
      'http://10.0.0.5/image.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://93.184.216.34/image.png',
      'https://198.51.100.1/v1/assets/abc123.png',
    ]) {
      expect((await assertExternalAssetUrl(url)).ok).toBe(true);
    }
  });

  it('rejects empty, non-string, malformed, and non-http(s) URLs', async () => {
    expect((await assertExternalAssetUrl('')).ok).toBe(false);
    expect((await assertExternalAssetUrl(null as unknown as string)).ok).toBe(false);
    expect((await assertExternalAssetUrl('not-a-url')).ok).toBe(false);
    expect((await assertExternalAssetUrl('ftp://example.com/x.png')).ok).toBe(false);
  });
});

describe('validateBaseUrlResolved — resolved addresses stay attached', () => {
  it('allows hosts resolving to loopback or private space (forbidLoopback no longer blocks)', async () => {
    const dnsResolvesLoopback: DnsLookupFn = async () => [
      { address: '127.0.0.1', family: 4 },
    ];
    const result = await validateBaseUrlResolved(
      'http://local-gateway.internal/v1',
      dnsResolvesLoopback,
      { forbidLoopback: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.parsed).toBeDefined();
    expect(result.resolvedAddresses).toHaveLength(1);
  });

  it('fails closed when the validation lookup throws for asset URLs', async () => {
    const throwingDns: DnsLookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    const result = await validateBaseUrlResolved(
      'http://offline.example.com/image.png',
      throwingDns,
      { forbidLoopback: true },
    );
    expect(result.forbidden).toBe(true);
    expect(result.error).toContain('DNS resolution failed');
  });

  it('returns the sync result when DNS throws without forbidLoopback (fetch surfaces it)', async () => {
    const throwingDns: DnsLookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    const result = await validateBaseUrlResolved(
      'http://provider.example.com/v1',
      throwingDns,
      { forbidLoopback: false },
    );
    expect(result.forbidden).toBeUndefined();
    expect(result.parsed).toBeDefined();
  });
});

describe('createAssetValidatingLookup — pass-through (fork)', () => {
  const lookupReturns = (address: string) => (
    _hostname: string,
    _opts: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ): void => {
    cb(null, address, 4);
  };

  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '93.184.216.34']) {
    it(`passes ${address} through to the callback`, () => {
      const lookup = createAssetValidatingLookup(lookupReturns(address) as never);
      return new Promise<void>((resolve) => {
        lookup('host.test', {}, (...args: unknown[]) => {
          expect(args[0]).toBeNull();
          expect(args[1]).toBe(address);
          resolve();
        });
      });
    });
  }
});

describe('assertAndFetchExternalAsset — fetch plumbing (fork)', () => {
  it('fetches loopback asset URLs with redirect:error and a dispatcher', async () => {
    let capturedInit: RequestInit | undefined;
    let fetchedUrl = '';
    const stubFetch = async (url: string, init?: RequestInit) => {
      fetchedUrl = url;
      capturedInit = init;
      return new Response('ok', { status: 200 });
    };

    const resp = await assertAndFetchExternalAsset(
      'http://localhost:3000/image.png',
      {},
      undefined,
      stubFetch as never,
    );
    expect(resp.ok).toBe(true);
    expect(fetchedUrl).toBe('http://localhost:3000/image.png');
    expect(capturedInit?.redirect).toBe('error');
    expect((capturedInit as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it('throws on empty URL before fetch', async () => {
    await expect(assertAndFetchExternalAsset('')).rejects.toThrow();
  });

  it('throws when the validation lookup throws', async () => {
    const throwingLookup: DnsLookupFn = async () => {
      throw new Error('SERVFAIL');
    };
    let fetchCalled = false;
    const stubFetch = async () => {
      fetchCalled = true;
      return new Response('should not reach', { status: 200 });
    };
    await expect(
      assertAndFetchExternalAsset(
        'http://fail-then-rebind.example.com/asset.png',
        {},
        throwingLookup,
        stubFetch as never,
      ),
    ).rejects.toThrow('blocked');
    expect(fetchCalled).toBe(false);
  });

  it('IP literal skips DNS validation and calls fetch directly', async () => {
    let fetchCalled = false;
    const stubFetch = async (_url: string, init?: RequestInit) => {
      fetchCalled = true;
      expect(init?.redirect).toBe('error');
      return new Response('ok', { status: 200 });
    };

    const resp = await assertAndFetchExternalAsset(
      'http://93.184.216.34/asset.png',
      {},
      undefined,
      stubFetch as never,
    );
    expect(fetchCalled).toBe(true);
    expect(resp.ok).toBe(true);
  });
});

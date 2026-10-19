import { describe, expect, it } from 'vitest';
import {
  isAllowlistedInternalHost,
  isLoopbackApiHost,
  validateBaseUrl,
} from '../src/api/connectionTest';

describe('provider base URL validation', () => {
  it('allows public endpoints and loopback local providers', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
      'http://[::ffff:127.0.0.1]:11434/v1',
    ]) {
      expect(validateBaseUrl(baseUrl).error).toBeUndefined();
    }
  });

  it('identifies trailing-dot FQDN forms of loopback hosts as loopback', () => {
    // Direct assertion against isLoopbackApiHost — validateBaseUrl alone
    // can't distinguish "passed because loopback" from "passed because
    // not blocked", which the previous test revision conflated.
    for (const host of ['localhost.', '127.0.0.1.', '127.0.0.5.']) {
      expect(isLoopbackApiHost(host)).toBe(true);
    }
  });

  it('allows any http/https host — local, LAN, and public endpoints (fork policy)', () => {
    for (const baseUrl of [
      'http://0.0.0.0:11434/v1',
      'http://10.0.0.5:11434/v1',
      'http://100.64.0.1:11434/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://172.16.0.5:11434/v1',
      'http://192.168.1.5:11434/v1',
      'http://224.0.0.1:11434/v1',
      'http://[::]/v1',
      'http://[fd00::1]:11434/v1',
      'http://[fe80::1]:11434/v1',
      'http://[::ffff:192.168.1.5]:11434/v1',
    ]) {
      expect(validateBaseUrl(baseUrl).error).toBeUndefined();
    }
  });

  it('still rejects non-http(s) schemes and malformed URLs', () => {
    expect(validateBaseUrl('not-a-url').error).toBe('Invalid baseUrl');
    expect(validateBaseUrl('ftp://api.example.com/v1').error).toBe('Only http/https allowed');
  });
});

describe('operator internal-host allowlist helpers (kept for other consumers)', () => {
  it('exempts a literal internal IP the operator explicitly allowlisted', () => {
    expect(
      validateBaseUrl('http://10.0.0.5:4000/v1', {
        allowedInternalHosts: ['10.0.0.5'],
      }).error,
    ).toBeUndefined();
  });

  it('validateBaseUrl no longer blocks internal hosts regardless of allowlist (fork policy)', () => {
    expect(validateBaseUrl('http://10.0.0.5:4000/v1').error).toBeUndefined();
    expect(
      validateBaseUrl('http://10.0.0.5:4000/v1', { allowedInternalHosts: [] }).error,
    ).toBeUndefined();
  });

  it('allows non-allowlisted internal hosts too (fork policy)', () => {
    expect(
      validateBaseUrl('http://192.168.1.5:4000/v1', {
        allowedInternalHosts: ['10.0.0.5'],
      }).error,
    ).toBeUndefined();
  });

  it('matches across bracket, trailing-dot, and IPv4-mapped normalized forms', () => {
    // An operator who lists `10.0.0.5` should also exempt the trailing-dot
    // FQDN form and the IPv4-mapped IPv6 literal of the same address.
    expect(isAllowlistedInternalHost('10.0.0.5.', ['10.0.0.5'])).toBe(true);
    expect(isAllowlistedInternalHost('[::ffff:10.0.0.5]', ['10.0.0.5'])).toBe(true);
    expect(isAllowlistedInternalHost('10.0.0.5', ['[::ffff:10.0.0.5]'])).toBe(true);
    expect(isAllowlistedInternalHost('FD00::1', ['[fd00::1]'])).toBe(true);
  });

  it('returns false for an empty allowlist or a non-matching host', () => {
    expect(isAllowlistedInternalHost('10.0.0.5', [])).toBe(false);
    expect(isAllowlistedInternalHost('10.0.0.5', undefined)).toBe(false);
    expect(isAllowlistedInternalHost('10.0.0.5', ['192.168.1.5'])).toBe(false);
  });
});

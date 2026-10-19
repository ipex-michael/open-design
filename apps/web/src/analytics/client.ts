// Fork policy (local-first BYOK): browser telemetry is removed. This module
// keeps its exported surface so the consent/identity plumbing compiles, but
// there is no analytics SDK, no transport, and every capture path is inert.
// The daemon's /api/analytics/config always reports enabled:false, and the
// `posthog-js` dependency is gone from package.json.

import type {
  AnalyticsClientType,
  AnalyticsConfigureGlobals,
} from '@open-design/contracts/analytics';
import { clearExceptionTrackingContext } from './error-tracking';

interface AnalyticsContext {
  anonymousId: string;
  sessionId: string;
  clientType: AnalyticsClientType;
  locale: string;
  appVersion: string;
  isFirstSession?: boolean;
}

// Nominal client shape kept only so provider call sites (client.register)
// type-check; getAnalyticsClient never returns a non-null value.
export interface AnalyticsClient {
  register(properties: Record<string, unknown>): void;
}

let configureGlobals: AnalyticsConfigureGlobals = {
  has_available_configure_cli: false,
  configure_type: 'unknown',
  configure_availability: 'unknown',
  runtime_type: 'none',
  cli_runnable: false,
  byok_runnable: false,
  amr_runnable: false,
};

export function getResolvedAnonymousId(): string | null {
  return null;
}

export function getResolvedDeviceId(): string | null {
  return null;
}

// Web-side accessor for the daemon header bridge (no transport; the value
// still feeds local run metadata plumbing that reads it).
export function getConfigureGlobals(): AnalyticsConfigureGlobals {
  return configureGlobals;
}

export function setConfigureGlobals(next: AnalyticsConfigureGlobals): void {
  configureGlobals = { ...next };
}

export function setAnalyticsUserId(_userId: string | null): void {
  // no-op: no person properties to register.
}

export function setAnalyticsPersonProperties(
  _properties: Record<string, unknown>,
): void {
  // no-op: no person store to write.
}

export function bootstrapExceptionTracking(_context: AnalyticsContext): Promise<void> {
  // No safety transport exists in the fork; make sure the error tracker can
  // never gain a dispatch context.
  clearExceptionTrackingContext();
  return Promise.resolve();
}

export async function getAnalyticsClient(
  _context: AnalyticsContext,
): Promise<AnalyticsClient | null> {
  return null;
}

export function applyConsent(_consentGranted: boolean): void {
  // no-op: no SDK consent gate exists.
}

export function applyIdentity(_installationId: string | null): void {
  // no-op: no identity to switch.
}

export function capture(
  client: AnalyticsClient | null,
  _args: {
    event: string;
    properties: Record<string, unknown>;
    insertId: string;
    requestId?: string | null;
  },
): void {
  if (!client) return;
  // no transport: inert.
}

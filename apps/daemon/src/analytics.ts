// Daemon-side PostHog capture. Mirrors apps/daemon/src/langfuse-trace.ts in
// its env-gating discipline: without POSTHOG_KEY in the env every entry point
// is a no-op, so dev builds and third-party forks impose zero overhead.
//
// Web-side captures (apps/web/src/analytics) carry the matching identity in
// HTTP headers (see x-od-analytics-* constants in @open-design/contracts);
// daemon reads those headers off the request and reuses the same
// device_id as the PostHog distinct_id so events from both sides land on
// the same person. (v2: renamed from `anonymous_id`.)

import crypto from 'node:crypto';
import type { Request } from 'express';
import {
  ANALYTICS_HEADER_DEVICE_ID,
  ANALYTICS_HEADER_CLIENT_TYPE,
  ANALYTICS_HEADER_ATTRIBUTION_QUALITY,
  ANALYTICS_HEADER_DISTRIBUTION_MECHANISM,
  ANALYTICS_HEADER_ENTRY_SURFACE,
  ANALYTICS_HEADER_EXTERNAL_PLUGIN_ID,
  ANALYTICS_HEADER_EXTERNAL_PLUGIN_VERSION,
  ANALYTICS_HEADER_HOST_PRODUCT,
  ANALYTICS_HEADER_LOCALE,
  ANALYTICS_HEADER_MCP_SESSION_ID,
  ANALYTICS_HEADER_PUBLISHER_CLASS,
  ANALYTICS_HEADER_REQUEST_ID,
  ANALYTICS_HEADER_SESSION_ID,
  anonymizeArtifactId as anonymizeArtifactIdShared,
  type AnalyticsClientType,
  type AnalyticsAttributionQuality,
  type AnalyticsConfigResponse,
  type AnalyticsDistributionMechanism,
  type AnalyticsEntrySurface,
  type AnalyticsHostProduct,
  type AnalyticsPublisherClass,
} from '@open-design/contracts/analytics';
import { readTelemetryEnvironment } from './telemetry-environment.js';

export interface AnalyticsContext {
  deviceId: string;
  sessionId: string;
  clientType: AnalyticsClientType;
  locale: string;
  requestId: string | null;
  entrySurface?: AnalyticsEntrySurface;
  hostProduct?: AnalyticsHostProduct;
  externalPluginId?: string;
  externalPluginVersion?: string;
  distributionMechanism?: AnalyticsDistributionMechanism;
  publisherClass?: AnalyticsPublisherClass;
  attributionQuality?: AnalyticsAttributionQuality;
  mcpSessionId?: string;
}

// Read context from an incoming request. Returns null when the web client did
// not include analytics headers (likely because analytics is disabled on the
// web side too). Daemon-internal capture sites (e.g. background sweeps with
// no request) should not invoke this path.
export function readAnalyticsContext(req: Request): AnalyticsContext | null {
  const deviceId = headerString(req, ANALYTICS_HEADER_DEVICE_ID);
  if (!deviceId) return null;
  const sessionId = headerString(req, ANALYTICS_HEADER_SESSION_ID) ?? deviceId;
  const clientHeader = headerString(req, ANALYTICS_HEADER_CLIENT_TYPE);
  const clientType: AnalyticsClientType =
    clientHeader === 'desktop'
      ? 'desktop'
      : clientHeader === 'external_mcp'
        ? 'external_mcp'
        : 'web';
  const locale = headerString(req, ANALYTICS_HEADER_LOCALE) ?? 'en';
  const requestId = headerString(req, ANALYTICS_HEADER_REQUEST_ID);
  const entrySurface = boundedHeader(
    req,
    ANALYTICS_HEADER_ENTRY_SURFACE,
    ['open_design_ui', 'od_cli', 'external_mcp'] as const,
  );
  const hostProduct = boundedHeader(
    req,
    ANALYTICS_HEADER_HOST_PRODUCT,
    ['codex_desktop', 'codex_cli', 'codex_unknown', 'claude_code', 'unknown'] as const,
  );
  const distributionMechanism = boundedHeader(
    req,
    ANALYTICS_HEADER_DISTRIBUTION_MECHANISM,
    ['git_marketplace', 'local_repo', 'manual', 'unknown'] as const,
  );
  const publisherClass = boundedHeader(
    req,
    ANALYTICS_HEADER_PUBLISHER_CLASS,
    ['open_design_first_party', 'third_party', 'unknown'] as const,
  );
  const attributionQuality = boundedHeader(
    req,
    ANALYTICS_HEADER_ATTRIBUTION_QUALITY,
    ['self_reported', 'session_correlated'] as const,
  );
  const externalPluginId = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_EXTERNAL_PLUGIN_ID,
  );
  const externalPluginVersion = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_EXTERNAL_PLUGIN_VERSION,
  );
  const mcpSessionId = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_MCP_SESSION_ID,
  );
  return {
    deviceId,
    sessionId,
    clientType,
    locale,
    requestId,
    ...(entrySurface ? { entrySurface } : {}),
    ...(hostProduct ? { hostProduct } : {}),
    ...(externalPluginId ? { externalPluginId } : {}),
    ...(externalPluginVersion ? { externalPluginVersion } : {}),
    ...(distributionMechanism ? { distributionMechanism } : {}),
    ...(publisherClass ? { publisherClass } : {}),
    ...(attributionQuality ? { attributionQuality } : {}),
    ...(mcpSessionId ? { mcpSessionId } : {}),
  };
}

function headerString(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  if (typeof raw === 'string') return raw.trim() || null;
  return null;
}

function boundedHeader<const Values extends readonly string[]>(
  req: Request,
  name: string,
  values: Values,
): Values[number] | undefined {
  const value = headerString(req, name);
  return value && values.includes(value) ? value : undefined;
}

function boundedFreeTextHeader(req: Request, name: string): string | undefined {
  const value = headerString(req, name);
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:@/-]+$/u.test(value)) {
    return undefined;
  }
  return value;
}

export interface PosthogConfig {
  key: string;
  host: string;
  env: string;
}

// Fork policy (local-first BYOK): telemetry removed. The PostHog transport is
// gone — readPosthogConfig always reports unconfigured, so createAnalyticsService
// returns the no-op service and every capture site above it stays inert.
// readAnalyticsContext / header plumbing is kept because routes consume it; it
// simply feeds the no-op service.
export function readPosthogConfig(
  _env: NodeJS.ProcessEnv = process.env,
): PosthogConfig | null {
  return null;
}

// Baseline wire response for GET /api/analytics/config — always disabled, so
// the web client never loads its browser analytics SDK either.
export function readPublicConfigResponse(
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsConfigResponse {
  return { enabled: false, env: readTelemetryEnvironment(env), key: null, host: null };
}

export type AnalyticsCaptureErrorType =
  | 'not_configured'
  | 'metrics_consent_disabled'
  | 'config_read_failed'
  | 'enqueue_failed';

export interface AnalyticsCaptureResult {
  status: 'queued' | 'not_expected' | 'failed';
  acknowledgement: 'local_buffer' | 'none';
  errorType: AnalyticsCaptureErrorType | null;
}

export function normalizeAnalyticsCaptureResult(value: unknown): AnalyticsCaptureResult {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<AnalyticsCaptureResult>;
    if (
      (candidate.status === 'queued'
        || candidate.status === 'not_expected'
        || candidate.status === 'failed')
      && (candidate.acknowledgement === 'local_buffer'
        || candidate.acknowledgement === 'none')
    ) {
      return {
        status: candidate.status,
        acknowledgement: candidate.acknowledgement,
        errorType: candidate.errorType ?? null,
      };
    }
  }
  // Compatibility for injected/legacy capture implementations. A returned
  // call proves only local queue admission, never remote PostHog ingestion.
  return {
    status: 'queued',
    acknowledgement: 'local_buffer',
    errorType: null,
  };
}

export interface AnalyticsService {
  capture(args: {
    eventName: string;
    context: AnalyticsContext;
    appVersion: string;
    properties: Record<string, unknown>;
    insertId: string;
  }): Promise<AnalyticsCaptureResult>;
  /**
   * Safety / reliability events (renderer crashes, daemon uncaught errors,
   * SSE health, etc.) that intentionally BYPASS the user's analytics
   * consent toggle. The product policy is: we always retain ground-truth
   * stability data even for opted-out users — the user-facing consent copy
   * in Settings → Privacy must call this out.
   *
   * Falls back to a synthetic distinctId when the installationId is not
   * yet stamped (first-launch or fork builds without an app-config file).
   *
   * Returns a Promise that resolves AFTER the event has been enqueued in
   * posthog-node's local buffer. Fire-and-forget callers (e.g. the
   * /api/observability/event endpoint) can `void` it; fatal-exit paths
   * MUST await before calling `shutdown()` so the crash event actually
   * makes it into the flush.
   */
  captureSafety(args: {
    eventName: string;
    distinctId?: string;
    appVersion: string;
    properties: Record<string, unknown>;
    insertId?: string;
  }): Promise<void>;
  mergeAnonymousPerson(args: {
    anonymousDistinctId: string;
    distinctId: string;
    properties?: Record<string, unknown>;
    insertId?: string;
  }): Promise<void>;
  identifyGroup(args: {
    context: AnalyticsContext;
    groupType: 'workspace';
    groupKey: string;
    properties: Record<string, unknown>;
  }): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP_SERVICE: AnalyticsService = {
  capture: async () => ({
    status: 'not_expected',
    acknowledgement: 'none',
    errorType: 'not_configured',
  }),
  captureSafety: async () => undefined,
  mergeAnonymousPerson: async () => undefined,
  identifyGroup: async () => undefined,
  shutdown: async () => undefined,
};

// Fork policy: no PostHog client exists; every AnalyticsService method is a
// no-op. Capture call sites (run analytics lifecycle, routes, fatal handlers)
// keep calling through here unchanged and stay inert.
export function createAnalyticsService(_args: {
  env?: NodeJS.ProcessEnv;
  dataDir: string;
}): AnalyticsService {
  return NOOP_SERVICE;
}

// Re-export so server.ts and route handlers don't need a second import
// path; the canonical hash lives in @open-design/contracts/analytics so
// the web bundle produces the same id for the same (projectId, fileName).
export const anonymizeArtifactId = anonymizeArtifactIdShared;

// Generate a fresh insert_id when the request didn't carry one. Used for
// daemon-internal events where there is no matching web emission.
export function newInsertId(): string {
  return crypto.randomUUID();
}

// HTTP-level coverage for the AMR (vela) integration routes.
//
// Boots the real daemon Express app on a random port (same shape as
// memory-config-route.test.ts) and exercises the three endpoints from the
// outside — `/api/integrations/vela/{status,login,logout}` — so the Settings
// AmrLoginPill provider helpers, the spawn lifecycle, and the
// ~/.amr/config.json projection all stay in lockstep.
//
// HOME is redirected to a tmpdir per test so the suite never touches the
// developer's real `~/.amr/config.json`. VELA_BIN points at the
// `tests/fixtures/fake-vela.mjs` stub, which handles the `login` argv by
// writing the config file with the active VELA_PROFILE and exiting 0 —
// mirroring real vela's on-disk side-effect without the device-auth loop.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer } from '../../src/server.js';
import { readAppConfig, writeAppConfig } from '../../src/app-config.js';
import {
  clearAllVelaLiveAccounts,
  clearVelaLiveAccountRefreshThrottle,
  isVelaLoginSupervisorSettled,
  readVelaCredentialRevision,
  velaLiveAccountCacheKey,
} from '../../src/integrations/vela.js';
import { registerVelaRoutes } from '../../src/routes/vela.js';

interface StartedServer {
  url: string;
  server: http.Server;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_VELA = path.resolve(HERE, '..', 'fixtures', 'fake-vela.mjs');

let baseUrl: string;
let server: http.Server;
let originalHome: string | undefined;
let tmpHome: string;

async function getJson<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const resp = await fetch(url);
  const parsedBody = (await resp.json()) as T;
  return { status: resp.status, body: parsedBody };
}

async function postJson<T = unknown>(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const init: RequestInit = {
    method: 'POST',
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  const parsedBody = (await resp.json()) as T;
  return { status: resp.status, body: parsedBody };
}

async function waitForAmrModels(
  expectedSource: 'preset' | 'remote',
  timeoutMs = 5_000,
): Promise<{ status: number; body: { source: 'preset' | 'remote'; models: Array<{ id: string }> } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await getJson<{
      source: 'preset' | 'remote';
      models: Array<{ id: string }>;
    }>(`${baseUrl}/api/amr/models`);
    if (response.body.source === expectedSource) return response;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for /api/amr/models source=${expectedSource}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForVelaLoginIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await getJson<{ loginInFlight: boolean }>(
      `${baseUrl}/api/integrations/vela/status`,
    );
    if (!response.body.loginInFlight) return;
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for vela login subprocess to become idle');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Wait for the close/error terminal handler (and any late proxy fallback it
// starts), not the public loginInFlight projection. Status can report idle
// between the child's exit and close once exitCode is set — especially after
// cancel, which suppresses the fallbackPending bridge that covers that gap.
async function waitForVelaLoginSupervisorSettled(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isVelaLoginSupervisorSettled()) return;
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for vela login supervisor to settle');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function configPath(): string {
  return path.join(tmpHome, '.amr', 'config.json');
}

function legacyVelaConfigPath(): string {
  return path.join(tmpHome, '.vela', 'config.json');
}

function seedLogin(profile: string, payload: Record<string, unknown> = {}): void {
  const dir = path.dirname(configPath());
  mkdirSync(dir, { recursive: true });
  const full = {
    profiles: {
      [profile]: {
        runtimeKey: 'rt-seeded-key',
        controlKey: 'ck-seeded-key',
        apiUrl: 'http://localhost:18080',
        linkUrl: 'http://localhost:18081',
        user: {
          id: 'user-seed',
          email: 'seed@example.com',
          plan: 'free',
          ...((payload.user as Record<string, unknown>) ?? {}),
        },
        ...payload,
      },
    },
  };
  writeFileSync(configPath(), JSON.stringify(full, null, 2), 'utf8');
}

async function setSettingsAmrEnv(extra: Record<string, string | undefined>): Promise<void> {
  const dataDir = process.env.OD_DATA_DIR as string;
  const cfg = await readAppConfig(dataDir);
  const amr: Record<string, string> = {
    ...((cfg.agentCliEnv?.amr as Record<string, string>) ?? {}),
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete amr[key];
    else amr[key] = value;
  }
  await writeAppConfig(dataDir, {
    ...cfg,
    agentCliEnv: { ...(cfg.agentCliEnv ?? {}), amr },
  });
}

async function startWalletApi(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ close: () => Promise<void>; requests: string[]; url: string }> {
  const requests: string[] = [];
  const walletServer = createServer((req, res) => {
    requests.push(req.headers.authorization ?? '');
    void Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  await new Promise<void>((resolve) => walletServer.listen(0, '127.0.0.1', resolve));
  const address = walletServer.address() as AddressInfo;
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => walletServer.close(() => resolve())),
  };
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  // The login route resolves the vela binary through the daemon's
  // `agentCliEnvForAgent` projection of `app-config.json` (NOT process.env),
  // so we have to persist the fake binary path through the app-config file
  // before any test calls /login. Without this the route would fall through
  // to `resolveOnPath('vela')` and spawn the developer's real vela.
  const dataDir = process.env.OD_DATA_DIR as string;
  const config = await readAppConfig(dataDir);
  await writeAppConfig(dataDir, {
    ...config,
    agentCliEnv: {
      ...(config.agentCliEnv ?? {}),
      amr: {
        ...((config.agentCliEnv?.amr as Record<string, string>) ?? {}),
        VELA_BIN: FAKE_VELA,
      },
    },
  });
  const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
  baseUrl = started.url;
  server = started.server;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(path.join(tmpdir(), 'od-vela-routes-'));
  process.env.HOME = tmpHome;
  process.env.OPEN_DESIGN_AMR_PROFILE = 'local';
  process.env.VELA_PROFILE = 'prod';
});

afterEach(async () => {
  try {
    // `/login` acknowledges after the child reaches its activation boundary,
    // not necessarily after the child exits. Do not let that process retain
    // this test's HOME/env or trip the next test's in-flight guard.
    const status = await getJson<{ loginInFlight: boolean }>(
      `${baseUrl}/api/integrations/vela/status`,
    );
    if (status.body.loginInFlight) {
      await postJson(`${baseUrl}/api/integrations/vela/login/cancel`);
      await waitForVelaLoginIdle();
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.OPEN_DESIGN_AMR_PROFILE;
    delete process.env.VELA_PROFILE;
    delete process.env.FAKE_VELA_LOGIN_DELAY_MS;
    delete process.env.FAKE_VELA_LOGIN_FAIL;
    delete process.env.FAKE_VELA_LOGIN_FAIL_WITHOUT_API_URL;
    delete process.env.FAKE_VELA_LOGIN_FAIL_WITHOUT_API_URL_DELAY_MS;
    delete process.env.FAKE_VELA_LOGIN_EXIT_ZERO_WITHOUT_API_URL_DELAY_MS;
    delete process.env.OD_AMR_LOGIN_ACTIVATION_GRACE_MS;
    delete process.env.FAKE_VELA_LOGIN_USER_EMAIL;
    delete process.env.FAKE_VELA_LOGIN_USER_PLAN;
    delete process.env.FAKE_VELA_BILLING_TIER;
    delete process.env.FAKE_VELA_BILLING_BALANCE_USD;
    delete process.env.FAKE_VELA_BILLING_LOG;
    delete process.env.FAKE_VELA_BILLING_DELAY_MS;
    delete process.env.FAKE_VELA_BILLING_UNKNOWN_COMMAND;
    delete process.env.FAKE_VELA_MODEL_LIST_JSON;
    delete process.env.FAKE_VELA_MODEL_PRESET_JSON;
    delete process.env.FAKE_VELA_ENV_DUMP_PATH;
    delete process.env.FAKE_VELA_LOGIN_INVOCATION_LOG;
    delete process.env.FAKE_VELA_LOGIN_ACTIVATION_AFTER_PARENT_EXIT_MS;
    delete process.env.FAKE_VELA_LOGIN_PARENT_EXIT_DELAY_MS;
    delete process.env.FAKE_VELA_LOGIN_ACTIVATION_THEN_EXIT_DELAY_MS;
    delete process.env.FAKE_VELA_LOGIN_ACTIVATION_THEN_EXIT_CODE;
    delete process.env.OD_PUBLIC_BASE_URL;
    delete process.env.VELA_RUNTIME_KEY;
    delete process.env.VELA_LINK_URL;
    delete process.env.OPEN_DESIGN_AMR_ANALYTICS_URL;
    delete process.env.OPEN_DESIGN_AMR_ANALYTICS_ENV;
    delete process.env.OD_AMR_WALLET_FETCH_TIMEOUT_MS;
    rmSync(tmpHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

describe('GET /api/integrations/vela/wallet', () => {
  it('returns signed_out without reading an upstream wallet API', async () => {
    const walletApi = await startWalletApi((_req, res) => {
      res.statusCode = 500;
      res.end('must not be called');
    });
    try {
      const { status, body } = await getJson<{
        status: string;
        balanceUsd: string | null;
        error?: { code: string };
      }>(`${baseUrl}/api/integrations/vela/wallet`);

      expect(status).toBe(200);
      expect(body.status).toBe('signed_out');
      expect(body.balanceUsd).toBeNull();
      expect(body.error?.code).toBe('signed_out');
      expect(walletApi.requests).toEqual([]);
    } finally {
      await walletApi.close();
    }
  });

  it('fetches the AMR wallet balance with the local control key and caches it briefly', async () => {
    const walletApi = await startWalletApi((req, res) => {
      expect(req.headers.authorization).toBe('Bearer ck-wallet-balance');
      res.setHeader('content-type', 'application/json');
      expect(req.url).toBe('/api/v1/wallet/balance');
      res.end(JSON.stringify({
        balanceUsd: '0.1000',
        updatedAt: '2026-06-23T06:05:18.782Z',
      }));
    });
    seedLogin('local', {
      apiUrl: walletApi.url,
      controlKey: 'ck-wallet-balance',
      runtimeKey: 'rt-wallet-balance',
      user: { id: 'wallet-user', email: 'wallet@example.com', plan: 'free' },
    });
    try {
      const first = await getJson<{
        balanceUsd: string | null;
        source: string;
        status: string;
        user: { email?: string } | null;
      }>(`${baseUrl}/api/integrations/vela/wallet`);
      const second = await getJson<{ balanceUsd: string | null; source: string }>(
        `${baseUrl}/api/integrations/vela/wallet`,
      );

      expect(first.status).toBe(200);
      expect(first.body.status).toBe('available');
      expect(first.body.balanceUsd).toBe('0.1000');
      expect(first.body.source).toBe('vela_api');
      expect(first.body.user?.email).toBe('wallet@example.com');
      expect(second.body.balanceUsd).toBe('0.1000');
      expect(second.body.source).toBe('daemon_cache');
      expect(walletApi.requests).toEqual(['Bearer ck-wallet-balance']);
      expect(JSON.stringify(first.body)).not.toContain('ck-wallet-balance');
      expect(JSON.stringify(first.body)).not.toContain('rt-wallet-balance');
    } finally {
      await walletApi.close();
    }
  });

  it('invalidates the AMR model catalog cache on explicit wallet refresh', async () => {
    const walletApi = await startWalletApi((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        balanceUsd: '20.0000',
        updatedAt: '2026-07-09T07:30:00.000Z',
      }));
    });
    process.env.FAKE_VELA_MODEL_LIST_JSON = JSON.stringify({
      source: 'remote',
      data: [
        { id: 'public_model_deepseek_v4_flash', enabled: false },
      ],
    });
    seedLogin('local', {
      apiUrl: walletApi.url,
      controlKey: 'ck-wallet-refresh',
      runtimeKey: 'rt-wallet-refresh',
      user: { id: 'wallet-user', email: 'wallet@example.com', plan: 'free' },
    });
    try {
      const warmed = await waitForAmrModels('remote');
      expect(warmed.body.models).toEqual([
        { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: false },
      ]);

      const refresh = await getJson<{ status: string; balanceUsd: string | null }>(
        `${baseUrl}/api/integrations/vela/wallet?refresh=1`,
      );
      expect(refresh.status).toBe(200);
      expect(refresh.body.status).toBe('available');

      const afterRefresh = await getJson<{
        source: 'preset' | 'remote';
        refreshing?: boolean;
        models: Array<{ id: string }>;
      }>(`${baseUrl}/api/amr/models`);
      expect(afterRefresh.status).toBe(200);
      expect(afterRefresh.body.source).toBe('preset');
      expect(afterRefresh.body.refreshing).toBe(true);
      expect(afterRefresh.body.models.map((model) => model.id)).toEqual([
        'deepseek-v4-flash',
        'deepseek-v3.2',
        'gemini-2.5-flash',
        'glm-5.1',
      ]);
    } finally {
      await walletApi.close();
    }
  });

  it('invalidates the AMR model catalog cache when a forced status refresh observes a plan change', async () => {
    process.env.FAKE_VELA_BILLING_TIER = 'free';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '1.00';
    process.env.FAKE_VELA_MODEL_LIST_JSON = JSON.stringify({
      source: 'remote',
      data: [
        { id: 'public_model_deepseek_v4_flash', enabled: false },
      ],
    });
    seedLogin('local', {
      controlKey: 'ck-status-refresh',
      runtimeKey: 'rt-status-refresh',
      user: { id: 'status-user', email: 'status@example.com', plan: 'free' },
    });

    const firstStatus = await getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status?refresh=1`,
    );
    expect(firstStatus.status).toBe(200);
    expect(firstStatus.body.account?.plan).toBe('free');

    const warmed = await waitForAmrModels('remote');
    expect(warmed.body.models).toEqual([
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: false },
    ]);

    process.env.FAKE_VELA_BILLING_TIER = 'pro';
    const upgradedStatus = await getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status?refresh=1`,
    );
    expect(upgradedStatus.status).toBe(200);
    expect(upgradedStatus.body.account?.plan).toBe('pro');

    const afterPlanChange = await getJson<{
      source: 'preset' | 'remote';
      refreshing?: boolean;
      models: Array<{ id: string }>;
    }>(`${baseUrl}/api/amr/models`);
    expect(afterPlanChange.status).toBe(200);
    expect(afterPlanChange.body.source).toBe('preset');
    expect(afterPlanChange.body.refreshing).toBe(true);
  });

  it('invalidates the AMR model catalog cache on forced status refresh without a prior account snapshot', async () => {
    process.env.FAKE_VELA_BILLING_TIER = 'pro';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '1.00';
    process.env.FAKE_VELA_MODEL_LIST_JSON = JSON.stringify({
      source: 'remote',
      data: [
        { id: 'public_model_deepseek_v4_flash', enabled: false },
      ],
    });
    seedLogin('local', {
      controlKey: 'ck-status-refresh-cold-account',
      runtimeKey: 'rt-status-refresh-cold-account',
      user: {
        id: 'status-cold-account-user',
        email: 'status-cold-account@example.com',
        plan: 'pro',
      },
    });

    const warmed = await waitForAmrModels('remote');
    expect(warmed.body.models).toEqual([
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: false },
    ]);

    clearAllVelaLiveAccounts();
    const refreshedStatus = await getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status?refresh=1`,
    );
    expect(refreshedStatus.status).toBe(200);
    expect(refreshedStatus.body.account?.plan).toBe('pro');

    const afterRefresh = await getJson<{
      source: 'preset' | 'remote';
      refreshing?: boolean;
      models: Array<{ id: string }>;
    }>(`${baseUrl}/api/amr/models`);
    expect(afterRefresh.status).toBe(200);
    expect(afterRefresh.body.source).toBe('preset');
    expect(afterRefresh.body.refreshing).toBe(true);
  });

  it('preserves model-cache invalidation when forced status refresh joins an in-flight probe', async () => {
    clearAllVelaLiveAccounts();
    process.env.FAKE_VELA_BILLING_TIER = 'free';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '1.00';
    process.env.FAKE_VELA_MODEL_LIST_JSON = JSON.stringify({
      source: 'remote',
      data: [
        { id: 'public_model_deepseek_v4_flash', enabled: false },
      ],
    });
    seedLogin('local', {
      controlKey: 'ck-status-refresh-inflight',
      runtimeKey: 'rt-status-refresh-inflight',
      user: { id: 'status-inflight-user', email: 'status-inflight@example.com', plan: 'free' },
    });

    const firstStatus = await getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status?refresh=1`,
    );
    expect(firstStatus.status).toBe(200);
    expect(firstStatus.body.account?.plan).toBe('free');

    const warmed = await waitForAmrModels('remote');
    expect(warmed.body.models).toEqual([
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: false },
    ]);

    const accountCacheKey = velaLiveAccountCacheKey(
      readVelaCredentialRevision(process.env, {}),
    );
    clearVelaLiveAccountRefreshThrottle(accountCacheKey);
    process.env.FAKE_VELA_BILLING_TIER = 'pro';
    process.env.FAKE_VELA_BILLING_DELAY_MS = '150';

    const warmStatus = getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const forcedStatus = await getJson<{ account?: { plan?: string } }>(
      `${baseUrl}/api/integrations/vela/status?refresh=1`,
    );
    expect((await warmStatus).body.account?.plan).toBe('free');
    expect(forcedStatus.status).toBe(200);
    expect(forcedStatus.body.account?.plan).toBe('pro');

    const afterPlanChange = await getJson<{
      source: 'preset' | 'remote';
      refreshing?: boolean;
      models: Array<{ id: string }>;
    }>(`${baseUrl}/api/amr/models`);
    expect(afterPlanChange.status).toBe(200);
    expect(afterPlanChange.body.source).toBe('preset');
    expect(afterPlanChange.body.refreshing).toBe(true);
  });

  it('does not serve a cached wallet balance after the control key is rejected', async () => {
    let walletRequestCount = 0;
    const walletApi = await startWalletApi((req, res) => {
      res.setHeader('content-type', 'application/json');
      walletRequestCount += 1;
      if (walletRequestCount === 1) {
        res.end(JSON.stringify({
          balanceUsd: '0.1000',
          updatedAt: '2026-06-23T06:05:18.782Z',
        }));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthenticated' }));
    });
    seedLogin('local', {
      apiUrl: walletApi.url,
      controlKey: 'ck-revoked-wallet',
      runtimeKey: 'rt-wallet-balance',
      user: { id: 'wallet-user', email: 'wallet@example.com', plan: 'free' },
    });
    try {
      const first = await getJson<{
        balanceUsd: string | null;
        source: string;
        status: string;
      }>(`${baseUrl}/api/integrations/vela/wallet`);
      const second = await getJson<{
        balanceUsd: string | null;
        error?: { code: string; message: string };
        source: string;
        status: string;
      }>(`${baseUrl}/api/integrations/vela/wallet?refresh=1`);

      expect(first.body.status).toBe('available');
      expect(first.body.balanceUsd).toBe('0.1000');
      expect(first.body.source).toBe('vela_api');
      expect(second.body.status).toBe('unavailable');
      expect(second.body.balanceUsd).toBeNull();
      expect(second.body.source).toBe('unavailable');
      expect(second.body.error?.code).toBe('unauthorized');
      expect(second.body.error?.message).toMatch(/sign in again/i);
    } finally {
      await walletApi.close();
    }
  });

  it('reports missing_control_key instead of showing zero when only a runtime key is present', async () => {
    seedLogin('local', {
      controlKey: '',
      runtimeKey: 'rt-without-control',
      user: { id: 'wallet-user', email: 'wallet@example.com' },
    });

    const { status, body } = await getJson<{
      status: string;
      balanceUsd: string | null;
      error?: { code: string };
    }>(`${baseUrl}/api/integrations/vela/wallet?refresh=1`);

    expect(status).toBe(200);
    expect(body.status).toBe('unavailable');
    expect(body.balanceUsd).toBeNull();
    expect(body.error?.code).toBe('missing_control_key');
  });

  it('bounds a stalled upstream wallet request and returns a recoverable network snapshot', async () => {
    process.env.OD_AMR_WALLET_FETCH_TIMEOUT_MS = '25';
    const walletApi = await startWalletApi((_req, _res) => {
      // Intentionally leave the request open so the daemon timeout owns the boundary.
    });
    seedLogin('local', {
      apiUrl: walletApi.url,
      controlKey: 'ck-stalled-wallet',
      runtimeKey: 'rt-wallet-balance',
      user: { id: 'wallet-user', email: 'wallet@example.com', plan: 'free' },
    });
    try {
      const startedAt = Date.now();
      const { status, body } = await getJson<{
        balanceUsd: string | null;
        error?: { code: string; message: string };
        source: string;
        status: string;
      }>(`${baseUrl}/api/integrations/vela/wallet?refresh=1`);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(status).toBe(200);
      expect(body.status).toBe('unavailable');
      expect(body.balanceUsd).toBeNull();
      expect(body.source).toBe('unavailable');
      expect(body.error?.code).toBe('network');
      expect(body.error?.message).toMatch(/temporarily unavailable/i);
      expect(walletApi.requests).toEqual(['Bearer ck-stalled-wallet']);
    } finally {
      await walletApi.close();
    }
  });
});

describe('GET /api/integrations/vela/status', () => {
  it('reports AMR runtime unavailable instead of signed out when the vela binary cannot be resolved', async () => {
    const previousPath = process.env.PATH;
    const previousAgentHome = process.env.OD_AGENT_HOME;
    const previousResourceRoot = process.env.OD_RESOURCE_ROOT;
    const previousVelaBin = process.env.VELA_BIN;
    const previousVelaOpenCodeBin = process.env.VELA_OPENCODE_BIN;
    process.env.PATH = '';
    process.env.OD_AGENT_HOME = tmpHome;
    delete process.env.OD_RESOURCE_ROOT;
    delete process.env.VELA_BIN;
    delete process.env.VELA_OPENCODE_BIN;

    const isolatedApp = express();
    isolatedApp.use(express.json());
    registerVelaRoutes(isolatedApp, {
      paths: { RUNTIME_DATA_DIR: tmpHome },
      appConfig: {
        readAppConfig: async () => ({ agentCliEnv: {} }),
      },
      http: {},
      env: {
        HOME: tmpHome,
        OPEN_DESIGN_AMR_PROFILE: 'local',
        PATH: '',
      },
    });
    const isolatedServer = createServer(isolatedApp);
    await new Promise<void>((resolve) => isolatedServer.listen(0, '127.0.0.1', resolve));
    const isolatedAddress = isolatedServer.address() as AddressInfo;
    const isolatedUrl = `http://127.0.0.1:${isolatedAddress.port}`;

    try {
      const { status, body } = await getJson<{ error?: string; loggedIn?: boolean }>(
        `${isolatedUrl}/api/integrations/vela/status`,
      );

      expect(status).toBe(503);
      expect(body.error).toBe('amr-runtime-unavailable');
      expect(body.loggedIn).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousAgentHome === undefined) delete process.env.OD_AGENT_HOME;
      else process.env.OD_AGENT_HOME = previousAgentHome;
      if (previousResourceRoot === undefined) delete process.env.OD_RESOURCE_ROOT;
      else process.env.OD_RESOURCE_ROOT = previousResourceRoot;
      if (previousVelaBin === undefined) delete process.env.VELA_BIN;
      else process.env.VELA_BIN = previousVelaBin;
      if (previousVelaOpenCodeBin === undefined) delete process.env.VELA_OPENCODE_BIN;
      else process.env.VELA_OPENCODE_BIN = previousVelaOpenCodeBin;
    }
  });

  it('reports loggedIn=false when ~/.amr/config.json is absent', async () => {
    const { status, body } = await getJson<{
      loggedIn: boolean;
      loginInFlight: boolean;
      profile: string;
      user: { email?: string } | null;
      configPath: string;
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(status).toBe(200);
    expect(body.loggedIn).toBe(false);
    expect(body.loginInFlight).toBe(false);
    expect(body.profile).toBe('local');
    expect(body.user).toBeNull();
    // configPath must point inside the temp HOME so the suite never leaks
    // into the developer's real config file.
    expect(body.configPath.startsWith(tmpHome)).toBe(true);
    expect(body.configPath).toContain('/.amr/');
  });

  it('ignores legacy ~/.vela/config.json when reporting AMR status', async () => {
    const legacyPath = legacyVelaConfigPath();
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        profiles: {
          local: {
            runtimeKey: 'rt-legacy',
            user: { id: 'legacy-user', email: 'legacy@example.com' },
          },
        },
      }),
      'utf8',
    );

    const { status, body } = await getJson<{
      loggedIn: boolean;
      user: { email?: string } | null;
      configPath: string;
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(status).toBe(200);
    expect(body.loggedIn).toBe(false);
    expect(body.user).toBeNull();
    expect(body.configPath).toContain('/.amr/');
  });

  it('reports Settings-configured AMR env credentials as logged in', async () => {
    const dataDir = process.env.OD_DATA_DIR as string;
    const previous = await readAppConfig(dataDir);
    await writeAppConfig(dataDir, {
      ...previous,
      agentCliEnv: {
        ...(previous.agentCliEnv ?? {}),
        amr: {
          ...((previous.agentCliEnv?.amr as Record<string, string>) ?? {}),
          VELA_BIN: FAKE_VELA,
          VELA_RUNTIME_KEY: 'rt-env-secret',
          VELA_LINK_URL: 'https://openrouter.example/v1',
        },
      },
    });
    try {
      const { status, body } = await getJson<{
        loggedIn: boolean;
        user: { email?: string } | null;
      }>(`${baseUrl}/api/integrations/vela/status`);
      expect(status).toBe(200);
      expect(body.loggedIn).toBe(true);
      expect(body.user).toBeNull();
      expect(JSON.stringify(body)).not.toContain('rt-env-secret');
    } finally {
      await writeAppConfig(dataDir, previous as unknown as Record<string, unknown>);
    }
  });

  it('reports daemon-process AMR env credentials as logged in', async () => {
    process.env.VELA_RUNTIME_KEY = 'rt-process-secret';
    process.env.VELA_LINK_URL = 'https://openrouter.example/v1';

    const { status, body } = await getJson<{
      loggedIn: boolean;
      user: { email?: string } | null;
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(status).toBe(200);
    expect(body.loggedIn).toBe(true);
    expect(body.user).toBeNull();
    expect(JSON.stringify(body)).not.toContain('rt-process-secret');
  });

  it('reports status for the Settings-configured AMR profile', async () => {
    const dataDir = process.env.OD_DATA_DIR as string;
    const previous = await readAppConfig(dataDir);
    seedLogin('local', {
      user: { id: 'local-user', email: 'settings-local@example.com' },
    });
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
    cfg.profiles.prod = {};
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    process.env.OPEN_DESIGN_AMR_PROFILE = 'prod';
    await writeAppConfig(dataDir, {
      ...previous,
      agentCliEnv: {
        ...(previous.agentCliEnv ?? {}),
        amr: {
          ...((previous.agentCliEnv?.amr as Record<string, string>) ?? {}),
          VELA_BIN: FAKE_VELA,
          OPEN_DESIGN_AMR_PROFILE: 'local',
        },
      },
    });
    try {
      const { status, body } = await getJson<{
        loggedIn: boolean;
        profile: string;
        user: { email?: string } | null;
      }>(`${baseUrl}/api/integrations/vela/status`);
      expect(status).toBe(200);
      expect(body.loggedIn).toBe(true);
      expect(body.profile).toBe('local');
      expect(body.user?.email).toBe('settings-local@example.com');
    } finally {
      await writeAppConfig(dataDir, previous as unknown as Record<string, unknown>);
    }
  });

  it('keeps Settings-configured AMR env, profile, status, and model catalog in sync', async () => {
    const dataDir = process.env.OD_DATA_DIR as string;
    const previous = await readAppConfig(dataDir);
    process.env.OPEN_DESIGN_AMR_PROFILE = 'prod';
    await writeAppConfig(dataDir, {
      ...previous,
      agentCliEnv: {
        ...(previous.agentCliEnv ?? {}),
        amr: {
          ...((previous.agentCliEnv?.amr as Record<string, string>) ?? {}),
          VELA_BIN: FAKE_VELA,
          OPEN_DESIGN_AMR_PROFILE: 'local',
          VELA_RUNTIME_KEY: 'rt-settings-risk-smoke',
          VELA_LINK_URL: 'http://localhost:18081',
        },
      },
    });

    try {
      const statusResponse = await getJson<{
        loggedIn: boolean;
        profile: string;
        user: { email?: string } | null;
      }>(`${baseUrl}/api/integrations/vela/status`);
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body).toMatchObject({
        loggedIn: true,
        profile: 'local',
        user: null,
      });
      expect(JSON.stringify(statusResponse.body)).not.toContain('rt-settings-risk-smoke');

      const modelsResponse = await waitForAmrModels('remote');
      expect(modelsResponse.status).toBe(200);
      expect(modelsResponse.body.models.map((model) => model.id)).toContain('deepseek-v4-flash');
      expect(modelsResponse.body.models.map((model) => model.id)).toContain('gpt-5.4');
    } finally {
      await writeAppConfig(dataDir, previous as unknown as Record<string, unknown>);
    }
  });

  it('reports loggedIn=true with the surfaced user fields when the active profile has a runtimeKey', async () => {
    seedLogin('local', {
      user: {
        id: 'u1',
        email: 'leaf@example.com',
        name: '杨瑾龙',
        plan: 'free',
      },
    });
    const { body } = await getJson<{
      loggedIn: boolean;
      user: { email?: string; plan?: string; name?: string } | null;
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(body.loggedIn).toBe(true);
    expect(body.user?.email).toBe('leaf@example.com');
    expect(body.user?.plan).toBe('free');
    expect(body.user?.name).toBe('杨瑾龙');
  });

  it('resolves live billing on a cold cache within the wait budget and surfaces the fetched plan + balance', async () => {
    // Regression: several account surfaces read /status once per mount/open
    // and do not re-poll on a fixed interval, so a cold cache should still
    // resolve live billing before the first response WHEN billing answers
    // promptly (the common case — fake-vela here has no delay configured).
    // A billing read slower than the wait budget is covered separately by
    // "does not block /status on a cold cache when billing is slow, …" below,
    // which asserts the response is never held hostage to a slow probe.
    clearAllVelaLiveAccounts();
    process.env.FAKE_VELA_BILLING_TIER = 'plus';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '247.51';
    // Config carries no plan, so plan/balance can only come from the live fetch.
    seedLogin('local', {
      user: { id: 'cold-1', email: 'cold@example.com', plan: undefined },
    });
    const { body } = await getJson<{
      loggedIn: boolean;
      user: { email?: string } | null;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(body.loggedIn).toBe(true);
    // Env-/config-identity stays on `user`; live billing rides on `account`.
    expect(body.account?.plan).toBe('plus');
    expect(body.account?.balanceUsd).toBe('247.51');
  });

  it('does not block /status on a cold cache when billing is slow, and applies the account on a later poll once it resolves', async () => {
    // Regression for the "sign out then sign back in" cold-cache path: every
    // logout clears the live-account cache (clearAllVelaLiveAccounts), so a
    // slow (or hung) `vela billing summary` must not delay the login-status
    // check itself — that check is what the avatar/menu/settings surfaces
    // need FIRST. The fetch is left running in the background and the next
    // /status read (every consumer already re-reads on mount, window
    // focus/visibilitychange, or the sign-in event) picks up the resolved
    // plan/balance instead.
    clearAllVelaLiveAccounts();
    process.env.FAKE_VELA_BILLING_TIER = 'plus';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '19.99';
    process.env.FAKE_VELA_BILLING_DELAY_MS = '2000';
    seedLogin('local', {
      user: { id: 'slow-billing-1', email: 'slow-billing@example.com', plan: undefined },
    });

    const startedAt = Date.now();
    const first = await getJson<{
      loggedIn: boolean;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);
    const elapsedMs = Date.now() - startedAt;

    expect(first.body.loggedIn).toBe(true);
    // Well under the 2s billing delay — proves /status did not block on it.
    expect(elapsedMs).toBeLessThan(1800);
    expect(first.body.account).toBeUndefined();

    // Give the still-running background billing fetch time to resolve and
    // populate the live-account cache.
    await new Promise((resolve) => setTimeout(resolve, 2300));

    const second = await getJson<{
      loggedIn: boolean;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(second.body.loggedIn).toBe(true);
    expect(second.body.account?.plan).toBe('plus');
    expect(second.body.account?.balanceUsd).toBe('19.99');
  });

  it('normalizes a successful billing summary without a tier to free (upgradeable)', async () => {
    // membershipTier is omitted for free accounts; a successful read must still
    // surface a concrete plan so the UI shows it AND keeps the Upgrade CTA.
    clearAllVelaLiveAccounts();
    // Balance set, tier unset → fake-vela returns balanceUsd with NO membershipTier.
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '0.00';
    seedLogin('local', {
      user: { id: 'free-1', email: 'free@example.com', plan: undefined },
    });
    const { body } = await getJson<{
      loggedIn: boolean;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);
    expect(body.loggedIn).toBe(true);
    expect(body.account?.plan).toBe('free');
    expect(body.account?.balanceUsd).toBe('0.00');
  });

  it('keeps failed live billing reads throttled for repeated status polls', async () => {
    clearAllVelaLiveAccounts();
    const billingLog = path.join(tmpHome, 'billing-summary.log');
    process.env.FAKE_VELA_BILLING_LOG = billingLog;
    // Leave FAKE_VELA_BILLING_* unset so fake-vela exits non-zero for the
    // optional live billing read.
    seedLogin('local', {
      user: { id: 'backoff-1', email: 'backoff@example.com', plan: undefined },
    });

    const first = await getJson<{
      loggedIn: boolean;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);
    const second = await getJson<{
      loggedIn: boolean;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.loggedIn).toBe(true);
    expect(second.body.loggedIn).toBe(true);
    expect(first.body.account).toBeUndefined();
    expect(second.body.account).toBeUndefined();
    const attempts = existsSync(billingLog)
      ? readFileSync(billingLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(attempts).toHaveLength(1);
  });

  it('keeps signed-in status usable when old vela CLI lacks billing commands', async () => {
    clearAllVelaLiveAccounts();
    process.env.FAKE_VELA_BILLING_UNKNOWN_COMMAND = '1';
    seedLogin('local', {
      user: { id: 'old-cli-1', email: 'old-cli@example.com', plan: undefined },
    });

    const { status, body } = await getJson<{
      loggedIn: boolean;
      user: { email?: string } | null;
      account?: { plan?: string; balanceUsd?: string | null };
    }>(`${baseUrl}/api/integrations/vela/status`);

    expect(status).toBe(200);
    expect(body.loggedIn).toBe(true);
    expect(body.user?.email).toBe('old-cli@example.com');
    expect(body.account).toBeUndefined();
  });

  it('uses the same Settings-backed credential for billing fetch and live-account cache key', async () => {
    clearAllVelaLiveAccounts();
    const billingLog = path.join(tmpHome, 'billing-summary-env.log');
    process.env.FAKE_VELA_BILLING_LOG = billingLog;
    process.env.FAKE_VELA_BILLING_DELAY_MS = '150';
    process.env.FAKE_VELA_BILLING_TIER = 'plus';
    process.env.FAKE_VELA_BILLING_BALANCE_USD = '8.00';
    seedLogin('local', {
      user: { id: 'race-1', email: 'race@example.com', plan: undefined },
    });

    try {
      await setSettingsAmrEnv({
        VELA_RUNTIME_KEY: 'rt-billing-account-A',
        VELA_LINK_URL: 'http://link.invalid',
      });
      const pending = getJson<{
        loggedIn: boolean;
        account?: { plan?: string; balanceUsd?: string | null };
      }>(`${baseUrl}/api/integrations/vela/status`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await setSettingsAmrEnv({ VELA_RUNTIME_KEY: 'rt-billing-account-B' });

      const { body } = await pending;

      expect(body.loggedIn).toBe(true);
      expect(body.account?.plan).toBe('plus');
      expect(body.account?.balanceUsd).toBe('8.00');
      const attempts = readFileSync(billingLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toContain('rt-billing-account-A');
      expect(attempts[0]).not.toContain('rt-billing-account-B');
    } finally {
      await setSettingsAmrEnv({
        VELA_RUNTIME_KEY: undefined,
        VELA_LINK_URL: undefined,
      });
    }
  });

  it('does not leak cached billing when the Settings-backed env credential switches accounts', async () => {
    // Account A and B share ~/.amr/config.json (untouched) and differ only by
    // the agentCliEnv.amr VELA_RUNTIME_KEY. The credential fingerprint must keep
    // their live-account caches separate so B never inherits A's plan/balance.
    clearAllVelaLiveAccounts();
    const dataDir = process.env.OD_DATA_DIR as string;
    const setAmrEnv = async (extra: Record<string, string | undefined>) => {
      const cfg = await readAppConfig(dataDir);
      const amr: Record<string, string> = {
        ...((cfg.agentCliEnv?.amr as Record<string, string>) ?? {}),
      };
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete amr[k];
        else amr[k] = v;
      }
      await writeAppConfig(dataDir, {
        ...cfg,
        agentCliEnv: { ...(cfg.agentCliEnv ?? {}), amr },
      });
    };
    seedLogin('local', {
      user: { id: 'cfg', email: 'cfg@example.com', plan: undefined },
    });
    try {
      await setAmrEnv({
        VELA_RUNTIME_KEY: 'rt-account-A',
        VELA_LINK_URL: 'http://link.invalid',
      });
      process.env.FAKE_VELA_BILLING_TIER = 'plus';
      const a = await getJson<{ account?: { plan?: string } }>(
        `${baseUrl}/api/integrations/vela/status`,
      );
      expect(a.body.account?.plan).toBe('plus');

      // Switch the Settings env credential to account B WITHOUT touching the
      // config file, and change what billing returns for the new account.
      await setAmrEnv({ VELA_RUNTIME_KEY: 'rt-account-B' });
      process.env.FAKE_VELA_BILLING_TIER = 'max';
      const b = await getJson<{ account?: { plan?: string } }>(
        `${baseUrl}/api/integrations/vela/status`,
      );
      expect(b.body.account?.plan).toBe('max');
    } finally {
      await setAmrEnv({ VELA_RUNTIME_KEY: undefined, VELA_LINK_URL: undefined });
    }
  });

  it('never leaks the runtimeKey or controlKey in the status payload', async () => {
    seedLogin('local', {
      runtimeKey: 'rt-very-secret-do-not-leak',
      controlKey: 'ck-also-secret',
    });
    const resp = await fetch(`${baseUrl}/api/integrations/vela/status`);
    const text = await resp.text();
    expect(text).not.toContain('rt-very-secret-do-not-leak');
    expect(text).not.toContain('ck-also-secret');
  });
});

describe('ALL /api/integrations/vela/api-proxy/*', () => {
  it('forwards form-encoded POST bodies to the AMR API upstream', async () => {
    const upstreamRequests: Array<{
      href: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((target, options, callback) => {
      const req = new PassThrough() as any;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('finish', () => {
        upstreamRequests.push({
          href: target instanceof URL ? target.href : String(target),
          method: String(options?.method ?? ''),
          headers: options?.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const upstreamRes = new PassThrough() as any;
        upstreamRes.statusCode = 201;
        upstreamRes.headers = { 'content-type': 'application/json' };
        callback?.(upstreamRes);
        upstreamRes.end(JSON.stringify({ ok: true }));
      });
      req.setTimeout = () => req;
      return req;
    }) as typeof https.request);

    try {
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-code-123',
      }).toString();
      const resp = await fetch(`${baseUrl}/api/integrations/vela/api-proxy/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      expect(resp.status).toBe(201);
      expect(await resp.json()).toEqual({ ok: true });
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]?.href).toBe('https://amr-api.open-design.ai/api/v1/oauth/token');
      expect(upstreamRequests[0]?.method).toBe('POST');
      expect(upstreamRequests[0]?.headers['content-type']).toContain(
        'application/x-www-form-urlencoded',
      );
      expect(upstreamRequests[0]?.headers['content-length']).toBe(String(Buffer.byteLength(body)));
      expect(upstreamRequests[0]?.body).toBe(body);
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('preserves a valid Workspace scope while stripping request hop-by-hop headers', async () => {
    let forwardedHeaders: Record<string, string | string[]> | undefined;
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((_target, options, callback) => {
      const upstream = new PassThrough() as any;
      upstream.on('finish', () => {
        forwardedHeaders = options?.headers as Record<string, string | string[]>;
        const upstreamRes = new PassThrough() as any;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = { 'content-type': 'application/json' };
        callback?.(upstreamRes);
        upstreamRes.end(JSON.stringify({ ok: true }));
      });
      upstream.setTimeout = () => upstream;
      return upstream;
    }) as typeof https.request);
    const daemonUrl = new URL(baseUrl);

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          {
            hostname: daemonUrl.hostname,
            port: daemonUrl.port,
            method: 'GET',
            path: '/api/integrations/vela/api-proxy/api/v1/workspaces/workspace_team-1/billing',
            headers: {
              'x-vela-workspace-id': 'workspace_team-1',
              connection: 'x-test-hop',
              'keep-alive': 'timeout=5',
              'proxy-authorization': 'Basic test-only',
              te: 'trailers',
              trailer: 'x-test-checksum',
              'transfer-encoding': 'chunked',
              'x-test-hop': 'drop-me',
            },
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
          },
        );
        request.on('error', reject);
        request.end();
      });

      expect(status).toBe(200);
      expect(forwardedHeaders?.['x-vela-workspace-id']).toBe('workspace_team-1');
      expect(forwardedHeaders).not.toHaveProperty('connection');
      expect(forwardedHeaders).not.toHaveProperty('keep-alive');
      expect(forwardedHeaders).not.toHaveProperty('proxy-authorization');
      expect(forwardedHeaders).not.toHaveProperty('te');
      expect(forwardedHeaders).not.toHaveProperty('trailer');
      expect(forwardedHeaders).not.toHaveProperty('transfer-encoding');
      expect(forwardedHeaders).not.toHaveProperty('upgrade');
      expect(forwardedHeaders).not.toHaveProperty('x-test-hop');
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('rejects normalized path escapes and malformed Workspace scope before proxying', async () => {
    let upstreamRequestCount = 0;
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((_target, _options, callback) => {
      upstreamRequestCount += 1;
      const upstream = new PassThrough() as any;
      upstream.on('finish', () => {
        const upstreamRes = new PassThrough() as any;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = { 'content-type': 'application/json' };
        callback?.(upstreamRes);
        upstreamRes.end(JSON.stringify({ unexpectedlyProxied: true }));
      });
      upstream.setTimeout = () => upstream;
      return upstream;
    }) as typeof https.request);
    const daemonUrl = new URL(baseUrl);
    const rawGet = (pathName: string, headers?: http.OutgoingHttpHeaders) =>
      new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = http.request(
          {
            hostname: daemonUrl.hostname,
            port: daemonUrl.port,
            method: 'GET',
            path: pathName,
            headers,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', () => {
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            });
          },
        );
        request.on('error', reject);
        request.end();
      });

    try {
      const escaped = await rawGet(
        '/api/integrations/vela/api-proxy/api/v1/%2e%2e/private',
      );
      const invalid = await rawGet(
        '/api/integrations/vela/api-proxy/api/v1/wallet/balance',
        { 'x-vela-workspace-id': ['workspace/escape'] },
      );
      const duplicate = await rawGet(
        '/api/integrations/vela/api-proxy/api/v1/wallet/balance',
        { 'x-vela-workspace-id': ['workspace-a', 'workspace-b'] },
      );
      const connectionNominated = await rawGet(
        '/api/integrations/vela/api-proxy/api/v1/wallet/balance',
        {
          connection: 'x-vela-workspace-id',
          'x-vela-workspace-id': 'workspace-team',
        },
      );

      expect(escaped).toEqual({ status: 404, body: { error: 'unknown_amr_api_proxy_path' } });
      expect(invalid).toEqual({ status: 400, body: { error: 'invalid_workspace_id' } });
      expect(duplicate).toEqual({ status: 400, body: { error: 'invalid_workspace_id' } });
      expect(connectionNominated).toEqual({
        status: 400,
        body: { error: 'invalid_workspace_id' },
      });
      expect(upstreamRequestCount).toBe(0);
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('strips upstream hop-by-hop response headers while preserving billing metadata', async () => {
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((_target, _options, callback) => {
      const upstream = new PassThrough() as any;
      upstream.on('finish', () => {
        const upstreamRes = new PassThrough() as any;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = {
          connection: 'x-upstream-hop',
          'x-upstream-hop': 'drop-me',
          'keep-alive': 'timeout=5',
          'proxy-authenticate': 'Basic',
          'proxy-authorization': 'Basic test-only',
          te: 'trailers',
          trailer: 'x-test-checksum',
          'transfer-encoding': 'chunked',
          upgrade: 'websocket',
          'x-request-id': 'billing-request-1',
          'content-type': 'application/json',
        };
        callback?.(upstreamRes);
        upstreamRes.end(JSON.stringify({ balanceUsd: '120.00' }));
      });
      upstream.setTimeout = () => upstream;
      return upstream;
    }) as typeof https.request);

    try {
      const response = await fetch(
        `${baseUrl}/api/integrations/vela/api-proxy/api/v1/wallet/balance`,
        { headers: { 'x-vela-workspace-id': 'workspace-team' } },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('billing-request-1');
      expect(response.headers.get('connection')).not.toBe('x-upstream-hop');
      expect(response.headers.get('x-upstream-hop')).toBeNull();
      expect(response.headers.get('keep-alive')).not.toBe('timeout=5');
      for (const name of [
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'upgrade',
      ]) {
        expect(response.headers.get(name), name).toBeNull();
      }
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('destroys the upstream request when a streaming Workspace upload is aborted', async () => {
    let upstreamRequest: PassThrough | undefined;
    let markUpstreamCreated: (() => void) | undefined;
    let markUpstreamDestroyed: (() => void) | undefined;
    const upstreamCreated = new Promise<void>((resolve) => {
      markUpstreamCreated = resolve;
    });
    const upstreamDestroyed = new Promise<void>((resolve) => {
      markUpstreamDestroyed = resolve;
    });
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((() => {
      upstreamRequest = new PassThrough();
      upstreamRequest.once('close', () => markUpstreamDestroyed?.());
      (upstreamRequest as any).setTimeout = () => upstreamRequest;
      markUpstreamCreated?.();
      return upstreamRequest as any;
    }) as typeof https.request);
    const daemonUrl = new URL(baseUrl);

    try {
      const upload = http.request({
        hostname: daemonUrl.hostname,
        port: daemonUrl.port,
        method: 'POST',
        path: '/api/integrations/vela/api-proxy/api/v1/workspaces/import',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '1024',
          'x-vela-workspace-id': 'workspace-upload',
        },
      });
      upload.on('error', () => {});
      const uploadClosed = new Promise<void>((resolve) => upload.once('close', resolve));
      upload.write(Buffer.alloc(64, 1));
      await upstreamCreated;
      upload.destroy();
      await uploadClosed;
      await upstreamDestroyed;

      expect(upstreamRequest?.destroyed).toBe(true);
    } finally {
      upstreamRequest?.destroy();
      requestSpy.mockRestore();
    }
  });

  it('destroys the upstream request when the downstream response closes', async () => {
    let upstreamRequest: PassThrough | undefined;
    let upstreamResponse: PassThrough | undefined;
    let downstreamRequest: http.ClientRequest | undefined;
    let markUpstreamDestroyed: (() => void) | undefined;
    const upstreamDestroyed = new Promise<void>((resolve) => {
      markUpstreamDestroyed = resolve;
    });
    let markResponseStarted: (() => void) | undefined;
    const responseStarted = new Promise<void>((resolve) => {
      markResponseStarted = resolve;
    });
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((_target, _options, callback) => {
      upstreamRequest = new PassThrough();
      upstreamRequest.once('close', () => markUpstreamDestroyed?.());
      upstreamRequest.on('finish', () => {
        upstreamResponse = new PassThrough();
        (upstreamResponse as any).statusCode = 200;
        (upstreamResponse as any).headers = { 'content-type': 'application/json' };
        callback?.(upstreamResponse as any);
        upstreamResponse.write('{"balanceUsd":');
        markResponseStarted?.();
      });
      (upstreamRequest as any).setTimeout = () => upstreamRequest;
      return upstreamRequest as any;
    }) as typeof https.request);
    const daemonUrl = new URL(baseUrl);

    try {
      const downstreamClosed = new Promise<void>((resolve, reject) => {
        downstreamRequest = http.request(
          {
            hostname: daemonUrl.hostname,
            port: daemonUrl.port,
            method: 'GET',
            path: '/api/integrations/vela/api-proxy/api/v1/wallet/balance',
            headers: { 'x-vela-workspace-id': 'workspace-close' },
          },
          (response) => {
            response.once('data', () => response.destroy());
            response.once('close', resolve);
          },
        );
        downstreamRequest.on('error', reject);
        downstreamRequest.end();
      });
      await responseStarted;
      await downstreamClosed;
      await upstreamDestroyed;

      expect(upstreamRequest?.destroyed).toBe(true);
    } finally {
      downstreamRequest?.destroy();
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
      requestSpy.mockRestore();
    }
  });
});

describe('ALL /api/integrations/vela/message-center/*', () => {
  it('uses the selected profile origin for anonymous messages without forwarding credentials', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const upstream = createServer((req, res) => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ messages: [], nextCursor: null, unreadCount: 0 }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('test', {
      apiUrl: `http://127.0.0.1:${address.port}`,
      controlKey: undefined,
      runtimeKey: undefined,
      user: undefined,
    });
    await setSettingsAmrEnv({ OPEN_DESIGN_AMR_PROFILE: 'test' });
    try {
      const response = await fetch(
        `${baseUrl}/api/integrations/vela/message-center-public/messages?locale=en-US&limit=30`,
        { headers: { authorization: 'Bearer browser-supplied-key' } },
      );
      expect(response.status).toBe(200);
      expect(requests).toEqual([
        {
          url: '/api/v1/message-center/messages?locale=en-US&limit=30',
          authorization: undefined,
        },
      ]);
    } finally {
      await setSettingsAmrEnv({ OPEN_DESIGN_AMR_PROFILE: undefined });
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('forwards only Message Center routes to the configured profile origin with its control key', async () => {
    const requests: Array<{ url: string; method: string; authorization: string | undefined }> = [];
    const upstream = createServer((req, res) => {
      requests.push({
        url: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ messages: [], nextCursor: null, unreadCount: 0 }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: `http://127.0.0.1:${address.port}` });
    try {
      const response = await fetch(
        `${baseUrl}/api/integrations/vela/message-center/messages?locale=en-US&limit=30`,
        { headers: { authorization: 'Bearer browser-supplied-key' } },
      );
      expect(response.status).toBe(200);
      expect(requests).toEqual([
        {
          url: '/api/v1/message-center/messages?locale=en-US&limit=30',
          method: 'GET',
          authorization: 'Bearer ck-seeded-key',
        },
      ]);
      const markRead = await fetch(
        `${baseUrl}/api/integrations/vela/message-center/messages/release/read`,
        { method: 'POST' },
      );
      expect(markRead.status).toBe(200);
      expect(requests).toEqual([
        {
          url: '/api/v1/message-center/messages?locale=en-US&limit=30',
          method: 'GET',
          authorization: 'Bearer ck-seeded-key',
        },
        {
          url: '/api/v1/message-center/messages/release/read',
          method: 'POST',
          authorization: 'Bearer ck-seeded-key',
        },
      ]);
      const rejected = await fetch(`${baseUrl}/api/integrations/vela/message-center/wallet/balance`);
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toEqual({ error: 'unknown_message_center_path' });
      expect(requests).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('fails visibly when no control key is configured', async () => {
    const response = await fetch(
      `${baseUrl}/api/integrations/vela/message-center/messages?locale=en-US`,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'vela_control_key_required' });
  });

  it('guards upstream response-stream errors after headers without crashing the daemon', async () => {
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(((target, options, callback) => {
      const req = new PassThrough() as any;
      req.on('finish', () => {
        const upstreamRes = new PassThrough() as any;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = { 'content-type': 'application/json' };
        callback?.(upstreamRes);
        upstreamRes.write('{"messages":[');
        setImmediate(() => upstreamRes.emit('error', new Error('mid-stream reset')));
      });
      req.setTimeout = () => req;
      return req;
    }) as typeof http.request);

    seedLogin('local', { apiUrl: 'http://127.0.0.1:18080' });

    try {
      const response = await fetch(
        `${baseUrl}/api/integrations/vela/message-center/messages?locale=en-US`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"messages":[');

      const status = await getJson<{ loggedIn: boolean }>(`${baseUrl}/api/integrations/vela/status`);
      expect(status.status).toBe(200);
      expect(status.body.loggedIn).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });
});

describe('Test touchpoint runtime proxy', () => {
  it('forwards the caller encoding preference and labels the reply it gets back', async () => {
    // Decisions carry base64 content and run to megabytes. Building the upstream
    // headers from scratch dropped `accept-encoding`, so every refresh pulled the
    // payload uncompressed; the body is piped verbatim, so the reply must also
    // carry upstream's `content-encoding` or the caller decodes gzip as JSON.
    let seenAcceptEncoding: string | undefined;
    const upstream = createServer((req, res) => {
      seenAcceptEncoding = req.headers['accept-encoding'] as string | undefined;
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.statusCode = 200;
      res.end(gzipSync(Buffer.from(JSON.stringify({ placementKey: 'opend.home.hover-layer' }))));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: `http://127.0.0.1:${address.port}` });
    try {
      const response = await fetch(
        `${baseUrl}/api/touchpoints/test-runtime?deploymentId=deployment-1&placementKey=opend.home.hover-layer&locale=zh-CN`,
        { headers: { 'accept-encoding': 'gzip' } },
      );
      expect(response.status).toBe(200);
      expect(seenAcceptEncoding).toBe('gzip');
      // `fetch` decodes transparently, which is only possible when the header survived.
      expect(await response.json()).toEqual({ placementKey: 'opend.home.hover-layer' });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('leaves an unencoded reply unlabelled when the caller asks for no encoding', async () => {
    let seenAcceptEncoding: string | undefined = 'unset';
    const upstream = createServer((req, res) => {
      seenAcceptEncoding = req.headers['accept-encoding'] as string | undefined;
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ placementKey: 'opend.home.hover-layer' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: `http://127.0.0.1:${address.port}` });
    try {
      const response = await fetch(
        `${baseUrl}/api/touchpoints/test-runtime?deploymentId=deployment-1&placementKey=opend.home.hover-layer&locale=zh-CN`,
        { headers: { 'accept-encoding': 'identity' } },
      );
      expect(seenAcceptEncoding).toBe('identity');
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(await response.json()).toEqual({ placementKey: 'opend.home.hover-layer' });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('forwards only the registered context POST with daemon-held credentials', async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | undefined;
      body: string;
    }> = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({
          url: req.url ?? '',
          method: req.method ?? '',
          authorization: req.headers.authorization,
          body,
        });
        res.setHeader('content-type', 'application/json');
        res.statusCode = 201;
        res.end(JSON.stringify({ deploymentId: 'deployment-1', scenario: 'realtime', updatedAt: '2026-09-14T00:00:00.000Z' }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: `http://127.0.0.1:${address.port}` });
    try {
      const accepted = await postJson(
        `${baseUrl}/api/touchpoints/test-runtime/context`,
        { deploymentId: 'deployment-1', scenario: 'realtime' },
        { authorization: 'Bearer browser-supplied-key' },
      );
      expect(accepted.status).toBe(201);
      expect(requests).toEqual([
        {
          url: '/api/v1/touchpoints/runtime/test-context',
          method: 'POST',
          authorization: 'Bearer ck-seeded-key',
          body: JSON.stringify({
            deploymentId: 'deployment-1',
            scenario: 'realtime',
          }),
        },
      ]);
      const acceptance = await postJson(
        `${baseUrl}/api/touchpoints/test-runtime/test-deployments/deployment-1/acceptances`,
        {
          placementKey: 'opend.home.campaign-modal',
          hostVersion: '2',
          locale: 'zh-CN',
          scenario: 'realtime',
          evidence: 'http://127.0.0.1:55381/#cms-test',
        },
        { authorization: 'Bearer browser-supplied-key' },
      );
      expect(acceptance.status).toBe(201);
      expect(requests).toEqual([
        {
          url: '/api/v1/touchpoints/runtime/test-context',
          method: 'POST',
          authorization: 'Bearer ck-seeded-key',
          body: JSON.stringify({
            deploymentId: 'deployment-1',
            scenario: 'realtime',
          }),
        },
        {
          url: '/api/v1/touchpoints/test-deployments/deployment-1/acceptances',
          method: 'POST',
          authorization: 'Bearer ck-seeded-key',
          body: JSON.stringify({
            placementKey: 'opend.home.campaign-modal',
            hostVersion: '2',
            locale: 'zh-CN',
            scenario: 'realtime',
            evidence: 'http://127.0.0.1:55381/#cms-test',
          }),
        },
      ]);
      const simulated = await postJson(
        `${baseUrl}/api/touchpoints/test-runtime/context`,
        { deploymentId: 'deployment-1', scenario: 'before' },
      );
      expect(simulated.status).toBe(400);
      expect(simulated.body).toEqual({ error: 'realtime_test_runtime_required' });
      expect(requests).toHaveLength(2);
      const rejected = await postJson(
        `${baseUrl}/api/touchpoints/test-runtime/unknown`,
        { deploymentId: 'deployment-1', scenario: 'before' },
      );
      expect(rejected.status).toBe(404);
      expect(rejected.body).toEqual({
        error: 'unknown_touchpoint_runtime_path',
      });
      expect(requests).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe('Production touchpoint runtime proxy', () => {
  it('routes a local publish reader separately without changing the stored login or trusting remote overrides', async () => {
    const requests: string[] = [];
    const upstream = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ activityId: 'published-local' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: 'http://127.0.0.1:1' });
    try {
      process.env.OPEN_DESIGN_CMS_PRODUCTION_API_URL = `http://127.0.0.1:${address.port}`;
      const response = await getJson(
        `${baseUrl}/api/touchpoints/production-runtime?placementKey=opend.home.account-badge&locale=zh-CN`,
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      process.env.OPEN_DESIGN_CMS_PRODUCTION_API_URL = 'https://example.com';
      const rejected = await getJson(
        `${baseUrl}/api/touchpoints/production-runtime?placementKey=opend.home.account-badge&locale=zh-CN`,
      );
      expect(rejected.status).toBe(400);
      expect(requests).toHaveLength(1);
    } finally {
      delete process.env.OPEN_DESIGN_CMS_PRODUCTION_API_URL;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
  it('forwards only the exact production decision path with daemon-held credentials', async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | undefined;
    }> = [];
    const upstream = createServer((req, res) => {
      requests.push({
        url: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ activityId: 'activity-1' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    seedLogin('local', { apiUrl: `http://127.0.0.1:${address.port}` });
    try {
      const accepted = await getJson(
        `${baseUrl}/api/touchpoints/production-runtime?placementKey=opend.home.campaign-modal&locale=en-US`,
      );
      expect(accepted.status).toBe(200);
      expect(requests).toEqual([
        {
          url: '/api/v1/touchpoints/runtime/production?placementKey=opend.home.campaign-modal&locale=en-US',
          method: 'GET',
          authorization: 'Bearer ck-seeded-key',
        },
      ]);
      const rejected = await getJson(
        `${baseUrl}/api/touchpoints/production-runtime/deployments`,
      );
      expect(rejected.status).toBe(404);
      expect(requests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

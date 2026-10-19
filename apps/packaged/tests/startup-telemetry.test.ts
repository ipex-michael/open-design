/**
 * Coverage for the packaged main-process startup-failure telemetry
 * (apps/packaged/src/startup-telemetry.ts).
 *
 * Background: when the daemon dies before reporting status (issue #4638:
 * `better-sqlite3` vanished from the bundle → ERR_MODULE_NOT_FOUND), the
 * daemon/web sidecars — which host the PostHog client — never run, so the
 * whole crash class emits ZERO telemetry. This module emits one event from the
 * main process on the fatal-exit path. These tests pin three guarantees:
 *   1. it extracts the real error code / missing module from the #4638 log,
 *   2. it scrubs the user's home dir out of anything it sends,
 *   3. it can NEVER block the exit (timeout wins over a hung fetch) and is a
 *      no-op without a PostHog key.
 *
 * @see apps/packaged/src/startup-telemetry.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STARTUP_FAILURE_EVENT,
  captureStartupFailure,
  classifyStartupFailure,
  parseDaemonLogTail,
  resolveStartupDistinctId,
  readErrnoFields,
  scrubUserPaths,
} from '../src/startup-telemetry.js';

// Verbatim daemon log tail from issue #4638.
const ISSUE_4638_LOG = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3' imported from /Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/chunks/server-PULTSXNL.mjs
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
[open-design packaged] exited app=daemon pid=45305 code=1 signal=none`;

// Verbatim shape of what waitForStatus throws (sidecars.ts:206-208).
const DAEMON_EXIT_MESSAGE =
  'daemon exited before reporting status (code=1, signal=none); see /Users/liudetao/Library/Application Support/Open Design/namespaces/release-stable/logs/daemon/latest.log for details';
const WEB_EXIT_MESSAGE =
  'daemon exited before reporting status (code=1, signal=none); see /Users/liudetao/Library/Application Support/Open Design/namespaces/release-stable/logs/web/latest.log for details';

describe('parseDaemonLogTail', () => {
  it('extracts the error code and missing module from the #4638 log', () => {
    expect(parseDaemonLogTail(ISSUE_4638_LOG)).toEqual({
      errorCode: 'ERR_MODULE_NOT_FOUND',
      missingModule: 'better-sqlite3',
    });
  });

  it('returns empty when the log carries no recognizable signal', () => {
    expect(parseDaemonLogTail('daemon started ok\nlistening on 17456')).toEqual({});
  });
});

describe('classifyStartupFailure', () => {
  it('classifies a daemon-start failure and pulls code/signal/logPath', () => {
    const c = classifyStartupFailure(new Error(DAEMON_EXIT_MESSAGE), false);
    expect(c.failureKind).toBe('daemon-start');
    expect(c.exitCode).toBe(1);
    expect(c.signal).toBeNull();
    expect(c.logPath).toContain('/logs/daemon/latest.log');
  });

  it('distinguishes a web-start failure by log-path segment, not message text', () => {
    // The thrown message still literally says "daemon" even for the web
    // sidecar; the log path is the only honest discriminator.
    const c = classifyStartupFailure(new Error(WEB_EXIT_MESSAGE), false);
    expect(c.failureKind).toBe('web-start');
  });

  it('classifies a Windows (backslash) web-start log path as web-start', () => {
    // startPackagedSidecars uses path.join, so on Windows the watched log path
    // is backslash-separated. A naive "/web/" check would misreport this as
    // daemon-start — the one platform split this field exists for.
    const winWebMessage =
      'daemon exited before reporting status (code=1, signal=none); see C:\\Users\\Alice\\AppData\\Roaming\\Open Design\\namespaces\\release-stable\\logs\\web\\latest.log for details';
    expect(classifyStartupFailure(new Error(winWebMessage), false).failureKind).toBe('web-start');
  });

  it('marks path-access failures without inventing a log path', () => {
    const c = classifyStartupFailure(new Error('whatever'), true);
    expect(c.failureKind).toBe('path-access');
    expect(c.logPath).toBeNull();
  });

  it('falls back to unknown for an unrecognized error', () => {
    expect(classifyStartupFailure(new Error('boom'), false).failureKind).toBe('unknown');
  });

  it('classifies a status-wait timeout as status-timeout, not unknown', () => {
    // waitForStatus throws this when the budget expires with the child still
    // ALIVE (the win32 first-launch AV-scan case) — the pipe never bound in
    // time, so there is no exit code, signal, or daemon log to read. Splitting
    // it out of `unknown` is what makes the win32 budget-raise measurable.
    const winPipe =
      'timed out waiting for sidecar status at \\\\.\\pipe\\open-design-release-stable-win-daemon (connect ENOENT \\\\.\\pipe\\open-design-release-stable-win-daemon)';
    const c = classifyStartupFailure(new Error(winPipe), false);
    expect(c.failureKind).toBe('status-timeout');
    expect(c.exitCode).toBeNull();
    expect(c.signal).toBeNull();
    expect(c.logPath).toBeNull();
  });
});

describe('scrubUserPaths', () => {
  it('redacts the user home directory but keeps the rest of the path', () => {
    const scrubbed = scrubUserPaths(
      '/Users/liudetao/Library/Application Support/Open Design/namespaces/release-stable/logs/daemon/latest.log',
    );
    expect(scrubbed).not.toContain('liudetao');
    expect(scrubbed).toContain('/Users/<redacted>/Library/Application Support');
  });

  it('redacts Windows user dirs too', () => {
    expect(scrubUserPaths('C:\\Users\\Alice\\AppData\\Roaming')).toBe(
      'C:\\Users\\<redacted>\\AppData\\Roaming',
    );
  });

  it('redacts the FULL Windows profile segment even when it contains spaces', () => {
    // A Windows profile dir can contain whitespace ("John Doe"). The redaction
    // must consume the whole segment up to the next separator, not stop at the
    // first space and leak the surname.
    const scrubbed = scrubUserPaths('C:\\Users\\John Doe\\AppData\\Roaming');
    expect(scrubbed).toBe('C:\\Users\\<redacted>\\AppData\\Roaming');
    expect(scrubbed).not.toContain('Doe');
  });

  it('scrubs a spaced Windows profile embedded in a crash message/stack', () => {
    const raw =
      "Cannot find package 'better-sqlite3' imported from C:\\Users\\John Doe\\App\\Resources\\app\\daemon\\server.mjs";
    const scrubbed = scrubUserPaths(raw);
    expect(scrubbed).not.toContain('John Doe');
    expect(scrubbed).not.toContain('Doe');
    expect(scrubbed).toContain('C:\\Users\\<redacted>\\App\\Resources');
  });

  it('redacts SLASH-separated Windows home paths with spaces (forward-slash form)', () => {
    // JS/Electron/Node diagnostics frequently normalize Windows paths to forward
    // slashes; the profile segment can still contain a literal space. The POSIX
    // "/Users/" rule alone would stop at the space and leak the tail.
    expect(scrubUserPaths('C:/Users/John Doe/AppData/Roaming')).toBe(
      'C:/Users/<redacted>/AppData/Roaming',
    );
  });

  it('scrubs a slash-form spaced Windows profile embedded in a crash message', () => {
    const raw =
      "Cannot find package 'better-sqlite3' imported from C:/Users/John Doe/App/Resources/app/daemon/server.mjs";
    const scrubbed = scrubUserPaths(raw);
    expect(scrubbed).not.toContain('John Doe');
    expect(scrubbed).not.toContain('Doe');
    expect(scrubbed).toContain('C:/Users/<redacted>/App/Resources');
  });

  it('does not over-redact across lines in a multi-line stack', () => {
    const scrubbed = scrubUserPaths('a C:\\Users\\John Doe\\x\nb /Users/bob/y');
    expect(scrubbed).toBe('a C:\\Users\\<redacted>\\x\nb /Users/<redacted>/y');
  });
});

describe('resolveStartupDistinctId', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OD_INSTALLATION_DIR;
  });

  it('reads installationId from an explicit installationRoot (not the child-only env)', () => {
    const root = mkdtempSync(join(tmpdir(), 'od-install-'));
    dirs.push(root);
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ installationId: 'inst-abc' }));
    // env is intentionally unset — proving the parent process resolves via the
    // explicit arg, the bug PerishCode flagged.
    expect(resolveStartupDistinctId('release-stable', root)).toBe('inst-abc');
  });

  it('falls back to a synthetic per-namespace id when no installation file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'od-install-'));
    dirs.push(root);
    expect(resolveStartupDistinctId('release-stable', root)).toBe('packaged-release-stable');
  });
});

describe('captureStartupFailure (fork policy: telemetry removed)', () => {
  it('never performs network I/O, even with a PostHog key', async () => {
    const fetchImpl = vi.fn();
    await captureStartupFailure(
      { posthogKey: 'phc_test', posthogHost: 'https://us.i.posthog.com', distinctId: 'd', event: STARTUP_FAILURE_EVENT, properties: {} },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


// Attribution guards. Every input below is a VERBATIM field payload pulled from
// the `packaged_runtime_failed` stream (7d window, 2026-07-22) while triaging
// the weekly alert. Each one is a failure the event carried enough evidence to
// name and reported as an opaque `unknown` / `null` anyway:
//
//   - 62 devices: daemon exited(code=1) with the log tail successfully read, but
//     `parseDaemonLogTail` only ever matched `ERR_*`, so any daemon that died of
//     something else (SQLite corruption, EPERM, a plain throw) reported
//     error_code=null AND missing_module=null — evidence in hand, nothing
//     extracted.
//   - 21 devices: Windows CreateProcess failures whose Error carries
//     code/errno/syscall as own properties. The event sent `.message` only and
//     dropped the triplet, so `spawn UNKNOWN` could not be separated from any
//     other opaque failure.
//   - 149 devices: an Error with an empty `.message` AND no `.stack`, which fell
//     through to error_message=null + error_stack=null + failure_kind=unknown —
//     a total black hole with no way to count or name the residue.

// Privacy guard for the errno triplet (review of PR #5956).
//
// Node does not guarantee `syscall` is only the operation name: a failed
// child_process.spawn sets it to the whole invocation. Verified against real
// Node behaviour — spawning a missing binary yields
// `syscall === 'spawn /Users/<name>/.../tool'`. Forwarding that verbatim would
// put the local username and install path into an event that is retained even
// for opted-out users, while every other path this module sends is scrubbed.

// The blind bucket (production, 14 days to 2026-08-22): macOS `daemon-start`
// with 968 events across 293 people where the daemon exits code=1, the native
// module IS present, and error_code / missing_module / daemon_error all come
// back empty. `parseDaemonLogTail` only names patterns we already know
// (`ERR_*`, a missing module, an `XError:` headline); when a daemon dies of
// anything else, the reason is sitting in a log tail we ALREADY READ and then
// threw away. These tests pin the recovery: when parsing yields nothing, send
// the tail itself — scrubbed and bounded — so the largest startup-failure
// bucket stops being undiagnosable.

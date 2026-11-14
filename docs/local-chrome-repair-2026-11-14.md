# Local Chrome bridge repair — November 14, 2026

Local Chrome was repaired and verified from ChatGPT. A read-only call using the
Local Chrome app and `Chrome.user.openTabs()` returned **2** existing user tabs.
No tab titles or URLs were included in the response.

## Causes

1. The installed app and plugin were `26.1111.21308`, but the v2 catalogue held
   only a `26.1106.51428` entry. The bridge incorrectly required that historical
   catalogue to contain the current app before it could use the current signed
   app's resources. The current native-host manifest and cache symlink were valid.
2. Shell diagnostics inherited Codex chat-scoped browser-access settings. The
   desktop rejected those independently launched diagnostic processes with
   `untrusted-process-ancestry`, producing `native pipe closed before response`.
   The same signed runtime passed when tested in Local Chrome's real launchd
   environment. This was a diagnostic-context error, not a signature failure or
   a broken Chrome extension.

## Changes

- `scripts/browserjack-runtime.mjs`: resolve the current signed app directly
  when a well-formed catalogue has no entry for the current version. Historical
  paths are never used. Current entries still require the original protocol,
  identity, and uniqueness checks. Direct resolution also requires all signed
  extension origins and contained app-resource paths.
- `scripts/browserjack-runtime.test.mjs`: cover historical, malformed, invalid,
  and duplicate registrations.
- `scripts/service-check.sh`: run doctor, smoke, or status as a temporary,
  one-shot launchd job using the existing service environment. No chat access
  identity is copied, replayed, fabricated, or disabled. Only bounded diagnostic
  fields are printed; private temporary output and jobs are removed afterward.
- `README.md` and `SECURITY.md`: document resolution and service-context checks.

The existing signature, OpenAI identity, native-host byte-identity, fingerprint,
sandbox, and live self-test checks remain enabled. The new fingerprint was
approved only after the existing live doctor succeeded. The approval file is
mode `600`. The trust policy and prepared BrowserJack adapter were not changed.

OpenAI's v2 registries were not rewritten: they still contain the historical
entry, so **a current v2 entry was not created**. The repaired bridge uses verified
signed-app resolution instead. No registration was invented.

## Verification

- `bash -n scripts/*.sh` and an individual syntax check of every shell script:
  passed.
- `node --check scripts/browserjack-mcp-smoke.mjs` and
  `node --check scripts/browserjack-fingerprint.mjs`: passed.
- `node --test scripts/browserjack-fingerprint.test.mjs scripts/browserjack-runtime.test.mjs`:
  **20 passed**.
- `node --test scripts/browserjack-supervisor.test.mjs`: **13 passed**.
- `bash scripts/service-check.sh doctor`: exit `0`, ready, live check passed.
- `bash scripts/service-check.sh smoke`: exit `0`, MCP initialized, Chrome
  discovered, `Example Domain` read from its own temporary tab, then tab closed.
- `bash scripts/service.sh restart`: only Local Chrome restarted successfully.
- `bash scripts/service-check.sh status`: exit `0`; underlying `status.sh`
  passed; Chrome discovered, user binding usable, tabs API usable, browser ready,
  launchd-owned tunnel process running, healthy, ready.
- ChatGPT's Local Chrome app: completed the existing-user-tabs test and returned
  `2`. The earlier session-owned-tabs API returned `0`; that is a different list.

A supplementary run of `scripts/browserjack-upgrade-process.test.mjs` timed out
in its simulated compatible-upgrade scenario. Its rejection scenario passed.
That test replaces the runtime resolver with a fixture; the supervisor and test
were unchanged. The timed-out runner kept polling and was stopped. This is not
a claim that the entire repository suite passed.

## Preserved state and backups

Codex configuration, Chrome's native-host manifest, and the v2 registry were
compared with the pre-repair backups and remained byte-identical. Chrome and the
desktop app were not restarted. Existing profiles, extensions, and sessions were
not edited. Pre-existing display-wake changes in the working tree were preserved.

Configuration backups are in
`/private/tmp/local-chrome-registration-backup.mBFNuM`; bridge code and approval
backups are in `/private/tmp/local-chrome-bridge-repair.eDzYas`. Both directories
are private. These are temporary local backups, not committed artifacts.

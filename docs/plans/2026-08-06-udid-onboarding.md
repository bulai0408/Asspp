# Asspp Self-Service UDID Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and deploy a password-gated Safari profile flow that privately obtains a device UDID, registers it with Apple, rebuilds Asspp, and presents the OTA install action.

**Architecture:** A Cloudflare Worker renders the UI, validates the shared answer, issues one-time Apple Profile Service challenges, stores short-lived request state in D1, and dispatches GitHub Actions using only a random request ID. The existing macOS signing workflow privately fetches and verifies the CMS response, registers the device through App Store Connect API, creates a fresh Ad Hoc profile, signs the IPA, and reports completion to the Worker.

**Tech Stack:** Cloudflare Workers, TypeScript, D1, Workers Rate Limiting, Vitest Workers pool, Apple OTA Profile Service, App Store Connect API, Node.js 20, GitHub Actions, macOS `security`/`plutil`, Wrangler 4.x.

---

### Task 1: Scaffold the Worker and Test Harness

**Files:**
- Create: `Services/UDIDOnboarding/package.json`
- Create: `Services/UDIDOnboarding/tsconfig.json`
- Create: `Services/UDIDOnboarding/vitest.config.ts`
- Create: `Services/UDIDOnboarding/wrangler.jsonc`
- Create: `Services/UDIDOnboarding/src/index.ts`
- Create: `Services/UDIDOnboarding/src/env.ts`
- Create: `Services/UDIDOnboarding/test/index.test.ts`

**Step 1: Write the failing smoke test**

Add a Worker-pool test that requests `/health` and expects status `200` with `{ "ok": true }`.

**Step 2: Run the test to verify it fails**

Run: `cd Services/UDIDOnboarding && npm test`

Expected: FAIL because the Worker entry point and test dependencies are incomplete.

**Step 3: Implement the minimal Worker**

Export a native Worker `fetch` handler. Define an `Env` interface with `DB`, `ANSWER_RATE_LIMITER`, `GATE_ANSWER`, `CHALLENGE_KEY`, `GITHUB_TOKEN`, and `INTERNAL_API_TOKEN`. Return JSON only from `/health` and `404` elsewhere.

Use `wrangler.jsonc` with a current compatibility date, `nodejs_compat`, D1 and Rate Limiting bindings, observability enabled, and production variables for the GitHub repository/workflow and final OTA URL. Keep every credential out of config.

**Step 4: Install dependencies and make the test pass**

Run:

```bash
cd Services/UDIDOnboarding
npm install
npm test
npx wrangler types
npx tsc --noEmit
```

Expected: all tests and type checks pass; generated Worker binding types match config.

**Step 5: Commit**

```bash
git add Services/UDIDOnboarding
git commit -m "feat: scaffold UDID onboarding worker"
```

### Task 2: Implement Password Gate and D1 Request State

**Files:**
- Create: `Services/UDIDOnboarding/migrations/0001_onboarding_requests.sql`
- Create: `Services/UDIDOnboarding/src/crypto.ts`
- Create: `Services/UDIDOnboarding/src/store.ts`
- Create: `Services/UDIDOnboarding/src/pages.ts`
- Create: `Services/UDIDOnboarding/test/gate.test.ts`
- Modify: `Services/UDIDOnboarding/src/index.ts`

**Step 1: Write failing gate tests**

Cover these cases:

- `GET /` renders the Chinese question and never renders the configured answer.
- `POST /unlock` rejects a wrong answer with a generic message.
- Answer normalization trims whitespace and compares case-insensitively.
- A correct answer creates a random request and redirects to `/requests/<id>`.
- More than the configured attempts returns `429`.
- Request identifiers and challenges contain at least 128 bits of entropy.

**Step 2: Run focused tests and verify failure**

Run: `npm test -- gate.test.ts`

Expected: FAIL because routes, storage, and crypto helpers do not exist.

**Step 3: Add schema and minimal implementation**

Create `onboarding_requests` with request ID, challenge hash, state, CMS blob, product, install URL, error code, timestamps, and expiry. Add indexes for state and expiry.

Use Web Crypto SHA-256/HMAC and a constant-time byte comparison. Generate request IDs with `crypto.getRandomValues`, derive challenges with the secret HMAC key, and store only the challenge hash. Render a quiet mobile-first page with a normal password input, explicit submit command, loading/error states, and no answer in HTML or JavaScript.

**Step 4: Run migration and tests locally**

Run:

```bash
npx wrangler d1 migrations apply asspp-udid-onboarding --local
npm test -- gate.test.ts
npm test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add Services/UDIDOnboarding
git commit -m "feat: add password-gated onboarding requests"
```

### Task 3: Implement Apple Profile Service Delivery and Callback

**Files:**
- Create: `Services/UDIDOnboarding/src/mobileconfig.ts`
- Create: `Services/UDIDOnboarding/test/mobileconfig.test.ts`
- Create: `Services/UDIDOnboarding/test/profile-callback.test.ts`
- Modify: `Services/UDIDOnboarding/src/index.ts`
- Modify: `Services/UDIDOnboarding/src/store.ts`

**Step 1: Write failing profile tests**

Verify that:

- `GET /requests/<id>/profile.mobileconfig` works only for an active unlocked request.
- Response type is `application/x-apple-aspen-config` with attachment headers.
- The plist has top-level `PayloadType = Profile Service`.
- `PayloadContent.URL` is the HTTPS callback URL.
- `DeviceAttributes` contains only `UDID`, `PRODUCT`, and `VERSION`.
- `Challenge` is present and never returned by status APIs.
- An expired or already used request cannot issue another profile.
- The callback accepts only a bounded CMS payload and transitions the request once.
- Replays and malformed content types fail without triggering GitHub.

**Step 2: Run tests and verify failure**

Run: `npm test -- mobileconfig.test.ts profile-callback.test.ts`

Expected: FAIL because profile generation and callback routes are missing.

**Step 3: Implement structured plist generation**

Use a plist serialization package instead of manual XML concatenation. Generate stable identifiers and random payload UUIDs. Bind the raw challenge to the request only long enough to build the profile; persist its SHA-256 hash for later verification.

The callback stores the raw DER CMS bytes as a D1 BLOB, marks `device_received`, returns a removable final configuration profile containing only a Web Clip back to the request status page, and schedules GitHub dispatch with `ctx.waitUntil`. It contains no MDM, root certificate, VPN, or restrictions payload.

**Step 4: Run tests and type checks**

Run:

```bash
npm test -- mobileconfig.test.ts profile-callback.test.ts
npm test
npx tsc --noEmit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add Services/UDIDOnboarding
git commit -m "feat: collect device CMS through Apple profile service"
```

### Task 4: Add Private GitHub Dispatch and Status APIs

**Files:**
- Create: `Services/UDIDOnboarding/src/github.ts`
- Create: `Services/UDIDOnboarding/test/internal-api.test.ts`
- Create: `Services/UDIDOnboarding/test/github.test.ts`
- Modify: `Services/UDIDOnboarding/src/index.ts`
- Modify: `Services/UDIDOnboarding/src/store.ts`
- Modify: `Services/UDIDOnboarding/src/pages.ts`

**Step 1: Write failing integration tests**

Cover:

- GitHub dispatch contains `onboarding_request_id` and no UDID/CMS content.
- Internal CMS claim requires a bearer token and is single-use.
- Claim returns raw CMS plus request metadata needed for challenge verification.
- Status updates require the same bearer token and validate state transitions.
- Public polling exposes only state, install URL, and stable error code.
- Ready page renders the OTA install action and temporary-profile removal reminder.
- Failed provider responses contain no token, UDID, or raw body in public output.

**Step 2: Run tests and verify failure**

Run: `npm test -- internal-api.test.ts github.test.ts`

Expected: FAIL.

**Step 3: Implement dispatch and internal routes**

Call GitHub's workflow dispatch endpoint with the fine-grained token stored as a Worker secret. Implement constant-time bearer validation. Clear `cms_payload` in the same D1 update that marks it claimed. Add idempotent status callbacks for `building`, `ready`, and `failed`.

**Step 4: Run the full Worker test suite**

Run: `npm test && npx tsc --noEmit`

Expected: PASS.

**Step 5: Commit**

```bash
git add Services/UDIDOnboarding
git commit -m "feat: dispatch private onboarding builds"
```

### Task 5: Implement CMS Verification and Apple Provisioning Automation

**Files:**
- Create: `Services/UDIDOnboarding/automation/process-device.mjs`
- Create: `Services/UDIDOnboarding/automation/app-store-connect.mjs`
- Create: `Services/UDIDOnboarding/automation/process-device.test.mjs`
- Create: `Services/UDIDOnboarding/automation/fixtures/README.md`

**Step 1: Write failing Node tests**

Test JWT construction, paginated App Store Connect requests, existing-device reuse, new-device registration, profile-create body relationships, provider error redaction, and UDID format validation. Mock `fetch`; never add a real CMS payload or UDID fixture to git.

**Step 2: Run tests and verify failure**

Run: `node --test Services/UDIDOnboarding/automation/*.test.mjs`

Expected: FAIL.

**Step 3: Implement the Apple API client**

Use Node's built-in `crypto` to create a short-lived ES256 App Store Connect JWT. Implement:

- device lookup by UDID
- new iOS device registration with a non-identifying generated name
- enabled iOS device listing with pagination
- configured bundle ID and distribution certificate lookup
- `IOS_APP_ADHOC` profile creation with all enabled device relationships
- profile content decoding to a file supplied by the caller

The processor reads decoded plist data from a path, validates the challenge, emits `::add-mask::<UDID>` before any later command, and writes only profile path/product/result fields to `GITHUB_OUTPUT`.

**Step 4: Run tests and lint checks**

Run:

```bash
node --test Services/UDIDOnboarding/automation/*.test.mjs
node --check Services/UDIDOnboarding/automation/process-device.mjs
node --check Services/UDIDOnboarding/automation/app-store-connect.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add Services/UDIDOnboarding/automation
git commit -m "feat: automate Apple device provisioning"
```

### Task 6: Integrate Onboarding With the Existing Signing Workflow

**Files:**
- Modify: `.github/workflows/upstream-signed-ios.yml`
- Create: `Services/UDIDOnboarding/automation/verify-cms.sh`
- Create: `Services/UDIDOnboarding/automation/verify-workflow.sh`

**Step 1: Add a workflow fixture check that fails**

Add a local shell check that confirms the workflow has the request ID input, never names a UDID input, masks extracted device data, supports profile fallback, and always reports terminal status.

Run: `bash Services/UDIDOnboarding/automation/verify-workflow.sh`

Expected: FAIL before workflow integration.

**Step 2: Add the optional workflow input and private claim**

Add `onboarding_request_id` to `workflow_dispatch`. In `build-release`, checkout only the automation scripts from the fork when onboarding is active, claim the CMS from the Worker using `UDID_WORKER_API_TOKEN`, and verify/decode it with macOS security tools into `RUNNER_TEMP`.

**Step 3: Generate a fresh profile**

When App Store Connect secrets are configured, run `process-device.mjs` and use its generated profile. For ordinary scheduled/manual builds, generate a fresh profile from the already registered devices. Preserve `IOS_PROVISIONING_PROFILE_BASE64` as fallback when API credentials are absent.

**Step 4: Report state and preserve privacy**

Post `building`, `ready`, and `failed` states to the Worker. Use `if: always()` for terminal reporting. Keep request ID in summaries; omit UDID, CMS, profile contents, and Apple response bodies.

**Step 5: Verify workflow structure**

Run:

```bash
bash Services/UDIDOnboarding/automation/verify-workflow.sh
git diff --check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add .github/workflows/upstream-signed-ios.yml Services/UDIDOnboarding/automation
git commit -m "ci: onboard registered devices before signing"
```

### Task 7: Deploy Cloudflare Resources and Configure Secrets

**Files:**
- Modify: `Services/UDIDOnboarding/wrangler.jsonc`
- Modify: `.github/workflows/upstream-signed-ios.yml` only if deployment reveals a binding mismatch
- Create: `Resources/Document/UDID_ONBOARDING_OPERATIONS.md`

**Step 1: Update Wrangler and validate current schema**

Run:

```bash
cd Services/UDIDOnboarding
npm install -D wrangler@latest
npx wrangler types
npx wrangler deploy --dry-run
npx wrangler check startup
```

Expected: valid bundle, generated types, startup under platform limit.

**Step 2: Create and migrate D1**

Run the current Wrangler commands from official documentation to create `asspp-udid-onboarding`, write the returned database ID into `wrangler.jsonc`, and apply migrations remotely.

**Step 3: Set secrets without exposing values**

Set Worker secrets interactively for the shared gate answer, challenge HMAC key, GitHub fine-grained token, and internal API token. Set GitHub secrets for App Store Connect issuer/key/private key, Worker URL, and the same internal API token. Never pass these values as command-line arguments or commit them.

**Step 4: Deploy and run API smoke tests**

Deploy the Worker, then verify health, gate redaction, wrong-answer handling, rate limiting behavior, profile content headers, and internal endpoint authorization with `curl` using non-secret fixtures.

**Step 5: Add the Worker entry to the generated install page**

Update the GitHub Pages install HTML template to link its registration warning/action to the deployed Worker. Trigger the signed build workflow and verify the live page points to the Worker.

**Step 6: Document operations and commit**

Document secret names, deployment commands, quota handling, request-state inspection, retry procedure, and rollback. Then commit configuration and docs.

### Task 8: Real iPhone End-to-End Acceptance

**Files:**
- Modify: `Resources/Document/UDID_ONBOARDING_OPERATIONS.md` with verified results only
- Modify: existing Obsidian Asspp note after verification

**Step 1: Open the production page on an iPhone**

Enter the configured answer, confirm the answer never appears in source/network URLs, and download the profile in Safari.

**Step 2: Install the temporary profile**

Confirm the profile requests only the documented device attributes and contains no MDM/root certificate/VPN payload.

**Step 3: Observe state transitions**

Verify `device_received -> building -> ready` from protected Worker state and the public status page. Confirm the GitHub run input contains only the request ID.

**Step 4: Verify Apple and IPA state**

Download the resulting IPA, decode `Payload/Asspp.app/embedded.mobileprovision`, and assert the collected UDID appears once. Run `codesign --verify --deep --strict`.

**Step 5: Install and launch Asspp**

Tap the production OTA action, confirm installation succeeds, launch the app, then remove the temporary registration profile and confirm Asspp still launches.

**Step 6: Final verification and commit**

Run Worker tests, Node tests, workflow checks, live `curl` smoke tests, and inspect GitHub Actions conclusion. Record exact URLs/run ID/profile expiry without recording the UDID. Commit verified operations updates and push `main`.

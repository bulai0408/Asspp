# Asspp Self-Service UDID Onboarding Design

## Goal

Provide a password-gated, iPhone-only onboarding flow that collects a device UDID through Apple's OTA Profile Service protocol, registers the device in the Apple Developer team, rebuilds the Ad Hoc IPA, and presents the OTA install action without exposing the UDID in public GitHub inputs or logs.

## User Experience

1. The user opens the Asspp registration page in Safari.
2. The page asks: `作者的微信号 ID 是多少？`
3. A correct server-side answer unlocks one onboarding request for 30 minutes.
4. Safari downloads a removable Asspp registration profile.
5. The device installs the profile and posts an Apple CMS-signed response containing `UDID`, `PRODUCT`, and `VERSION` plus the one-time challenge.
6. The page shows a waiting state while GitHub Actions registers the device and signs the app.
7. When the build succeeds, the page shows the Asspp OTA install action.
8. The page asks the user to remove the temporary registration profile after the app is installed.

The first onboarding is expected to take approximately six minutes with the current build pipeline. A previously registered device can use the latest OTA page without consuming another device slot.

## Architecture

### Cloudflare Worker

Create `Services/UDIDOnboarding/` as a standalone TypeScript Worker with static HTML rendered by the Worker.

Responsibilities:

- Render the password gate, profile-install instructions, build status, and final install action.
- Validate the shared answer exclusively on the server using an encrypted Worker secret.
- Apply an IP-based rate limit to answer attempts.
- Create a cryptographically random, single-use challenge with a 30-minute expiry.
- Emit an Apple `Profile Service` `.mobileconfig` requesting only `UDID`, `PRODUCT`, and `VERSION`.
- Accept the device CMS callback and store its raw bytes for a short period.
- Trigger GitHub Actions using only the random request ID.
- Provide authenticated internal endpoints for the GitHub runner to claim the CMS payload and update status.
- Delete raw CMS and UDID-bearing material after completion or expiry.

Use Cloudflare D1 for request state. Use the Workers Rate Limiting binding for password attempts. Store the gate answer, challenge HMAC key, GitHub token, and internal callback token as encrypted Worker secrets. Derive the raw challenge from the random request ID with HMAC so D1 retains only its hash.

### GitHub Actions and Apple Provisioning

Extend `.github/workflows/upstream-signed-ios.yml` with an optional `onboarding_request_id` input.

When that input is present, the macOS build job will:

1. Fetch the raw CMS response from the Worker using an internal bearer token.
2. Verify and decode the CMS response with platform security tools.
3. Confirm the signed challenge matches the claimed request.
4. Mask the UDID before any further shell output.
5. Register the device through the App Store Connect API when it is new.
6. Create and download a fresh Ad Hoc profile containing all enabled iOS-family devices for the Asspp bundle ID and active distribution certificate.
7. Use that profile for the existing archive/export pipeline.
8. Publish the release and GitHub Pages artifacts as today.
9. Report `ready` or `failed` to the Worker.

Scheduled and manually triggered builds will also generate a fresh profile from App Store Connect API credentials when configured, ensuring later upstream updates retain every registered device. The existing `IOS_PROVISIONING_PROFILE_BASE64` secret remains as a fallback.

Apple API credentials remain in GitHub Actions secrets. The Worker receives no Apple private key. GitHub receives only a random request ID in the public workflow event.

## Data Model

The D1 `onboarding_requests` table contains:

- `id`: random public request identifier
- `challenge_hash`: hash of the one-time profile challenge
- `state`: `unlocked`, `profile_issued`, `device_received`, `building`, `ready`, `failed`, or `expired`
- `cms_payload`: encrypted or raw short-lived CMS bytes
- `product`: non-sensitive product identifier after verified processing
- `install_url`: final OTA page URL
- `error_code`: stable user-facing failure category
- `created_at`, `expires_at`, `updated_at`

The Worker deletes `cms_payload` after the GitHub runner claims it. Completed rows retain only request state, timestamps, and the install URL for a short retention window.

## Security

- The shared answer never appears in repository files, generated HTML, URLs, or logs.
- Password comparison is constant-time after normalization.
- Failed answers are rate-limited by Cloudflare before D1 work.
- Challenges are random, single-use, short-lived, and bound to one request.
- The CMS-signed challenge and device attributes are verified on macOS before Apple registration.
- Internal Worker endpoints require a separate bearer secret.
- UDIDs are masked in GitHub Actions immediately after extraction.
- The generated profile contains no MDM, root certificate, VPN, or device-management payload.
- Public responses use stable error codes and omit provider details.

The shared password is a lightweight gate. It can be forwarded by an authorized user, so rate limiting and quota monitoring remain required.

## Failure Handling

- Invalid answer: keep the gate locked and return a generic message.
- Rate limit: return a retry time without revealing whether an answer was close.
- Expired or reused challenge: require a new unlock.
- Invalid CMS or challenge mismatch: mark the request failed and skip Apple registration.
- Existing device: reuse the device and continue without consuming another slot.
- Apple device quota or API error: show a stable support message and preserve diagnostics only in protected logs.
- Build failure: show retry/support state and retain the request long enough for an operator retry.
- Duplicate concurrent requests: serialize profile generation through the existing workflow concurrency group.

## Testing and Acceptance

Automated tests cover answer normalization, constant-time verification, rate limiting, challenge expiry/reuse, mobileconfig structure, internal endpoint authorization, callback state transitions, and public response redaction.

Deployment acceptance requires:

1. Worker unit and local integration tests pass.
2. Wrangler dry-run, type generation, and startup checks pass.
3. GitHub workflow syntax and Apple provisioning script tests pass.
4. A real iPhone completes the Safari profile flow.
5. The CMS callback is verified and the same UDID is registered in Apple Developer.
6. The resulting IPA embeds a provisioning profile containing that UDID.
7. OTA installation succeeds from the final page.
8. The temporary registration profile can be removed without affecting Asspp.

## References

- [Apple Over-the-Air Profile Delivery Concepts](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/iPhoneOTAConfiguration/OTASecurity/OTASecurity.html)
- [Apple Profile Server Reference](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/iPhoneOTAConfiguration/profile-service/profile-service.html)
- [App Store Connect API Devices](https://developer.apple.com/documentation/appstoreconnectapi/devices)
- [App Store Connect API Profiles](https://developer.apple.com/documentation/appstoreconnectapi/profiles)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

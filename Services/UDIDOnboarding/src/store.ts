export const REQUEST_TTL_SECONDS = 60 * 60;
export const REQUEST_RETENTION_SECONDS = 24 * 60 * 60;

export type OnboardingState =
  | "unlocked"
  | "device_received"
  | "building"
  | "ready"
  | "failed"
  | "expired";

export interface OnboardingRequest {
  id: string;
  challenge_hash: string;
  state: OnboardingState;
  cms_payload: ArrayBuffer | Uint8Array | null;
  product: string | null;
  version: string | null;
  install_url: string | null;
  error_code: string | null;
  github_run_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  cms_claimed_at: number | null;
  completed_at: number | null;
}

export async function createRequest(
  db: D1Database,
  id: string,
  challengeHash: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO onboarding_requests
        (id, challenge_hash, state, created_at, updated_at, expires_at)
       VALUES (?, ?, 'unlocked', ?, ?, ?)`,
    )
    .bind(id, challengeHash, now, now, now + REQUEST_TTL_SECONDS)
    .run();
}

export async function getRequest(db: D1Database, id: string): Promise<OnboardingRequest | null> {
  return db.prepare("SELECT * FROM onboarding_requests WHERE id = ?").bind(id).first<OnboardingRequest>();
}

export function isExpired(request: OnboardingRequest, now = Math.floor(Date.now() / 1000)): boolean {
  return request.expires_at <= now || request.state === "expired";
}

export async function storeCmsPayload(
  db: D1Database,
  id: string,
  cmsPayload: Uint8Array,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE onboarding_requests
       SET state = 'device_received', cms_payload = ?, updated_at = ?
       WHERE id = ? AND state = 'unlocked' AND cms_payload IS NULL AND expires_at > ?`,
    )
    .bind(cmsPayload, now, id, now)
    .run();
  return result.meta.changes === 1;
}

export async function claimCmsPayload(
  db: D1Database,
  id: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ request: OnboardingRequest; cms: Uint8Array } | null> {
  const request = await getRequest(db, id);
  if (!request || request.state !== "device_received" || !request.cms_payload || isExpired(request, now)) {
    return null;
  }

  const result = await db
    .prepare(
      `UPDATE onboarding_requests
       SET cms_payload = NULL, cms_claimed_at = ?, state = 'building', updated_at = ?
       WHERE id = ? AND state = 'device_received' AND cms_payload IS NOT NULL`,
    )
    .bind(now, now, id)
    .run();
  if (result.meta.changes !== 1) {
    return null;
  }

  const raw = request.cms_payload;
  return {
    request,
    cms: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
  };
}

export async function updateRequestStatus(
  db: D1Database,
  id: string,
  state: "building" | "ready" | "failed",
  values: { installUrl?: string; errorCode?: string; githubRunId?: string },
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const allowedFrom = state === "building"
    ? ["device_received", "building"]
    : state === "failed"
      ? ["device_received", "building", "failed"]
      : ["building", "ready"];
  const placeholders = allowedFrom.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `UPDATE onboarding_requests
       SET state = ?, install_url = ?, error_code = ?, github_run_id = ?, updated_at = ?,
           completed_at = CASE WHEN ? IN ('ready', 'failed') THEN ? ELSE completed_at END,
           cms_payload = CASE WHEN ? IN ('ready', 'failed') THEN NULL ELSE cms_payload END
       WHERE id = ? AND state IN (${placeholders})`,
    )
    .bind(
      state,
      values.installUrl ?? null,
      values.errorCode ?? null,
      values.githubRunId ?? null,
      now,
      state,
      now,
      state,
      id,
      ...allowedFrom,
    )
    .run();
  return result.meta.changes === 1;
}

export async function purgeExpiredRequests(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE onboarding_requests
         SET state = CASE
               WHEN state IN ('unlocked', 'device_received', 'building') THEN 'expired'
               ELSE state
             END,
             cms_payload = NULL,
             updated_at = ?
         WHERE expires_at <= ?
           AND (cms_payload IS NOT NULL OR state IN ('unlocked', 'device_received', 'building'))`,
      )
      .bind(now, now),
    db
      .prepare("DELETE FROM onboarding_requests WHERE expires_at <= ?")
      .bind(now - REQUEST_RETENTION_SECONDS),
  ]);
}

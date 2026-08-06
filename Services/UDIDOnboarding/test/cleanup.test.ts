import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  REQUEST_RETENTION_SECONDS,
  REQUEST_TTL_SECONDS,
  createRequest,
  getRequest,
  purgeExpiredRequests,
  storeCmsPayload,
} from "../src/store";

const db = (env as unknown as { DB: D1Database }).DB;

describe("expired request cleanup", () => {
  it("expires requests and clears an unclaimed CMS payload", async () => {
    const createdAt = 1_800_000_000;
    await createRequest(db, "cleanup-pending", "challenge-hash", createdAt);
    expect(await storeCmsPayload(db, "cleanup-pending", new Uint8Array([1, 2, 3]), createdAt + 1)).toBe(true);

    await purgeExpiredRequests(db, createdAt + REQUEST_TTL_SECONDS + 1);

    const request = await getRequest(db, "cleanup-pending");
    expect(request?.state).toBe("expired");
    expect(request?.cms_payload).toBeNull();
  });

  it("deletes request metadata after the retention window", async () => {
    const createdAt = 1_800_100_000;
    await createRequest(db, "cleanup-delete", "challenge-hash", createdAt);

    await purgeExpiredRequests(
      db,
      createdAt + REQUEST_TTL_SECONDS + REQUEST_RETENTION_SECONDS + 1,
    );

    expect(await getRequest(db, "cleanup-delete")).toBeNull();
  });
});

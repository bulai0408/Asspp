import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createUnlockedRequest } from "./helpers";

const internalHeaders = {
  authorization: "Bearer test-internal-token",
};

async function submitCms(id: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/profile-callback/${id}`, {
    method: "POST",
    headers: { "content-type": "application/x-apple-aspen-config" },
    body: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
  });
  expect(response.status).toBe(200);
}

describe("private onboarding API", () => {
  it("requires a bearer token to claim CMS data", async () => {
    const id = await createUnlockedRequest();
    await submitCms(id);

    const response = await SELF.fetch(`https://example.com/internal/requests/${id}/claim`, {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("claims CMS data exactly once", async () => {
    const id = await createUnlockedRequest();
    await submitCms(id);
    const claim = () => SELF.fetch(`https://example.com/internal/requests/${id}/claim`, {
      method: "POST",
      headers: internalHeaders,
    });

    const first = await claim();
    const payload = await first.json() as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(payload.request_id).toBe(id);
    expect(payload.cms_base64).toBe("MAMCAQA=");
    expect(payload.challenge_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await claim()).status).toBe(409);
  });

  it("accepts authenticated terminal status and keeps public output redacted", async () => {
    const id = await createUnlockedRequest();
    await submitCms(id);
    await SELF.fetch(`https://example.com/internal/requests/${id}/claim`, {
      method: "POST",
      headers: internalHeaders,
    });

    const update = await SELF.fetch(`https://example.com/internal/requests/${id}/status`, {
      method: "POST",
      headers: { ...internalHeaders, "content-type": "application/json" },
      body: JSON.stringify({ state: "ready" }),
    });
    expect(update.status).toBe(204);

    const publicResponse = await SELF.fetch(`https://example.com/api/requests/${id}`);
    const publicStatus = await publicResponse.json() as Record<string, unknown>;
    expect(publicStatus).toEqual({
      state: "ready",
      install_url: "itms-services://?action=download-manifest&url=https://example.com/ios/latest/manifest.plist",
      error_code: null,
    });
    expect(JSON.stringify(publicStatus)).not.toMatch(/challenge|cms|udid/i);

    const page = await SELF.fetch(`https://example.com/requests/${id}`);
    const html = await page.text();
    expect(html).toContain("安装 Asspp");
    expect(html).toContain("移除临时的“Asspp 设备登记”描述文件");
  });

  it("rejects unauthenticated status updates", async () => {
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/internal/requests/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "failed", error_code: "TEST" }),
    });
    expect(response.status).toBe(401);
  });
});

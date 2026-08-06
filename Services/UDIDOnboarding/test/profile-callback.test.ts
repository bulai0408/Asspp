import plist from "plist";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createUnlockedRequest } from "./helpers";
import { server } from "./server";

describe("Profile Service callback", () => {
  it("accepts a bounded CMS payload once and returns a removable Web Clip profile", async () => {
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "application/x-apple-aspen-config" },
      body: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
    });
    const profile = plist.parse(new TextDecoder().decode(await response.arrayBuffer())) as Record<string, unknown>;
    const payloads = profile.PayloadContent as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-apple-aspen-config");
    expect(profile.PayloadType).toBe("Configuration");
    expect(profile.PayloadRemovalDisallowed).toBe(false);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].PayloadType).toBe("com.apple.webClip.managed");
    expect(payloads[0].URL).toBe(`https://example.com/requests/${id}`);
  });

  it("rejects callback replays", async () => {
    const id = await createUnlockedRequest();
    const callback = () => SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "application/x-apple-aspen-config" },
      body: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
    });

    expect((await callback()).status).toBe(200);
    expect((await callback()).status).toBe(409);
  });

  it("rejects malformed content types", async () => {
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-cms",
    });

    expect(response.status).toBe(415);
  });

  it("rejects payloads larger than 256 KiB", async () => {
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "application/x-apple-aspen-config" },
      body: new Uint8Array(256 * 1024 + 1),
    });

    expect(response.status).toBe(413);
  });

  it("fails closed and deletes CMS data when GitHub dispatch fails", async () => {
    server.use(
      http.post(
        "https://api.github.com/repos/bulai0408/Asspp/actions/workflows/upstream-signed-ios.yml/dispatches",
        () => HttpResponse.json({ error: "provider detail" }, { status: 503 }),
        { once: true },
      ),
    );
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "application/x-apple-aspen-config" },
      body: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
    });
    expect(response.status).toBe(200);

    const status = await (await SELF.fetch(`https://example.com/api/requests/${id}`)).json() as Record<string, unknown>;
    expect(status).toEqual({ state: "failed", install_url: null, error_code: "DISPATCH_FAILED" });

    const bindings = env as unknown as { DB: D1Database };
    const row = await bindings.DB
      .prepare("SELECT cms_payload FROM onboarding_requests WHERE id = ?")
      .bind(id)
      .first<{ cms_payload: ArrayBuffer | null }>();
    expect(row?.cms_payload).toBeNull();
  });
});

import plist from "plist";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createUnlockedRequest } from "./helpers";

describe("Apple Profile Service profile", () => {
  it("contains only the approved device attributes", async () => {
    const id = await createUnlockedRequest();
    const response = await SELF.fetch(`https://example.com/requests/${id}/profile.mobileconfig`);
    const profile = plist.parse(new TextDecoder().decode(await response.arrayBuffer())) as Record<string, unknown>;
    const content = profile.PayloadContent as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-apple-aspen-config");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(profile.PayloadType).toBe("Profile Service");
    expect(content.URL).toBe(`https://example.com/profile-callback/${id}`);
    expect(content.DeviceAttributes).toEqual(["UDID", "PRODUCT", "VERSION"]);
    expect(content.Challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a profile after the request has been consumed", async () => {
    const id = await createUnlockedRequest();
    await SELF.fetch(`https://example.com/profile-callback/${id}`, {
      method: "POST",
      headers: { "content-type": "application/x-apple-aspen-config" },
      body: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
    });

    const response = await SELF.fetch(`https://example.com/requests/${id}/profile.mobileconfig`);
    expect(response.status).toBe(409);
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("password gate", () => {
  it("renders the question without rendering the configured answer", async () => {
    const response = await SELF.fetch("https://example.com/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("作者的微信号 ID 是多少？");
    expect(html).not.toContain("test-answer");
  });

  it("rejects a wrong answer with a generic error", async () => {
    const response = await SELF.fetch("https://example.com/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "answer=wrong-answer",
      redirect: "manual",
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain("答案不正确");
    expect(body).not.toContain("test-answer");
  });

  it("normalizes whitespace and case for a correct answer", async () => {
    const response = await SELF.fetch("https://example.com/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "answer=%20TeSt-AnSwEr%20",
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toMatch(/^\/requests\/[A-Za-z0-9_-]{22}$/);
  });

  it("creates identifiers with at least 128 bits of entropy", async () => {
    const locations = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const response = await SELF.fetch("https://example.com/unlock", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "answer=test-answer",
          redirect: "manual",
        });
        return response.headers.get("location");
      }),
    );

    const ids = locations.map((location) => location?.split("/").pop());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id && id.length >= 22)).toBe(true);
  });
});

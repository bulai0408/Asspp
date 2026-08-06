import { describe, expect, it } from "vitest";
import { dispatchGithubWorkflow } from "../src/github";

describe("GitHub workflow dispatch", () => {
  it("sends only the opaque onboarding request identifier", async () => {
    const calls: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return new Response(null, { status: 204 });
    };

    await dispatchGithubWorkflow(
      {
        GITHUB_TOKEN: "secret-token",
        GITHUB_REPOSITORY: "bulai0408/Asspp",
        GITHUB_WORKFLOW: "upstream-signed-ios.yml",
        GITHUB_REF: "main",
      },
      "opaque-request-id",
      fetcher,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/bulai0408/Asspp/actions/workflows/upstream-signed-ios.yml/dispatches");
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret-token");
    const payload = await calls[0].json() as Record<string, unknown>;
    expect(payload).toEqual({
      ref: "main",
      inputs: { onboarding_request_id: "opaque-request-id" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/udid|cms/i);
  });

  it("redacts provider response bodies from errors", async () => {
    const fetcher: typeof fetch = async () => new Response(
      JSON.stringify({ token: "leaked-token", device: "private-device" }),
      { status: 403 },
    );

    await expect(dispatchGithubWorkflow(
      {
        GITHUB_TOKEN: "secret-token",
        GITHUB_REPOSITORY: "bulai0408/Asspp",
        GITHUB_WORKFLOW: "upstream-signed-ios.yml",
        GITHUB_REF: "main",
      },
      "opaque-request-id",
      fetcher,
    )).rejects.toThrow("GitHub workflow dispatch failed (403)");
  });
});

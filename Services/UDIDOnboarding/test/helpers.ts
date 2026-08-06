import { SELF } from "cloudflare:test";

export async function createUnlockedRequest(): Promise<string> {
  const response = await SELF.fetch("https://example.com/unlock", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "answer=test-answer",
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Unlock failed with ${response.status}`);
  }
  return location.split("/").pop()!;
}

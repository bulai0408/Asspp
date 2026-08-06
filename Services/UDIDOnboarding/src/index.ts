import type { Env } from "./env";
import { bytesToBase64, constantTimeEqual, hmacBase64Url, randomToken, sha256Hex, verifyAnswer } from "./crypto";
import { dispatchGithubWorkflow } from "./github";
import { buildProfileServiceProfile, buildWebClipProfile, mobileconfigHeaders } from "./mobileconfig";
import { gatePage, requestPage } from "./pages";
import {
  claimCmsPayload,
  createRequest,
  getRequest,
  isExpired,
  purgeExpiredRequests,
  storeCmsPayload,
  updateRequestStatus,
} from "./store";

const MAX_CMS_BYTES = 256 * 1024;

const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(gatePage(), { headers: htmlHeaders });
    }

    if (request.method === "POST" && url.pathname === "/unlock") {
      return unlock(request, env);
    }

    const profileMatch = url.pathname.match(/^\/requests\/([A-Za-z0-9_-]{22})\/profile\.mobileconfig$/);
    if (request.method === "GET" && profileMatch) {
      return profileService(request, env, profileMatch[1]);
    }

    const callbackMatch = url.pathname.match(/^\/profile-callback\/([A-Za-z0-9_-]{22})$/);
    if (request.method === "POST" && callbackMatch) {
      return profileCallback(request, env, ctx, callbackMatch[1]);
    }

    const publicStatusMatch = url.pathname.match(/^\/api\/requests\/([A-Za-z0-9_-]{22})$/);
    if (request.method === "GET" && publicStatusMatch) {
      return publicStatus(env, publicStatusMatch[1]);
    }

    const internalMatch = url.pathname.match(/^\/internal\/requests\/([A-Za-z0-9_-]{22})\/(claim|status)$/);
    if (request.method === "POST" && internalMatch) {
      if (!isInternalRequestAuthorized(request, env.INTERNAL_API_TOKEN)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
        });
      }
      if (internalMatch[2] === "claim") {
        return claimCms(env, internalMatch[1]);
      }
      return setInternalStatus(request, env, internalMatch[1]);
    }

    const requestMatch = url.pathname.match(/^\/requests\/([A-Za-z0-9_-]{22})$/);
    if (request.method === "GET" && requestMatch) {
      const onboardingRequest = await getRequest(env.DB, requestMatch[1]);
      if (!onboardingRequest) {
        return new Response("Not found", { status: 404 });
      }
      if (isExpired(onboardingRequest)) {
        onboardingRequest.state = "expired";
      }
      return new Response(requestPage(onboardingRequest), { headers: htmlHeaders });
    }

    return new Response("Not found", { status: 404 });
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(purgeExpiredRequests(env.DB));
  },
} satisfies ExportedHandler<Env>;

async function unlock(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return new Response("Unsupported media type", { status: 415 });
  }

  const actor = `${request.headers.get("cf-connecting-ip") ?? "unknown"}:${request.headers.get("user-agent") ?? "unknown"}`;
  const rateLimit = await env.ANSWER_RATE_LIMITER.limit({ key: actor });
  if (!rateLimit.success) {
    return new Response(gatePage("尝试次数过多，请稍后再试。"), { status: 429, headers: htmlHeaders });
  }

  const form = await request.formData();
  const answer = form.get("answer");
  if (typeof answer !== "string" || !env.GATE_ANSWER || !(await verifyAnswer(answer, env.GATE_ANSWER))) {
    return new Response(gatePage("答案不正确。"), { status: 401, headers: htmlHeaders });
  }

  const id = randomToken(16);
  const challenge = await hmacBase64Url(env.CHALLENGE_KEY, `asspp-udid:${id}`);
  await createRequest(env.DB, id, await sha256Hex(challenge));
  return new Response(null, {
    status: 303,
    headers: {
      location: `/requests/${id}`,
      "cache-control": "no-store",
    },
  });
}

async function profileService(request: Request, env: Env, id: string): Promise<Response> {
  const onboardingRequest = await getRequest(env.DB, id);
  if (!onboardingRequest) {
    return new Response("Not found", { status: 404 });
  }
  if (onboardingRequest.state !== "unlocked" || isExpired(onboardingRequest)) {
    return new Response("Request unavailable", { status: 409 });
  }

  const challenge = await hmacBase64Url(env.CHALLENGE_KEY, `asspp-udid:${id}`);
  if (!constantTimeEqual(await sha256Hex(challenge), onboardingRequest.challenge_hash)) {
    return new Response("Request unavailable", { status: 409 });
  }

  const callbackUrl = new URL(`/profile-callback/${id}`, request.url).toString();
  return new Response(
    buildProfileServiceProfile({ requestId: id, callbackUrl, challenge }),
    { headers: mobileconfigHeaders },
  );
}

async function profileCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-apple-aspen-config" && contentType !== "application/octet-stream") {
    return new Response("Unsupported media type", { status: 415 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CMS_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  const cmsPayload = new Uint8Array(await request.arrayBuffer());
  if (cmsPayload.byteLength === 0) {
    return new Response("Invalid payload", { status: 400 });
  }
  if (cmsPayload.byteLength > MAX_CMS_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  if (!(await storeCmsPayload(env.DB, id, cmsPayload))) {
    return new Response("Request unavailable", { status: 409 });
  }

  ctx.waitUntil(
    dispatchGithubWorkflow(env, id).catch(async () => {
      await updateRequestStatus(env.DB, id, "failed", { errorCode: "DISPATCH_FAILED" });
    }),
  );

  const statusUrl = new URL(`/requests/${id}`, request.url).toString();
  return new Response(buildWebClipProfile({ requestId: id, statusUrl }), {
    headers: mobileconfigHeaders,
  });
}

async function publicStatus(env: Env, id: string): Promise<Response> {
  const onboardingRequest = await getRequest(env.DB, id);
  if (!onboardingRequest) {
    return new Response("Not found", { status: 404 });
  }
  const state = isExpired(onboardingRequest) ? "expired" : onboardingRequest.state;
  return Response.json(
    {
      state,
      install_url: state === "ready" ? onboardingRequest.install_url : null,
      error_code: state === "failed" ? onboardingRequest.error_code : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function claimCms(env: Env, id: string): Promise<Response> {
  const claimed = await claimCmsPayload(env.DB, id);
  if (!claimed) {
    return new Response("Request unavailable", { status: 409 });
  }
  return Response.json(
    {
      request_id: id,
      cms_base64: bytesToBase64(claimed.cms),
      challenge_hash: claimed.request.challenge_hash,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function setInternalStatus(request: Request, env: Env, id: string): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported media type", { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return new Response("Invalid request", { status: 400 });
  }

  const values = body as Record<string, unknown>;
  const state = values.state;
  if (state !== "building" && state !== "ready" && state !== "failed") {
    return new Response("Invalid request", { status: 400 });
  }

  const installUrl = validateInstallUrl(values.install_url) ?? (state === "ready" ? env.OTA_INSTALL_URL : undefined);
  if (values.install_url !== undefined && !installUrl) {
    return new Response("Invalid request", { status: 400 });
  }
  const errorCode = typeof values.error_code === "string" && /^[A-Z0-9_]{1,64}$/.test(values.error_code)
    ? values.error_code
    : undefined;
  if (values.error_code !== undefined && !errorCode) {
    return new Response("Invalid request", { status: 400 });
  }
  const githubRunId = typeof values.github_run_id === "string" && /^\d{1,32}$/.test(values.github_run_id)
    ? values.github_run_id
    : undefined;
  if (values.github_run_id !== undefined && !githubRunId) {
    return new Response("Invalid request", { status: 400 });
  }

  const updated = await updateRequestStatus(env.DB, id, state, { installUrl, errorCode, githubRunId });
  return updated ? new Response(null, { status: 204 }) : new Response("Request unavailable", { status: 409 });
}

function validateInstallUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "itms-services:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isInternalRequestAuthorized(request: Request, configuredToken: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix) || !configuredToken) {
    return false;
  }
  return constantTimeEqual(authorization.slice(prefix.length), configuredToken);
}

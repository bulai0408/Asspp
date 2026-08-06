export interface GithubDispatchEnv {
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
}

export async function dispatchGithubWorkflow(
  env: GithubDispatchEnv,
  requestId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const repository = env.GITHUB_REPOSITORY.split("/");
  if (repository.length !== 2 || repository.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("GitHub workflow dispatch configuration is invalid");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(env.GITHUB_WORKFLOW) || !env.GITHUB_TOKEN || !env.GITHUB_REF) {
    throw new Error("GitHub workflow dispatch configuration is invalid");
  }

  const endpoint = `https://api.github.com/repos/${repository.map(encodeURIComponent).join("/")}/actions/workflows/${encodeURIComponent(env.GITHUB_WORKFLOW)}/dispatches`;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "asspp-udid-onboarding",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF,
      inputs: { onboarding_request_id: requestId },
    }),
  });

  if (response.status !== 204) {
    throw new Error(`GitHub workflow dispatch failed (${response.status})`);
  }
}

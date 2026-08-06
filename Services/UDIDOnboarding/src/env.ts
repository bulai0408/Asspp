export interface Env {
  DB: D1Database;
  ANSWER_RATE_LIMITER: RateLimit;
  GATE_ANSWER: string;
  CHALLENGE_KEY: string;
  GITHUB_TOKEN: string;
  INTERNAL_API_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  OTA_INSTALL_URL: string;
}

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

export interface GitHubUserProps {
  login: string;
  name: string;
  email: string;
  accessToken: string;
  [key: string]: unknown;
}

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const REQUIRED_SCOPES = ["repo", "read:user", "user:email"];

export const githubHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  if (!oauthReqInfo.clientId) {
    return new Response("Missing client_id", { status: 400 });
  }

  const stateToken = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `gh_state:${stateToken}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 }
  );

  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set(
    "redirect_uri",
    `${new URL(request.url).origin}/callback`
  );
  githubUrl.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
  githubUrl.searchParams.set("state", stateToken);

  return Response.redirect(githubUrl.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const oauthReqInfoRaw = await env.OAUTH_KV.get(`gh_state:${state}`);
  if (!oauthReqInfoRaw) {
    return new Response("Invalid or expired state", { status: 400 });
  }
  await env.OAUTH_KV.delete(`gh_state:${state}`);
  const oauthReqInfo = JSON.parse(oauthReqInfoRaw);

  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });

  if (!tokenRes.ok) {
    return new Response("GitHub token exchange failed", { status: 500 });
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return new Response(
      `GitHub error: ${tokenData.error ?? "unknown"}`,
      { status: 500 }
    );
  }

  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "github-mcp-worker",
      Accept: "application/vnd.github+json",
    },
  });

  if (!userRes.ok) {
    return new Response("Failed to fetch GitHub user", { status: 500 });
  }

  const user = (await userRes.json()) as {
    login: string;
    name: string | null;
    email: string | null;
  };

  const props: GitHubUserProps = {
    login: user.login,
    name: user.name ?? user.login,
    email: user.email ?? "",
    accessToken: tokenData.access_token,
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.login,
    metadata: { label: user.name ?? user.login },
    scope: oauthReqInfo.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
}

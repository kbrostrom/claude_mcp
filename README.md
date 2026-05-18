# github-mcp

A thin GitHub OAuth wrapper exposed as an MCP server on Cloudflare Workers. Lets Claude commit files, open PRs, and read repos from any device.

## What it does

- Acts as an OAuth 2.1 provider for claude.ai (handled by `@cloudflare/workers-oauth-provider`)
- Delegates user authentication to GitHub via standard GitHub OAuth
- Exposes six MCP tools: `list_repos`, `read_file`, `create_branch`, `commit_files`, `open_pr`, `get_pr_status`

## One-time setup

### 1. Register a GitHub OAuth App

Go to https://github.com/settings/developers > OAuth Apps > New OAuth App.

- Application name: `Claude MCP` (or whatever)
- Homepage URL: `https://github-mcp.<your-subdomain>.workers.dev` (you can update later)
- Authorization callback URL: `https://github-mcp.<your-subdomain>.workers.dev/callback`

Save, copy the Client ID, generate a Client Secret, copy that too.

### 2. Install and configure Wrangler

```sh
npm install
npx wrangler login
```

### 3. Create the KV namespace

```sh
npx wrangler kv:namespace create OAUTH_KV
```

Copy the returned ID into `wrangler.jsonc` (replace `REPLACE_WITH_KV_NAMESPACE_ID`).

### 4. Set secrets

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY  # paste output of: openssl rand -hex 32
```

### 5. Deploy

```sh
npm run deploy
```

Note the deployed URL. Update the GitHub OAuth App's Homepage URL and callback URL to match if they were placeholders.

### 6. Add as a custom connector in claude.ai

Settings > Connectors > Add custom connector.

- URL: `https://github-mcp.<your-subdomain>.workers.dev/mcp`
- Leave Advanced settings blank — DCR handles registration automatically.

Save, click Connect, sign in to GitHub, authorize. You're done.

## Local development

```sh
cp .dev.vars.template .dev.vars
# Fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY
# Use a separate GitHub OAuth App for local with callback http://localhost:8788/callback
npm run dev
```

Test with the MCP Inspector: `npx @modelcontextprotocol/inspector`, point at `http://localhost:8788/mcp`.

## Architecture

```
claude.ai  <-- OAuth 2.1 --> Worker (this) <-- OAuth + REST --> GitHub
                                |
                                v
                            Workers KV
                       (MCP token -> GH token)
```

The worker is both an OAuth provider (to claude.ai) and an OAuth client (to GitHub). `workers-oauth-provider` handles the provider side; `github-handler.ts` handles the client side. After the user authorizes, the worker stores the GitHub access token encrypted in KV and issues its own opaque MCP token to claude.ai.

When Claude calls a tool, the worker looks up the GitHub token from the MCP token, instantiates Octokit, and calls the GitHub API.

## Adding more tools

Drop new `this.server.tool(...)` calls into `init()` in `mcp-agent.ts`. The `this.props.accessToken` is automatically available — `workers-oauth-provider` injects it from the props you stored at authorization time.

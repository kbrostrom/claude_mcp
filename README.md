# github-mcp

A thin GitHub OAuth wrapper exposed as an MCP server on Cloudflare Workers. Lets Claude commit files, open PRs, and read repos from any device.

## What it does

- Acts as an OAuth 2.1 provider for claude.ai (handled by `@cloudflare/workers-oauth-provider`)
- Delegates user authentication to GitHub via standard GitHub OAuth
- Exposes nine MCP tools: `list_repos`, `read_file`, `create_branch`, `commit_files`, `open_pr`, `get_pr_status`, plus `get_upload_url` / `commit_from_blob` / `list_my_blobs` for large-file pushes

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

### 4. Create the R2 bucket (for large-file uploads)

```sh
npx wrangler r2 bucket create claude-mcp-uploads
```

Then in the Cloudflare dashboard go to R2 > Manage R2 API Tokens > Create API token, scope it to **Object Read & Write** on the `claude-mcp-uploads` bucket only, and copy the Access Key ID and Secret Access Key.

You also need your Cloudflare account ID — visible in any zone's overview page in the dashboard, or via `npx wrangler whoami`.

### 5. Set secrets

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY  # paste output of: openssl rand -hex 32
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

### 6. Deploy

```sh
npm run deploy
```

Note the deployed URL. Update the GitHub OAuth App's Homepage URL and callback URL to match if they were placeholders.

### 7. Add as a custom connector in claude.ai

Settings > Connectors > Add custom connector.

- URL: `https://github-mcp.<your-subdomain>.workers.dev/mcp`
- Leave Advanced settings blank — DCR handles registration automatically.

Save, click Connect, sign in to GitHub, authorize. You're done.

## Local development

```sh
cp .dev.vars.template .dev.vars
# Fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY,
# R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
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

Large-file path:
  Claude bash --PUT--> R2 <--read-- Worker --PUT--> GitHub
```

The worker is both an OAuth provider (to claude.ai) and an OAuth client (to GitHub). `workers-oauth-provider` handles the provider side; `github-handler.ts` handles the client side. After the user authorizes, the worker stores the GitHub access token encrypted in KV and issues its own opaque MCP token to claude.ai.

When Claude calls a tool, the worker looks up the GitHub token from the MCP token, instantiates Octokit, and calls the GitHub API.

## Large-file uploads

The `commit_files` tool passes file content through Claude's tool-call arguments, which means the bytes are generated as tokens. For large files this is slow, expensive, and occasionally unreliable — long content can get truncated during generation.

For files larger than ~50KB (or really any file you want pushed verbatim with no rewriting risk), use the three-tool flow:

```
1. Claude calls: get_upload_url(filename: "index.html")
   → { blob_id: "a3f2…-index-html", upload_url: "https://…r2…?X-Amz-Signature=…" }

2. Claude runs in bash:
   curl -X PUT --data-binary @/path/to/index.html "<upload_url>"

3. Claude calls: commit_from_blob(
     owner: "you", repo: "yourrepo", branch: "main",
     path: "index.html", blob_id: "a3f2…-index-html",
     message: "Update index.html"
   )
   → { commit_sha: "1fb3fb2…", commit_url: "https://github.com/…" }
```

The bytes never pass through Claude's token generation. The Worker pulls from R2 server-to-server and pushes to GitHub via the same Git Data API as `commit_files`.

Per-user scoping: blob keys are namespaced as `uploads/{github-login}/{blob_id}`, so each authenticated user only sees their own pending uploads via `list_my_blobs`. Presigned URLs use Worker-held R2 credentials, not the user's GitHub token.

Blobs are deleted automatically after a successful commit unless `delete_blob_after: false` is passed. Uncommitted blobs hang around indefinitely until the bucket's lifecycle rules age them out — see the next section.

### Recommended R2 lifecycle rule

In the Cloudflare dashboard, R2 > claude-mcp-uploads > Settings > Object lifecycle rules, add a rule:

- Prefix: `uploads/`
- Delete objects after: 7 days

This catches orphaned blobs from interrupted upload flows.

## Adding more tools

Drop new `this.server.tool(...)` calls into `init()` in `mcp-agent.ts`. The `this.props.accessToken` is automatically available — `workers-oauth-provider` injects it from the props you stored at authorization time. R2 is available as `this.env.UPLOADS`.

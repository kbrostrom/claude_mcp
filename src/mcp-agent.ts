import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "octokit";
import { z } from "zod";
import type { GitHubUserProps } from "./github-handler";
import { presignR2Url } from "./r2-presign";

interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  // R2 binding for direct reads/deletes from Worker code.
  UPLOADS: R2Bucket;
  // R2 S3-API credentials for generating presigned URLs that Claude can curl to from bash.
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

// Upload URLs are valid for this long. Enough that a slow phone upload won't time out,
// short enough that a leaked URL has limited blast radius.
const UPLOAD_URL_TTL_SECONDS = 3600;

// Cap blob lifetime. List/cleanup logic can use this to age out stale uploads
// that were never committed.
const BLOB_MAX_AGE_SECONDS = 24 * 3600;

export class GitHubMCP extends McpAgent<Env, unknown, GitHubUserProps> {
  server = new McpServer({
    name: "github-mcp",
    version: "0.5.0",
  });

  private get octokit() {
    return new Octokit({ auth: this.userProps.accessToken });
  }

  /**
   * Narrowed accessor for this.props. The McpAgent base class types props as
   * possibly-undefined; in our auth flow it's always set by the time init()
   * runs, so we assert that here once rather than every callsite.
   */
  private get userProps(): GitHubUserProps {
    return this.props as GitHubUserProps;
  }

  /**
   * Per-user blob key. Scoping by GitHub login keeps users from reading each
   * other's pending uploads even if a blob_id leaked.
   */
  private blobKey(blobId: string): string {
    return `uploads/${this.userProps.login}/${blobId}`;
  }

  async init() {
    this.server.tool(
      "list_repos",
      "List repositories accessible to the authenticated user. Returns name, full_name, default_branch, and visibility. Use page to paginate if you have more than 100 repos.",
      {
        per_page: z.number().int().min(1).max(100).default(100),
        page: z.number().int().min(1).default(1),
        sort: z
          .enum(["created", "updated", "pushed", "full_name"])
          .default("updated"),
      },
      async ({ per_page, page, sort }) => {
        const { data } =
          await this.octokit.rest.repos.listForAuthenticatedUser({
            per_page,
            page,
            sort,
          });
        const repos = data.map((r) => ({
          name: r.name,
          full_name: r.full_name,
          default_branch: r.default_branch,
          visibility: r.visibility,
          updated_at: r.updated_at,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(repos, null, 2) }],
        };
      }
    );

    this.server.tool(
      "read_file",
      "Read a file's contents from a repository at a given ref (branch, tag, or commit SHA).",
      {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      },
      async ({ owner, repo, path, ref }) => {
        const { data } = await this.octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        if (Array.isArray(data) || data.type !== "file") {
          return {
            content: [
              { type: "text", text: `Path is not a file: ${path}` },
            ],
            isError: true,
          };
        }
        // GitHub returns content as base64 with newlines every 60 chars.
        // atob() gives back a "binary string" where each char's code point is
        // a raw byte (0-255). For files with non-ASCII UTF-8 (em-dashes,
        // arrows, unicode quotes, anything outside 7-bit ASCII), this binary
        // string is NOT the original text — each UTF-8 byte becomes a separate
        // character. Round-tripping this through JSON-RPC/SSE has been
        // observed to cause the response stream to never reach the client,
        // even though the Worker logs show the tool returning successfully.
        //
        // Fix: decode the base64 as bytes, then run a proper UTF-8 decode
        // to produce a real JS string with one code point per Unicode char.
        const stripped = data.content.replace(/\n/g, "");
        const bytes = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
        const content = new TextDecoder("utf-8").decode(bytes);
        return {
          content: [{ type: "text", text: content }],
        };
      }
    );

    this.server.tool(
      "create_branch",
      "Create a new branch from an existing branch in a repository.",
      {
        owner: z.string(),
        repo: z.string(),
        name: z.string().describe("Name of the new branch"),
        from_branch: z.string().default("main"),
      },
      async ({ owner, repo, name, from_branch }) => {
        const { data: ref } = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${from_branch}`,
        });
        await this.octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${name}`,
          sha: ref.object.sha,
        });
        return {
          content: [
            {
              type: "text",
              text: `Created branch ${name} from ${from_branch} (sha ${ref.object.sha.slice(0, 7)})`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "commit_files",
      "Atomically commit one or more files to a branch. Creates a single commit containing all changes. NOTE: content here passes through Claude's token generation and can be truncated for large files. Prefer commit_from_blob (with the upload flow) for anything beyond trivially small content.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        message: z.string(),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          )
          .min(1)
          .max(50),
      },
      async ({ owner, repo, branch, message, files }) => {
        const { data: ref } = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
        });
        const parentSha = ref.object.sha;

        const { data: parentCommit } = await this.octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: parentSha,
        });
        const baseTreeSha = parentCommit.tree.sha;

        const blobs = await Promise.all(
          files.map(async (file) => {
            const encoded = btoa(unescape(encodeURIComponent(file.content)));
            const { data: blob } = await this.octokit.rest.git.createBlob({
              owner,
              repo,
              content: encoded,
              encoding: "base64",
            });
            return {
              path: file.path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: blob.sha,
            };
          })
        );

        const { data: newTree } = await this.octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: baseTreeSha,
          tree: blobs,
        });

        const { data: newCommit } = await this.octokit.rest.git.createCommit({
          owner,
          repo,
          message,
          tree: newTree.sha,
          parents: [parentSha],
        });

        await this.octokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: newCommit.sha,
        });

        return {
          content: [
            {
              type: "text",
              text: `Committed ${files.length} file(s) to ${branch} (sha ${newCommit.sha.slice(0, 7)})`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "open_pr",
      "Open a pull request from a head branch to a base branch.",
      {
        owner: z.string(),
        repo: z.string(),
        head: z.string().describe("Branch with changes"),
        base: z.string().default("main").describe("Branch to merge into"),
        title: z.string(),
        body: z.string().optional(),
        draft: z.boolean().default(false),
      },
      async ({ owner, repo, head, base, title, body, draft }) => {
        const { data: pr } = await this.octokit.rest.pulls.create({
          owner,
          repo,
          head,
          base,
          title,
          body,
          draft,
        });
        return {
          content: [
            {
              type: "text",
              text: `Opened PR #${pr.number}: ${pr.html_url}`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "get_pr_status",
      "Get the state, mergeability, and CI check status of a pull request.",
      {
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().int(),
      },
      async ({ owner, repo, pr_number }) => {
        const { data: pr } = await this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pr_number,
        });
        const { data: checks } = await this.octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: pr.head.sha,
        });
        const summary = {
          number: pr.number,
          state: pr.state,
          merged: pr.merged,
          mergeable: pr.mergeable,
          head: pr.head.ref,
          base: pr.base.ref,
          checks: checks.check_runs.map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
          })),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
        };
      }
    );

    this.server.tool(
      "list_issues",
      "List issues for a repository. Supports filtering by state, labels, and date. Use since to find issues created or updated after a specific date (ISO 8601). Returns issue number, title, body, state, labels, created_at, and updated_at.",
      {
        owner: z.string(),
        repo: z.string(),
        state: z
          .enum(["open", "closed", "all"])
          .default("all")
          .describe("Filter by issue state"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated list of label names to filter by, e.g. 'deployment overview'"),
        since: z
          .string()
          .optional()
          .describe("Only return issues updated at or after this time (ISO 8601, e.g. '2026-04-06T00:00:00Z')"),
        per_page: z.number().int().min(1).max(100).default(30),
        page: z.number().int().min(1).default(1),
      },
      async ({ owner, repo, state, labels, since, per_page, page }) => {
        const { data } = await this.octokit.rest.issues.listForRepo({
          owner,
          repo,
          state,
          labels,
          since,
          per_page,
          page,
        });
        // Filter out pull requests (GitHub's issues API returns PRs too)
        const issues = data
          .filter((i) => !i.pull_request)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
            created_at: i.created_at,
            updated_at: i.updated_at,
            url: i.html_url,
            body: i.body ?? "",
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(issues, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_issue",
      "Get the full details of a single issue by number, including its complete body text.",
      {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().int(),
      },
      async ({ owner, repo, issue_number }) => {
        const { data: issue } = await this.octokit.rest.issues.get({
          owner,
          repo,
          issue_number,
        });
        const result = {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          url: issue.html_url,
          body: issue.body ?? "",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ====================================================================
    // Large-file upload flow
    //
    // Three-step pattern for pushing files Claude can't reliably pass through
    // a single tool call's argument payload (truncation risk, base64 token
    // bloat):
    //
    //   1. get_upload_url(filename?)              → presigned R2 PUT URL  (call N times for N files)
    //   2. curl -X PUT --data-binary @file …      (run from bash_tool, once per file)
    //   3. commit_from_blob(repo, blobs: […], …)  → server-to-server R2 read + GitHub PUT
    //
    // The bytes only ever cross the wire as raw HTTP body, never as generated
    // tokens. Bash → R2 directly; R2 → GitHub through this Worker.
    //
    // commit_from_blob now accepts an array of {blob_id, path} entries, so any
    // number of files can land in a single atomic commit. The legacy single-file
    // shape {blob_id, path} at the top level is still accepted for backwards
    // compatibility — internally it is normalized to a 1-element array.
    // ====================================================================

    this.server.tool(
      "get_upload_url",
      "Generate a presigned URL that Claude can curl a file to from bash. Returns {blob_id, upload_url, expires_in_seconds}. Pair with commit_from_blob to push the uploaded file to GitHub. For multi-file atomic commits, call this once per file then pass all blob_ids to commit_from_blob.",
      {
        filename: z
          .string()
          .optional()
          .describe(
            "Optional filename hint, used only for the blob_id. Has no effect on what path the file ends up at in the repo."
          ),
      },
      async ({ filename }) => {
        const blobId = generateBlobId(filename);
        const uploadUrl = await presignR2Url({
          accessKeyId: this.env.R2_ACCESS_KEY_ID,
          secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
          accountId: this.env.R2_ACCOUNT_ID,
          bucket: this.env.R2_BUCKET_NAME,
          key: this.blobKey(blobId),
          method: "PUT",
          expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  blob_id: blobId,
                  upload_url: uploadUrl,
                  expires_in_seconds: UPLOAD_URL_TTL_SECONDS,
                  curl_hint: `curl -X PUT --data-binary @<path-to-file> "${uploadUrl.slice(0, 80)}..."`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Schema for commit_from_blob:
    //   Preferred shape:  { blobs: [{blob_id, path}, ...] }   — N files, one commit
    //   Legacy shape:     { blob_id, path }                   — single file (compat)
    //
    // Zod's discriminated unions don't play nicely with the MCP schema
    // serializer here, so we declare all the fields as optional and validate
    // the combination in the handler. The tool description tells callers to
    // use `blobs`.
    this.server.tool(
      "commit_from_blob",
      "Commit one or more previously-uploaded blobs to a GitHub repo as a single atomic commit. Use get_upload_url N times first (once per file), upload each via curl from bash, then call this with `blobs: [{blob_id, path}, ...]`. The Worker reads each blob from R2 and writes them to GitHub server-to-server in one commit. The legacy single-file shape (top-level `blob_id` + `path`) is still accepted but `blobs` is preferred — multi-file atomic commits are the default flow.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        message: z.string().describe("Git commit message"),
        blobs: z
          .array(
            z.object({
              blob_id: z.string().describe("Returned by get_upload_url"),
              path: z.string().describe("Destination path in the repo, e.g. 'src/foo.html'"),
            })
          )
          .min(1)
          .max(50)
          .optional()
          .describe("Array of blobs to commit together. Preferred. Use this for both single- and multi-file commits."),
        blob_id: z.string().optional().describe("Legacy single-file shape. Prefer `blobs` instead."),
        path: z.string().optional().describe("Legacy single-file shape. Prefer `blobs` instead."),
        delete_blob_after: z
          .boolean()
          .default(true)
          .describe("Delete the R2 blobs once the commit succeeds. Defaults true; set false if you want to commit the same blobs to multiple repos."),
      },
      async ({ owner, repo, branch, message, blobs, blob_id, path, delete_blob_after }) => {
        // ---- Normalize input into a single blobs[] array ----
        let entries: Array<{ blob_id: string; path: string }>;
        if (blobs && blobs.length > 0) {
          if (blob_id || path) {
            return {
              content: [{
                type: "text",
                text: "Pass either `blobs` (preferred) or the legacy top-level `blob_id`+`path` — not both.",
              }],
              isError: true,
            };
          }
          entries = blobs;
        } else if (blob_id && path) {
          entries = [{ blob_id, path }];
        } else {
          return {
            content: [{
              type: "text",
              text: "Missing required input. Provide either `blobs: [{blob_id, path}, ...]` (preferred) or top-level `blob_id` + `path` (legacy single-file shape).",
            }],
            isError: true,
          };
        }

        // Reject duplicate paths in one commit — GitHub's createTree would
        // silently apply only the last one, which is almost never what the
        // caller wanted and would silently lose data.
        const seenPaths = new Set<string>();
        for (const e of entries) {
          if (seenPaths.has(e.path)) {
            return {
              content: [{
                type: "text",
                text: `Duplicate path "${e.path}" in blobs. Each path can only appear once per commit.`,
              }],
              isError: true,
            };
          }
          seenPaths.add(e.path);
        }

        // ---- Fetch every blob from R2, fail fast if any is missing ----
        // Fetch in parallel; if any returns null, abort before touching GitHub
        // so we don't end up with a half-committed tree.
        const fetched = await Promise.all(
          entries.map(async (e) => {
            const obj = await this.env.UPLOADS.get(this.blobKey(e.blob_id));
            return { entry: e, obj };
          })
        );
        const missing = fetched.filter((f) => !f.obj).map((f) => f.entry.blob_id);
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `No blob found for blob_id(s): ${missing.join(", ")}. Did get_upload_url succeed for each, and did each curl upload return 200?`,
            }],
            isError: true,
          };
        }

        // ---- Read bytes and base64-encode ----
        const fileData = await Promise.all(
          fetched.map(async (f) => {
            const buf = await f.obj!.arrayBuffer();
            return {
              entry: f.entry,
              bytes: buf,
              size: buf.byteLength,
              base64: arrayBufferToBase64(buf),
            };
          })
        );

        // ---- Standard create-blob → create-tree → create-commit → update-ref ----
        const { data: ref } = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
        });
        const parentSha = ref.object.sha;

        const { data: parentCommit } = await this.octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: parentSha,
        });

        // Create one Git blob per file (in parallel — independent API calls)
        const treeEntries = await Promise.all(
          fileData.map(async (fd) => {
            const { data: gitBlob } = await this.octokit.rest.git.createBlob({
              owner,
              repo,
              content: fd.base64,
              encoding: "base64",
            });
            return {
              path: fd.entry.path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: gitBlob.sha,
            };
          })
        );

        // One tree containing every entry; one commit on top of it.
        const { data: newTree } = await this.octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: parentCommit.tree.sha,
          tree: treeEntries,
        });

        const { data: newCommit } = await this.octokit.rest.git.createCommit({
          owner,
          repo,
          message,
          tree: newTree.sha,
          parents: [parentSha],
        });

        await this.octokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: newCommit.sha,
        });

        // ---- Cleanup ----
        // Delete blobs in parallel after successful commit. Failures here are
        // non-fatal (orphans get caught by the R2 lifecycle rule eventually),
        // so we don't surface them to the caller.
        if (delete_blob_after) {
          await Promise.all(
            entries.map((e) => this.env.UPLOADS.delete(this.blobKey(e.blob_id)))
          );
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                status: "committed",
                commit_sha: newCommit.sha,
                commit_url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
                files_committed: entries.length,
                files: fileData.map((fd) => ({ path: fd.entry.path, size_bytes: fd.size })),
                blobs_deleted: delete_blob_after,
              },
              null,
              2
            ),
          }],
        };
      }
    );

    this.server.tool(
      "list_my_blobs",
      "List pending uploads for the current user (uncommitted blobs in R2). Useful for cleanup or debugging an interrupted upload flow.",
      {},
      async () => {
        const prefix = `uploads/${this.userProps.login}/`;
        const listed = await this.env.UPLOADS.list({ prefix, limit: 100 });
        const items = listed.objects.map((o) => ({
          blob_id: o.key.slice(prefix.length),
          size: o.size,
          uploaded: o.uploaded,
          age_seconds: Math.floor(
            (Date.now() - new Date(o.uploaded).getTime()) / 1000
          ),
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  blob_max_age_seconds: BLOB_MAX_AGE_SECONDS,
                  pending: items,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

/**
 * Generate a URL-safe blob ID. Includes a short random suffix and, if a
 * filename hint was provided, a sanitized slug so list_my_blobs is human-readable.
 */
function generateBlobId(filenameHint?: string): string {
  const randomPart = crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");
  if (!filenameHint) return randomPart;
  const slug = filenameHint
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `${randomPart}-${slug}` : randomPart;
}

/**
 * Convert an ArrayBuffer to a base64 string without blowing the stack on
 * large buffers. Workers' atob/btoa apply only to binary strings, so we
 * chunk and concatenate.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32KB chunks keep us well clear of any arg-length limits
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(binary);
}

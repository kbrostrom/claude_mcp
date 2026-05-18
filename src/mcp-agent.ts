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
    version: "0.2.0",
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
      "List repositories accessible to the authenticated user. Returns name, full_name, default_branch, and visibility.",
      {
        per_page: z.number().int().min(1).max(100).default(30),
        sort: z
          .enum(["created", "updated", "pushed", "full_name"])
          .default("updated"),
      },
      async ({ per_page, sort }) => {
        const { data } =
          await this.octokit.rest.repos.listForAuthenticatedUser({
            per_page,
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
        const content = atob(data.content.replace(/\n/g, ""));
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
      "Atomically commit one or more files to a branch. Creates a single commit containing all changes. For large files (>50KB), prefer get_upload_url + commit_from_blob — content here passes through Claude's token generation and can be truncated.",
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

    // ====================================================================
    // Large-file upload flow
    //
    // Three-step pattern for pushing files Claude can't reliably pass through
    // a single tool call's argument payload (truncation risk, base64 token
    // bloat):
    //
    //   1. get_upload_url(filename?)          → presigned R2 PUT URL
    //   2. curl -X PUT --data-binary @file …  (run from bash_tool)
    //   3. commit_from_blob(repo, path, …)    → server-to-server R2 read + GitHub PUT
    //
    // The bytes only ever cross the wire as raw HTTP body, never as generated
    // tokens. Bash → R2 directly; R2 → GitHub through this Worker.
    // ====================================================================

    this.server.tool(
      "get_upload_url",
      "Generate a presigned URL that Claude can curl a file to from bash. Returns {blob_id, upload_url, expires_in_seconds}. Pair with commit_from_blob to push the uploaded file to GitHub.",
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

    this.server.tool(
      "commit_from_blob",
      "Commit a previously-uploaded blob to a GitHub repo. Use get_upload_url first to obtain blob_id, then upload via curl from bash, then call this. The Worker reads the blob from R2 and pushes it to GitHub server-to-server.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        path: z.string().describe("Destination path in the repo, e.g. 'src/foo.html'"),
        blob_id: z.string().describe("Returned by get_upload_url"),
        message: z.string().describe("Git commit message"),
        delete_blob_after: z
          .boolean()
          .default(true)
          .describe("Delete the R2 blob once the commit succeeds. Defaults true; set false if you want to commit the same blob to multiple repos."),
      },
      async ({ owner, repo, branch, path, blob_id, message, delete_blob_after }) => {
        // 1. Fetch the blob from R2 (server-to-server, no presign needed).
        const r2Object = await this.env.UPLOADS.get(this.blobKey(blob_id));
        if (!r2Object) {
          return {
            content: [
              {
                type: "text",
                text: `No blob found for blob_id=${blob_id}. Did get_upload_url succeed, and did the curl upload return 200?`,
              },
            ],
            isError: true,
          };
        }
        const fileBytes = await r2Object.arrayBuffer();
        const fileSize = fileBytes.byteLength;

        // 2. Base64-encode for the GitHub Git Data API.
        //    We use createBlob with encoding: "base64" so binary files (PDFs,
        //    images) round-trip correctly.
        const base64Content = arrayBufferToBase64(fileBytes);

        // 3. Standard create-blob → create-tree → create-commit → update-ref dance.
        //    Same shape as the existing commit_files tool, just one file.
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

        const { data: blob } = await this.octokit.rest.git.createBlob({
          owner,
          repo,
          content: base64Content,
          encoding: "base64",
        });

        const { data: newTree } = await this.octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: parentCommit.tree.sha,
          tree: [
            {
              path,
              mode: "100644",
              type: "blob",
              sha: blob.sha,
            },
          ],
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

        // 4. Cleanup. Default to deleting since most blobs are one-shot.
        if (delete_blob_after) {
          await this.env.UPLOADS.delete(this.blobKey(blob_id));
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "committed",
                  commit_sha: newCommit.sha,
                  commit_url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
                  file_size_bytes: fileSize,
                  blob_deleted: delete_blob_after,
                },
                null,
                2
              ),
            },
          ],
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

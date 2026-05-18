import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "octokit";
import { z } from "zod";
import type { GitHubUserProps } from "./github-handler";

export class GitHubMCP extends McpAgent<Env, unknown, GitHubUserProps> {
  server = new McpServer({
    name: "github-mcp",
    version: "0.1.0",
  });

  private get octokit() {
    return new Octokit({ auth: this.props.accessToken });
  }

  async init() {
    this.server.tool(
      "list_repos",
      "List repositories accessible to the authenticated user. Returns name, full_name, default_branch, and visibility.",
      {
        per_page: z.number().int().min(1).max(100).default(30),
        sort: z.enum(["created", "updated", "pushed", "full_name"]).default("updated"),
      },
      async ({ per_page, sort }) => {
        const { data } = await this.octokit.rest.repos.listForAuthenticatedUser({
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
              {
                type: "text",
                text: `Path is not a file: ${path}`,
              },
            ],
            isError: true,
          };
        }
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
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
      "Atomically commit one or more files to a branch. Creates a single commit containing all changes.",
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
            const { data: blob } = await this.octokit.rest.git.createBlob({
              owner,
              repo,
              content: Buffer.from(file.content, "utf-8").toString("base64"),
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
        const { data: checks } =
          await this.octokit.rest.checks.listForRef({
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
  }
}

interface Env {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

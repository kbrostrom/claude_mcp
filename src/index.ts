import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { githubHandler } from "./github-handler";
import { GitHubMCP } from "./mcp-agent";

export { GitHubMCP };

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": GitHubMCP.serve("/mcp") as never,
    "/sse": GitHubMCP.serveSSE("/sse") as never,
  },
  defaultHandler: githubHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

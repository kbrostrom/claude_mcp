import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { githubHandler } from "./github-handler";
import { GitHubMCP } from "./mcp-agent";

export { GitHubMCP };

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": GitHubMCP.serve("/mcp"),
    "/sse": GitHubMCP.serveSSE("/sse"),
  },
  defaultHandler: githubHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

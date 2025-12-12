/**
 * x402 Builder Service - Railway Function
 * 
 * Single edge function that creates GitHub repos and dispatches Jinn workstreams
 * to build x402 services from text specifications.
 * 
 * Deploy: Railway Functions (Bun runtime)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";

const app = new Hono();
app.use("/*", cors());

// Environment
const payTo = Bun.env.PAYMENT_WALLET_ADDRESS as `0x${string}` | undefined;
const network = (Bun.env.X402_NETWORK || "base-sepolia") as Network;
const githubToken = Bun.env.GITHUB_TOKEN;
const mechAddress = Bun.env.MECH_ADDRESS;
const privateKey = Bun.env.PRIVATE_KEY;
const ponderUrl = Bun.env.PONDER_GRAPHQL_URL || "http://localhost:42069/graphql";
const chainConfig = Bun.env.CHAIN_CONFIG || "base";

// Base blueprint for generated services
const BASE_BLUEPRINT = {
  assertions: [
    {
      id: "SCAFFOLD-001",
      assertion: "Scaffold as Hono app with x402-hono middleware",
      examples: {
        do: ["Create .gitignore first", "Use x402-hono paymentMiddleware", "moduleResolution: bundler"],
        dont: ["Use Express", "Skip .gitignore before yarn install"]
      },
      commentary: "Hono + x402-hono is the standard stack"
    },
    {
      id: "X402-001",
      assertion: "Paid endpoints must use x402-hono paymentMiddleware",
      examples: {
        do: ["Configure with PAYMENT_WALLET_ADDRESS env", "Return 402 for unpaid requests"],
        dont: ["Hardcode wallet addresses", "Skip payment verification"]
      },
      commentary: "x402 is the monetization mechanism"
    },
    {
      id: "DEPLOY-001",
      assertion: "Include railway.json for Railway deployment",
      examples: {
        do: ["Use NIXPACKS builder", "Set healthcheckPath: /health"],
        dont: ["Omit deployment config"]
      },
      commentary: "Railway deployment config for one-click deploy"
    },
    {
      id: "BUILD-001",
      assertion: "Service must build: yarn install && yarn build must succeed",
      examples: {
        do: ["Fix all TypeScript errors", "Verify dependencies resolve"],
        dont: ["Ignore build errors", "Use ts-ignore"]
      },
      commentary: "Build verification catches issues before runtime"
    }
  ]
};

// Payment middleware for /build
if (payTo) {
  app.use("/build", paymentMiddleware(payTo, {
    "/build": {
      price: "$1.00",
      network,
      config: { description: "Build a new x402 service" }
    }
  }));
}

// Health check
app.get("/health", (c) => c.json({ 
  status: "ok", 
  service: "x402-builder",
  timestamp: new Date().toISOString()
}));

// Service info
app.get("/", (c) => c.json({
  name: "x402 Builder",
  description: "Build x402 services from text specs",
  endpoints: {
    "POST /build": { payment: "$1.00", body: { spec: "string", name: "string?" } },
    "GET /status/:jobId": { payment: "free" },
    "GET /health": { payment: "free" }
  }
}));

// POST /build - Create new service
app.post("/build", async (c) => {
  const body = await c.req.json();
  const { spec, name } = body as { spec?: string; name?: string };

  if (!spec || spec.length < 10) {
    return c.json({ error: "spec must be at least 10 characters" }, 400);
  }

  if (!githubToken || !mechAddress || !privateKey) {
    return c.json({ error: "Server not configured for dispatch" }, 500);
  }

  // Extract service name from spec if not provided
  const serviceName = name || extractServiceName(spec);
  const shortId = Math.random().toString(36).substring(2, 5).toUpperCase();
  let repoName = serviceName;

  try {
    // Create GitHub repo
    let repo;
    try {
      repo = await createGitHubRepo(repoName, githubToken);
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        repoName = `${serviceName}-${shortId.toLowerCase()}`;
        repo = await createGitHubRepo(repoName, githubToken);
      } else {
        throw e;
      }
    }

    // Prepare blueprint with user spec
    const blueprint = {
      ...BASE_BLUEPRINT,
      context: `## User Specification\n\n${spec}\n\n## Repository\n${repo.html_url}`
    };

    // Dispatch to Jinn
    const jobDefinitionId = crypto.randomUUID();
    const { marketplaceInteract } = await import("@jinn-network/mech-client-ts/dist/marketplace_interact.js");

    const result = await marketplaceInteract({
      prompts: [JSON.stringify(blueprint)],
      priorityMech: mechAddress,
      tools: ["web_search", "create_artifact", "write_file", "read_file", "replace", "list_directory", "run_shell_command"],
      ipfsJsonContents: [{
        blueprint: JSON.stringify(blueprint),
        jobName: `Build ${serviceName} – ${shortId}`,
        model: "gemini-2.5-flash",
        jobDefinitionId,
        nonce: crypto.randomUUID(),
      }],
      chainConfig,
      keyConfig: { source: "value", value: privateKey },
      postOnly: true,
      responseTimeout: 300,
    });

    if (!result?.request_ids?.[0]) {
      throw new Error("Dispatch failed: no request ID");
    }

    const requestId = result.request_ids[0];
    const baseUrl = new URL(c.req.url).origin;

    return c.json({
      jobId: requestId,
      jobDefinitionId,
      repoUrl: repo.html_url,
      statusUrl: `${baseUrl}/status/${requestId}`,
      explorerUrl: `https://explorer.jinn.network/workstreams/${requestId}`,
    }, 201);

  } catch (e: any) {
    console.error("Build failed:", e);
    return c.json({ error: "Build failed", details: e.message }, 500);
  }
});

// GET /status/:jobId - Query build status
app.get("/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const query = `query ($id: String!) { request(id: $id) { id delivered deliveryIpfsHash } }`;
  
  try {
    const res = await fetch(ponderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: jobId } }),
    });

    const data = await res.json() as { data?: { request?: { delivered: boolean; deliveryIpfsHash?: string } } };
    const req = data?.data?.request;

    if (!req) {
      return c.json({ jobId, status: "pending" });
    }

    if (req.delivered && req.deliveryIpfsHash) {
      return c.json({
        jobId,
        status: "completed",
        reportUrl: `https://gateway.autonolas.tech/ipfs/${req.deliveryIpfsHash}`,
      });
    }

    return c.json({ jobId, status: "in_progress" });
  } catch (e: any) {
    return c.json({ error: "Status query failed", details: e.message }, 500);
  }
});

// Helper: Create GitHub repo
async function createGitHubRepo(name: string, token: string) {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      private: true,
      auto_init: true,
      description: `x402 service: ${name}`,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error: ${err}`);
  }

  return res.json() as Promise<{ html_url: string; clone_url: string }>;
}

// Helper: Extract service name from spec
function extractServiceName(spec: string): string {
  const match = spec.match(/(?:build|create)\s+(?:a|an)?\s*([a-z0-9-]+)\s+(?:service|api)/i);
  if (match?.[1]) return match[1].toLowerCase().replace(/[^a-z0-9-]/g, "");
  return spec.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x402-service";
}

// Start server
const port = parseInt(Bun.env.PORT || "3000", 10);
console.log(`x402 Builder running on :${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
});


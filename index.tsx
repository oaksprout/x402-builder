/**
 * x402 Builder Service - Railway Function
 * 
 * Single edge function that creates GitHub repos and dispatches Jinn workstreams
 * to build x402 services from specifications.
 * 
 * Accepts either:
 * - spec: freeform text description
 * - blueprint: structured JSON with assertions array
 * 
 * Deploy: Railway Functions (Bun runtime)
 * 
 * Required env vars for x402 payments:
 * - PAYMENT_WALLET_ADDRESS: Address to receive payments
 * - CDP_API_KEY_ID: Coinbase Developer Platform key ID
 * - CDP_API_KEY_SECRET: Coinbase Developer Platform key secret
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";
import { facilitator } from "@coinbase/x402";

const app = new Hono();
app.use("/*", cors());

// Environment
const payTo = Bun.env.PAYMENT_WALLET_ADDRESS as `0x${string}` | undefined;
const network = (Bun.env.X402_NETWORK || "base") as Network;
const githubToken = Bun.env.GITHUB_TOKEN;
const mechAddress = Bun.env.MECH_ADDRESS;
const privateKey = Bun.env.PRIVATE_KEY;
const ponderUrl = Bun.env.PONDER_GRAPHQL_URL || "http://localhost:42069/graphql";
const chainConfig = Bun.env.CHAIN_CONFIG || "base";

// Base assertions added to all builds (unless blueprint provided)
const BASE_ASSERTIONS = [
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
];

interface BlueprintAssertion {
  id: string;
  assertion: string;
  examples: { do: string[]; dont: string[] };
  commentary: string;
}

interface Blueprint {
  assertions: BlueprintAssertion[];
  context?: string;
}

// Payment middleware for /build - uses Coinbase facilitator
if (payTo) {
  app.use("/build", paymentMiddleware(
    payTo,
    {
      "/build": {
        price: "$0.001",
        network,
        config: { description: "Build a new x402 service" }
      }
    },
    facilitator  // Coinbase facilitator for payment verification
  ));
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
  description: "Build x402 services from specs or blueprints",
  network,
  endpoints: {
    "POST /build": { 
      payment: "$0.001", 
      network, 
      body: { 
        spec: "string? - freeform text description",
        blueprint: "object? - structured { assertions: [...], context?: string }",
        name: "string? - service name (auto-extracted if omitted)" 
      },
      note: "Provide either spec OR blueprint, not both"
    },
    "GET /status/:jobId": { payment: "free" },
    "GET /health": { payment: "free" }
  }
}));

// POST /build - Create new service
app.post("/build", async (c) => {
  const body = await c.req.json();
  const { spec, blueprint, name } = body as { 
    spec?: string; 
    blueprint?: Blueprint | string;
    name?: string;
  };

  // Validate input - need either spec or blueprint
  if (!spec && !blueprint) {
    return c.json({ error: "Either 'spec' or 'blueprint' is required" }, 400);
  }

  if (spec && blueprint) {
    return c.json({ error: "Provide either 'spec' or 'blueprint', not both" }, 400);
  }

  if (!githubToken || !mechAddress || !privateKey) {
    return c.json({ error: "Server not configured for dispatch" }, 500);
  }

  // Parse blueprint if provided as string
  let userBlueprint: Blueprint | null = null;
  if (blueprint) {
    try {
      userBlueprint = typeof blueprint === 'string' ? JSON.parse(blueprint) : blueprint;
      if (!userBlueprint?.assertions || !Array.isArray(userBlueprint.assertions)) {
        return c.json({ error: "Blueprint must have an 'assertions' array" }, 400);
      }
    } catch (e) {
      return c.json({ error: "Invalid blueprint JSON" }, 400);
    }
  }

  // Extract service name
  const serviceName = name || (userBlueprint 
    ? extractNameFromBlueprint(userBlueprint)
    : extractServiceName(spec!));
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

    // Build final blueprint
    let finalBlueprint: Blueprint;
    
    if (userBlueprint) {
      // Use user's blueprint directly, append repo context
      finalBlueprint = {
        assertions: userBlueprint.assertions,
        context: [
          userBlueprint.context || '',
          '',
          '## Repository',
          repo.html_url,
        ].filter(Boolean).join('\n')
      };
    } else {
      // Build from freeform spec
      finalBlueprint = {
        assertions: BASE_ASSERTIONS,
        context: `## User Specification\n\n${spec}\n\n## Repository\n${repo.html_url}`
      };
    }

    // Dispatch to Jinn
    const jobDefinitionId = crypto.randomUUID();
    const { marketplaceInteract } = await import("@jinn-network/mech-client-ts/dist/marketplace_interact.js");

    const result = await marketplaceInteract({
      prompts: [JSON.stringify(finalBlueprint)],
      priorityMech: mechAddress,
      tools: ["web_search", "create_artifact", "write_file", "read_file", "replace", "list_directory", "run_shell_command", "dispatch_new_job"],
      ipfsJsonContents: [{
        blueprint: JSON.stringify(finalBlueprint),
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

// Helper: Extract service name from freeform spec
function extractServiceName(spec: string): string {
  const match = spec.match(/(?:build|create)\s+(?:a|an)?\s*([a-z0-9-]+)\s+(?:service|api)/i);
  if (match?.[1]) return match[1].toLowerCase().replace(/[^a-z0-9-]/g, "");
  return spec.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x402-service";
}

// Helper: Extract service name from blueprint
function extractNameFromBlueprint(blueprint: Blueprint): string {
  // Try to find name in context
  const contextMatch = blueprint.context?.match(/(?:service|api|project)[:\s]+([a-z0-9-]+)/i);
  if (contextMatch?.[1]) return contextMatch[1].toLowerCase();
  
  // Try to extract from first assertion
  const firstAssertion = blueprint.assertions[0]?.assertion || '';
  const assertionMatch = firstAssertion.match(/([a-z0-9-]+)\s+(?:service|api)/i);
  if (assertionMatch?.[1]) return assertionMatch[1].toLowerCase();
  
  return "x402-service";
}

// Start server
const port = parseInt(Bun.env.PORT || "3000", 10);
console.log(`x402 Builder running on :${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
});

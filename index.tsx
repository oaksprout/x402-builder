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
 * Blueprint Merging Strategy:
 * - BASE_ASSERTIONS are ALWAYS included (generic x402 scaffolding)
 * - User assertions are APPENDED (service-specific requirements)
 * - User context describes WHAT to build, base assertions describe HOW
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

// Environment (compatible with both Bun and Node.js)
const env = typeof Bun !== 'undefined' ? Bun.env : process.env;
const payTo = env.PAYMENT_WALLET_ADDRESS as `0x${string}` | undefined;
const network = (env.X402_NETWORK || "base") as Network;
const githubToken = env.GITHUB_TOKEN;
const mechAddress = env.MECH_ADDRESS;
const privateKey = env.PRIVATE_KEY;
const ponderUrl = env.PONDER_GRAPHQL_URL || "http://localhost:42069/graphql";
const chainConfig = env.CHAIN_CONFIG || "base";
// Note: RPC_URL is read directly by mech-client-ts (see config.js:87-90)

// Base assertions - ALWAYS included for any x402 service build
// These are generic HOW-TO-BUILD assertions, not service-specific
const BASE_ASSERTIONS = [
  {
    id: "BASE-SCAFFOLD-001",
    assertion: "Scaffold as Hono app with x402-hono middleware. Create .gitignore FIRST before any yarn install.",
    examples: {
      do: [
        "Create .gitignore first excluding node_modules/, dist/, .env, *.log",
        "Use x402-hono paymentMiddleware for paid routes",
        "Create tsconfig.json with moduleResolution: 'bundler' (required for x402-hono)",
        "Include package.json with hono, @hono/node-server, x402-hono dependencies"
      ],
      dont: [
        "Use Express, Fastify, or other frameworks",
        "Skip .gitignore before yarn install (causes token overflow)",
        "Use moduleResolution: 'nodenext' (x402-hono has broken type exports)"
      ]
    },
    commentary: "Hono + x402-hono is the standard x402 stack. .gitignore must be created FIRST."
  },
  {
    id: "BASE-X402-001",
    assertion: "Paid endpoints must use x402-hono paymentMiddleware with PAYMENT_WALLET_ADDRESS from env.",
    examples: {
      do: [
        "Configure paymentMiddleware with price and network from env",
        "Return proper 402 Payment Required response",
        "Use 'base' network for mainnet, 'base-sepolia' for testnet"
      ],
      dont: [
        "Hardcode wallet addresses",
        "Skip payment verification",
        "Allow unpaid access to paid endpoints"
      ]
    },
    commentary: "x402 payment is the monetization mechanism for all paid endpoints."
  },
  {
    id: "BASE-DEPLOY-001",
    assertion: "Include railway.json for Railway deployment with NIXPACKS builder and health check.",
    examples: {
      do: [
        "Include railway.json with NIXPACKS builder",
        "Set healthcheckPath to '/health'",
        "Document required env vars in .env.example"
      ],
      dont: [
        "Omit deployment config",
        "Hardcode environment-specific values"
      ]
    },
    commentary: "Railway deployment config enables one-click deployment."
  },
  {
    id: "BASE-BUILD-001",
    assertion: "Service must compile: 'yarn install' and 'yarn build' must both succeed without errors.",
    examples: {
      do: [
        "Run yarn install and verify completion",
        "Run yarn build and verify TypeScript compiles",
        "Fix type errors before proceeding"
      ],
      dont: [
        "Proceed if build fails",
        "Use ts-ignore to suppress errors",
        "Skip build verification"
      ]
    },
    commentary: "Build verification catches issues before runtime."
  },
  {
    id: "BASE-RUN-001",
    assertion: "Service must start: 'yarn start' must launch server and respond to /health with 200 OK.",
    examples: {
      do: [
        "Run yarn start and verify server starts",
        "Test curl http://localhost:PORT/health returns 200",
        "Include GET /health endpoint returning { status: 'ok' }"
      ],
      dont: [
        "Assume server starts without testing",
        "Skip health endpoint"
      ]
    },
    commentary: "Runtime verification confirms the service actually works."
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
        spec: "string? - freeform text description of what to build",
        blueprint: "object? - structured { assertions: [...], context?: string }",
        name: "string? - service name (auto-extracted if omitted)" 
      },
      note: "BASE_ASSERTIONS (scaffolding) are always included. User assertions are appended for service-specific requirements."
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

    // Build final blueprint - ALWAYS include BASE_ASSERTIONS
    let finalBlueprint: Blueprint;
    
    if (userBlueprint) {
      // Merge: BASE_ASSERTIONS + user assertions
      // Filter out any user assertions that duplicate base IDs
      const baseIds = new Set(BASE_ASSERTIONS.map(a => a.id));
      const userAssertionsFiltered = userBlueprint.assertions.filter(a => !baseIds.has(a.id));
      
      finalBlueprint = {
        assertions: [...BASE_ASSERTIONS, ...userAssertionsFiltered],
        context: [
          '## Service Specification',
          '',
          userBlueprint.context || '(No additional context provided)',
          '',
          '## Target Repository',
          repo.html_url,
          '',
          '## Build Instructions',
          'Use the BASE-* assertions for scaffolding. Use service-specific assertions for functionality.',
        ].join('\n')
      };
    } else {
      // Build from freeform spec - only BASE_ASSERTIONS
      finalBlueprint = {
        assertions: BASE_ASSERTIONS,
        context: [
          '## Service Specification',
          '',
          spec,
          '',
          '## Target Repository', 
          repo.html_url,
        ].join('\n')
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
        jobName: `Build: ${serviceName}`,
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
      assertionCount: {
        base: BASE_ASSERTIONS.length,
        user: userBlueprint?.assertions.length || 0,
        total: finalBlueprint.assertions.length,
      }
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
  // Try to find "build X service" or "create X api" pattern
  const match = spec.match(/(?:build|create)\s+(?:a|an|the)?\s*([a-z0-9-]+)\s+(?:service|api)/i);
  if (match?.[1]) return match[1].toLowerCase().replace(/[^a-z0-9-]/g, "");
  
  // Fallback: use first few words
  return spec.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x402-service";
}

// Helper: Extract service name from blueprint
function extractNameFromBlueprint(blueprint: Blueprint): string {
  const context = blueprint.context || '';
  
  // 1. Try to extract from GitHub repo URL in context
  const repoMatch = context.match(/github\.com\/[^\/]+\/([a-z0-9_-]+)/i);
  if (repoMatch?.[1]) {
    // Clean up the repo name (remove common prefixes/suffixes)
    let name = repoMatch[1].toLowerCase();
    name = name.replace(/^(x402-|the-|my-)/, '').replace(/(-service|-api)$/, '');
    if (name.length >= 2) return name;
  }
  
  // 2. Try to find explicit "service: name" or "project: name" pattern
  const explicitMatch = context.match(/(?:service|project|name)[:\s]+([a-z0-9-]+)/i);
  if (explicitMatch?.[1]) return explicitMatch[1].toLowerCase();
  
  // 3. Try to extract from first assertion that mentions a service name
  for (const assertion of blueprint.assertions) {
    // Look for "X service" or "X api" pattern
    const assertionMatch = assertion.assertion.match(/(?:the\s+)?([a-z0-9-]+)\s+(?:service|api|endpoint)/i);
    if (assertionMatch?.[1] && assertionMatch[1].length > 2) {
      const name = assertionMatch[1].toLowerCase();
      // Skip generic words
      if (!['the', 'this', 'a', 'an', 'hono', 'x402'].includes(name)) {
        return name;
      }
    }
  }
  
  return "x402-service";
}

// Start server (compatible with both Bun and Node.js)
const port = parseInt(env.PORT || "3000", 10);
console.log(`x402 Builder running on :${port}`);

if (typeof Bun !== 'undefined') {
  Bun.serve({
    port,
    fetch: app.fetch,
  });
} else {
  // Node.js: use @hono/node-server or built-in serve
  import('@hono/node-server').then(({ serve }) => {
    serve({ fetch: app.fetch, port });
  }).catch(() => {
    // Fallback: try hono's built-in serve
    console.log('Starting with built-in serve...');
    // @ts-ignore
    app.listen(port);
  });
}

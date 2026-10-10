#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configFromEnv, TilcaiClient, TilcaiError } from "./client.ts";
import { paymentGuidance } from "./guidance.ts";
import { ROUTES } from "./networks.ts";

const cfg = configFromEnv();
const api = new TilcaiClient(cfg);

const NET = ROUTES[cfg.mode];
const MAINNET_NOTE = cfg.mode === "mainnet" ? " MAINNET: moves real USDC." : " Testnet only.";
const EVM_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address (0x…)");
const STELLAR_ADDRESS = z.string().regex(/^G[A-Z2-7]{55}$/, "Stellar account (G…, with a USDC trustline)");
const TX_HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "transaction hash (0x…64 hex)");
const PAYMENT_ID = z.string().min(1).max(128);

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown): Result => {
  if (e instanceof TilcaiError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { status: e.status, code: e.code, message: e.message, recovery: e.recovery } }, null, 2) }] };
  }
  return { isError: true, content: [{ type: "text", text: String((e as Error)?.message ?? e) }] };
};
const run = (fn: () => Promise<unknown>) => async (): Promise<Result> => {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
};

/** Refuses to create a payment when the instance behind TILCAI_API_URL is not the environment this MCP was configured for. */
async function assertEnvironment() {
  const h = (await api.health()) as { env?: string; transactionsEnabled?: boolean };
  const expected = cfg.mode;
  if (h.env && h.env !== expected) {
    throw new TilcaiError(0, "ENVIRONMENT_MISMATCH", `tilcai-mcp is configured for ${expected} but ${cfg.baseUrl} runs ${h.env}`, "CONFIGURE");
  }
  if (h.transactionsEnabled === false) {
    throw new TilcaiError(0, "TRANSACTIONS_DISABLED", `${cfg.baseUrl} is read-only (transactions disabled); quotes and status still work`, "ESCALATE");
  }
}

const server = new McpServer({ name: "tilcai-mcp", version: "0.2.0" });

server.registerTool(
  "tilcai_status",
  { description: `Health of TilcAI and the relayer, and the crosschain routes it serves. Use it first to confirm the route ${NET.sourceLabel} → ${NET.destinationLabel} is available.`, inputSchema: {} },
  async () => {
    try {
      const health = await api.health();
      let routes: unknown = "set TILCAI_API_KEY to list routes";
      if (cfg.apiKey) routes = await api.routes().catch((e) => ({ error: String((e as Error).message) }));
      const env = (health as { env?: string }).env;
      return ok({ configuredNetwork: cfg.mode, route: `${NET.source} → ${NET.destination}`, baseUrl: cfg.baseUrl, ...(env && env !== cfg.mode ? { warning: `server runs ${env}, MCP is configured for ${cfg.mode}` } : {}), health, routes });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "tilcai_quote",
  {
    description:
      `Quote a USDC payment from the agent's EVM wallet on ${NET.sourceLabel} to a Stellar address (CCTP V2). Returns the amount burned, the amount delivered and a preflight on the destination trustline.${MAINNET_NOTE}`,
    inputSchema: {
      amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "USDC amount with at most 6 decimals, e.g. 1.25"),
      payTo: STELLAR_ADDRESS,
    },
  },
  ({ amount, payTo }) => run(() => api.quote({ sourceNetwork: NET.source, destinationNetwork: NET.destination, amount, payTo }))(),
);

server.registerTool(
  "tilcai_create_payment",
  {
    description:
      `Create the payment for a quote and get what the agent must do next with evm-mcp-server. mode=gasless (recommended): returns arguments for \`sign_typed_data\` (EIP-3009), the relayer pays all gas. mode=external: returns the unsigned approve + depositForBurnWithHook calls to broadcast (needs AVAX). Safe to retry with the same idempotencyKey.${MAINNET_NOTE}`,
    inputSchema: {
      quoteId: z.string().min(1),
      payer: EVM_ADDRESS.describe(`The address of the wallet configured in evm-mcp-server (see its get_wallet_address); it must hold the USDC on ${NET.sourceLabel}`),
      mode: z.enum(["gasless", "external"]).default("gasless"),
      orderId: z.string().max(128).optional(),
      idempotencyKey: z.string().min(8).max(128).optional().describe("Reuse the same value to retry without creating a second payment"),
    },
  },
  ({ quoteId, payer, mode, orderId, idempotencyKey }) =>
    run(async () => {
      await assertEnvironment();
      const r = await api.createPayment({ quoteId, mode, payer, ...(orderId ? { orderId } : {}) }, idempotencyKey);
      return { payment: r.payment, ...paymentGuidance(r, NET) };
    })(),
);

server.registerTool(
  "tilcai_submit_authorization",
  {
    description: "gasless mode: send the 65-byte signature returned by evm-mcp-server `sign_typed_data`. TilcAI verifies it against the payer and asks the relayer to submit the burn on the source chain.",
    inputSchema: { paymentId: PAYMENT_ID, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "65-byte hex signature") },
  },
  ({ paymentId, signature }) => run(() => api.submitAuthorization(paymentId, signature))(),
);

server.registerTool(
  "tilcai_submit_burn",
  {
    description: "external mode: report the hash of the depositForBurnWithHook transaction the agent broadcast with evm-mcp-server. Also rescues a gasless payment whose burn hash was lost.",
    inputSchema: { paymentId: PAYMENT_ID, txHash: TX_HASH },
  },
  ({ paymentId, txHash }) => run(() => api.submitBurn(paymentId, txHash))(),
);

server.registerTool(
  "tilcai_payment_status",
  {
    description:
      "State of a payment: AWAITING_BURN → BURN_SUBMITTED → BURN_CONFIRMED → ATTESTED → MINT_SUBMITTED → SETTLED (or FAILED / UNCERTAIN). SETTLED means the USDC reached the Stellar address. Circle's attestation can take minutes on Standard finality. Set reconcile=true to run one reconciliation step now.",
    inputSchema: { paymentId: PAYMENT_ID, reconcile: z.boolean().default(false) },
  },
  ({ paymentId, reconcile }) =>
    run(async () => {
      if (reconcile) await api.reconcile(paymentId);
      return api.payment(paymentId);
    })(),
);

await server.connect(new StdioServerTransport());

#!/usr/bin/env -S npx tsx
/**
 * End-to-end check of tilcai-mcp over stdio, as an MCP client would use it.
 * Read-only: status + quote (no payment is created). Configure with the same env as the server
 * (TILCAI_NETWORK, TILCAI_API_URL, TILCAI_API_KEY) plus E2E_PAY_TO (a Stellar G… account) and E2E_AMOUNT.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const payTo = process.env.E2E_PAY_TO ?? "";
const amount = process.env.E2E_AMOUNT ?? "0.01";
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", new URL("../src/main.ts", import.meta.url).pathname],
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
});
const client = new Client({ name: "tilcai-mcp-e2e", version: "0.0.0" });
await client.connect(transport);

let failed = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!pass) failed++;
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  let body: unknown = r.content[0]?.text;
  try {
    body = JSON.parse(r.content[0]?.text ?? "");
  } catch {}
  return { isError: !!r.isError, body: body as Record<string, any> };
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("tools listed", tools.length === 6 && tools.includes("tilcai_quote"), tools);

const status = await call("tilcai_status");
check("tilcai_status", !status.isError && status.body.health?.ok === true, { network: status.body.configuredNetwork, env: status.body.health?.env, warning: status.body.warning });
check("environment matches", !status.body.warning);

if (payTo) {
  const q = await call("tilcai_quote", { amount, payTo });
  check("tilcai_quote", !q.isError && !!q.body.quote?.id, q.isError ? q.body : { id: q.body.quote?.id, route: q.body.quote?.route, preflight: q.body.quote?.preflight });
} else {
  console.log("SKIP tilcai_quote (set E2E_PAY_TO)");
}

const missing = await call("tilcai_payment_status", { paymentId: "does-not-exist" });
check("unknown payment is a structured error", missing.isError && !!missing.body.error?.code, missing.body.error);

await client.close();
process.exit(failed ? 1 : 0);

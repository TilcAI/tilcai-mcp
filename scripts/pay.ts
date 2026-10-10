#!/usr/bin/env -S npx tsx
/**
 * Full gasless payment through both MCP servers over stdio: tilcai-mcp (quote/create/submit/status)
 * and evm-mcp-server (get_wallet_address/sign_typed_data). The private key (EVM_PRIVATE_KEY) is only
 * read by evm-mcp-server; this script never sees or prints it.
 *
 * Env: TILCAI_NETWORK, TILCAI_API_URL, TILCAI_API_KEY, EVM_PRIVATE_KEY, E2E_PAY_TO, E2E_AMOUNT (default 0.01).
 * On mainnet it moves real USDC and refuses to run without E2E_CONFIRM_MAINNET=yes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const payTo = process.env.E2E_PAY_TO ?? "";
const amount = process.env.E2E_AMOUNT ?? "0.01";
const network = process.env.TILCAI_NETWORK ?? "testnet";
if (!/^G[A-Z2-7]{55}$/.test(payTo)) throw new Error("set E2E_PAY_TO to a Stellar G… account with a USDC trustline");
if (network === "mainnet" && process.env.E2E_CONFIRM_MAINNET !== "yes") throw new Error("mainnet moves real USDC: set E2E_CONFIRM_MAINNET=yes");
if (!process.env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is not set (evm-mcp-server signs with it)");

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
const tilcai = new Client({ name: "pay-e2e", version: "0" });
const evm = new Client({ name: "pay-e2e", version: "0" });
await tilcai.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../src/main.ts", import.meta.url).pathname], env }));
await evm.connect(new StdioClientTransport({ command: "npx", args: ["-y", "@mcpdotdirect/evm-mcp-server"], env, stderr: "ignore" }));

const text = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const t = r.content.map((p) => p.text).join("\n");
  if (r.isError) throw new Error(`${name} failed: ${t}`);
  return t;
};
const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await text(tilcai, name, args)) as Record<string, any>;
const step = (s: string) => console.log(`\n== ${s}`);

step("payer wallet");
const payer = (await text(evm, "get_wallet_address")).match(/0x[0-9a-fA-F]{40}/)?.[0];
if (!payer) throw new Error("could not read the payer address from evm-mcp-server");
console.log("payer:", payer);

step("quote");
const q = (await json("tilcai_quote", { amount, payTo })).quote;
console.log(JSON.stringify({ id: q.id, route: q.route, preflight: q.preflight }, null, 2));
if (!q.preflight?.payToTrustline) throw new Error("destination has no USDC trustline");

step("create payment (gasless)");
const created = await json("tilcai_create_payment", { quoteId: q.id, payer, mode: "gasless" });
const paymentId = created.paymentId as string;
console.log("paymentId:", paymentId, "mode:", created.mode, "environment:", created.environment);
if (created.mode !== "gasless" || !created.signTypedData) throw new Error(`expected gasless guidance, got ${JSON.stringify(created).slice(0, 300)}`);
const message = JSON.parse(created.signTypedData.messageJson) as Record<string, string>;
if (message.from && message.from.toLowerCase() !== payer.toLowerCase()) throw new Error(`typed data is for ${message.from}, not the payer`);
console.log("authorization value (atomic):", message.value, "to:", message.to);

step("sign");
const signature = (await text(evm, "sign_typed_data", created.signTypedData)).match(/0x[0-9a-fA-F]{130}/)?.[0];
if (!signature) throw new Error("no 65-byte signature in sign_typed_data output");
console.log("signature obtained");

step("submit authorization");
console.log(JSON.stringify((await json("tilcai_submit_authorization", { paymentId, signature })).payment, null, 2));

step("poll until SETTLED");
const deadline = Date.now() + 20 * 60_000;
let last = "";
for (;;) {
  const p = (await json("tilcai_payment_status", { paymentId, reconcile: true })) as Record<string, any>;
  const pay = (p.payment ?? p) as Record<string, any>;
  if (pay.state !== last) {
    last = pay.state;
    console.log(new Date().toISOString(), pay.state, JSON.stringify({ burnTx: pay.burnTxHash ?? pay.burn?.txHash, mintTx: pay.mintTxHash ?? pay.mint?.txHash }));
  }
  if (pay.state === "SETTLED") {
    console.log("\nFULL PAYMENT:", JSON.stringify(pay, null, 2));
    break;
  }
  if (pay.state === "FAILED" || pay.state === "UNCERTAIN") throw new Error(`payment ended ${pay.state}: ${JSON.stringify(pay)}`);
  if (Date.now() > deadline) throw new Error(`timeout waiting for SETTLED (last state ${pay.state}); paymentId=${paymentId}`);
  await new Promise((r) => setTimeout(r, 10_000));
}
await tilcai.close();
await evm.close();
process.exit(0);

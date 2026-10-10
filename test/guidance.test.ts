import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentGuidance, signTypedDataArgs } from "../src/guidance.ts";
import { modeFromEnv, ROUTES } from "../src/networks.ts";

const typedData = {
  domain: { name: "USD Coin", version: "2", chainId: 43113, verifyingContract: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  types: { EIP712Domain: [{ name: "name", type: "string" }], ReceiveWithAuthorization: [{ name: "from", type: "address" }] },
  primaryType: "ReceiveWithAuthorization",
  message: { from: "0x0000000000000000000000000000000000000001" },
};

test("sign_typed_data args drop EIP712Domain and stay JSON strings", () => {
  const a = signTypedDataArgs(typedData);
  assert.equal(a.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(Object.keys(JSON.parse(a.typesJson)), ["ReceiveWithAuthorization"]);
  assert.equal(JSON.parse(a.domainJson).chainId, 43113);
});

test("gasless guidance points at sign_typed_data then tilcai_submit_authorization", () => {
  const g = paymentGuidance({ payment: { id: "p1", state: "AWAITING_BURN" }, unsignedCalls: [], authorization: { router: "0x1", nonce: "0x2", validBefore: "9", typedData }, next: "" }, ROUTES.testnet) as { mode: string; instructions: string[] };
  assert.equal(g.mode, "gasless");
  assert.match(g.instructions.join(" "), /tilcai_submit_authorization/);
});

test("external guidance lists the calls in order", () => {
  const call = { chainId: 43113, to: "0xabc", data: "0x095ea7b3deadbeef", value: "0", description: "approve" };
  const g = paymentGuidance({ payment: { id: "p2", state: "AWAITING_BURN" }, unsignedCalls: [call, { ...call, data: "0x1234abcd" }], next: "" }, ROUTES.testnet) as { mode: string; calls: { step: number }[] };
  assert.equal(g.mode, "external");
  assert.deepEqual(g.calls.map((c) => c.step), [1, 2]);
});

test("external guidance on mainnet targets evm-mcp-server network avalanche", () => {
  const call = { chainId: 43114, to: "0xabc", data: "0x095ea7b3deadbeef", value: "0", description: "approve" };
  const g = paymentGuidance({ payment: { id: "p3", state: "AWAITING_BURN" }, unsignedCalls: [call], next: "" }, ROUTES.mainnet) as { environment: string; calls: { network: string; chainId: number }[]; instructions: string[] };
  assert.equal(g.environment, "mainnet");
  assert.equal(g.calls[0].network, "avalanche");
  assert.equal(g.calls[0].chainId, 43114);
  assert.match(g.instructions[0], /Avalanche C-Chain/);
});

test("TILCAI_NETWORK selects the route and rejects unknown values", () => {
  assert.equal(modeFromEnv({}), "testnet");
  assert.equal(modeFromEnv({ TILCAI_NETWORK: "Mainnet" }), "mainnet");
  assert.equal(ROUTES.mainnet.source, "eip155:43114");
  assert.equal(ROUTES.mainnet.destination, "stellar:pubnet");
  assert.throws(() => modeFromEnv({ TILCAI_NETWORK: "fuji" }));
});

import type { PaymentResponse, TypedData, UnsignedCall } from "./client.ts";
import type { RouteNetworks } from "./networks.ts";

/**
 * Arguments for evm-mcp-server's `sign_typed_data` (domainJson, typesJson, primaryType, messageJson).
 * `EIP712Domain` is dropped from `types`: evm-mcp-server adds it itself and viem rejects a duplicate.
 */
export function signTypedDataArgs(td: TypedData) {
  const { EIP712Domain: _omit, ...types } = td.types as Record<string, unknown>;
  return {
    domainJson: JSON.stringify(td.domain),
    typesJson: JSON.stringify(types),
    primaryType: td.primaryType,
    messageJson: JSON.stringify(td.message),
  };
}

const APPROVE = "0x095ea7b3";

/** Which evm-mcp-server tool executes each unsigned call, with the raw calldata kept as the source of truth. */
export function describeCall(c: UnsignedCall, index: number, net: RouteNetworks) {
  const selector = c.data.slice(0, 10);
  return {
    step: index + 1,
    description: c.description,
    network: net.evmMcpNetwork,
    chainId: c.chainId,
    to: c.to,
    data: c.data,
    value: c.value,
    evmMcpTool: selector === APPROVE ? "approve_token_spending (or write_contract approve)" : "write_contract",
    abiSelector: selector,
  };
}

export function paymentGuidance(r: PaymentResponse, net: RouteNetworks) {
  const id = r.payment.id;
  if (r.authorization) {
    return {
      mode: "gasless",
      environment: net.mode,
      paymentId: id,
      validBefore: r.authorization.validBefore,
      instructions: [
        "1. Call evm-mcp-server `sign_typed_data` with exactly the arguments in `signTypedData` (do not edit them).",
        `2. Call tilcai_submit_authorization with paymentId=${id} and the returned signature. TilcAI's relayer pays the gas on both chains.`,
        `3. Poll tilcai_payment_status until state is SETTLED.`,
      ],
      signTypedData: signTypedDataArgs(r.authorization.typedData),
    };
  }
  if (r.unsignedCalls.length > 0) {
    return {
      mode: "external",
      environment: net.mode,
      paymentId: id,
      instructions: [
        `1. Execute the calls in order from the payer wallet with evm-mcp-server (it needs AVAX on ${net.sourceLabel} for gas). Use \`write_contract\` with the calldata ABI of each call, or send the raw \`data\` to \`to\`. Use network=${net.evmMcpNetwork}.`,
        `2. Call tilcai_submit_burn with paymentId=${id} and the hash of the depositForBurnWithHook transaction (the last call).`,
        "3. Poll tilcai_payment_status until state is SETTLED.",
      ],
      calls: r.unsignedCalls.map((c, i) => describeCall(c, i, net)),
    };
  }
  return { mode: "none", environment: net.mode, paymentId: id, instructions: ["Nothing to sign: poll tilcai_payment_status."] };
}

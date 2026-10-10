/** Which TilcAI environment this MCP process talks to. One process serves exactly one environment. */
export type NetworkMode = "testnet" | "mainnet";

export interface RouteNetworks {
  mode: NetworkMode;
  /** CAIP-2 ids sent to TilcAI. */
  source: string;
  destination: string;
  sourceLabel: string;
  destinationLabel: string;
  /** Value of the `network` argument in evm-mcp-server tools. */
  evmMcpNetwork: string;
  evmChainId: number;
  /** TilcAI's default base URL for this environment when TILCAI_API_URL is not set. */
  defaultApiUrl: string;
}

export const ROUTES: Record<NetworkMode, RouteNetworks> = {
  testnet: {
    mode: "testnet",
    source: "eip155:43113",
    destination: "stellar:testnet",
    sourceLabel: "Avalanche Fuji",
    destinationLabel: "Stellar Testnet",
    evmMcpNetwork: "avalanche-fuji",
    evmChainId: 43113,
    defaultApiUrl: "http://192.168.1.57:8787",
  },
  mainnet: {
    mode: "mainnet",
    source: "eip155:43114",
    destination: "stellar:pubnet",
    sourceLabel: "Avalanche C-Chain",
    destinationLabel: "Stellar Public Network",
    evmMcpNetwork: "avalanche",
    evmChainId: 43114,
    // The `tilcai-mainnet` container listens on loopback only (deploy/docker-compose.mainnet.yml).
    defaultApiUrl: "http://127.0.0.1:18787",
  },
};

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkMode {
  const v = (env.TILCAI_NETWORK ?? "testnet").trim().toLowerCase();
  if (v === "testnet" || v === "mainnet") return v;
  throw new Error(`TILCAI_NETWORK must be "testnet" or "mainnet", got "${env.TILCAI_NETWORK}"`);
}

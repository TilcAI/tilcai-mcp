import { randomUUID } from "node:crypto";
import { modeFromEnv, ROUTES, type NetworkMode } from "./networks.ts";

export interface TilcaiConfig {
  mode: NetworkMode;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TilcaiConfig {
  const mode = modeFromEnv(env);
  return {
    mode,
    baseUrl: (env.TILCAI_API_URL ?? ROUTES[mode].defaultApiUrl).replace(/\/+$/, ""),
    apiKey: env.TILCAI_API_KEY ?? "",
    timeoutMs: Number(env.TILCAI_TIMEOUT_MS ?? 20_000),
  };
}

/** A non-2xx answer from TilcAI, keeping its `tilcai-shared-v1` envelope (`code`, `message`, `recovery`). */
export class TilcaiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
  }
}

export class TilcaiClient {
  constructor(private readonly cfg: TilcaiConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; idempotencyKey?: string; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth !== false) {
      if (!this.cfg.apiKey) throw new TilcaiError(0, "NO_API_KEY", "TILCAI_API_KEY is not set for tilcai-mcp", "CONFIGURE");
      headers.authorization = `Bearer ${this.cfg.apiKey}`;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new TilcaiError(0, "UNREACHABLE", `cannot reach TilcAI at ${this.cfg.baseUrl}: ${(e as Error).message}`, "RETRY");
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const env = (json as { error?: { code?: string; message?: string; recovery?: string } }).error;
      throw new TilcaiError(res.status, env?.code ?? `HTTP_${res.status}`, env?.message ?? text.slice(0, 300), env?.recovery);
    }
    return json as T;
  }

  health() {
    return this.call<Record<string, unknown>>("GET", "/health", { auth: false });
  }
  routes() {
    return this.call<unknown>("GET", "/v1/routes");
  }
  quote(body: { sourceNetwork: string; destinationNetwork: string; amount: string; payTo: string }) {
    return this.call<{ quote: Record<string, unknown> }>("POST", "/v1/crosschain/quotes", { body });
  }
  createPayment(body: { quoteId: string; mode: "gasless" | "external"; payer: string; orderId?: string }, idempotencyKey: string = randomUUID()) {
    return this.call<PaymentResponse>("POST", "/v1/crosschain/payments", { body, idempotencyKey });
  }
  submitAuthorization(paymentId: string, signature: string) {
    return this.call<{ payment: Record<string, unknown> }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/authorization`, { body: { signature } });
  }
  submitBurn(paymentId: string, txHash: string) {
    return this.call<{ payment: Record<string, unknown> }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/burn`, { body: { txHash } });
  }
  payment(paymentId: string) {
    return this.call<Record<string, unknown>>("GET", `/v1/crosschain/payments/${enc(paymentId)}`);
  }
  reconcile(paymentId: string) {
    return this.call<{ payment: Record<string, unknown> }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/reconcile`, { body: {} });
  }
}

const enc = encodeURIComponent;

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface UnsignedCall {
  chainId: number;
  to: string;
  data: string;
  value: string;
  description: string;
}

export interface PaymentResponse {
  payment: Record<string, unknown> & { id: string; state: string };
  unsignedCalls: UnsignedCall[];
  authorization?: { router: string; nonce: string; validBefore: string | number; typedData: TypedData };
  next: string;
}

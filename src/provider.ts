import { ActionProvider, EvmWalletProvider, type Action, type Network } from "@coinbase/agentkit";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client, type PaymentPolicy } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { z } from "zod";
import {
  checkWalletSchema, preflightActionSchema, simulateTransactionSchema, tokenSecurityAuditSchema, whaleActivitySchema,
} from "./schemas.js";

export const DEFAULT_BASE_URL = "https://mcp.dropenginehq.com";
export const PAYMENT_NETWORK = "eip155:8453";
export const VERSION = "0.1.0";

export type DropEngineActionName =
  | "analyze_whale_activity" | "simulate_transaction" | "token_security_audit" | "check_wallet" | "preflight_action";

export interface DropEngineActionProviderConfig {
  /** Service origin. Defaults to the hosted DropEngine service. */
  baseUrl?: string;
  /** Hard cap per call in USD, enforced by the x402 client before signing. Default 0.05. */
  maxPaymentUsd?: number;
  /** Expose only these actions. Default: all five. */
  actions?: DropEngineActionName[];
  /** Per-call timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Fetch implementation (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

type Definition = {
  name: DropEngineActionName;
  path: string;
  priceUsd: number;
  schema: z.ZodTypeAny;
  description: string;
  body: (args: Record<string, unknown>, wallet: EvmWalletProvider) => Record<string, unknown>;
};

const DEFINITIONS: Definition[] = [
  {
    name: "analyze_whale_activity",
    path: "/api/analyze-whale-activity",
    priceUsd: 0.02,
    schema: whaleActivitySchema,
    description: `Whale activity before a trade. mode "asset": recent large DEX trades of one token (indexed public pool trades) on solana, ethereum, base, arbitrum, optimism or polygon, filtered by window and minimum USD size, with estimated buy and sell volume. mode "wallet": recent large activity of one address. Use it to see accumulation or distribution before buying or selling. Paid per call: $0.02 USDC on Base from this wallet via x402.`,
    body: (args) => args,
  },
  {
    name: "simulate_transaction",
    path: "/api/simulate-transaction",
    priceUsd: 0.02,
    schema: simulateTransactionSchema,
    description: `Simulate an EVM transaction on Base before signing or sending it: whether it would revert (with the revert reason), estimated gas, native balance changes, token approvals including unlimited ones, contract reputation, warnings and an allow / caution / block recommendation. "from" defaults to this wallet; "value" (wei) defaults to 0 and "data" to 0x. Nothing is signed or broadcast. Paid per call: $0.02 USDC on Base from this wallet via x402.`,
    body: (args, wallet) => ({
      chain: args.chain,
      from: args.from ?? wallet.getAddress(),
      to: args.to,
      value: args.value ?? "0",
      data: args.data ?? "0x",
    }),
  },
  {
    name: "token_security_audit",
    path: "/api/token-security-audit",
    priceUsd: 0.01,
    schema: tokenSecurityAuditSchema,
    description: `Security audit of an ERC-20 token contract before buying, swapping or approving it: honeypot, buy and sell tax, mintable, proxy, hidden or changeable owner, blacklist and holder-count signals where the data provider has them, with a caution-level recommendation when coverage is partial. Chains: ethereum, base, arbitrum, optimism, polygon, bsc. Paid per call: $0.01 USDC on Base from this wallet via x402.`,
    body: (args) => args,
  },
  {
    name: "check_wallet",
    path: "/api/check-wallet",
    priceUsd: 0.02,
    schema: checkWalletSchema,
    description: `Risk check of a counterparty address on Base before sending it funds or interacting with it: wallet or contract (verified, proxy), transaction count, and sanctions, phishing, theft and malicious-contract flags reported by GoPlus where available. Paid per call: $0.02 USDC on Base from this wallet via x402.`,
    body: (args) => args,
  },
  {
    name: "preflight_action",
    path: "/api/preflight-action",
    priceUsd: 0.02,
    schema: preflightActionSchema,
    description: `One ALLOW / REVIEW / REQUIRE_APPROVAL / DENY decision before a risky action (a transaction, token or wallet interaction, a purchase, opening a URL, installing a package). Runs the checks relevant to the given target server-side and never signs or broadcasts. Paid per call: $0.02 USDC on Base from this wallet via x402.`,
    body: (args) => ({ ...args, target: args.target ?? {} }),
  },
];

/** Keeps the model-facing result small: drops the service's agent UX envelope. */
function compact(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { agent_ux: _envelope, ...rest } = result as Record<string, unknown>;
  void _envelope;
  return rest;
}

/**
 * AgentKit action provider for DropEngine's paid crypto due-diligence tools.
 * Each call pays the quoted x402 price in USDC on Base from the agent's EVM wallet.
 */
export class DropEngineActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly baseUrl: string;
  private readonly maxPaymentUsd: number;
  private readonly selected: Set<DropEngineActionName>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DropEngineActionProviderConfig = {}) {
    super("dropengine", []);
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxPaymentUsd = config.maxPaymentUsd ?? 0.05;
    if (!(this.maxPaymentUsd > 0)) throw new Error("maxPaymentUsd must be greater than 0");
    this.selected = new Set(config.actions ?? DEFINITIONS.map((definition) => definition.name));
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Payment is made on Base; any EVM wallet whose key holds USDC on Base can pay. */
  supportsNetwork = (network: Network): boolean => network.protocolFamily === "evm";

  override getActions(walletProvider: EvmWalletProvider): Action[] {
    return DEFINITIONS.filter((definition) => this.selected.has(definition.name)).map((definition) => ({
      name: `DropEngineActionProvider_${definition.name}`,
      description: definition.description,
      schema: definition.schema,
      invoke: (args: Record<string, unknown>) => this.call(walletProvider, definition, args),
    }));
  }

  private paymentClient(walletProvider: EvmWalletProvider): x402Client {
    const account = walletProvider.toSigner();
    const signer = {
      ...account,
      readContract: (args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) =>
        walletProvider.readContract({
          address: args.address,
          abi: args.abi as never,
          functionName: args.functionName as never,
          args: args.args as never,
        }),
    };
    const client = new x402Client();
    registerExactEvmScheme(client, { signer, networks: [PAYMENT_NETWORK] });
    client.setSpendControls({ maxAmountPerPayment: `$${this.maxPaymentUsd}` });
    const baseMainnetOnly: PaymentPolicy = (_version, requirements) =>
      requirements.filter((requirement) => requirement.scheme === "exact" && requirement.network === PAYMENT_NETWORK);
    client.registerPolicy(baseMainnetOnly);
    return client;
  }

  private async call(walletProvider: EvmWalletProvider, definition: Definition, rawArgs: Record<string, unknown>): Promise<string> {
    if (!(walletProvider instanceof EvmWalletProvider)) {
      return JSON.stringify({ error: true, message: "DropEngine actions need an EVM wallet provider holding USDC on Base." });
    }
    let args: Record<string, unknown>;
    try {
      args = definition.schema.parse(rawArgs) as Record<string, unknown>;
    } catch (error) {
      return JSON.stringify({ error: true, code: "INVALID_INPUT", message: error instanceof Error ? error.message : "Invalid input" });
    }
    if (definition.priceUsd > this.maxPaymentUsd) {
      return JSON.stringify({ error: true, code: "PRICE_ABOVE_LIMIT", message: `${definition.name} costs $${definition.priceUsd}, above maxPaymentUsd $${this.maxPaymentUsd}.` });
    }

    const paidFetch = wrapFetchWithPayment(this.fetchImpl, this.paymentClient(walletProvider));
    let response: Response;
    try {
      response = await paidFetch(`${this.baseUrl}${definition.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-attribution-source": "agentkit" },
        body: JSON.stringify(definition.body(args, walletProvider)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      // The x402 client throws this before anything is signed: the cap or the Base-only policy refused the offer.
      if (message.includes("Failed to create payment payload")) {
        return JSON.stringify({
          error: true,
          code: "PAYMENT_REFUSED",
          message: message.slice(0, 300),
          payment_state: "not_charged",
          instruction: "No payment was signed. The offer exceeded maxPaymentUsd or was not USDC on Base mainnet.",
        });
      }
      return JSON.stringify({
        error: true,
        code: "PAYMENT_OR_NETWORK_ERROR",
        message: message.slice(0, 300),
        payment_state: "unknown",
        instruction: "Do not retry automatically; check the wallet's USDC balance and recent transfers first.",
      });
    }

    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }

    let payment: { transaction?: string; network?: string; amount_usd: number } | null = null;
    const receipt = response.headers.get("payment-response");
    if (receipt) {
      try {
        const decoded = decodePaymentResponseHeader(receipt) as { transaction?: string; network?: string };
        payment = { transaction: decoded.transaction, network: decoded.network, amount_usd: definition.priceUsd };
      } catch { /* the result is still useful without the receipt */ }
    }

    if (!response.ok) {
      const error = body && typeof body === "object" ? (body as { error?: { code?: string; message?: string } }).error : undefined;
      return JSON.stringify({
        error: true,
        status: response.status,
        code: error?.code ?? `HTTP_${response.status}`,
        message: error?.message ?? (response.status === 402 ? "Payment was not accepted; check the wallet holds enough USDC on Base." : "DropEngine request failed"),
        payment_state: payment ? "charged" : response.status === 400 || response.status === 402 ? "not_charged" : "unknown",
      });
    }
    return JSON.stringify({ action: definition.name, result: compact(body), payment });
  }
}

export const dropengineActionProvider = (config?: DropEngineActionProviderConfig) => new DropEngineActionProvider(config);

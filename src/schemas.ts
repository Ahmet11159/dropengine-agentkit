import { z } from "zod";

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be a 0x-prefixed 20-byte EVM address");

export const whaleActivitySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("asset").describe("Large transfers of one token"),
    chain: z.enum(["solana", "ethereum", "base", "arbitrum", "optimism", "polygon"]),
    asset: z.string().min(1).max(90).describe("Token mint (Solana) or contract address (EVM)"),
    window: z.enum(["5m", "15m", "1h", "4h", "24h"]).optional().describe("Lookback window, default 1h"),
    min_transaction_usd: z.number().min(1).max(1_000_000_000).optional().describe("Minimum transfer size in USD, default 100000"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum transfers returned, default 50"),
  }).strict(),
  z.object({
    mode: z.literal("wallet").describe("Recent large activity of one wallet"),
    chain: z.enum(["solana", "ethereum", "base", "arbitrum", "optimism", "polygon"]),
    address: z.string().min(1).max(128).describe("Wallet address to inspect"),
  }).strict(),
]);

export const simulateTransactionSchema = z.object({
  chain: z.enum(["base", "base-sepolia"]).describe("Chain to simulate on"),
  from: evmAddress.optional().describe("Sender; defaults to the agent's own wallet address"),
  to: evmAddress.describe("Contract or recipient address"),
  value: z.string().regex(/^(?:0|[1-9]\d*)$/).max(78).optional().describe("Native value in wei as a decimal string, default 0"),
  data: z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).max(131_074).optional().describe("Calldata hex, default 0x"),
}).strict();

export const tokenSecurityAuditSchema = z.object({
  chain: z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"]),
  token_address: evmAddress.describe("Token contract address"),
}).strict();

export const checkWalletSchema = z.object({
  chain: z.enum(["base", "base-sepolia"]),
  address: evmAddress.describe("Counterparty wallet to check before sending funds or interacting"),
}).strict();

export const preflightActionSchema = z.object({
  action_type: z.enum(["transaction", "token_interaction", "wallet_interaction", "purchase", "open_url", "install_package", "use_external_content", "tool_call", "custom"]),
  intent: z.string().min(3).max(500).describe("What the agent is about to do and why"),
  target: z.object({
    url: z.string().url().max(4096).optional(),
    package: z.string().min(1).max(214).optional(),
    content: z.string().min(1).max(100_000).optional(),
    wallet: evmAddress.optional(),
    token: z.object({ chain: z.string().max(32), token_address: z.string().max(128) }).strict().optional(),
    transaction: z.object({ chain: z.string().max(32), from: z.string().max(128), to: z.string().max(128), value: z.string().max(128), data: z.string().max(200_000) }).strict().optional(),
  }).strict().optional(),
}).strict();

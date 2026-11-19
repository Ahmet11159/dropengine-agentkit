// Manual check, not part of the test suite: `npx tsx scripts/live-unpaid-check.ts`.
// Sends each action's unpaid request to the live API (valid input answers 402), lets the
// x402 client sign the payment locally with a throwaway key, and never sends the signed request.
import { EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { dropengineActionProvider } from "../src/index.js";

class ThrowawayWallet extends EvmWalletProvider {
  private readonly account = privateKeyToAccount(generatePrivateKey());
  getAddress() { return this.account.address; }
  getNetwork(): Network { return { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }; }
  getName() { return "throwaway"; }
  async getBalance() { return 0n; }
  async nativeTransfer(): Promise<string> { throw new Error("unused"); }
  async sign(hash: `0x${string}`) { return this.account.sign({ hash }); }
  async signMessage(message: string | Uint8Array) { return this.account.signMessage({ message: typeof message === "string" ? message : { raw: message } }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(typedData: any) { return this.account.signTypedData(typedData); }
  async signTransaction(): Promise<`0x${string}`> { throw new Error("unused"); }
  async sendTransaction(): Promise<`0x${string}`> { throw new Error("unused"); }
  async waitForTransactionReceipt() { throw new Error("unused"); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async readContract(): Promise<any> { throw new Error("unexpected RPC"); }
  getPublicClient(): PublicClient { throw new Error("unused"); }
}
Object.defineProperty(ThrowawayWallet.prototype, "trackInitialization", { value() {} });

const log: string[] = [];
const guardedFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const url = input instanceof Request ? input.url : String(input);
  const signature = headers.get("payment-signature");
  if (signature) {
    const payment = decodePaymentSignatureHeader(signature) as unknown as { payload: { authorization: { value: string; to: string } } };
    log.push(`  signed locally, NOT sent: value=${payment.payload.authorization.value} to=${payment.payload.authorization.to.slice(0, 8)}…`);
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_SENT", message: "check stopped before paying" } }), { status: 418 });
  }
  const response = await fetch(input, init);
  log.push(`  ${new URL(url).pathname} unpaid -> HTTP ${response.status}`);
  return response;
};

const wallet = new ThrowawayWallet();
const actions = dropengineActionProvider({ fetch: guardedFetch }).getActions(wallet);
const inputs: Record<string, Record<string, unknown>> = {
  analyze_whale_activity: { mode: "asset", chain: "solana", asset: "So11111111111111111111111111111111111111112", window: "1h" },
  simulate_transaction: { chain: "base", to: "0x833589fCD6eDb6E08f4c7C32D4F71b54bdA02913" },
  token_security_audit: { chain: "base", token_address: "0x833589fCD6eDb6E08f4c7C32D4F71b54bdA02913" },
  check_wallet: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4F71b54bdA02913" },
  preflight_action: { action_type: "token_interaction", intent: "Swap USDC for a new token", target: { token: { chain: "base", token_address: "0x833589fCD6eDb6E08f4c7C32D4F71b54bdA02913" } } },
};
for (const action of actions) {
  const short = action.name.replace("DropEngineActionProvider_", "");
  log.length = 0;
  const output = JSON.parse(await action.invoke(inputs[short]));
  console.log(`${short}:\n${log.join("\n")}\n  result: ${output.code ?? "ok"} payment_state=${output.payment_state ?? "-"}`);
}

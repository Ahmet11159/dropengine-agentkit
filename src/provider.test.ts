import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { verifyTypedData, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DropEngineActionProvider, dropengineActionProvider } from "./index.js";

/** Local-key EVM wallet with no RPC and no AgentKit initialization telemetry. */
class TestWallet extends EvmWalletProvider {
  private readonly account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  getAddress() { return this.account.address; }
  getNetwork(): Network { return { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }; }
  getName() { return "test_wallet"; }
  async getBalance() { return 0n; }
  async nativeTransfer(): Promise<string> { throw new Error("not used in tests"); }
  async sign(hash: `0x${string}`) { return this.account.sign({ hash }); }
  async signMessage(message: string | Uint8Array) { return this.account.signMessage({ message: typeof message === "string" ? message : { raw: message } }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(typedData: any) { return this.account.signTypedData(typedData); }
  async signTransaction(): Promise<`0x${string}`> { throw new Error("not used in tests"); }
  async sendTransaction(): Promise<`0x${string}`> { throw new Error("not used in tests"); }
  async waitForTransactionReceipt() { throw new Error("not used in tests"); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async readContract(): Promise<any> { throw new Error("payment must not need an RPC call"); }
  getPublicClient(): PublicClient { throw new Error("not used in tests"); }
}
Object.defineProperty(TestWallet.prototype, "trackInitialization", { value() { /* no telemetry in tests */ } });

// Local stand-in for the DropEngine API: answers an unpaid POST with the same x402 v2
// challenge shape production sends, then checks the signed payment on the retry.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x00000000000000000000000000000000000000AA";
const TX = `0x${"ab".repeat(32)}`;

type Seen = { path: string; body: unknown; headers: IncomingMessage["headers"]; payment?: Record<string, unknown> };
let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
let challenge = { amount: "20000", network: "eip155:8453" };

function challengeFor(path: string) {
  return {
    x402Version: 2,
    resource: { url: `${baseUrl}${path}`, description: "test resource", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: challenge.network, amount: challenge.amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
  };
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "/";
  const body = await readBody(req);
  const signature = req.headers["payment-signature"];
  if (!signature) {
    seen.push({ path, body, headers: req.headers });
    const required = challengeFor(path);
    res.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(required as never) });
    res.end(JSON.stringify(required));
    return;
  }
  const payment = decodePaymentSignatureHeader(String(signature)) as unknown as Record<string, unknown>;
  seen.push({ path, body, headers: req.headers, payment });
  res.writeHead(200, {
    "content-type": "application/json",
    "payment-response": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:8453", payer: "0x" } as never),
  });
  res.end(JSON.stringify({ success: true, tool: path, data: { ok: true }, agent_ux: { large: "envelope" } }));
}

function wallet() {
  return new TestWallet();
}

beforeAll(async () => {
  server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function action(provider: DropEngineActionProvider, w: TestWallet, name: string) {
  const found = provider.getActions(w).find((a) => a.name === `DropEngineActionProvider_${name}`);
  if (!found) throw new Error(`missing action ${name}`);
  return found;
}

describe("DropEngineActionProvider", () => {
  it("exposes five priced actions and supports EVM networks only", () => {
    const provider = dropengineActionProvider();
    const actions = provider.getActions(wallet());
    expect(actions.map((a) => a.name)).toEqual([
      "DropEngineActionProvider_analyze_whale_activity",
      "DropEngineActionProvider_simulate_transaction",
      "DropEngineActionProvider_token_security_audit",
      "DropEngineActionProvider_check_wallet",
      "DropEngineActionProvider_preflight_action",
    ]);
    for (const a of actions) expect(a.description).toMatch(/\$0\.0\d USDC on Base/);
    expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" })).toBe(true);
    expect(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" })).toBe(false);
    expect(dropengineActionProvider({ actions: ["check_wallet"] }).getActions(wallet()).map((a) => a.name)).toEqual(["DropEngineActionProvider_check_wallet"]);
  });

  it("pays the quoted $0.02 from the agent wallet with a valid USDC authorization", async () => {
    challenge = { amount: "20000", network: "eip155:8453" };
    seen.length = 0;
    const w = wallet();
    const provider = dropengineActionProvider({ baseUrl });
    const output = JSON.parse(await action(provider, w, "simulate_transaction").invoke({ chain: "base", to: "0x1111111111111111111111111111111111111111" }));

    expect(output).toMatchObject({ action: "simulate_transaction", payment: { transaction: TX, network: "eip155:8453", amount_usd: 0.02 } });
    expect(output.result).toEqual({ success: true, tool: "/api/simulate-transaction", data: { ok: true } });
    expect(seen).toHaveLength(2);
    expect(seen[0].body).toEqual({ chain: "base", from: w.getAddress(), to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x" });
    expect(seen[0].headers["x-attribution-source"]).toBe("agentkit");

    const payload = seen[1].payment!.payload as { authorization: Record<string, string>; signature: `0x${string}` };
    const auth = payload.authorization;
    expect(auth.from.toLowerCase()).toBe(w.getAddress().toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.value).toBe("20000");
    const valid = await verifyTypedData({
      address: w.getAddress() as `0x${string}`,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
      signature: payload.signature,
    });
    expect(valid).toBe(true);
  });

  it("refuses to sign above the per-call cap", async () => {
    challenge = { amount: "100000", network: "eip155:8453" };
    seen.length = 0;
    const output = JSON.parse(await action(dropengineActionProvider({ baseUrl, maxPaymentUsd: 0.05 }), wallet(), "check_wallet").invoke({ chain: "base", address: "0x1111111111111111111111111111111111111111" }));
    expect(output).toMatchObject({ error: true, code: "PAYMENT_REFUSED", payment_state: "not_charged" });
    expect(seen.every((s) => !s.payment)).toBe(true);
  });

  it("refuses to pay on any network other than Base mainnet", async () => {
    challenge = { amount: "20000", network: "eip155:84532" };
    seen.length = 0;
    const output = JSON.parse(await action(dropengineActionProvider({ baseUrl }), wallet(), "token_security_audit").invoke({ chain: "base", token_address: USDC }));
    expect(output).toMatchObject({ error: true, code: "PAYMENT_REFUSED", payment_state: "not_charged" });
    expect(seen.every((s) => !s.payment)).toBe(true);
  });

  it("blocks actions priced above the cap before any request", async () => {
    seen.length = 0;
    const output = JSON.parse(await action(dropengineActionProvider({ baseUrl, maxPaymentUsd: 0.01 }), wallet(), "analyze_whale_activity").invoke({ mode: "asset", chain: "base", asset: USDC }));
    expect(output).toMatchObject({ error: true, code: "PRICE_ABOVE_LIMIT" });
    expect(seen).toHaveLength(0);
  });

  it("rejects invalid input without a request", async () => {
    seen.length = 0;
    const output = JSON.parse(await action(dropengineActionProvider({ baseUrl }), wallet(), "check_wallet").invoke({ chain: "base", address: "not-an-address" }));
    expect(output).toMatchObject({ error: true, code: "INVALID_INPUT" });
    expect(seen).toHaveLength(0);
  });
});

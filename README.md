# dropengine-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for crypto due diligence. It gives your agent five actions it can call before it trades, signs or sends funds:

| Action | Use it before | Price |
|---|---|---|
| `analyze_whale_activity` | buying or selling a token: recent large DEX trades and estimated buy/sell volume, or one wallet's large activity | $0.02 |
| `simulate_transaction` | signing or sending a Base transaction: revert reason, gas, balance changes, approvals (incl. unlimited), contract reputation, allow / caution / block | $0.02 |
| `token_security_audit` | buying, swapping or approving a token: honeypot, buy/sell tax, mintable, proxy, owner and blacklist signals | $0.01 |
| `check_wallet` | sending funds to or interacting with an address: contract vs wallet, activity, sanctions and theft/phishing flags | $0.02 |
| `preflight_action` | any risky action: one ALLOW / REVIEW / REQUIRE_APPROVAL / DENY decision from the relevant checks | $0.02 |

There is no account or API key. Each call is paid with [x402](https://x402.org) in USDC on Base, from the agent's own wallet. Nothing is ever signed or broadcast on the agent's behalf except that payment.

## Install

```bash
npm install dropengine-agentkit @coinbase/agentkit zod
```

Requires Node.js 20+ and `@coinbase/agentkit` 0.10.x. Works from ESM and CommonJS.

## Use

```ts
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { dropengineActionProvider } from "dropengine-agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// A dedicated agent wallet holding a little USDC on Base. Never use a treasury key.
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const walletProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http() }));

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [dropengineActionProvider({ maxPaymentUsd: 0.05 })],
});
```

Then hand the actions to your framework as usual, for example `getLangChainTools(agentkit)` from `@coinbase/agentkit-langchain` or `getVercelAITools(agentkit)` from `@coinbase/agentkit-vercel-ai-sdk`. Action names are prefixed, e.g. `DropEngineActionProvider_simulate_transaction`.

`simulate_transaction` defaults `from` to the agent's own address, `value` to `0` and `data` to `0x`, so a model only has to supply `chain` and `to`.

## Options

| Option | Default | |
|---|---|---|
| `maxPaymentUsd` | `0.05` | Hard per-call cap. The x402 client refuses to sign anything above it, and actions priced above it are not called at all. |
| `actions` | all five | Expose a subset, e.g. `["simulate_transaction", "token_security_audit"]`. |
| `baseUrl` | `https://mcp.dropenginehq.com` | |
| `timeoutMs` | `30000` | |

Payments are only signed for the `exact` scheme on Base mainnet (`eip155:8453`); offers on any other network are refused. The wallet needs USDC on Base even if the agent works on another EVM chain.

## Results and errors

Every action returns a JSON string. On success:

```json
{ "action": "simulate_transaction", "result": { "...": "service response" }, "payment": { "transaction": "0x…", "network": "eip155:8453", "amount_usd": 0.02 } }
```

On failure it returns `{ "error": true, "code": "...", "message": "...", "payment_state": "..." }` instead of throwing:

| `payment_state` | Meaning |
|---|---|
| `not_charged` | Nothing was paid: invalid input, an offer above `maxPaymentUsd` or not on Base, or a rejected request. Safe to fix and retry. |
| `charged` | The payment settled but the check failed. Treat the target as unverified. |
| `unknown` | Timeout or network error during the paid request. Check the wallet's recent USDC transfers before retrying. |

## What is sent

The action input (token or wallet address, transaction fields, intent) is sent to `mcp.dropenginehq.com`, with the header `X-Attribution-Source: agentkit`. The x402 payment reveals the paying wallet's address, as any on-chain payment does. This package sends no telemetry of its own; AgentKit's wallet providers have their own initialization analytics, documented by Coinbase.

Results are risk signals from public data sources, not guarantees. A clean result does not prove a token, contract or address is safe.

## Tested

The test suite runs the full payment flow against a local x402 server: the provider signs a USDC `TransferWithAuthorization` for exactly the quoted price with the agent's key, and the signature is verified against USDC's EIP-712 domain on Base. It also checks that offers above the cap and on other networks are refused before signing. Tested with a local-key EVM wallet; smart-contract wallets depend on the facilitator's support for their signatures.

## Related

- [dropengine-agent-safety](https://github.com/Ahmet11159/dropengine-agent-safety): framework-neutral SDK for URL, prompt-injection and npm package checks.
- The same tools are available as an MCP server at `https://mcp.dropenginehq.com/api/agent-services`.

## License

MIT

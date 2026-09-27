# skitty - sui reclaimer

react app that lets you connect your wallet (or paste any sui address) and scan for reclaimable SUI stuck in storage rebates. merge coins, close empty kiosks, burn spam NFTs - and get most of that rebate back (99%; 1% is burned by the protocol).

## what it does

- **merge coins** - finds multiple `0x2::coin::Coin<T>` per type and merges them so you get the rebate.
- **empty kiosks** - finds empty `0x2::kiosk::Kiosk` and closes them via your `KioskOwnerCap` (only if you own the cap and the kiosk holds no items). any profits sitting in the kiosk are paid out to you.
- **burnable stuff** - supports known burn/delete entry points (add more in `src/constants.ts`) and tries to discover burn functions via RPC for other types. discovered burns are matched by function name alone, so they're flagged unverified in the UI and need an explicit confirmation - skitty cannot tell a spam token from a valuable NFT.
- **analysis** - lists every cleanup action with object count, IDs, and estimated user rebate.
- **dry run** - simulates the tx before you sign so you see net SUI gain vs gas.
- **feed skitty** - when viewing the raw simulation, you can have skitty (powered by Gemini) explain the txn in plain language. rate limited per minute and per day so the cat doesn’t get exhausted.
- **eats a small fee** - for now it takes a 13.69% fee, since the amounts are so smol as it is.
- **gas sponsor** - the wallet that receives fees, sponsors the gas. this allows a wallet w no sui to burn and get sui.
- **self-paid fallback** - when the sponsor wallet cannot pay gas, the app keeps working and the connected wallet pays its own gas. A banner states that the sponsor is out of SUI and shows its address; wallets holding no SUI cannot run cleanups until the sponsor is topped up.


## tech stack

- react 18 + typescript + vite
- `@mysten/sui` (client + transactions)
- `@mysten/dapp-kit` (wallet, signing)
- tailwind (skitty-themed styling)
- api: serverless (Vercel); explain endpoint uses Gemini + Upstash Redis for rate limits

## run it locally

**frontend only** (no explain API):

```bash
npm install
npm run dev
```

open [http://localhost:5173](http://localhost:5173). scan, merge, close kiosks, burn - all good. the “feed skitty” explain button will fail without the API. Without the API the sponsor status check also fails, so the app runs in self-paid mode and the connected wallet pays its own gas.

**full local (including explain API)**

the explain feature lives in `api/explain.js` and only runs when the app is served through Vercel’s dev server. so:

1. install the Vercel CLI if you haven’t: `npm i -g vercel`
2. link the project to Vercel (one-time): `vercel link` - follow the prompts (create/link to a project, pick your scope).
3. in the project root, run:

```bash
vercel dev
```

this starts the Vite app and the serverless API together. use the URL it prints (usually same port or the one Vercel assigns). now “feed skitty” works locally.

there’s a `vercel.json` in the repo (build output, rewrites if needed). with `vite-plugin-vercel`, the plugin handles output and API routes; avoid rewrites that conflict with the dev server (e.g. a catch-all to `index.html`).

**env for the API**

create a `.env.local` (or set env in Vercel dashboard for prod). the API needs:

- `GEMINI_API_KEY` - for the explain endpoint (Gemini).
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` (injected by the Vercel Marketplace Upstash integration), or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for a manually configured instance. The Marketplace names take precedence. Used for rate limiting on both endpoints and gas-coin reservation for the sponsor. Without them the sponsor selects a random coin from its pool and neither endpoint is rate limited, so configure them for any public deployment.
- `SUI_SPONSOR_PRIV` - **hot private key** (`suiprivkey...` or base64) for the wallet that pays gas. use a dedicated wallet holding only what you're willing to front, and keep its address equal to `FEE_RECIPIENT` in `src/constants.ts` - the sponsor only signs transactions where value goes to the sender or to itself, so a mismatch makes every sponsored transaction fail. without it `/api/sponsor` returns 503 and the app falls back to self-paid gas.
- `ALLOWED_ORIGINS` (optional) - comma-separated extra origins allowed to call the API. same-origin and localhost are always allowed.
- `SPONSOR_DEBUG` (optional) - set to `1` to include the underlying error message in `/api/sponsor` 500 responses. Leave unset in production.

### Funding the sponsor wallet

The sponsor pays gas from a `Coin<SUI>` **object**, and it needs one coin holding at least `SPONSOR_GAS_BUDGET_MIST` (0.05 SUI) plus the payout of the batch being sponsored. SUI held as an **address balance** cannot pay gas for this application:

- Wallets treat the empty gas payment that address-balance gas requires as "no gas selected" and re-resolve it against the sender, which fails for users who hold no SUI.
- Simulation does not check an empty gas payment against the payer, so the sponsor's balance gate could not verify the transaction.
- The protocol includes a switch (`address_balance_gas_reject_gas_coin_arg`) that rejects a `GasCoin` argument alongside address-balance gas, and the sponsored transaction relies on that argument to pay the user their share.

A transfer from a modern wallet frequently arrives as an address balance rather than as a coin object. Check with `getBalance`: `coinBalance` is the usable coin-object portion and `addressBalance` is the accumulator portion.

**Automatic conversion.** Anyone may top up the sponsor, since its address is displayed whenever it cannot pay, so the server converts address balances itself. When the sponsor has no usable coin and its address balance could produce one, both `GET /api/sponsor` and `POST /api/sponsor` submit a conversion transaction signed by the sponsor: it withdraws the address balance (minus the conversion's own gas budget of 0.005 SUI), redeems it as a `Coin<SUI>` through `0x2::coin::redeem_funds`, and transfers the coin back to the sponsor. The status response that performed the conversion already reports the sponsor as funded, so users switch back to sponsored gas on their next status check.

Conversion is deliberately conservative:

- It only runs when no existing coin covers the gas budget (plus the payout, on the signing path), and only when the resulting coin would hold at least `SPONSOR_MIN_CONVERSION_MIST` (0.06 SUI). A top-up below about 0.065 SUI is left alone until more arrives.
- The transaction is simulated before it is signed, so a conversion that would fail costs nothing.
- A lock (`sponsor_conversion` in Redis, or a per-instance fallback without it) allows one attempt at a time for `SPONSOR_CONVERSION_LOCK_SECONDS`. After a failure, attempts pause for `SPONSOR_CONVERSION_BACKOFF_SECONDS` (15 minutes).
- It is safe to trigger from an unauthenticated request because the transaction can only move the sponsor's own SUI from its address balance into a coin the sponsor owns.

Self-paid fees (see below) are deposited into the sponsor's address balance as well, so a sponsor that runs dry refills itself once enough fees accumulate.

**Manual conversion.** `scripts/materialize-gas-coin.mjs` builds the same transaction (both use `lib/sponsorGasCoin.js`) for converting a specific amount by hand. Run it with `SUI_SPONSOR_PRIV` in the environment (for example through `node --env-file`, pointing at a file you delete afterwards):

```bash
node scripts/materialize-gas-coin.mjs
```

The script only simulates by default. Add `--execute` to submit, and `--amount <mist>` to change the amount (default 0.3 SUI).

### When the sponsor cannot pay

`GET /api/sponsor` reports whether the sponsor can pay gas: `{ funded, reason, sponsorAddress }`, where `reason` is one of `ok`, `empty`, `address_balance` (convertible, and not converted yet), `too_little` (holds SUI, but not enough to pay gas in any form), `not_configured` or `unreachable`. The response is cached at the edge for 15 seconds. The client polls it every minute, and `POST /api/sponsor` returns a 503 with a machine-readable `code` when the sponsor refuses mid-flow:

| code | meaning | client behaviour |
| --- | --- | --- |
| `sponsor_unfunded` | no coin can pay the gas budget, and converting the address balance did not help | switches to self-paid gas immediately |
| `sponsor_not_configured` | `SUI_SPONSOR_PRIV` is missing | switches to self-paid gas immediately |
| `sponsor_insufficient` | funded, but not for this batch's payout | shows the error; a smaller batch can still be sponsored |
| `sponsor_busy` | every funded coin is reserved | shows the error; retry shortly |

In self-paid mode the connected wallet is the gas owner and nothing is co-signed. Gas comes from exactly one source, whichever holds more: the wallet's `Coin<SUI>` objects (pinned as the gas payment, with the fee split from `tx.gas`), or its address balance (an empty gas payment, with the fee drawn through `tx.withdrawal`, which never references `tx.gas`). The fee is sent to `FEE_RECIPIENT` with `send_funds` rather than as a new coin object, because a coin would charge the user roughly 988,000 mist of storage, which exceeds the fee on a small batch. The fee is capped at what the chosen source holds after the gas budget, and waived when the batch does not cover its own gas. The planner measures gas with a draft simulation, sets the budget to 1.5 times the measured cost (minimum `SELF_PAY_MIN_GAS_BUDGET_MIST`, 0.003 SUI), and simulates the final transaction again before the wallet is asked to sign. A wallet holding less than the minimum budget cannot run cleanups in this mode, and the UI blocks execution with an explanation.

## build and test

```bash
npm run build
npm run preview
```

```bash
npm test
npm run lint
```

## project layout

- `src/ReclaimDashboard.tsx` - main UI: address input, SuiNS resolve, scan, action list, dry run, execute, feed skitty.
- `src/useGraphQLScanner.ts` - hook that uses GraphQL to find mergeable coins, empty kiosks, and burnable objects.
- `src/graphql/client.ts` - the single Sui client the whole app shares, plus SuiNS resolution (see the JSON-RPC note below).
- `src/buildCleanupTransaction.ts` - builds the `Transaction` for merge, destroy_zero, kiosk close, burn; works out what the batch really reclaims and splits the fee.
- `src/sponsoredTx.ts` - the shared simulate and execute pipeline for both gas modes: sponsored (build → sponsor → simulate → sign → submit) and self-paid (measure → pin budget and payment → simulate → sign → submit).
- `src/useSponsorStatus.ts` - polls `GET /api/sponsor` and decides who pays gas; a refusal from the sponsor overrides the last poll immediately.
- `src/useSuiHoldings.ts` - the connected wallet's SUI, split into coin objects and address balance, used to block self-paid execution from wallets with no SUI.
- `src/components/SponsorStatusBanner.tsx` - the notice shown while users pay their own gas, including the sponsor address to top up.
- `src/actionIdentity.ts` - stable per-action keys so selections survive a re-scan without re-pointing at different objects.
- `src/constants.ts` - MIST_PER_SUI, rebate multiplier, batch sizes, protected types, fee rate, explain rate limits.
- `src/types.ts` - cleanup action and scanner state types.
- `src/utils/format.ts` - formatSui, bytesToBase64, shortenAddress, shortLabelFromType, etc.
- `src/utils/explain.ts` - explain rate-limit helpers (timestamps, canRequestExplain, recordExplainRequest).
- `src/utils/suiNS.ts` - SuiNS domain resolution (SDK + GraphQL fallback).
- `src/walletBlocklist.ts` - Mysten wallet blocklist (excludes blocked coins from merge/destroy and blocked objects from burn). fails closed: if it can't load, the scan stops.
- `src/components/ScanProgressPanel.tsx` - scan progress card (phase, progress bar).
- `src/components/WarningsBlock.tsx` - irreversible destruction warning alert.
- `src/components/ActionCard.tsx` - single cleanup action row (checkbox, label, links, simulate/execute).
- `src/components/FloatingCart.tsx` - queue panel with the fee/gas breakdown, dry run summary, and execute.
- `api/sponsor.js` - serverless handler: `POST` co-signs reclaim transactions with the sponsor keypair, `GET` reports whether the sponsor can pay gas.
- `api/explain.js` - serverless handler: rate limit (RPM/RPD) then Gemini explain for the transaction payload.
- `lib/` - server code shared by the API handlers, scripts and tests. Every file in `api/` is deployed as its own endpoint, so `api/` contains only the two handlers and everything they import lives here.
  - `lib/sponsorPolicy.js` - the allow-list deciding which transactions the sponsor is willing to sign.
  - `lib/sponsorGasCoin.js` - whether the sponsor has a usable gas coin, and the transaction that converts its address balance into one.
  - `lib/redisClient.js` - the shared Upstash client, reading either the Marketplace or the manual variable names.
  - `lib/constants.js` - rate limit, sponsor and conversion constants.
- `scripts/materialize-gas-coin.mjs` - converts a chosen amount of the sponsor's address balance into a `Coin<SUI>` by hand.
- `tests/sponsorPolicy.test.mjs`, `tests/sponsorGasCoin.test.mjs` - the sponsor's drain shapes, and when and how it converts its own balance.

## how gas sponsorship stays safe

The sponsor signature covers the whole transaction, gas coin included, so `/api/sponsor` never signs blind. A request has to clear four gates:

1. **Rate limit and origin check.** Per-IP limits, and only signing counts against them - the simulate-only path issues no signature.
2. **`validateReclaimTransactionKind`.** Commands must look like a reclaim batch: `destroy_zero`, `close_and_withdraw`, single-argument third-party burns, coin merges, and the split that pays the user their share. The fee is never split out; it stays in the sponsor's gas coin. The gas coin may only ever appear as the source of a `SplitCoins`, anything transferred must go to the sender or to the sponsor itself, and the sponsor may never be the sender (that would collapse the required signers to one and make our signature a complete transaction by itself).
3. **A hard ceiling** (`MAX_GAS_COIN_SPLIT_MIST`) on the total that may be split out of the gas coin, summed across commands - so a wrong prediction in gate 4 can never authorize an unbounded transfer.
4. **Simulation.** The transaction is simulated and rejected unless the sponsor's own SUI balance change is non-negative. This is the gate that bounds ordinary exposure, and it also catches any accounting bug that would otherwise pay out more rebate than the transaction reclaims.

Gate 4 only holds if the simulated outcome is the executed outcome, which is why object arguments must be **owned and version-pinned**: a caller-controlled *shared* object could be mutated between our simulation and their submission, turning a profitable prediction into a real loss. The one exception is the Kiosk passed to `0x2::kiosk::close_and_withdraw`, a fixed framework function whose behaviour we know.

For the same reason each signature reserves its gas coin **by version**, not by coin id: a signature stays valid until the coin actually moves, which is longer than any wall-clock lease, and two live signatures over one coin version can be equivocated to freeze it until end of epoch. Signed transactions also carry an **epoch expiration**, so a signature cannot be held indefinitely while the caller arranges for execution to diverge from the simulation it was based on.

**Known residual risk.** None of these gates can tell "will succeed" from "will abort", and an aborted transaction still bills the sponsor for computation. A caller who deliberately makes a signed transaction abort costs the sponsor gas without gaining anything. That is bounded rather than eliminated: the signed gas budget is tightened to the simulated cost plus a margin (rather than the generous ceiling), per-IP rate limits cap the frequency, and each caller may hold at most `SPONSOR_MAX_HELD_COINS_PER_CALLER` gas coins reserved at a time. Related: a third-party burn function runs arbitrary code under the sponsor's gas and can branch on `TxContext`, which version-pinned inputs do not cover - the epoch expiration is what keeps that window short.

`tests/sponsorPolicy.test.mjs` covers the drain shapes directly.

## a note on Sui JSON-RPC

Sui's public fullnodes have **removed JSON-RPC** - every method now returns *"Method not found. JSON-RPC on public fullnodes has been deprecated."* Everything here runs on the GraphQL client (`@mysten/sui/graphql`), including object reads, owned-object paging, Move-function lookups, execution and `waitForTransaction`. `src/graphql/client.ts` exports the one client, and dapp-kit's `SuiClientProvider` is handed the same instance via `createClient` so it does not build a JSON-RPC client from a URL.

## disclaimer

This software is provided "as is", without warranty of any kind. By using Skitty Sui Reclaimer, you acknowledge and agree to the following:

- **Risk of loss:** Interacting with blockchain protocols involves inherent risks. You are solely responsible for any SUI or digital assets moved, reclaimed, or lost while using this tool.
- **No financial advice:** This tool is a technical utility for managing storage rebates and coin objects. It does not constitute financial or investment advice.
- **Experimental software:** While we strive for accuracy, bugs can occur. Always verify transaction details in your wallet (e.g. Sui Wallet, Surf, or Martian) before signing.
- **Limitation of liability:** In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.
- **AI disclosure:** Parts of this project's logic or documentation may be assisted by AI. Users should independently verify transaction blocks and coin object IDs before signing any Programmable Transaction Blocks (PTBs).

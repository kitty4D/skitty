# skitty - sui reclaimer

react app that lets you connect your wallet (or paste any sui address) and scan for reclaimable SUI stuck in storage rebates. merge coins, close empty kiosks, burn spam NFTs - and get most of that rebate back (99%; 1% is burned by the protocol).

## what it does

- **merge coins** - finds multiple `0x2::coin::Coin<T>` per type and merges them so you get the rebate.
- **empty kiosks** - finds empty `0x2::kiosk::Kiosk` and closes them via your `KioskOwnerCap` (only if you own the cap and the kiosk holds no items). any profits sitting in the kiosk are paid out to you.
- **burnable stuff** - supports known burn/delete entry points (add more in `src/constants.ts`) and tries to discover burn functions via RPC for other types. discovered burns are matched by function name alone, so they're flagged unverified in the UI and need an explicit confirmation — skitty cannot tell a spam token from a valuable NFT.
- **analysis** - lists every cleanup action with object count, IDs, and estimated user rebate.
- **dry run** - simulates the tx before you sign so you see net SUI gain vs gas.
- **feed skitty** - when viewing the raw simulation, you can have skitty (powered by Gemini) explain the txn in plain language. rate limited per minute and per day so the cat doesn’t get exhausted.
- **eats a small fee** - for now it takes a 13.69% fee, since the amounts are so smol as it is.
- **gas sponsor** - the wallet that receives fees, sponsors the gas. this allows a wallet w no sui to burn and get sui.


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

open [http://localhost:5173](http://localhost:5173). scan, merge, close kiosks, burn - all good. the “feed skitty” explain button will fail without the API.

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
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` - rate limiting for both endpoints, plus gas-coin reservation for the sponsor. without them the sponsor falls back to picking a random coin from its pool and neither endpoint is rate limited, so set them for anything public.
- `SUI_SPONSOR_PRIV` - **hot private key** (`suiprivkey...` or base64) for the wallet that pays gas. use a dedicated wallet holding only what you're willing to front, and keep its address equal to `FEE_RECIPIENT` in `src/constants.ts` — the sponsor only signs transactions where value goes to the sender or to itself, so a mismatch makes every sponsored transaction fail. without it `/api/sponsor` returns 503.
- `ALLOWED_ORIGINS` (optional) - comma-separated extra origins allowed to call the API. same-origin and localhost are always allowed.

**Funding the sponsor wallet:** it needs at least `SPONSOR_GAS_BUDGET_MIST` (0.05 SUI) of SUI, held either as `Coin<SUI>` objects or as an *address balance* — both can pay gas, but they are selected differently:

- **Address balance** (preferred): paid via an **empty** gas payment plus a transaction expiration. Automatic gas selection does *not* find it — a gas owner holding only a balance fails with "Gas object is not an owned object" — so `api/sponsor.js` requests it explicitly. A balance is not an owned object, so it cannot be equivocated and needs no coin reservation.
- **Coin objects**: pooled, and each signature reserves one by version.

Check which you have with `getBalance`: `coinBalance` is the coin-object part, `addressBalance` the accumulator part. A wallet funded by a recent transfer often holds everything as an address balance and owns no coins at all — that is fine. If neither source covers the budget, `/api/sponsor` returns a 503 that says so rather than a generic 500.

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
- `src/sponsoredTx.ts` - the shared simulate and execute pipeline (build → sponsor → simulate → sign → submit).
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
- `api/sponsor.js` - serverless handler that co-signs reclaim transactions with the sponsor keypair.
- `api/sponsorPolicy.js` - the allow-list deciding which transactions the sponsor is willing to sign.
- `api/explain.js` - serverless handler: rate limit (RPM/RPD) then Gemini explain for the transaction payload.
- `api/constants.js` - rate limit and sponsor constants (used by the API handlers).

## how gas sponsorship stays safe

The sponsor signature covers the whole transaction, gas coin included, so `/api/sponsor` never signs blind. A request has to clear four gates:

1. **Rate limit and origin check.** Per-IP limits, and only signing counts against them — the simulate-only path issues no signature.
2. **`validateReclaimTransactionKind`.** Commands must look like a reclaim batch: `destroy_zero`, `close_and_withdraw`, single-argument third-party burns, coin merges, and a fee split. The gas coin may only ever appear as the source of a `SplitCoins`, anything transferred must go to the sender or to the sponsor itself, and the sponsor may never be the sender (that would collapse the required signers to one and make our signature a complete transaction by itself).
3. **A hard ceiling** (`MAX_GAS_COIN_SPLIT_MIST`) on the total that may be split out of the gas coin, summed across commands — so a wrong prediction in gate 4 can never authorize an unbounded transfer.
4. **Simulation.** The transaction is simulated and rejected unless the sponsor's own SUI balance change is non-negative. This is the gate that bounds ordinary exposure, and it also catches any accounting bug that would otherwise pay out more rebate than the transaction reclaims.

Gate 4 only holds if the simulated outcome is the executed outcome, which is why object arguments must be **owned and version-pinned**: a caller-controlled *shared* object could be mutated between our simulation and their submission, turning a profitable prediction into a real loss. The one exception is the Kiosk passed to `0x2::kiosk::close_and_withdraw`, a fixed framework function whose behaviour we know.

For the same reason each signature reserves its gas coin **by version**, not by coin id: a signature stays valid until the coin actually moves, which is longer than any wall-clock lease, and two live signatures over one coin version can be equivocated to freeze it until end of epoch. Signed transactions also carry an **epoch expiration**, so a signature cannot be held indefinitely while the caller arranges for execution to diverge from the simulation it was based on.

**Known residual risk.** None of these gates can tell "will succeed" from "will abort", and an aborted transaction still bills the sponsor for computation. A caller who deliberately makes a signed transaction abort costs the sponsor gas without gaining anything. That is bounded rather than eliminated: the signed gas budget is tightened to the simulated cost plus a margin (rather than the generous ceiling), per-IP rate limits cap the frequency, and each caller may hold at most `SPONSOR_MAX_HELD_COINS_PER_CALLER` gas coins reserved at a time. Related: a third-party burn function runs arbitrary code under the sponsor's gas and can branch on `TxContext`, which version-pinned inputs do not cover — the epoch expiration is what keeps that window short.

`tests/sponsorPolicy.test.mjs` covers the drain shapes directly.

## a note on Sui JSON-RPC

Sui's public fullnodes have **removed JSON-RPC** — every method now returns *"Method not found. JSON-RPC on public fullnodes has been deprecated."* Everything here runs on the GraphQL client (`@mysten/sui/graphql`), including object reads, owned-object paging, Move-function lookups, execution and `waitForTransaction`. `src/rpcClient.ts` is only a re-export of that one client, and dapp-kit's `SuiClientProvider` is handed the same instance via `createClient` so it does not build a JSON-RPC client from a URL.

## disclaimer

This software is provided "as is", without warranty of any kind. By using Skitty Sui Reclaimer, you acknowledge and agree to the following:

- **Risk of loss:** Interacting with blockchain protocols involves inherent risks. You are solely responsible for any SUI or digital assets moved, reclaimed, or lost while using this tool.
- **No financial advice:** This tool is a technical utility for managing storage rebates and coin objects. It does not constitute financial or investment advice.
- **Experimental software:** While we strive for accuracy, bugs can occur. Always verify transaction details in your wallet (e.g. Sui Wallet, Surf, or Martian) before signing.
- **Limitation of liability:** In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.
- **AI disclosure:** Parts of this project's logic or documentation may be assisted by AI. Users should independently verify transaction blocks and coin object IDs before signing any Programmable Transaction Blocks (PTBs).

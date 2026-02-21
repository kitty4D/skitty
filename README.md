# skitty - sui reclaimer

react app that lets you connect your wallet (or paste any sui address) and scan for reclaimable SUI stuck in storage rebates. merge coins, close empty kiosks, burn spam NFTs - and get most of that rebate back (99%; 1% is burned by the protocol).

## what it does

- **merge coins** - finds multiple `0x2::coin::Coin<T>` per type and merges them so you get the rebate.
- **empty kiosks** - finds empty `0x2::kiosk::Kiosk` and closes them via your `KioskOwnerCap` (only if you own the cap and the kiosk has no dynamic fields).
- **burnable stuff** - supports known burn/delete entry points (add more in `src/constants.ts`) and tries to discover burn functions via RPC for other types.
- **analysis** - lists every cleanup action with object count, IDs, and estimated user rebate.
- **dry run** - simulates the tx before you sign so you see net SUI gain vs gas.
- **feed skitty** - when viewing the raw simulation, you can have skitty (powered by Gemini) explain the txn in plain language. rate limited per minute and per day so the cat doesn’t get exhausted.
- **eats a small fee** - for now it takes a 13.69% fee, since the amounts are so smol as it is.


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

create a `.env.local` (or set env in Vercel dashboard for prod). the explain API needs:

- `GEMINI_API_KEY` - for the explain endpoint (Gemini).
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` - for rate limiting (per minute / per day). if you skip these, the API will complain when it tries to rate limit.

## build

```bash
npm run build
npm run preview
```

## project layout

- `src/ReclaimDashboard.tsx` - main UI: address input, SuiNS resolve, scan, action list, dry run, execute, feed skitty.
- `src/useGraphQLScanner.ts` - hook that uses GraphQL + RPC to find mergeable coins, empty kiosks, and burnable objects.
- `src/graphql/client.ts` - GraphQL client + SuiNS resolution via GraphQL.
- `src/rpcClient.ts` - shared RPC client for SuiNS and burn discovery.
- `src/buildCleanupTransaction.ts` - builds the `Transaction` for merge, destroy_zero, kiosk close, burn; fee split to skitty recipient.
- `src/constants.ts` - MIST_PER_SUI, rebate multiplier, batch sizes, known burnable types, fee rate, explain rate limits.
- `src/types.ts` - cleanup action and scanner state types.
- `src/utils/format.ts` - formatSui, bytesToBase64, shortenAddress, shortLabelFromType, etc.
- `src/utils/explain.ts` - explain rate-limit helpers (timestamps, canRequestExplain, recordExplainRequest).
- `src/utils/suiNS.ts` - SuiNS domain resolution (SDK + GraphQL fallback).
- `src/utils/network.ts` - RPC and GraphQL endpoint URLs by network.
- `src/walletBlocklist.ts` - Mysten wallet blocklist for coins (exclude from merge/destroy).
- `src/components/ScanProgressPanel.tsx` - scan progress card (phase, progress bar).
- `src/components/WarningsBlock.tsx` - irreversible destruction warning alert.
- `src/components/ActionCard.tsx` - single cleanup action row (checkbox, label, links, simulate/execute).
- `src/components/FloatingCart.tsx` - queue panel with dry run summary and execute.
- `api/explain.js` - serverless handler: rate limit (RPM/RPD) then Gemini explain for the transaction payload.
- `api/constants.js` - explain rate limit constants (used by explain.js).

## disclaimer

This software is provided "as is", without warranty of any kind. By using Skitty Sui Reclaimer, you acknowledge and agree to the following:

- **Risk of loss:** Interacting with blockchain protocols involves inherent risks. You are solely responsible for any SUI or digital assets moved, reclaimed, or lost while using this tool.
- **No financial advice:** This tool is a technical utility for managing storage rebates and coin objects. It does not constitute financial or investment advice.
- **Experimental software:** While we strive for accuracy, bugs can occur. Always verify transaction details in your wallet (e.g. Sui Wallet, Surf, or Martian) before signing.
- **Limitation of liability:** In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.
- **AI disclosure:** Parts of this project's logic or documentation may be assisted by AI. Users should independently verify transaction blocks and coin object IDs before signing any Programmable Transaction Blocks (PTBs).

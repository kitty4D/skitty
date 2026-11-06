# skitty - Sui reclaimer

Sui objects cost storage. skitty finds objects you can remove or combine and shows what you'd recover after gas and the service fee

connect a wallet, or paste an address or SuiNS name to look around without connecting. execution requires the scanned wallet to be connected. a scan or simulation doesn't sign a transaction

## what you can do

| panel | what happens |
| --- | --- |
| keep tokens, recover storage | selected nonzero coin objects move into your own address balance. you keep the tokens, and the original coin object IDs disappear |
| merge coins | combines coins of the same type, including SUI. the surviving coin keeps their combined balance |
| destroy zero coins | deletes coin objects with a verified zero balance. zero-balance SUI coins aren't offered |
| close empty kiosks | closes a kiosk when you own its cap, it has no items, and no dynamic fields remain. any sale proceeds go to you |
| empty containers | deletes directly wallet-owned empty framework bags and tables after checking size and dynamic fields. wrapped containers aren't included |
| expired Walrus receipts | burns expired mainnet blob receipts to recover eligible SUI object storage. this doesn't refund WAL or itself delete Walrus data |
| withdraw kiosk proceeds | sends the amount observed during scanning to your address balance. the kiosk and cap stay open. later sales remain for another withdrawal |
| allowance review and revocation | shows native Sui allowances controlled by your caps, including spender, asset, limits, spend, app, and expiry. revoking deletes the cap and allowance |
| attempt burn | discovers supported burn/delete/destroy functions through GraphQL. discovered functions are marked unverified because their names don't establish an object's value |

allowance review doesn't cover every protocol's custom permissions. empty-container cleanup supports the framework's `Bag`, `ObjectBag`, `Table`, and `ObjectTable`

nothing starts selected. merge and keep-token choices replace each other for overlapping coins. withdrawing and closing the same kiosk can't be queued together. deposits, burns, kiosk closure, and the four new object panels require confirmation before signing

the four object panels stay visible after scanning even when empty. incomplete discovery shows a warning. Walrus expiry uses the Walrus committee epoch, and an unrecognized system version or package stops receipt discovery

token balances use metadata when available. otherwise they're shown in raw units. depositing tokens into an address balance doesn't sell them for SUI. applications that need coin objects can withdraw them later

coins matching Mysten's coin-type or package blocklist, plus exact types reported blocked by Slush, appear under **flagged coins, excluded from Select All**. the list shows the reason and object links. you can explicitly reveal framework-only cleanup options and choose them individually, with an additional warning before signing. Select All never chooses them, even when visible. hiding them again removes their selections. another wallet may allow the action, but skitty can't override a wallet's refusal

each new scan revalidates the public lists. your wallet can apply additional screening, so absence from the flagged section isn't a promise it will sign

## gas and fees

the fee rate is 13.69% of the storage rebate the batch is planned to reclaim. it doesn't apply to token balances or withdrawn kiosk proceeds. the quote applies the app's 0.99 rebate multiplier before subtracting gas and the fee. simulation shows network effects, which can differ from the estimate

a merge keeps its primary coin, so that object's storage isn't counted as recovered. quotes cover only actions that fit in the batch. anything left out stays available for another run

### sponsored gas

the fee recipient is also the sponsor:

```text
0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1
```

when the sponsor can cover an eligible cleanup, a wallet with no SUI can still run it. the sponsor pays gas, receives the storage rebate, and sends your quoted share into your address balance. the fee stays in its gas coin. the payout doesn't create another SUI coin for the scanner to offer again

a batch can be refused if it doesn't cover its costs or needs more payout than the available coin can front. try fewer objects, or choose **pay gas with my wallet**

### wallet-paid gas

when sponsorship is unavailable, your wallet pays gas. the banner shows the full sponsor address with copy and explorer links. it asks for funding only when a shortage is confirmed. an offline API or missing key isn't fixed by sending SUI

after scanning, the **gas payment** section beside the cleanup results explains both choices: use sponsorship or **pay gas with my wallet**. sponsorship is selected by default while available. choosing your wallet requires SUI already available for gas. changing the choice updates the quote and clears pending confirmation. it doesn't retry a failed transaction for you

kiosk proceeds withdrawal always uses your gas, including in a mixed queue. it doesn't delete storage to pay for sponsorship

self-paid execution needs SUI already available for gas. proceeds and rebates received at the end can't pay the initial budget. the minimum budget is 0.003 SUI, and a larger batch can need more. if neither you nor the sponsor can pay, execution is blocked with an explanation

the planner uses one gas source: coin objects or your address balance. for SUI cleanup it prefers a sufficient address balance, otherwise it reserves payment coins. other selections prefer the larger source. payment coins are excluded from deposits, and coin-paid SUI consolidation merges into the gas payment

gas is measured before signing, with a budget of at least 1.5 times gross cost and a 0.003 SUI minimum. if changing the payment changes the batch, the planner measures it again. self-paid fees are capped at what remains after the budget and waived when the cleanup doesn't cover gas and the fee

## simulation and review

simulate before signing. a small cleanup can cost more than it recovers

the final transaction is checked before the wallet prompt. shared state can still change before execution, and a failed submitted transaction can cost gas. review the wallet's transaction details

an empty gas-payment simulation doesn't verify its payer can afford gas. self-paid planning checks holdings separately

the optional **feed skitty** button sends raw simulation data to Gemini for an explanation. that isn't an audit or a guarantee. don't include private data you don't want sent to that service

disconnecting or changing wallets clears errors, notices, simulations, explanations, and pending confirmations. it doesn't cancel an already submitted transaction

## run locally

you'll need Node.js and npm

```sh
npm install
npm run dev
```

open the URL Vite prints, normally [localhost:5173](http://localhost:5173). this serves the frontend. without working API handlers, sponsorship looks offline, cleanup is wallet-paid, and explanations are unavailable

for the frontend and Vercel handlers together:

```sh
npm install -g vercel
vercel link
vercel dev
```

link the intended account and project. the existing `skitty-dev` launch configuration uses port 5199 for frontend checks

### server configuration

set these in the deployment environment. don't commit keys or local environment files

| variable | purpose |
| --- | --- |
| `SUI_SPONSOR_PRIV` | dedicated sponsor hot key, in `suiprivkey...` or base64 form. its address must match `FEE_RECIPIENT` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash credentials from the Vercel Marketplace integration |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | fallback names for a manual Upstash instance. corresponding `KV_*` values take precedence |
| `GEMINI_API_KEY` | enables explanations |
| `ALLOWED_ORIGINS` | optional additional origins accepted by the sponsor endpoint |
| `SPONSOR_DEBUG` | optional `1` includes underlying sponsor errors in 500 responses. leave it unset publicly |

Redis handles rate limits, coin reservations, and conversion locks. explanations return 503 without a working limiter. sponsorship uses logged fallback behavior when Redis is missing or unavailable, which weakens throttling and distributed reservations. configure Redis for a public deployment

### sponsor funding and conversion

user cleanup sponsorship uses a sponsor-owned `Coin<SUI>` object. the current selection check needs one coin covering the 0.05 SUI initial budget plus the user's payout

a top-up can arrive as an address balance. when no usable coin exists, the server can convert that balance itself. both the status GET and sponsorship POST can trigger this separate, sponsor-signed transaction. checking status can therefore submit a conversion

conversion withdraws from the sponsor's own balance, calls `coin::redeem_funds`, and returns the coin to the sponsor. it reserves 0.005 SUI for conversion gas and requires a resulting coin of at least 0.06 SUI. automatic conversion needs at least 0.065 SUI in address balance, or more for a particular payout

conversion is simulated before signing. it uses a 90-second lock and a 15-minute backoff after failure. without Redis the lock is local to one server instance. self-paid fees go to the sponsor's address balance and can contribute to a later conversion

the manual script uses the same builder. provide `SUI_SPONSOR_PRIV` through your environment:

```sh
node scripts/materialize-gas-coin.mjs
```

it simulates by default. `--execute` submits, and `--amount <mist>` changes the default 0.3 SUI amount. don't paste a key into a command you plan to share

status polling runs every 60 seconds. successful status responses have a 15-second shared cache with stale revalidation, so a top-up may take another poll to appear

| refusal | what the app does |
| --- | --- |
| `sponsor_unfunded`, `sponsor_not_configured` | switches the next attempt to wallet-paid gas |
| `sponsor_insufficient` | keeps sponsorship available for a smaller batch |
| `sponsor_busy` | keeps sponsorship available for a later retry |

## sponsor checks

`lib/sponsorPolicy.js` checks the transaction shape before the hot key signs. supported cleanup calls, owned coin merges and deposits, and bounded payout splits are allowed. deposits go only to the sender. the gas coin can appear only as a split source

ordinary object inputs must be owned and version-pinned. framework kiosk-close and allowance-revoke calls have narrow shared-object exceptions. the allowance cap must still be owned. kiosk proceeds withdrawal isn't sponsored

the signing path requires both:

- nonnegative gas-coin arithmetic: storage rebate minus computation, storage cost, and payout to the sender
- a nonnegative simulated sponsor SUI balance change

missing evidence is a rejection. the payout ceiling is 2 SUI. signed gas budgets are tightened to measured cost with a margin. reservations are keyed by coin version. epoch expiration is set when the epoch lookup succeeds

these checks bound exposure. they don't eliminate deliberate aborts, Redis fallback collisions, or arbitrary behavior inside a third-party burn. [sponsor memory](docs/memory/sponsor-trust-boundary.md) covers the reasoning and attack cases

## development

```sh
npm test
npx tsc --noEmit -p .
npm run lint
npm run build
```

`npm run preview` serves the built frontend. a local build doesn't deploy the app

| location | purpose |
| --- | --- |
| `src/ReclaimDashboard.tsx`, `src/components/` | panels, selection, confirmations, simulation, and queue |
| `src/useGraphQLScanner.ts`, `src/coinActions.ts` | wallet discovery and coin candidates |
| `src/containerDiscovery.ts`, `src/receiptDiscovery.ts` | containers, Walrus receipts, and native allowances |
| `src/buildCleanupTransaction.ts` | batch planning, commands, realized storage, and fees |
| `src/sponsoredTx.ts`, `src/gasSelection.ts` | gas planning, simulation, signing, and execution |
| `src/graphql/client.ts` | shared mainnet GraphQL client |
| `api/sponsor.js`, `api/explain.js` | the two deployed handlers |
| `lib/` | shared server policy, conversion, Redis, and constants |
| `scripts/materialize-gas-coin.mjs` | manual sponsor conversion |
| `src/*.test.ts`, `tests/*.test.mjs` | planning, discovery, formatting, and sponsor-policy tests |
| [project memory](docs/memory/MEMORY.md) | decisions, operational limits, and dated verification |

the app uses React 18, TypeScript, Vite, Tailwind, Mysten's Sui SDK and dapp-kit, Vercel functions, and Upstash. public-fullnode JSON-RPC was removed in earlier checks, so the app uses GraphQL throughout

every file in `api/` is deployed as an endpoint. shared helpers belong in `lib/`

## limits

deleting an object can remove collectible value, application state, or eligibility that skitty can't identify. a discovered burn function isn't proof that an object is spam. blocklists reduce what gets offered, but they don't establish value

the software is provided as is, without warranty. you're responsible for reviewing and approving transactions. this is a storage and wallet utility, not financial advice. parts of the implementation and optional explanations use AI, and neither replaces checking the transaction

this is experimental software. the authors and copyright holders aren't liable for claims, damages, or other liability arising from its use

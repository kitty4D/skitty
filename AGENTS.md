# agents

skitty reclaims Sui object storage. mainnet only. Vite + React + TypeScript, Vercel handlers in `api/`

read [project memory](docs/memory/MEMORY.md) before changing gas, sponsorship, discovery, or the Sui client. code is the source of truth. update memory when it disagrees. local `.cursorrules` predates the GraphQL migration

## commands

- `npm test`
- `npx tsc --noEmit -p .`
- `npm run lint`
- `npm run build`
- `npm run dev`: frontend only, self-paid fallback without the API
- launch config `skitty-dev` uses port 5199. use `vercel dev` for handlers too

## boundaries

- use the shared `SuiGraphQLClient` in `src/graphql/client.ts`. don't restore public-fullnode JSON-RPC
- `api/` contains only `sponsor.js` and `explain.js`. shared server code belongs in `lib/`, otherwise Vercel deploys it as an endpoint
- `lib/sponsorPolicy.js` decides what the hot key signs. policy changes need attack-shape tests in `tests/sponsorPolicy.test.mjs`. keep the gas-coin arithmetic and sponsor balance gates
- user cleanup sponsorship uses a real sponsor-owned `Coin<SUI>`. automatic conversion is a separate sponsor-sent transaction and can use its address balance
- `FEE_RECIPIENT` must match the sponsor key's address. never read `.env*` or expose `SUI_SPONSOR_PRIV`
- empty-payment simulation doesn't prove the payer can afford gas. self-paid planning checks holdings separately
- recovery quotes prefer final sender balance changes. fallback uses final effects for self-paid and the explicit payout for sponsored. never show the sponsor's rebate as user recovery. queue results belong to one selection and payer
- sponsored payout credits gas-object rebates. retain only fee plus the app's 1% allowance. converge the payout shape and verify exact final sponsor retention before user signing; keep server loss gates intact. don't label the allowance a protocol burn
- self-paid address-balance transactions never reference `tx.gas`. fees use withdrawal/redeem/send. coin-paid fees use `coin::send_funds`, avoiding a new fee coin
- keep-token deposits go only to the sender's address balance. exclude all gas-payment coins. overlapping actions can't share inputs. coin-paid SUI consolidation uses the gas coin
- coin cleanup revalidates Mysten's coin-type/package lists each scan. flagged coins stay outside Select All and normal totals. explicit unhide allows individual framework-only cleanup with confirmation. hide/rescan/wallet change clears the opt-in. wallet refusals aren't scam verdicts
- sponsored user payouts use `coin::send_funds<SUI>` into sender address balance, not replacement coin objects. policy accepts only tracked gas-split results for this route and counts them in `splitToSenderMist`
- kiosk proceeds go to the sender's address balance, earn no storage rebate, and force the whole batch self-paid. don't charge a fee on proceeds
- containers: exact supported framework types, explicit zero size, no dynamic fields, owned inputs only
- Walrus expiry uses Walrus committee time. keep the pinned system/package checks. exclude recognized receipts from generic burn discovery, including live receipts
- allowance review covers native Sui caps only. revoke uses owned cap first, matching allowance second. don't call this a review of every protocol permission
- show incomplete discovery as a warning. require confirmation for object cleanup. wallet changes clear feedback and pending confirmations
- publish only checked scan results; metadata may enrich raw balances later. keep partial results labeled, per-section status accurate, and transaction controls locked until scan settles. outside clicks minimize the queue without clearing selections; don't dismiss through open review dialogs
- no commits, branches, pushes, deployments, or signed onchain actions without explicit authorization. this docs update isn't commit permission

## docs and voice

keep README, this file, and `docs/memory/` aligned with implemented behavior. `CLAUDE.md` imports this file, so don't duplicate rules there

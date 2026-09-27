# agents

sui storage-rebate reclaimer. vite + react + ts frontend, vercel functions in `api/`. mainnet only.

read `docs/memory/MEMORY.md` before touching gas, sponsorship, or the sui client. `.cursorrules` (local, untracked) predates the graphql migration; where it disagrees with this, it's wrong.

## commands

- `npm test` (vitest: `src/**/*.test.ts` + `tests/*.test.mjs`)
- `npx tsc --noEmit -p .` / `npm run lint` / `npm run build`
- dev server: launch config `skitty-dev` (port 5199). plain vite serves `api/*.js` as source, so the sponsor looks offline and the app runs self-paid.

## hard rules

- sui json-rpc is dead on public fullnodes. everything goes through `SuiGraphQLClient` (`src/graphql/client.ts`).
- `lib/sponsorPolicy.js` is the fund-safety boundary. any change needs a drain-shape test in `tests/sponsorPolicy.test.mjs`.
- sponsor gas comes from a `Coin<SUI>` object only. never reintroduce address-balance gas for the sponsor. its address balance gets converted into a coin automatically (`lib/sponsorGasCoin.js`, called from `api/sponsor.js`).
- every file in `api/` is deployed as its own endpoint. `api/` holds only the handlers (`sponsor.js`, `explain.js`); anything they import goes in `lib/`.
- self-paid address-balance route must never reference `tx.gas`. fee goes through `tx.withdrawal`.
- self-paid fees go to `FEE_RECIPIENT` via `send_funds`, never as a new coin object (storage cost lands on the user).
- `FEE_RECIPIENT` in `src/constants.ts` must equal the address of `SUI_SPONSOR_PRIV`.
- `simulateTransaction` with an empty gas payment does NOT check the payer. never treat that simulation as proof anyone can pay.
- never read `.env*` files. `SUI_SPONSOR_PRIV` is a hot key.
- no commits, branches or pushes without asking.

## style

no emoji, no em or en dashes in anything committed. comments lowercase, explain why. README is public and professional.

# operations

these are configuration and code facts, plus explicitly labeled earlier incidents. no current sponsor balance, Vercel deployment, account, or external service policy was checked for this docs update

## configuration

- `SUI_SPONSOR_PRIV` is the sponsor hot key. never read `.env*`, print the key, or commit a local environment file. a sensitive Vercel variable returned an empty value from `vercel env pull` in the earlier setup. a downloaded file isn't proof the key is present
- `lib/redisClient.js` prefers `KV_REST_API_URL` and `KV_REST_API_TOKEN`, with the corresponding `UPSTASH_REDIS_REST_*` values as fallback. these are per-variable fallbacks, so configure a matching URL/token pair
- a deleted Upstash instance previously left stale credentials and caused execute failures. that incident doesn't establish the provider's current inactivity or billing policy
- `GEMINI_API_KEY` enables explanation requests. the explain endpoint refuses with 503 when its Redis-backed limiter is missing or unavailable
- sponsor rate limiting and reservations degrade when Redis is missing or unreachable. the fallback logs the error and chooses a random usable coin. this weakens coordination and can produce duplicate signatures over a coin version
- `SPONSOR_DEBUG=1` includes underlying sponsor errors in 500 responses. leave it unset for public use
- sponsor origin checks are in `api/sponsor.js`. optional `ALLOWED_ORIGINS` extends the accepted host list. don't describe that as authentication

## sponsor funding

configured recipient:

```text
0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1
```

`FEE_RECIPIENT` must equal the keypair's address. rotating the sponsor means changing the key and recipient together, then deploying the change. don't infer the live deployment's key or balance from this file

user cleanup sponsorship requires a `Coin<SUI>` object. the server reads the first 50 coins and checks whether one covers the 0.05 SUI initial budget plus payout. the pool is sorted locally, not queried by balance. a funded coin beyond that page won't be found by the current code

top-ups can arrive in address balance. `convertAddressBalance` in `api/sponsor.js` uses the shared builder in `lib/sponsorGasCoin.js` when no usable coin exists

- status GET triggers conversion for the `address_balance` reason. signing POST can trigger it for a specific payout. GET therefore isn't strictly read-only
- amount is the address balance minus the 0.005 SUI conversion budget
- the result must be at least 0.06 SUI and cover the initial sponsor budget plus any requested payout. automatic conversion needs at least 0.065 SUI address balance
- the transaction withdraws as the sponsor, redeems through `coin::redeem_funds`, and returns the coin to the sponsor
- conversion uses `ValidDuring` with the current epoch and next epoch, chain identifier, and nonce. it has no address-owned input
- simulation happens before signing. the lock is 90 seconds, with a 15-minute backoff after failure. without working Redis the lock is local to one instance
- execution effects supply the new coin reference when the indexer hasn't caught up
- self-paid fees arrive in the sponsor's address balance and can fund a later conversion

`node scripts/materialize-gas-coin.mjs` is the manual path. it reads the key from the environment, simulates by default, supports `--amount <mist>`, and submits only with `--execute`. no script run or real conversion was performed during this docs update

## status and diagnosis

`GET /api/sponsor` returns `funded`, `reason`, and `sponsorAddress`. normal responses have `s-maxage=15, stale-while-revalidate=45`. missing-key responses cache for 60 seconds. unreachable responses use `no-store`

| reason or refusal | meaning |
| --- | --- |
| `ok` | a fetched coin exceeds the initial budget. a large payout may still be refused |
| `empty` | fetched balance data reports no SUI |
| `address_balance` | enough balance could make a usable coin, but conversion hasn't succeeded yet |
| `too_little` | no fetched usable coin and insufficient balance for automatic conversion. it doesn't describe every possible manual transaction |
| `not_configured`, `unreachable` | missing/invalid key or failed status lookup |
| `sponsor_unfunded`, `sponsor_not_configured` | the UI switches future attempts to self-paid |
| `sponsor_insufficient`, `sponsor_busy` | smaller batches or retries may work without changing payer |

simulation can succeed while execution fails because simulate-only skips Redis reservations and returns no sponsor signature. check the signing path's logs rather than assuming a successful dry run exercised it

the banner always shows the sponsor address, using `FEE_RECIPIENT` until the API supplies one. only confirmed funding shortages get top-up wording

## deployment layout

only handlers belong in `api/`: `sponsor.js` and `explain.js`. Vercel deploys every file there as an endpoint. shared code belongs in `lib/`

plain Vite serves the frontend without running those handlers. use `vercel dev` when testing the complete API flow. a successful local build isn't proof a deployment is live

related: [gas modes](gas-modes.md), [sponsor checks](sponsor-trust-boundary.md)

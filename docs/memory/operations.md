# operations

## vercel env

- `SUI_SPONSOR_PRIV` is a sensitive vercel variable: write-only. `vercel env pull` returns it as `""`. anything that needs it locally needs a copy from wherever it was generated.
- upstash through the vercel marketplace injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`, not `UPSTASH_*`. `lib/redisClient.js` prefers the `KV_*` names because stale `UPSTASH_*` vars survive the database being deleted, and that turned into an opaque 500 on the signing path once already.
- `SPONSOR_DEBUG=1` puts the underlying error in `/api/sponsor` 500s. don't leave it on.
- upstash free-tier databases get deleted for inactivity. symptom: simulate works (no redis on that path), execute 500s.

## sponsor wallet

- address: `0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1` (must equal `FEE_RECIPIENT`).
- it needs a `Coin<SUI>` object, not an address balance. check with `getBalance`: `coinBalance` is what counts.
- top-ups from modern wallets land as an address balance (both aug 2026 top-ups did). the server converts it on its own: `convertAddressBalance` in `api/sponsor.js`, transaction built by `lib/sponsorGasCoin.js`.
  - triggers: status GET when the reason is `address_balance`; signing POST when no coin covers the batch. page polls are what drive it, so it happens while someone has the site open.
  - converts everything but a 0.005 SUI gas budget, only if the result is at least 0.06 SUI (a smaller coin can pay gas but never pay anyone out). a top-up under ~0.065 SUI just sits there until more arrives.
  - simulates before signing, redis lock `sponsor_conversion` (90s) so only one instance converts, 15 minute backoff after a failure. without redis the lock is per instance; a duplicate fails its withdrawal check rather than losing anything.
  - the new coin is read from the transaction effects, because the indexer can trail them and a "no coin" answer right after converting would flip everyone back to self-paid.
  - verified against mainnet short of a real submission (stand-in signer, submission replaced by simulation). the first real conversion is the one that proves the ValidDuring expiration, which only a real submission checks.
- `node scripts/materialize-gas-coin.mjs` (with `SUI_SPONSOR_PRIV` in env) is the manual version of the same transaction: simulates by default, `--execute` to submit, `--amount <mist>` for a specific amount.
- sponsored batches leave the fee in the gas coin, so the coin grows by roughly the fee per batch instead of fragmenting.
- self-paid fees land in its address balance and get converted the same way once there's enough.
- the vercel plugin deploys every file in `api/` as its own endpoint, whether or not it's a handler. that's why `api/` holds only `sponsor.js` and `explain.js`, and everything they import lives in `lib/`. constants, the redis client and the sponsor policy used to sit in `api/` as broken public urls until sept 2026.
- when it can't pay, users pay their own gas automatically; the banner shows this address. wallets with no SUI are stuck until it's topped up.
- rotating the key means a new keypair, a new `FEE_RECIPIENT` in `src/constants.ts`, the new secret in vercel, and a redeploy. the two addresses must match or every sponsored transaction fails the policy.

related: [gas modes](gas-modes.md)

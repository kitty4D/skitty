# sui json-rpc is gone

as of aug 2026, public fullnodes answer every json-rpc method with "method not found. json-rpc on public fullnodes has been deprecated". that covers `sui_getObject`, `suix_getCoins`, `suix_getOwnedObjects`, `sui_getNormalizedMoveModule`, `sui_multiGetObjects`, `sui_getChainIdentifier`, including through `SuiJsonRpcClient`.

it silently broke burn discovery, `refreshAfterExecute` and the whole execute path. the old scanner swallowed errors and returned `[]`, so the symptom was "vault is empty" instead of an error.

how to apply: everything goes through `SuiGraphQLClient` in `src/graphql/client.ts`. equivalents: `getObject`/`getObjects`, `listCoins`, `listOwnedObjects`, `getBalance`, `getMoveFunction` (per function; there's no normalized-module call, so burn discovery queries each candidate name), `simulateTransaction`, `executeTransaction`, `waitForTransaction`. `storageRebate` isn't on the typed object response, so raw `graphQLClient.query` is used where it's needed. dapp-kit's `SuiClientProvider` must be handed this client via `createClient`, or it builds a dead json-rpc client from the url.

sdk gotchas:

- `simulateTransaction` / `executeTransaction` return a union: `result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction`, with `status`, `effects`, `balanceChanges` nested inside.
- `graphQLClient.query` resolves graphql errors into `{ errors }` instead of throwing, so an unchecked call reads as "no results".
- connection page size caps at 50.

related: [sui gas facts](sui-gas-facts.md)

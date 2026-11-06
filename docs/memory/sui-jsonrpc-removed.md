# GraphQL migration

earlier public-fullnode checks returned "method not found" for JSON-RPC calls, including object reads, coin listing, normalized Move modules, and chain identifier. that broke discovery and execution. the old scanner swallowed errors, so failures looked like an empty wallet

the app now uses `SuiGraphQLClient` throughout. this docs update checked that implementation, not the current behavior of every public RPC endpoint

## client contract

`src/graphql/client.ts` exports the shared frontend client. dapp-kit's provider receives it through `createClient`. server handlers create their own GraphQL clients. don't restore a JSON-RPC client as a fallback

use `getObject`/`getObjects`, `listCoins`, `listOwnedObjects`, `getBalance`, `getMoveFunction`, `simulateTransaction`, `executeTransaction`, and `waitForTransaction`. raw queries provide storage rebates and discovery fields absent from the typed responses

burn discovery checks individual candidate functions through `getMoveFunction`. the callable signature matters: one consumed object argument, no unsupported generics or required extra arguments. a borrowed argument doesn't establish destruction

## things that otherwise look like success

- simulation/execution returns a union. choose `result.Transaction` or `result.FailedTransaction` using `$kind`, then check nested `status.success`
- GraphQL queries can resolve with `errors` instead of throwing. missing or partial data mustn't become "nothing found"
- connections use `hasNextPage` and `endCursor`. fewer than 50 nodes isn't proof the connection ended. discovery requests use pages of 50
- token metadata is optional display data. unavailable decimals mean raw units, not an invented decimal count
- container and receipt queries use 20-second abort signals and report incomplete discovery. receipt paging has a 1,000-page guard. container paging rejects repeated cursors
- scanner epochs suppress stale responses after a new address or scan. they aren't a general network cancellation mechanism

execution refresh runs a full scan so stale alternatives and partially executed batches are removed. wallet-session epochs separately clear late feedback after disconnect/change

related: [gas observations](sui-gas-facts.md), [object cleanup](object-cleanup.md)

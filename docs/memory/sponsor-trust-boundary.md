# sponsor checks

`api/sponsor.js` can sign a transaction with the sponsor's hot key. `lib/sponsorPolicy.js` checks the transaction shape. neither the browser nor the sender's chosen recipient is a reason to trust a payout

## what is allowed

- supported coin merges with owned inputs
- `coin::destroy_zero`
- `coin::send_funds<T>` with one owned, version-pinned input and a literal sender recipient. sponsor payouts also permit tracked earlier gas-split results with SUI type, counting the amount in `splitToSenderMist`. arbitrary results, direct gas references, shared coins, and sponsor/third-party deposit destinations are rejected
- framework `kiosk::close_and_withdraw`, with an owned cap. the kiosk argument can be shared
- exact framework `destroy_empty` calls for Bag/ObjectBag and Table/ObjectTable, with zero or two type arguments respectively. one owned, version-pinned object argument
- framework `allowance::revoke<T>`, with owned cap first and owned/shared allowance second. the framework checks their pairing and deletes both
- single-owned-input third-party burn/delete/destroy calls. expired Walrus receipt burns use this existing route
- bounded gas splits and permitted result transfers

kiosk proceeds withdrawal stays self-paid. it isn't a sponsored framework call

the sponsor can't be the sender. that would make its returned signature sufficient to submit the transaction without another signer

## the value gates

ordinary inputs must be owned and version-pinned. the shared kiosk and allowance exceptions are limited to the known framework operations above

the primary signing gate is:

```text
storageRebate - computationCost - storageCost - splitToSenderMist >= 0
```

the secondary gate requires nonnegative sponsor SUI balance change. missing gas fields or a missing sponsor balance row return `null` and cause rejection. absent evidence isn't zero loss

the gas coin can appear only as a split source. total gas splits are capped at 2,000,000,000 mist. the sponsor may only receive transferred results originating in its own gas splits. the browser normally leaves the fee in the gas coin rather than splitting it

sender payouts now use address balance rather than a replacement SUI coin. `send_funds` is not an uncounted exit: known gas-split amounts are added to the primary arithmetic gate. bare results from multi-amount splits, future/unknown result origins, and non-SUI type substitutions are rejected. keep regression coverage for both old object-transfer payouts and new address-balance payouts

simulate-only requests get bytes without a signature. the real signing path performs the simulation and value gates before signing

## why the shared-input rules exist

an earlier attack shape seeded a shared kiosk with profits, routed them to the sponsor to make its simulated balance positive, split gas to the caller, then drained the kiosk before submission

that is why sponsor income can't be manufactured through an unrelated result, and why the gas-coin arithmetic gate exists independently of whole-address balance changes

native allowance revocation deletes the matching allowance and cap without paying funds or branching on spend counters. permitting its shared allowance doesn't create a route for apparent sponsor income. the cap must still be owned, and the normal value gates still apply

empty-container calls have no shared exception. broadening those inputs would let the caller change the predicted state after simulation

## remaining exposure

a successful simulation doesn't guarantee later success. a deliberate abort still costs computation. third-party burns can branch on transaction context even when their inputs are pinned

the server starts with a 0.05 SUI budget, then tightens the signed budget to gross simulated cost times 1.5, bounded by a 0.003 SUI minimum and the initial ceiling. it sets epoch expiration when the epoch lookup succeeds. it currently continues without that expiration if the lookup returns no usable epoch

Redis reservations are keyed by coin ID and version, with a 30-minute expiry and at most two held coins per caller. don't describe that lease as covering every possible signature lifetime. missing or failed Redis falls back to random coin selection and weaker throttling, so collisions remain possible

per-IP signing limits are 12 per minute and 300 per day when Redis works. simulate-only calls skip that quota. origin checks and rate limits reduce access and frequency, but they aren't proof a transaction preserves funds

## changes

policy changes need matching attack-shape tests in `tests/sponsorPolicy.test.mjs`. check gas references, argument kinds, arity, ownership, recipients, shared-state changes, and payout accounting

self-paid transactions aren't co-signed and don't go through this policy. they still use wallet funding checks, simulation, and explicit user approval

related: [gas modes](gas-modes.md), [gas observations](sui-gas-facts.md)

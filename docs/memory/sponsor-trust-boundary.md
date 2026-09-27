# sponsor trust boundary

`/api/sponsor` co-signs user transactions with a hot keypair that owns the gas coin. the sponsor signature covers the whole `TransactionData`, gas coin included, so the server is the trust boundary. the original version blind-signed any client-supplied kind and was drainable with `SplitCoins(GasCoin)` + `TransferObjects` to the caller.

two rounds of adversarial review broke earlier fixes. each lesson lives in `lib/sponsorPolicy.js`:

1. a structural allow-list isn't a value bound. the caller is legitimately the sender, so "only transfer to sender or fee recipient" doesn't stop self-dealing.
2. a simulation gate is only as good as sim == execution. shared object arguments broke it: the caller mutates their own shared object between our simulation and their submission. object inputs must be owned and version-pinned. the one exception is the kiosk `0x2::kiosk::close_and_withdraw` needs.
3. the caller must not be able to manufacture apparent sponsor income. the proven attack seeded a shared kiosk with profits, routed that payout to the sponsor so the simulated sponsor balance looked positive, split the ceiling out to themselves, then drained the kiosk before submitting. so the fee recipient may only receive value that came out of its own gas-coin split.
4. the primary gate is arithmetic on things the caller can't inflate: `storageRebate - computationCost - storageCost - splitToSenderMist >= 0`. the whole-address balance change is a secondary gate.

other gates: per-ip rate limit (fails open, it's a throttle not a safety gate), origin check, `MAX_GAS_COIN_SPLIT_MIST` ceiling, per-version coin reservation (two signatures over one coin version can be equivocated to freeze it), per-caller reservation cap, epoch expiration, gas budget tightened to 1.5x simulated cost.

residual risk: nothing can tell "will succeed" from "will abort", and an abort still bills the sponsor for computation. it's bounded by the tight budget, rate limits and the reservation cap, not eliminated. a real one happened on sept 7 2026: 773,208 mist.

how to apply: any allow-list change needs a matching drain-shape test in `tests/sponsorPolicy.test.mjs`. before widening what an argument may be, ask whether the caller can change it between our simulation and their submission. `netSuiChangeForAddress` returns `null`, not `0n`, when the sponsor has no balance row: absent data must never read as "no loss".

self-paid transactions never touch this boundary. nothing is co-signed, so the policy doesn't apply to them.

related: [gas modes](gas-modes.md), [sui gas facts](sui-gas-facts.md)

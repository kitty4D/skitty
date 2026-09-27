# gas modes

who pays gas is decided per page load and can flip mid-session. `GasMode = 'sponsored' | 'self'` (`src/sponsoredTx.ts`).

## deciding

- `GET /api/sponsor` returns `{ funded, reason, sponsorAddress }`. reasons: `ok`, `empty`, `address_balance` (convertible, not converted yet), `too_little`, `not_configured`, `unreachable`. edge cached 15s.
- before answering, both GET and POST convert the sponsor's address balance into a gas coin when no usable coin exists and the balance could make one (see [operations](operations.md)). so a top-up from anyone flips everyone back to sponsored within a poll or two, no terminal involved.
- `useSponsorStatus` polls it every 60s. `checking` counts as sponsored (optimistic); `unfunded` and `offline` mean self-paid.
- `funded` means some sponsor coin is strictly bigger than `SPONSOR_GAS_BUDGET_MIST`. a coin of exactly the budget can pay gas but can't pay anyone out.
- a mid-flow `POST` 503 carries a `code`. `sponsor_unfunded` and `sponsor_not_configured` flip to self-paid immediately (via `markUnavailable`, which also discards any in-flight poll). `sponsor_insufficient` (funded, just not for this payout) and `sponsor_busy` don't flip: a smaller batch or a retry still works.
- the flip never silently re-runs anything. the user is told the next attempt costs their own gas and has to press it again.

## sponsored

unchanged from before: kind bytes to the sponsor, sponsor sets gas owner, payment and budget, simulates, gates, signs. the fee stays inside the sponsor's gas coin; only the user's share is split out.

## self-paid

`planSelfPaid` in `src/sponsoredTx.ts`:

1. read the sender's SUI: first page of coin objects (balance > 0) and the address balance.
2. pick ONE source, whichever holds more. gas can't come from both.
3. below `SELF_PAY_MIN_GAS_BUDGET_MIST` (0.003 SUI) available: refuse with the "no SUI, sponsor is out" message. the UI blocks execute with the same reason and shows it on the banner.
4. draft: build with empty payment and a 1 SUI budget, fee included at roughly final size, simulate. empty payment is unchecked in simulation, which is exactly why it can price a batch before a budget is chosen. it is NOT evidence the wallet can pay.
5. budget = max(min, ceil(gross gas * 1.5)). refuse if the source can't cover it.
6. final build: fee capped at `available - budget`.
   - coin route: payment pinned to those coins (explicit payment IS checked in simulation), fee = `splitCoins(tx.gas)` then `coin::send_funds`.
   - address-balance route: payment left for the resolver (it checks budget + withdrawals against the real balance and returns an empty payment), fee = `tx.withdrawal` then `balance::redeem_funds` then `balance::send_funds`. never touches `tx.gas`.
7. execute simulates the final bytes once more before the wallet sees them, then signs `Transaction.from(bytes)` so the wallet signs exactly what was simulated.

fee is waived when the batch doesn't cover its own gas (`userRebate - gas - fee <= 0`). fees land in the sponsor's address balance; `scripts/materialize-gas-coin.mjs` turns that into a usable gas coin.

side effect worth knowing: on the coin route every pinned coin gets smashed into the first one, which also pays the user those coins' storage rebates.

## ui

- `SponsorStatusBanner` shows whenever self-paid: title by reason, and always the full sponsor address with copy and explorer link. only a confirmed shortage (`unfunded`) gets the "send SUI here" label; offline just says "sponsor wallet", since a missing key isn't fixed by a top-up.
- `FloatingCart` shows net cost in red when a self-paid batch loses money, labels gas as the wallet's, and takes `executeBlockedReason` instead of the old `canSponsor`.
- dry-run results carry their `gasMode` and are hidden when the mode flips; per-card simulated yields are cleared on a flip.

related: [sui gas facts](sui-gas-facts.md), [sponsor trust boundary](sponsor-trust-boundary.md)

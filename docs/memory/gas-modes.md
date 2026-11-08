# gas modes

`src/sponsoredTx.ts` owns simulation and execution. `GasMode` is `sponsored` or `self`. the dashboard chooses the requested mode, and `gasModeForActions` forces self-paid for kiosk proceeds or any `selfPaidOnly` action

## choosing the payer

`useSponsorStatus` polls every 60 seconds. `checking` is optimistic, `funded` requests sponsorship, and `unfunded` or `offline` uses the wallet. a funded status means a coin exceeds the initial sponsor budget, not that it can front every batch

after a scan, the gas-payment fieldset sits between the results summary and cleanup panels while the sponsor is checking or funded. it explains both radio options before selection: sponsorship for eligible cleanups, or the wallet's existing SUI for gas. sponsorship is selected by default. the choice resets on wallet change and clears pending confirmation. it doesn't rerun a failed transaction. kiosk withdrawals still force the queue self-paid, with a visible explanation

a kiosk-proceeds withdrawal forces the entire queue self-paid. it releases earnings without deleting storage. proceeds aren't included in the service-fee base

a POST refusal with `sponsor_unfunded` or `sponsor_not_configured` switches future attempts to self-paid and tells the user to press again. `sponsor_insufficient` and `sponsor_busy` don't switch modes. smaller batches or retries can still be sponsored

## sponsored path

the browser builds transaction-kind bytes. the server validates the shape, chooses a real sponsor coin, and supplies transaction bytes. simulate-only requests get no signature and don't reserve a coin

execution measures gross gas, rebuilds the included batch, then requests the sponsor signature. the signing path simulates again and checks both gas-coin arithmetic and the sponsor's SUI balance change. the wallet signs the returned transaction and the client submits both signatures

rebates go to the gas payer. the sponsor therefore splits the user's share from its existing coin and sends it into sender address balance with `coin::send_funds<SUI>`. a new payout coin would recreate the storage being cleaned up. the policy counts that split exactly as it counts an object-transfer payout. the fee stays in the gas coin. initial selection requires `coin balance >= 50,000,000 mist + payout`; the signed budget is tightened later

## self-paid path

`planSelfPaid` does this:

1. read one page of up to 50 SUI coins and the address balance. retain positive-balance coins
2. choose one source with `selectCleanupGas`. SUI cleanup prefers a sufficient address balance, otherwise reserves payment coins, unselected first. other selections prefer the larger source and use the fetched coin pool if coin-paid
3. require the source to cover the initial 3,000,000 mist budget. don't count proceeds or expected rebates toward available gas
4. build a measuring draft with an empty payment and a 1 SUI budget. simulate to price the work. that empty payment doesn't prove anyone can pay
5. raise the budget to at least `ceil(gross cost * 1.5)`. if choosing payment coins changes the source or included work, measure again. stop after six attempts
6. rebuild with measured gas and a fee capped at `available - budget`. pin coin payments, or leave address-balance selection to the resolver
7. simulate the final bytes. execution then asks the wallet to sign `Transaction.from(bytes)`, submits, checks execution status, and waits briefly for finality

coin-paid fees use `splitCoins(tx.gas)` then `coin::send_funds`. address-balance fees use `tx.withdrawal`, `balance::redeem_funds`, and `balance::send_funds`, without touching `tx.gas`. both deposit into the fee recipient's address balance and avoid creating another coin

the fee is waived when `userRebate - gas - fee <= 0`. storage accounting uses only included actions. gas-paid SUI merges can be performed entirely by gas smashing. payment coins are never deposited by keep-tokens cleanup

## feedback and limits

- the offline banner follows actual sponsor availability, not voluntary self-payment. it always includes the sponsor address, copy, and explorer links. funding language appears only for a confirmed shortage
- card and cart modes are derived from their own selections. a self-paid action mustn't be blocked by the sponsor's rebate threshold
- the queue separates kiosk proceeds from storage and includes proceeds once in the net amount. negative net estimates remain visible
- disconnecting or changing wallets clears feedback, simulations, explanations, and pending confirmations. epochs reject late responses from the old wallet session
- an active execution stays locked until it settles. a wallet switch doesn't cancel a transaction already submitted
- finality timeout is reported as pending, not as proof of failure. an onchain abort isn't reported as success
- scan estimates still use fixed per-action gas allowances. queue simulation replaces the headline with measured net recovery and labels the remaining breakdown as rough. individual card simulations don't price the queue. selection, refreshed actions, or payer changes invalidate queue results
- simulation prefers sender SUI balance changes, including zero. without them, self-paid recovery uses final simulated storage rebate minus computation/storage costs and the actual built fee, plus kiosk proceeds. sponsored recovery uses the explicit built sender payout, never the sponsor's gas rebate. this fixes the stale draft-gas fallback when final planning waives a fee
- sponsored simulation and execution share `planSponsored`: start with zero payout, simulate, and recoup `gross gas - effects storage rebate + included object rebates`. this credits the gas object's rebate once. rebuild and measure until the payout stabilizes, at most four passes. the fee plus `included object rebates - userRebate` is the sponsor's exact retention target. rough allowances don't set the final payout
- simulation labels distinguish `storage rebate minus gas`, `your net recovery`, and `sponsor net balance change (simulated)`. the last comes only from the sponsor address returned by the final sponsor response and its final simulated SUI balance changes. sponsored final results now require both gas arithmetic and sponsor balance change to equal disclosed retention; missing data or mismatch rejects the quote. self-paid transactions omit the sponsor row. the gas-only figure doesn't include the user's payout
- keep-token rough gas allowance is 100,000 mist per generated action, approximating effective computation cost after crediting the gas-object rebate. 500 mist was implausibly low; 1,088,000 mist modeled gross costs but would understate recovery after the payout fix. cards label unsimulated recovery as rough; simulated cards say simulated. batching, nonrefundable fees, and storage state can still change actual costs

related: [coin cleanup](coin-cleanup.md), [object cleanup](object-cleanup.md), [gas observations](sui-gas-facts.md)

## november 8 payout reconciliation

read-only mainnet transaction `E81xP93i5irArzUVxKKfXtkfzYZFJC1qaeQYQ4t9vhnU` succeeded. two deleted user coins each held 1,307,200 mist storage rebate. sender gained 1,142,345 mist; sponsor gained 1,371,695 mist. gross gas was 1,088,000 and actual effects rebate was 3,602,040. the payout used 99% of the user objects' 2,614,400 rebate minus 357,911 service fee and gross gas

the old calculation left the sponsor not just the stated fee and 26,144-mist app buffer, but another 987,640 mist associated with rewriting its gas object. corrected replay uses effective gas of 100,360 mist, pays the user 2,129,985 mist, and retains 384,055 mist (fee plus allowance). prior claims that the gas coin grew only by the fee were incomplete

execution re-simulates the exact sponsor-signed bytes before asking the user to sign, since coin reservation can choose a different coin from the measuring calls. changed costs, missing data, or mismatched retention stop execution with a retry message. server policy and both nonnegative gates remain unchanged; these exact-retention checks apply to the app's flow, not arbitrary clients calling the API. no signed onchain action was used to verify this change

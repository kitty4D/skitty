# Sui gas observations

the code depends on these distinctions. the earlier gas experiments used SDK 2.7.0 and mainnet around september 2026. november 6 checks exercised the added cleanup calls. those are dated observations, not a fresh check of every protocol flag or wallet version

## rebates and available funds

rebates are credited to the gas payer when execution finishes. with sponsorship that is the sponsor, so the user's share has to be paid separately

a split during execution uses existing gas-coin funds. the earlier simulations found spendable value was payment total minus budget. skitty's coin selection therefore requires the sponsor's initial budget plus payout. self-paid fees are capped after reserving gas

the builder applies `REBATE_MULTIPLIER = 0.99` to its planned storage rebate, then subtracts gas and the service fee. that's an app quote. don't label every reported `storageRebate` value as a gross deposit or infer the exact current protocol burn from that multiplier. simulated effects report their own storage rebate and nonrefundable fee

## address balances and withdrawals

`getBalance` separates aggregate balance, coin-object balance, and address balance. the current app can use address-balance gas for self-paid transactions and sponsor-owned conversion

`tx.withdrawal()` returns `funds_accumulator::Withdrawal<Balance<T>>`, not `Balance<T>`. use `coin::redeem_funds` for a Coin or `balance::redeem_funds` for a Balance. passing the withdrawal directly to `coin::from_balance` failed the earlier type check

`coin::send_funds` and `balance::send_funds` deposit into an address balance without making a replacement coin object. keep-token cleanup uses that to remove coin wrappers while preserving their tokens

earlier mainnet checks rejected explicit sponsor withdrawals. ordinary owned inputs were checked against the sender, so a sponsor-owned coin couldn't be used as an ordinary user input. storage rebates also arrive too late to fund a mid-transaction payout. the sponsored user payout therefore still uses `tx.gas`

transactions without address-owned inputs needed `ValidDuring` expiration covering at most two epochs. the conversion builder supplies current/next epoch, chain identifier, and nonce. the earlier simulation didn't enforce the expiration rule that execution did

## simulation limits

with empty gas payment, earlier simulations succeeded even when the supposed gas payer couldn't afford the budget or split. that isn't funding evidence

withdrawal reservations were checked against real address balance. explicit gas coin payments were also checked. these are separate checks, so a successful withdrawal doesn't prove the remaining balance covers gas

the self-paid planner reads holdings before pricing and before signing the resolved plan. its measuring draft uses empty payment only to price the commands. the final resolver/payment choice still has to be affordable

the self-paid address-balance route never references `GasCoin`. the SDK resolution path used in the earlier checks chose address balance only when the transaction avoided that argument and the balance covered budget plus withdrawals

## sponsor consequence

user cleanup sponsorship requires a real `Coin<SUI>` payment. an earlier wallet rebuilt an empty payment against the user and rejected it. an earlier protocol version also exposed `address_balance_gas_reject_gas_coin_arg`; its current setting wasn't checked in this docs update

automatic sponsor conversion is different: the sponsor is also the sender and redeems its own withdrawal into its own coin. that conversion can use address-balance gas without a `GasCoin` argument

## november 6 evidence

read-only mainnet simulations passed keep-token deposits, SUI merges, all four supported container destroy functions, kiosk withdrawal into sender address balance, and a real expired Walrus receipt burn. function lookups confirmed native allowance revocation. these checks didn't sign or submit transactions

empty payment in those Move-call probes tested command behavior only. the normal app's wallet funding checks still matter. [object cleanup](object-cleanup.md) keeps the receipt fixture and measured effects

related: [gas modes](gas-modes.md), [coin cleanup](coin-cleanup.md)

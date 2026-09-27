# sui gas facts

all verified against mainnet by simulation, sdk `@mysten/sui` 2.7.0, protocol ~v134, sept 2026. re-verify before building on any of it; this layer is moving.

## rebates

- storage rebates are credited to the GAS PAYER, not the sender. so in a sponsored reclaim the recovered SUI is the sponsor's the instant it exists.
- rebates land when execution ENDS. anything split out of `tx.gas` mid-PTB comes out of the gas coin's existing balance, not the rebate. that's why the sponsor's coin needs `budget + payout` and a self-paying user needs `budget + fee`.
- spendable through `tx.gas` is exactly `payment total - budget`. one mist over aborts with insufficient coin balance.

## address balances

- a wallet funded by a recent transfer often holds all of its SUI as an address balance and owns zero usable coins. that's the normal case now, not an edge case.
- `getBalance` returns `balance`, `coinBalance`, `addressBalance`. only `coinBalance` is coin objects.
- address-balance gas = empty gas payment + `ValidDuring` expiration (max two epochs) when there are no address-owned inputs.
- the sdk resolver only picks the address balance if the PTB never references `GasCoin` and `addressBalance >= budget + withdrawals`. otherwise it lists coin objects.
- `tx.withdrawal()` yields `funds_accumulator::Withdrawal<Balance<T>>`, NOT a `Balance<T>`. redeem it with `coin::redeem_funds` (returns `Coin`) or `balance::redeem_funds` (returns `Balance`). `coin::from_balance` rejects it.
- `balance::send_funds(Balance, address)` and `coin::send_funds(Coin, address)` deposit into the recipient's address balance and create no object.
- withdrawals draw only on the SENDER. `withdrawFrom: Sponsor` is rejected ("explicit sponsor withdrawals are not yet supported").
- a withdrawal reservation IS checked in simulation, down to the mist.

## simulation lies

- with an empty gas payment, simulation does not check the payer at all. an address holding zero SUI "successfully" simulates `splitCoins(tx.gas)` with a 5 SUI budget.
- with an explicit coin payment, it's checked ("balance of gas object 0 is lower than the needed amount").
- the graphql resolver does server-side gas selection when payment is unset and fails loudly when nothing covers it.

## sponsor constraints that follow

- a sponsor-owned coin can't be an ordinary PTB input (owned inputs are checked against the sender). the `GasCoin` argument is the only channel for sponsor value to reach a user in a user-sent tx.
- so the sponsor needs a `Coin<SUI>` object. its address balance can't pay for skitty: wallets re-resolve an empty payment against the sender, the balance gate can't be verified, and `address_balance_gas_reject_gas_coin_arg` (currently off) would reject the shape outright.

related: [gas modes](gas-modes.md)

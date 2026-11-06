# coin cleanup

`coinActions.ts` finds alternatives. `buildCleanupTransaction.ts` accounts for what actually fits. `gasSelection.ts` keeps the payment out of the wrong inputs

## keep tokens

`keep_tokens` consumes owned nonzero `Coin<T>` objects through `coin::send_funds<T>(coin, sender)`. tokens stay in the same account's address balance. deleting the wrapper realizes storage without a separate `destroy_zero` or replacement coin

groups contain at most 50 deposits, including single coins and SUI. balances are parsed strictly. metadata is optional and fetched sequentially. unknown decimals show raw units. don't convert token amounts to JavaScript numbers for display

Move names are case-sensitive. grouping uses `normalizeStructTag`, not a lowercased label. coin blocklists still apply

the destination is the sender. it appears once in the panel header, with confirmation before signing. don't repeat the same explanation on every coin row

## alternatives and accounting

merge and deposit actions can name the same coins, but can't both be selected for them. `selectActionKeys` replaces conflicting selections. the builder rejects overlapping object inputs as another check

a merge deletes all but its primary coin. a deposit deletes every included wrapper. the batch planner uses per-object rebates and only included actions, rather than paying on the full selection. header totals exclude alternate merge quotes where keep-tokens already covers those objects

execution triggers a full scan. partial batches and overlapping alternatives mustn't retain stale references

## gas

when cleaning up SUI, prefer a sufficient address balance. otherwise reserve coin payments, unselected first. exclude every payment ID from deposits and ordinary merge inputs

coin-paid SUI consolidation merges remaining selected coins into `tx.gas`. payment coins after the first also disappear through gas smashing and count toward the realized rebate. the first payment survives. consolidation can be entirely gas smashing with no explicit merge command

the measuring pass replans if a larger budget changes the payment/source. excluding another selected input can free a batch slot. don't price one included batch and sign a different one without measuring again

## sponsorship

the policy allows `coin::send_funds<T>` only with one type argument, an owned version-pinned input, and literal recipient equal to the sender. it rejects gas references, shared inputs, results, and sponsor/third-party destinations

self-paid fees use the recipient's address balance too. creating a fee coin would charge the user extra storage. fees apply to planned recovered storage, not the token amount

## verification

earlier offline checks covered ownership attacks, overlapping choices, realized rebates, exact token formatting, gas reservation, gas-only smashing, and source-switch replanning. november 6 read-only mainnet simulations passed deposits and SUI merges with real owned inputs. no signed execution was performed in those development checks

related: [gas modes](gas-modes.md), [sponsor checks](sponsor-trust-boundary.md)

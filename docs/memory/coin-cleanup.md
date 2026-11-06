# coin cleanup

`coinActions.ts` finds alternatives. `buildCleanupTransaction.ts` accounts for what actually fits. `gasSelection.ts` keeps the payment out of the wrong inputs

## keep tokens

`keep_tokens` consumes owned nonzero `Coin<T>` objects through `coin::send_funds<T>(coin, sender)`. tokens stay in the same account's address balance. deleting the wrapper realizes storage without a separate `destroy_zero` or replacement coin

groups contain at most 50 deposits, including single coins and SUI. balances are parsed strictly. metadata is optional and fetched sequentially. unknown decimals show raw units. don't convert token amounts to JavaScript numbers for display

Move names are case-sensitive. grouping uses `normalizeStructTag`, not a lowercased label. coin blocklists still apply

before generating normal coin actions, `partitionBlockedCoins` checks the token type against Mysten's coin list and referenced package addresses against its separate package list, including nested generic types. the old path checked only coin types, so a package-flagged token could appear in keep-tokens. each scan invalidates the in-memory lists and uses HTTP revalidation with 20-second request limits. cache reuse is within the scan, not forever for an open tab. missing or malformed list data stops scanning. the package feed contains domains too: validate its string array, match only Sui addresses, and never fetch those listed domains

flagged coins appear in scanner diagnostics (`blockedCoins`) and separate opt-in `flaggedActions`. the dashboard shows their types, object links, raw balances, and public-list or user-reported refusal reasons. they stay outside normal panels, Select All, and default totals. explicit unhide allows individual framework-only merge/deposit/zero cleanup. actions carry `walletWarning` and require confirmation. hiding, rescanning, or changing wallets resets the opt-in and removes hidden selections. other wallets may sign, but the app doesn't override Slush or ask for keys

november 6 public-list check: the user's abbreviated `0x74fe...e843::blub::BLUB` matched package entry `0x74fe61df63c62579b8d589583363c08a0afb6516d0a17f148f5957757bb7e843`. the other nine supplied package/type combinations didn't match those public lists. that supports a likely explanation for the batch refusal, not proof of which rule produced the private Slush alert. names alone don't establish legitimacy or fraud

the user then isolated three more Slush refusals: `0xf76d5bdd1efad15a858103f9976ef3a0c8177ac90173d9f4ae5c017c137f47ee::tato::TATO`, `0xd225dee9e2723b38d8162dbdb4c85a9958359d98069865f7527f9e6092c5d980::mmt::MMT`, and `0xce5fae2d360631ef80512ce0c10ac57282a25e01239d30a250040581db5e684f::tato::TATO`. these exact types are supplemental reported-refusal entries, not official Mysten scam classifications. other types sharing a ticker aren't excluded by those entries

public source audit: `src/` and `blocklists/` coin/object/package files had identical GitHub blob hashes. the fetched package bytes matched current blob `5c9daa3793d0380becab4ed98f667096d6b9b98e`; that file's latest change was august 2 2026. the repo also publishes domain lists and `allowlists/`. sync scripts fetch an authenticated upstream URL from repository secrets. its runtime contents and Slush's actual feed aren't verified. latest public copy doesn't mean complete wallet screening

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

normal deposits require `coin::send_funds<T>` with one owned version-pinned input and literal sender recipient. sponsor payouts additionally accept a tracked earlier gas-split result, SUI type only, and count the exact amount toward `splitToSenderMist`. arbitrary results, direct gas references, shared inputs, and sponsor/third-party deposit destinations remain rejected

sponsored payouts now go into sender address balance. the earlier transfer-object payout recreated a SUI coin immediately after keep-tokens removed one. transaction `jFehBH5ysRYLWAdXyyWYd7kbcyvnDH65rBpERz1vLEs` was read on november 6: it deleted the old SUI wrapper and created `0x1e33e2f6321e21995eb8bc8c948fdfefadca90726bc1f12594d46581226d78be` holding 1,036,109 mist as the sponsor payout. the remaining option was a real new object, not stale discovery. self-paid gas coins can still survive legitimately

the new payout shape was simulated read-only on november 6 with a real sponsor coin and user SUI input. it succeeded and created no user-owned replacement object. that probe used zero estimated gas to exercise the payout commands, not to certify an eligible sponsor quote. production pricing and both value gates remain required

self-paid fees use the recipient's address balance too. creating a fee coin would charge the user extra storage. fees apply to planned recovered storage, not the token amount

## verification

earlier offline checks covered ownership attacks, overlapping choices, realized rebates, exact token formatting, gas reservation, gas-only smashing, and source-switch replanning. november 6 read-only mainnet simulations passed deposits and SUI merges with real owned inputs. no signed execution was performed in those development checks

the follow-up UI fixture used the four exact flagged types and a wallet stub that cannot sign. Select All left all four unchecked after reveal. individual execution showed the warning. hiding options removed the flagged selection while preserving a normal selection. desktop/mobile checks covered both gas choices and the opt-in section. these are UI checks, not evidence another real wallet will accept the flagged types

related: [gas modes](gas-modes.md), [sponsor checks](sponsor-trust-boundary.md)

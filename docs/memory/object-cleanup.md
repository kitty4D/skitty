# object cleanup

four panels cover containers, expired Walrus receipts, kiosk proceeds, and native allowances. they remain visible after scanning, including empty results. nothing starts selected. each action needs confirmation before signing

discovery errors show warnings. generic burn discovery excludes supported container and receipt types so their dedicated checks can't be bypassed by finding a burn name

## empty containers

`src/containerDiscovery.ts` recognizes exact framework `Bag`, `ObjectBag`, `Table<K,V>`, and `ObjectTable<K,V>` types. it queries address-owned objects. wrapped containers aren't accessible through this panel

require explicit zero size and a successful empty dynamic-field query. missing data isn't empty. `destroy_empty` also checks emptiness onchain

the SDK parser preserves nested generic arguments. the sponsor permits only the exact targets, correct type-argument counts, and one owned version-pinned input. shared containers and command results are rejected

## kiosk proceeds

an owned `KioskOwnerCap` authorizes `kiosk::withdraw`, including for nonempty kiosks. the amount is the exact u64 observed during scanning, encoded as `Option::some`. later sales stay in the kiosk for another scan

the returned coin goes through `coin::send_funds` to the sender's address balance. the kiosk and cap survive. the action earns no deletion rebate and forces the entire queue self-paid. the wallet needs gas before any proceeds arrive

fees apply only to storage removed elsewhere in the batch. proceeds appear separately in the queue and are included once in net recovery. both kiosk and cap participate in action identity, so withdrawal and closure conflict

## native allowances

`src/receiptDiscovery.ts` finds native framework allowances controlled by the wallet's `AllowanceCap<T>`. this isn't a scan of every protocol permission

the cap field is `allowance`, as verified during the november 6 mainnet checks. `allowance_id` isn't accepted. verify the cap owner, linked shared object's ID/type, funder, metadata, and rebates

review includes asset/type, spender, funder, app, u256 limits and spend, and readable dates. raw values remain available. time status uses the device clock and doesn't establish that spending would succeed

`allowance::revoke<T>(cap, allowance)` deletes both and removes permission. it doesn't transfer the allowed funds. the sponsor permits owned cap first and owned/shared allowance second. framework pairing checks and both sponsor value gates still apply

## Walrus receipts

the supported original mainnet type package is:

```text
0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77
```

the code pins callable v4 package:

```text
0xa9ac4281c72b0ed3277c08e821ab77eccea7b187f2b402ffa3b33f548d4bbf1e
```

system object:

```text
0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2
```

verify that object's version/package and its version-keyed inner committee epoch. only offer `storage.end_epoch <= Walrus committee epoch`. Sui epoch isn't the clock here. package/version drift produces a warning and stops receipt discovery until reviewed

`blob::burn(Blob)` takes one owned receipt and doesn't enforce expiry itself. exclude recognized unexpired receipts from generic burns. burning removes the receipt, storage resource, and metadata. it doesn't refund WAL or itself delete Walrus data. sponsorship uses the existing owned-input burn policy

source references used in the earlier checks: [deployment metadata](https://github.com/MystenLabs/walrus/blob/mainnet/mainnet-contracts/walrus/Published.toml), [blob module](https://github.com/MystenLabs/walrus/blob/mainnet/contracts/walrus/sources/system/blob.move), [system module](https://github.com/MystenLabs/walrus/blob/mainnet/contracts/walrus/sources/system.move), [allowance module](https://github.com/MystenLabs/sui/blob/mainnet/crates/sui-framework/packages/sui-framework/sources/allowance.move). the deployment file still listed v3 then, so live system state supplied the verified v4 package

## november 6 verification

earlier in this development session, mainnet function lookups confirmed all four container destroy calls, kiosk withdrawal, and native allowance revocation. these weren't signed executions

a read-only simulation created/destroyed all four container types, funded a temporary kiosk with 10,000 mist from a public fixture's coin, and withdrew that amount into sender address balance. it succeeded. the initial address-balance fixture was rejected because its balance was empty, so the probe used its existing coin instead

expired receipt fixture:

```text
0x00001c4e73a7fc0acf28fab0ff5a9b6d13e7261d61f945264a699791e2b0f0b3
```

end epoch was 14, observed Walrus committee epoch was 43. its burn simulation reported 100,000 mist computation, 988,000 storage cost, and 2,006,199 storage rebate. no signature or submission

the owner's full scan exceeded the browser check's 60-second window. a bounded single-receipt fixture separately verified the live object, expiry lookup, and burn path. don't describe that as a completed full-wallet scan

desktop/mobile scans at `0x5` rendered all four empty panels. populated action-card fixtures checked display and callbacks. a mocked funded-sponsor response checked voluntary wallet-paid mode. these checks aren't a signed wallet acceptance test

container/receipt requests have 20-second abort signals and per-page progress. the scanner reports incomplete discovery rather than calling it a clean result. future transactions still require their normal funding checks and preflight

related: [gas modes](gas-modes.md), [sponsor checks](sponsor-trust-boundary.md)

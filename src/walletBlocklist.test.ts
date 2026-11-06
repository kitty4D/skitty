import { afterEach, expect, it, vi } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { blockedCoinReason } from './walletBlocklist';
import { generateCoinActions, partitionBlockedCoins } from './coinActions';
import { selectActionKeys } from './actionIdentity';

afterEach(()=>vi.unstubAllGlobals());
const type = '0x2::coin::Coin<0xa::token::TOKEN>';
const coin = (objectId: string, balance='7')=>({address:objectId,storageRebate:'2000000',contents:{type:{repr:type},json:{balance}}});

it('excludes the three user-confirmed Slush refusals by exact type without blocking lookalike tickers',()=>{
  const reported=[
    '0xf76d5bdd1efad15a858103f9976ef3a0c8177ac90173d9f4ae5c017c137f47ee::tato::TATO',
    '0xd225dee9e2723b38d8162dbdb4c85a9958359d98069865f7527f9e6092c5d980::mmt::MMT',
    '0xce5fae2d360631ef80512ce0c10ac57282a25e01239d30a250040581db5e684f::tato::TATO',
  ];
  for(const token of reported) expect(blockedCoinReason(`0x2::coin::Coin<${token}>`,new Set(),new Set())).toEqual({kind:'wallet'});
  expect(blockedCoinReason('0x2::coin::Coin<0xabc::tato::TATO>',new Set(),new Set())).toBeNull();
  const {allowed,blockedCoins}=partitionBlockedCoins(reported.map((token,i)=>({...coin(`0x${i+1}`),contents:{type:{repr:`0x2::coin::Coin<${token}>`},json:{balance:'1'}}})),new Set(),new Set());
  expect(allowed).toEqual([]);
  expect(blockedCoins).toHaveLength(3);
});

it('matches package flags with padded addresses, including nested type arguments',()=>{
  const packages = new Set([normalizeSuiAddress('0xa')]);
  expect(blockedCoinReason(type,new Set(),packages)).toEqual({kind:'package',packageId:normalizeSuiAddress('0xa')});
  expect(blockedCoinReason('0x2::coin::Coin<0xb::wrapper::T<0x000a::token::TOKEN>>',new Set(),packages)?.kind).toBe('package');
  expect(blockedCoinReason('0x2::coin::Coin<0xab::token::TOKEN>',new Set(),packages)).toBeNull();
});

it('separates type-flagged and package-flagged coins without creating selectable actions',()=>{
  for (const [coinTypes,packages] of [
    [new Set(['0x000a::token::TOKEN']),new Set<string>()],
    [new Set<string>(),new Set([normalizeSuiAddress('0xa')])],
  ]) {
    const {allowed,blockedCoins}=partitionBlockedCoins([coin('0x1'),coin('0x2','0'),coin('0x1')],coinTypes,packages);
    expect(allowed).toEqual([]);
    expect(blockedCoins).toHaveLength(2);
    const actions=generateCoinActions(allowed,coinTypes);
    expect(actions).toEqual([]);
    expect(selectActionKeys(actions,new Set(),actions)).toEqual(new Set());
  }
});

it('keeps unflagged cleanup available while excluding flagged objects from select all',()=>{
  const unflagged={...coin('0x3'),contents:{type:{repr:'0x2::coin::Coin<0xb::t::T>'},json:{balance:'1'}}};
  const {allowed,blockedCoins}=partitionBlockedCoins([coin('0x1'),unflagged],new Set(),new Set([normalizeSuiAddress('0xa')]));
  const actions=generateCoinActions(allowed,new Set());
  expect(blockedCoins.map(coin=>coin.objectId)).toEqual(['0x1']);
  expect(actions.flatMap(action=>action.objectIds)).toEqual(['0x3']);
  expect(selectActionKeys(actions,new Set(),actions).size).toBe(1);
});

it('validates the package list and normalizes every entry rather than treating map indexes as SDK arguments',async()=>{
  vi.resetModules();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({blocklist:['0xa','0xb']})}));
  const {getWalletPackageBlocklist}=await import('./walletBlocklist');
  expect(await getWalletPackageBlocklist()).toEqual(new Set([normalizeSuiAddress('0xa'),normalizeSuiAddress('0xb')]));
});

it('reads address entries from the real mixed-domain package-feed shape without fetching listed domains',async()=>{
  vi.resetModules();
  const fetch = vi.fn().mockResolvedValue({ok:true,json:async()=>({blocklist:['0xa','deepbookrwd.com',' 0xb ','bafy.example.ipfs.storry.tv ']})});
  vi.stubGlobal('fetch',fetch);
  const {getWalletPackageBlocklist}=await import('./walletBlocklist');
  expect(await getWalletPackageBlocklist()).toEqual(new Set([normalizeSuiAddress('0xa'),normalizeSuiAddress('0xb')]));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain('raw.githubusercontent.com');
});

it.each([{}, {blocklist:null}, {blocklist:['invalid']}, {blocklist:[42]}])('does not treat an invalid package response as an empty list: %j',async data=>{
  vi.resetModules();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>data}));
  const {getWalletPackageBlocklist}=await import('./walletBlocklist');
  await expect(getWalletPackageBlocklist()).rejects.toThrow(/package blocklist/);
});

it('revalidates the public package list when a new scan invalidates the page cache',async()=>{
  vi.resetModules();
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({blocklist:['0xa']})});
  vi.stubGlobal('fetch',fetch);
  const {getWalletPackageBlocklist,refreshWalletBlocklists}=await import('./walletBlocklist');
  await getWalletPackageBlocklist();
  await getWalletPackageBlocklist();
  expect(fetch).toHaveBeenCalledTimes(1);
  refreshWalletBlocklists();
  await getWalletPackageBlocklist();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].cache).toBe('no-cache');
});

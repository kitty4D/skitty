import { describe, it, expect, vi } from 'vitest';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { containerType, hasZeroSize, discoverContainers } from './containerDiscovery';

describe('container recognition', () => {
  it('recognizes only framework containers and preserves nested generic arguments', () => {
    expect(containerType('0x2::bag::Bag')).toEqual({target:'0x2::bag::destroy_empty',typeArguments:[]});
    expect(containerType('0x2::table::Table<u64,vector<0xabc::n::N>>')?.typeArguments).toHaveLength(2);
    expect(containerType('0x2::object_table::ObjectTable<u64,0xabc::n::N>')?.target).toBe('0x2::object_table::destroy_empty');
    expect(containerType('0xabc::bag::Bag')).toBeNull();
    expect(containerType('0x2::bag::Bag<u64>')).toBeNull();
    expect(containerType('0x2::table::Table<u64>')).toBeNull();
  });
  it('requires explicit zero size', () => {
    expect(hasZeroSize({size:'0'})).toBe(true);
    expect(hasZeroSize({size:0})).toBe(true);
    for (const json of [{},{size:null},{size:false},{size:'1'},{size:''},null]) expect(hasZeroSize(json)).toBe(false);
  });
});

it('checks dynamic fields and never offers containers with hidden children', async () => {
  const query = vi.fn().mockResolvedValueOnce({data:{address:{objects:{
    nodes:[{address:'0xa',storageRebate:'2000000',contents:{type:{repr:'0x2::bag::Bag'},json:{size:'0'}}}],
    pageInfo:{hasNextPage:false,endCursor:null},
  }}}}).mockResolvedValueOnce({data:{address:{dynamicFields:{nodes:[{name:{}}]}}}});
  expect(await discoverContainers({query} as unknown as SuiGraphQLClient,'0x1')).toEqual([]);
  expect(query).toHaveBeenCalledTimes(2);
});
it('surfaces failed dynamic-field verification instead of claiming empty', async () => {
  const query = vi.fn().mockResolvedValueOnce({data:{address:{objects:{
    nodes:[{address:'0xa',storageRebate:'2000000',contents:{type:{repr:'0x2::bag::Bag'},json:{size:'0'}}}],
    pageInfo:{hasNextPage:false,endCursor:null},
  }}}}).mockResolvedValueOnce({errors:[{message:'rate limited'}]});
  await expect(discoverContainers({query} as unknown as SuiGraphQLClient,'0x1')).rejects.toThrow(/verify/);
});

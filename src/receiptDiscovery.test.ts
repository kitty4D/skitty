import { describe, expect, it, vi } from 'vitest';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { discoverReceipts, isReceiptType } from './receiptDiscovery';

const original = '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77';
const latest = '0xa9ac4281c72b0ed3277c08e821ab77eccea7b187f2b402ffa3b33f548d4bbf1e';
const blobType = `${original}::blob::Blob`;
const arg = '0x2::balance::Balance<0x2::sui::SUI>';
const capType = `0x2::allowance::AllowanceCap<${arg}>`;
const owner = '0x123';
const node = (type = blobType, json: unknown = { storage: { end_epoch: 43 } }, id = '0xa') => ({
  address: id, storageRebate: '2000000', owner: { __typename: 'AddressOwner', address: { address: owner } },
  contents: { type: { repr: type }, json },
});
const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { address: { objects: { nodes, pageInfo: { hasNextPage, endCursor } } } },
});
const system = { data: { object: { asMoveObject: { contents: { type: { repr: `${original}::system::System` },
  json: { version: '4', package_id: latest } } } } } };
const epoch = (value: unknown = 43) => ({ data: { address: { dynamicField: { value: {
  type: { repr: `${original}::system_state_inner::SystemStateInnerV1` }, json: { committee: { epoch: value } },
} } } } });
const mock = (...responses: unknown[]) => {
  const query = vi.fn();
  responses.forEach(response => query.mockResolvedValueOnce(response));
  return { client: { query } as unknown as SuiGraphQLClient, query };
};

describe('receipt discovery', () => {
  it('recognizes exact supported types independent of expiry', () => {
    expect(isReceiptType(blobType)).toBe(true);
    expect(isReceiptType(capType)).toBe(true);
    for (const type of [`${latest}::blob::Blob`, '0xbad::blob::Blob', `${blobType}<u64>`, `${blobType}Fake`,
      '0x2::allowance::AllowanceCap', '0xbad::allowance::AllowanceCap<u64>',
      '0x2::allowance::AllowanceCap<bad>', '0x2::allowance::AllowanceCap<u64>>']) expect(isReceiptType(type)).toBe(false);
  });

  it('burns only expired blobs using the Walrus committee epoch and exact target', async () => {
    const { client } = mock(page([node(), node(blobType, { storage: { end_epoch: 44 } }, '0xb')]), system, epoch());
    const result = await discoverReceipts(client, owner);
    expect(result.warnings).toEqual([]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: 'expired_walrus', moveTarget: `${latest}::blob::burn`,
      typeArguments: [], callObjectIds: ['0xa'], objectIds: ['0xa'] });
    expect(result.actions[0].selfPaidOnly).toBeUndefined();
  });

  it.each([null, {}, { storage: {} }, { storage: { end_epoch: -1 } },
    { storage: { end_epoch: '4294967296' } }, { storage: { end_epoch: '1.0' } }])('rejects malformed blob expiry %j', async json => {
    const { client, query } = mock(page([node(blobType, json)]));
    const result = await discoverReceipts(client, owner);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([null, '18446744073709551616', -1, 9007199254740992, '9007199254740992'])('rejects unsafe or malformed rebate %j', async storageRebate => {
    const { client } = mock(page([{ ...node(), storageRebate }]), system, epoch());
    const result = await discoverReceipts(client, owner);
    expect(result.actions).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('fails closed on missing Walrus epoch and partial graphql errors', async () => {
    for (const response of [epoch(null), { ...epoch(), errors: [{ message: 'partial failure' }] }]) {
      const { client } = mock(page([node()]), system, response);
      const result = await discoverReceipts(client, owner);
      expect(result.actions).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it('ignores spoof packages and pages through owned receipts without duplicates', async () => {
    const { client, query } = mock(page([node('0xbad::blob::Blob')], true, 'next'),
      page([node(), node()]), system, epoch('43'));
    const result = await discoverReceipts(client, owner);
    expect(result.actions).toHaveLength(1);
    expect(query.mock.calls[1][0].variables.after).toBe('next');
  });

  it('reports broken pagination rather than silently calling a partial scan complete', async () => {
    const { client } = mock(page([], true));
    expect((await discoverReceipts(client, owner)).warnings).toHaveLength(1);
  });

  const allowance = (settings: Record<string, unknown> = {}) => ({ data: { object: {
    address: '0xc', storageRebate: '3000000', owner: { __typename: 'Shared' }, asMoveObject: { contents: {
      type: { repr: `0x2::allowance::Allowance<${arg}>` }, json: {
        current_spend: '9007199254740993', settings: { funder: owner, spender: '0x456', app: null,
          name: 'review me', lifetime_cap: '18446744073709551616', start_timestamp_ms: null,
          expiration_timestamp_ms: '18446744073709551615', rate_limit: null, ...settings },
      },
    } },
  } } });

  it('reviews native allowances with exact nested generic and cap-first call order', async () => {
    const { client } = mock(page([node(capType, { allowance: '0xc' })]), allowance());
    const result = await discoverReceipts(client, owner);
    expect(result.warnings).toEqual([]);
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action).toMatchObject({ kind: 'revoke_allowance', moveTarget: '0x2::allowance::revoke',
      objectStorageRebates: ['2000000', '3000000'], storageRebateTotal: '5000000' });
    expect(action.callObjectIds).toEqual(action.objectIds);
    expect(action.callObjectIds[0]).toBe('0xa');
    expect(action.callObjectIds[1]).toMatch(/c$/);
    expect(action.typeArguments[0]).toContain('::balance::Balance<');
    expect(action.details.join('\n')).toContain('18446744073709551615');
    expect(action.details.join('\n')).toContain('18446744073709551616');
    expect(action.details.join('\n')).toContain('9007199254740993');
  });

  it.each([{ allowance_id: '0xc' }, { allowance: 'bogus' }, {}])('rejects an unverified cap link %j', async json => {
    const { client, query } = mock(page([node(capType, json)]));
    const result = await discoverReceipts(client, owner);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([{ funder: '0xbad' }, { expiration_timestamp_ms: '18446744073709551616' },
    { expiration_timestamp_ms: 9007199254740992 }, { lifetime_cap: '-1' }, { app: {} }])('rejects malformed allowance metadata %j', async settings => {
    const { client } = mock(page([node(capType, { allowance: '0xc' })]), allowance(settings));
    const result = await discoverReceipts(client, owner);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('requires cap ownership and exact shared type and ownership', async () => {
    const cap = node(capType, { allowance: '0xc' });
    const { client } = mock(page([{ ...cap, owner: { __typename: 'Shared' } }]));
    expect((await discoverReceipts(client, owner)).actions).toEqual([]);
    for (const mutate of [
      (value: ReturnType<typeof allowance>) => { value.data.object.owner.__typename = 'AddressOwner'; },
      (value: ReturnType<typeof allowance>) => { value.data.object.asMoveObject.contents.type.repr = '0xbad::allowance::Allowance<u64>'; },
      (value: ReturnType<typeof allowance>) => { value.data.object.address = '0xd'; },
    ]) {
      const value = allowance();
      mutate(value);
      const { client } = mock(page([cap]), value);
      expect((await discoverReceipts(client, owner)).actions).toEqual([]);
    }
  });

  it('shows the review type, readable dates, and time status without rounding u64 metadata', async () => {
    const { client } = mock(page([node(capType, { allowance: '0xc' })]),
      allowance({ start_timestamp_ms: '0', expiration_timestamp_ms: '1' }));
    const result = await discoverReceipts(client, owner);
    const details = result.actions[0].details.join('\n');
    expect(details).toContain('asset/type:');
    expect(details).toContain('::balance::Balance<');
    expect(details).toContain('1970-01-01T00:00:00.001Z');
    expect(details).toContain('time status: expired');
    expect(details).not.toContain('sponsor');
  });

  it('shows app binding and recurring spending limits', async () => {
    const { client } = mock(page([node(capType, { allowance: '0xc' })]), allowance({
      app: { name: '2::app::App' }, rate_limit: { $variant: 'Windowed', limit: '100', spent: '5',
        anchor_ms: null, index: '0', window: { $variant: 'PeriodicMs', pos0: '86400000' } },
    }));
    const result = await discoverReceipts(client, owner);
    expect(result.warnings).toEqual([]);
    expect(result.actions[0].details.join('\n')).toContain('100 per 86400000 ms, spent 5');
    expect(result.actions[0].details.join('\n')).toContain('app: 2::app::App');
  });
});

import { parseStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { ContainerAction } from './types';
import { computeFeeMist } from './buildCleanupTransaction';

const containers: Record<string, number> = {
  'bag::Bag': 0, 'object_bag::ObjectBag': 0,
  'table::Table': 2, 'object_table::ObjectTable': 2,
};

export function containerType(type: string): { target: string; typeArguments: string[] } | null {
  try {
    const tag = parseStructTag(type);
    const key = `${tag.module}::${tag.name}`;
    if (normalizeSuiAddress(tag.address) !== normalizeSuiAddress('0x2') || !(key in containers)) return null;
    if (tag.typeParams.length !== containers[key]) return null;
    // the SDK parser preserves nested generics without splitting their commas.
    const typeArguments = tag.typeParams.map((param) => typeof param === 'string' ? param :
      `${param.address}::${param.module}::${param.name}${param.typeParams.length ? `<${formatParams(param.typeParams)}>` : ''}`);
    return { target: `0x2::${tag.module}::destroy_empty`, typeArguments };
  } catch { return null; }
}

function formatParams(params: ReturnType<typeof parseStructTag>['typeParams']): string {
  return params.map((param) => typeof param === 'string' ? param :
    `${param.address}::${param.module}::${param.name}${param.typeParams.length ? `<${formatParams(param.typeParams)}>` : ''}`).join(',');
}

export function hasZeroSize(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const size = (json as Record<string, unknown>).size;
  return size === '0' || size === 0;
}

export async function discoverContainers(client: SuiGraphQLClient, owner: string, onPage?: () => void): Promise<ContainerAction[]> {
  const actions: ContainerAction[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const result = await client.query({ query: `query Containers($owner:SuiAddress!, $after:String) {
      address(address:$owner) { objects(first:50,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on MoveObject { address storageRebate contents { type { repr } json } } }
      } }
    }`, variables: { owner, after }, signal: AbortSignal.timeout(20_000) });
    if (result.errors?.length || !result.data) throw new Error('Could not check empty containers.');
    const data = result.data as {address?:{objects?:{nodes?:{address:string;storageRebate?:string;contents?:{type?:{repr?:string};json?:unknown}}[];pageInfo:{hasNextPage:boolean;endCursor:string}}}};
    const connection = data.address?.objects;
    if (!connection) throw new Error('Missing container scan results.');
    onPage?.();
    for (const node of connection.nodes ?? []) {
      const objectType = node.contents?.type?.repr;
      const call = objectType ? containerType(objectType) : null;
      if (!call || !hasZeroSize(node.contents?.json)) continue;
      // size alone isn't proof: a custom extension could have added other fields.
      const fields = await client.query({query:`query Fields($id:SuiAddress!) {
        address(address:$id) { dynamicFields(first:1) { nodes { name { type { repr } } } } }
      }`,variables:{id:node.address},signal:AbortSignal.timeout(20_000)});
      if (fields.errors?.length || !fields.data) throw new Error('Could not verify container contents.');
      const fieldData = fields.data as {address?:{dynamicFields?:{nodes?:unknown[]}}};
      const nodes = fieldData.address?.dynamicFields?.nodes;
      if (!nodes || nodes.length) continue;
      const rebate = Number(node.storageRebate);
      if (!Number.isSafeInteger(rebate) || rebate < 0) continue;
      const userRebateMist = Math.floor(rebate * 0.99);
      actions.push({kind:'empty_container',objectType:objectType!,moveTarget:call.target,typeArguments:call.typeArguments,
        objectIds:[node.address],objectStorageRebates:[String(rebate)],storageRebateTotal:String(rebate),
        userRebateMist,estimatedGasMist:1_000_000,netGainMist:userRebateMist-1_000_000-computeFeeMist(rebate),
        label:objectType!.split('::').slice(1).join('::'),details:['verified empty: size 0, no dynamic fields']});
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !after) throw new Error('Incomplete container pagination.');
    if (after && cursors.has(after)) throw new Error('Repeated container cursor.');
    if (after) cursors.add(after);
  } while (after);
  return actions;
}

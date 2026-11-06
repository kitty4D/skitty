import { expect, it } from 'vitest';
import { buildBatchTransaction } from './buildCleanupTransaction';
import type { ContainerAction, WithdrawKioskAction } from './types';
import { selectActionKeys, actionKey } from './actionIdentity';
import { gasModeForActions } from './sponsoredTx';
import type { ReceiptAction } from './receiptDiscovery';

const senderAddress = `0x${'1'.repeat(64)}`;
const container: ContainerAction = {kind:'empty_container',objectType:'0x2::table::Table<u64,u64>',
  moveTarget:'0x2::table::destroy_empty',typeArguments:['u64','u64'],objectIds:['0xa'],
  storageRebateTotal:'2000000',objectStorageRebates:['2000000'],userRebateMist:1980000,
  estimatedGasMist:100000,netGainMist:0,details:[]};
const withdrawal: WithdrawKioskAction = {kind:'withdraw_kiosk',kioskId:'0xb',ownerCapId:'0xc',
  objectIds:['0xb','0xc'],proceedsMist:'9007199254740993',selfPaidOnly:true,
  storageRebateTotal:'0',userRebateMist:0,estimatedGasMist:100000,netGainMist:0,details:[]};

it('destroys empty generic containers with exact type arguments and counts their rebate', () => {
  const build = buildBatchTransaction([container], {senderAddress});
  expect(build.storageRebateMist).toBe(2000000);
  expect(build.tx.getData().commands[0].MoveCall).toMatchObject({module:'table',function:'destroy_empty',typeArguments:['u64','u64']});
});
it('withdraws a fixed u64 amount to the sender balance without charging proceeds', () => {
  const build = buildBatchTransaction([withdrawal], {senderAddress,selfPaidFee:{source:'addressBalance',maxMist:1e9}});
  expect(build.feeMist).toBe(0);
  expect(build.storageRebateMist).toBe(0);
  const commands = build.tx.getData().commands;
  expect(commands.map(command=>command.MoveCall?.function)).toEqual(['withdraw','send_funds']);
  expect(JSON.stringify(commands)).not.toContain('GasCoin');
  expect(JSON.stringify(build.tx.getData().inputs)).toContain('Pure');
});
it('routes standalone withdrawal to self-paid and refuses a sponsored build', () => {
  expect(gasModeForActions([withdrawal], 'sponsored')).toBe('self');
  expect(()=>buildBatchTransaction([withdrawal],{senderAddress,sponsoredGas:true})).toThrow(/wallet for gas/);
});
it('refuses overlapping kiosk operations even though the cap survives withdrawal', () => {
  expect(()=>buildBatchTransaction([withdrawal,withdrawal],{senderAddress})).toThrow(/overlap/);
  const second = {...withdrawal,kind:'close_kiosk' as const,label:'kiosk'};
  expect(selectActionKeys([withdrawal,second],new Set([actionKey(second)]),[withdrawal])).toEqual(new Set([actionKey(withdrawal)]));
});

it('revokes with cap first and allowance second, reclaiming both objects', () => {
  const action: ReceiptAction = {...container,kind:'revoke_allowance',
    objectType:'0x2::allowance::AllowanceCap<0x2::balance::Balance<0x2::sui::SUI>>',
    moveTarget:'0x2::allowance::revoke',typeArguments:['0x2::balance::Balance<0x2::sui::SUI>'],
    callObjectIds:['0xa','0xb'],objectIds:['0xa','0xb'],objectStorageRebates:['2000000','3000000'],
    storageRebateTotal:'5000000'};
  const build = buildBatchTransaction([action],{senderAddress});
  const data = build.tx.getData();
  expect(build.storageRebateMist).toBe(5000000);
  expect(data.commands[0].MoveCall).toMatchObject({module:'allowance',function:'revoke',arguments:[{Input:0},{Input:1}]});
  expect(data.inputs[0]).toMatchObject({UnresolvedObject:{objectId:expect.stringMatching(/a$/)}});
  expect(data.inputs[1]).toMatchObject({UnresolvedObject:{objectId:expect.stringMatching(/b$/)}});
});

it('expired Walrus receipts build a single owned burn without touching gas', () => {
  const action: ReceiptAction = {...container,kind:'expired_walrus',
    objectType:'0xabc::blob::Blob',moveTarget:'0xabc::blob::burn',typeArguments:[],callObjectIds:['0xa']};
  const build = buildBatchTransaction([action],{senderAddress});
  expect(build.tx.getData().commands).toHaveLength(1);
  expect(build.tx.getData().commands[0].MoveCall).toMatchObject({module:'blob',function:'burn',typeArguments:[]});
});

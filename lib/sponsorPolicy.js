// Policy for /api/sponsor: decide whether a client-supplied transaction kind is
// one we are willing to blind-sign with the house keypair.
//
// The sponsor co-signs the WHOLE TransactionData, so an unvalidated kind lets a
// caller drain the sponsor's gas coin (SplitCoins(GasCoin) + TransferObjects to
// themselves). Two independent gates guard against that:
//   1. validateReclaimTransactionKind - structural allow-list (this file).
//   2. a simulated sponsor net-balance check in the handler, which is what
//      actually bounds the amount of value that can leave the gas coin.

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

// mirrors BURN_FUNCTION_NAMES in src/useGraphQLScanner.ts
const BURN_FUNCTION_NAMES = new Set(['burn', 'delete', 'destroy']);

// normalized so they compare equal to the padded package addresses the SDK emits
const normalizeTarget = (target) => {
  const [pkg, mod, fn] = target.split('::');
  return `${normalizeSuiAddress(pkg)}::${mod}::${fn}`;
};

const COIN_DESTROY_ZERO = normalizeTarget('0x2::coin::destroy_zero');
const KIOSK_CLOSE_AND_WITHDRAW = normalizeTarget('0x2::kiosk::close_and_withdraw');

// framework packages may only be called through the two entry points above
const FRAMEWORK_PACKAGES = new Set(
  ['0x1', '0x2', '0x3', '0x5'].map((p) => normalizeSuiAddress(p))
);

// worst case is MAX_ACTIONS_PER_BATCH (50) kiosk closes = 2 commands each, plus fee commands
export const MAX_COMMANDS = 256;

// Absolute ceiling on value that may be split out of the gas coin in one transaction.
// Real reclaim batches move well under this; it exists so a wrong simulation can never
// authorize an unbounded transfer.
export const MAX_GAS_COIN_SPLIT_MIST = 2_000_000_000n; // 2 SUI

export class SponsorPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SponsorPolicyError';
  }
}

function reject(message) {
  throw new SponsorPolicyError(message);
}

function normalizedTarget(moveCall) {
  return `${normalizeSuiAddress(moveCall.package)}::${moveCall.module}::${moveCall.function}`;
}

// a Pure input holding a BCS address is exactly 32 raw bytes
function decodePureAddress(input) {
  if (input?.$kind !== 'Pure' || typeof input.Pure?.bytes !== 'string') return null;
  let bytes;
  try {
    bytes = fromBase64(input.Pure.bytes);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function isGasCoin(arg) {
  return arg?.$kind === 'GasCoin';
}

function isCommandResult(arg) {
  return arg?.$kind === 'Result' || arg?.$kind === 'NestedResult';
}

function objectInputKind(arg, inputs) {
  if (arg?.$kind !== 'Input') return null;
  const input = inputs[arg.Input];
  if (input?.$kind !== 'Object') return null;
  return input.Object?.$kind ?? null;
}

/**
 * Owned objects are pinned to an exact version in the transaction, so what the
 * simulation runs against is what execution runs against. Shared objects are not:
 * their state can change between our simulation and the caller submitting the
 * signature we handed out, which would let a caller show us a profitable simulation
 * and then execute a different, unprofitable one.
 */
function isOwnedObjectInput(arg, inputs) {
  return objectInputKind(arg, inputs) === 'ImmOrOwnedObject';
}

function isPureInput(arg, inputs) {
  if (arg?.$kind !== 'Input') return false;
  return inputs[arg.Input]?.$kind === 'Pure';
}

// a Pure input holding a BCS u64 is 8 little-endian bytes
function decodePureU64(input) {
  if (input?.$kind !== 'Pure' || typeof input.Pure?.bytes !== 'string') return null;
  let bytes;
  try {
    bytes = fromBase64(input.Pure.bytes);
  } catch {
    return null;
  }
  if (bytes.length !== 8) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

// every argument a command references, so we can assert GasCoin appears nowhere unexpected
function commandArguments(command) {
  switch (command.$kind) {
    case 'MoveCall':
      return command.MoveCall.arguments ?? [];
    case 'TransferObjects':
      return [...(command.TransferObjects.objects ?? []), command.TransferObjects.address];
    case 'MergeCoins':
      return [command.MergeCoins.destination, ...(command.MergeCoins.sources ?? [])];
    case 'SplitCoins':
      return [command.SplitCoins.coin, ...(command.SplitCoins.amounts ?? [])];
    default:
      return [];
  }
}

/**
 * Throws SponsorPolicyError unless `data` is shaped like a skitty reclaim batch.
 *
 * @param {object} data      result of Transaction.fromKind(bytes).getData()
 * @param {object} options
 * @param {string} options.sender        address the caller declared as sender
 * @param {string} options.feeRecipient  the only other address value may be sent to
 */
export function validateReclaimTransactionKind(data, { sender, feeRecipient }) {
  const commands = data?.commands ?? [];
  const inputs = data?.inputs ?? [];

  if (commands.length === 0) reject('Transaction has no commands.');
  if (commands.length > MAX_COMMANDS) {
    reject(`Transaction has ${commands.length} commands; the limit is ${MAX_COMMANDS}.`);
  }

  // Vet every input, not just the ones a command references. An unreferenced input is
  // inert today, but the transaction format carries kinds such as FundsWithdrawal that
  // draw on the sender's balance directly, and nothing should smuggle one in.
  for (let i = 0; i < inputs.length; i++) {
    const kind = inputs[i]?.$kind;
    if (kind !== 'Pure' && kind !== 'Object') {
      reject(`input ${i}: ${kind ?? 'unknown'} inputs are not allowed.`);
    }
    if (kind === 'Object' && inputs[i].Object?.$kind === 'Receiving') {
      reject(`input ${i}: receiving inputs are not allowed.`);
    }
  }

  const senderNorm = normalizeSuiAddress(sender);
  const feeRecipientNorm = normalizeSuiAddress(feeRecipient);
  if (senderNorm === feeRecipientNorm) {
    // sender == gas owner would collapse the required signers to just the sponsor,
    // making our signature a complete, submittable transaction on its own
    reject('The sponsor cannot be the sender of a transaction it sponsors.');
  }
  const allowedRecipients = new Set([senderNorm, feeRecipientNorm]);

  // Hard ceiling on value leaving the gas coin, independent of the simulation. The
  // simulated net-balance gate is the primary bound, but it trusts a prediction; this
  // caps the damage if that prediction is ever wrong.
  let totalSplitFromGas = 0n;
  // How much of that actually leaves the sponsor (i.e. goes to the sender). The handler
  // checks this against the storage rebate the simulation says the batch reclaims - // a figure the caller cannot inflate, unlike a balance credit they arrange themselves.
  let splitToSenderMist = 0n;
  // amount produced by each SplitCoins(GasCoin) result, keyed "cmdIndex:resultIndex"
  const gasSplitAmounts = new Map();

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const at = `command ${i} (${command?.$kind ?? 'unknown'})`;

    // GasCoin is spendable value: it may only ever appear as the source of a split.
    for (const arg of commandArguments(command)) {
      if (isGasCoin(arg) && !(command.$kind === 'SplitCoins' && arg === command.SplitCoins.coin)) {
        reject(`${at} references the gas coin; only SplitCoins may.`);
      }
    }

    switch (command.$kind) {
      case 'MoveCall': {
        const moveCall = command.MoveCall;
        const target = normalizedTarget(moveCall);
        const args = moveCall.arguments ?? [];

        if (target === COIN_DESTROY_ZERO) {
          if (args.length !== 1) reject(`${at}: destroy_zero takes exactly 1 argument.`);
          // A command result is allowed here so an emptied kiosk's zero-balance payout
          // coin can be destroyed instead of costing storage. destroy_zero aborts on a
          // non-zero balance, so no value can be destroyed this way.
          if (!isOwnedObjectInput(args[0], inputs) && !isCommandResult(args[0])) {
            reject(`${at}: destroy_zero needs an owned object or a coin from this transaction.`);
          }
          break;
        }

        if (target === KIOSK_CLOSE_AND_WITHDRAW) {
          if (args.length !== 2) reject(`${at}: close_and_withdraw takes exactly 2 arguments.`);
          // the Kiosk itself is usually shared, but this is a fixed framework function
          // whose behaviour we know; the owner cap must still be owned
          if (objectInputKind(args[0], inputs) == null) {
            reject(`${at}: close_and_withdraw needs a kiosk object.`);
          }
          if (!isOwnedObjectInput(args[1], inputs)) {
            reject(`${at}: close_and_withdraw needs an owned kiosk owner cap.`);
          }
          break;
        }

        // anything else must look like a single-argument burn on a third-party package
        if (FRAMEWORK_PACKAGES.has(normalizeSuiAddress(moveCall.package))) {
          reject(`${at}: ${target} is not an allowed framework call.`);
        }
        if (!BURN_FUNCTION_NAMES.has(moveCall.function)) {
          reject(`${at}: ${target} is not a burn/delete/destroy entry point.`);
        }
        if (args.length !== 1) reject(`${at}: burn entry points must take exactly 1 argument.`);
        // Critically an OWNED object: a caller-controlled shared object would let the
        // code we are about to sign for behave differently at execution than it did in
        // the simulation we based the decision on.
        if (!isOwnedObjectInput(args[0], inputs)) {
          reject(`${at}: burn needs an owned, version-pinned object.`);
        }
        break;
      }

      case 'SplitCoins': {
        const { coin, amounts } = command.SplitCoins;
        // the reclaim flow only ever peels the fee/user share off the gas coin
        if (!isGasCoin(coin)) reject(`${at}: may only split the gas coin.`);
        if (!amounts?.length) reject(`${at}: split needs at least one amount.`);
        for (let a = 0; a < amounts.length; a++) {
          const amount = amounts[a];
          if (!isPureInput(amount, inputs)) {
            reject(`${at}: split amounts must be literal values.`);
          }
          const value = decodePureU64(inputs[amount.Input]);
          if (value == null) reject(`${at}: split amounts must be u64 literals.`);
          totalSplitFromGas += value;
          gasSplitAmounts.set(`${i}:${a}`, value);
        }
        break;
      }

      case 'TransferObjects': {
        const { objects, address } = command.TransferObjects;
        if (!objects?.length) reject(`${at}: nothing to transfer.`);
        // only coins produced earlier in this transaction may be sent anywhere
        if (!objects.every(isCommandResult)) {
          reject(`${at}: may only transfer objects produced by this transaction.`);
        }
        const recipient = decodePureAddress(inputs[address?.Input]);
        if (!recipient) reject(`${at}: recipient must be a literal address.`);
        const recipientNorm = normalizeSuiAddress(recipient);
        if (!allowedRecipients.has(recipientNorm)) {
          reject(`${at}: may only transfer to the sender or the fee recipient.`);
        }
        for (const object of objects) {
          if (object.$kind === 'Result' && gasSplitAmounts.has(`${object.Result}:1`)) {
            // Result(i) means "the single value command i produced". Pointing it at a
            // multi-amount split would have us count only the first amount; the VM
            // rejects it anyway, but the validator must not mis-model what it signs.
            reject(`${at}: cannot reference a multi-value split as a single result.`);
          }
          const key =
            object.$kind === 'NestedResult'
              ? `${object.NestedResult[0]}:${object.NestedResult[1]}`
              : `${object.Result}:0`;
          const splitAmount = gasSplitAmounts.get(key);
          if (recipientNorm === feeRecipientNorm) {
            // Paying the sponsor anything it did not already own would let a caller
            // manufacture apparent sponsor income and talk the simulation gate into
            // signing - the sponsor's own gas-coin split is the only legitimate case.
            if (splitAmount == null) {
              reject(`${at}: the fee recipient may only receive value split from the gas coin.`);
            }
          } else if (splitAmount != null) {
            splitToSenderMist += splitAmount;
          }
        }
        break;
      }

      case 'MergeCoins': {
        const { destination, sources } = command.MergeCoins;
        if (!isOwnedObjectInput(destination, inputs)) {
          reject(`${at}: merge destination must be an owned coin.`);
        }
        if (!sources?.length) reject(`${at}: merge needs at least one source.`);
        if (!sources.every((s) => isOwnedObjectInput(s, inputs))) {
          reject(`${at}: merge sources must be owned coins.`);
        }
        break;
      }

      default:
        reject(`${at}: command type is not allowed.`);
    }
  }

  if (totalSplitFromGas > MAX_GAS_COIN_SPLIT_MIST) {
    reject(
      `Transaction would move ${totalSplitFromGas} mist out of the gas coin; the ceiling is ${MAX_GAS_COIN_SPLIT_MIST}.`
    );
  }

  return { totalSplitFromGas, splitToSenderMist };
}

/**
 * The gas coin's own arithmetic: it is charged computation and storage, credited the
 * storage rebate for everything the batch deletes, and debited whatever is split out to
 * the sender. All three come from sources the caller cannot inflate - gasUsed is
 * determined by the objects actually destroyed - so this holds even if the caller can
 * make some other part of the simulation look different at execution time.
 */
export function gasCoinNetMist(gasUsed, splitToSenderMist) {
  // Missing fields are missing evidence, not zeros. Defaulting them would make this
  // gate pass on no data at all - and asymmetrically, since a zero-value griefing
  // transaction would sail through while a real payout got rejected.
  const toBig = (value) => {
    if (value === undefined || value === null || value === '') return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  };
  const computation = toBig(gasUsed?.computationCost);
  const storage = toBig(gasUsed?.storageCost);
  const rebate = toBig(gasUsed?.storageRebate);
  if (computation == null || storage == null || rebate == null) return null;
  return rebate - computation - storage - splitToSenderMist;
}

/**
 * Net SUI (mist) flowing to `address` according to simulated balance changes.
 * Returns null when the answer cannot be trusted, so the caller can refuse to sign.
 *
 * An absent row is NOT "net zero": the sponsor owns the gas coin and is always
 * charged gas, so having no row for it means the data is missing. Treating that as
 * zero would let the one gate that actually bounds our exposure pass on no evidence.
 */
export function netSuiChangeForAddress(balanceChanges, address) {
  if (!Array.isArray(balanceChanges) || balanceChanges.length === 0) return null;
  const target = normalizeSuiAddress(address);
  const isSui = (type) => /^0x0*2::sui::SUI$/i.test(type ?? '');
  let net = 0n;
  let sawAddress = false;
  for (const change of balanceChanges) {
    if (!change?.address || !isSui(change.coinType)) continue;
    if (normalizeSuiAddress(change.address) !== target) continue;
    sawAddress = true;
    try {
      net += BigInt(change.amount);
    } catch {
      return null;
    }
  }
  return sawAddress ? net : null;
}

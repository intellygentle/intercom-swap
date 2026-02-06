import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

export const LN_USDT_ESCROW_PROGRAM_ID = new PublicKey('evYHPt33hCYHNm7iFHAHXmSkYrEoDnBSv69MHwLfYyK');

const ESCROW_SEED = Buffer.from('escrow');
const CONFIG_SEED = Buffer.from('config');

function hexToBytes(hex) {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2 !== 0) {
    throw new Error('Invalid hex');
  }
  return Buffer.from(h, 'hex');
}

function u64Le(n) {
  const x = BigInt(n);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(x);
  return buf;
}

function i64Le(n) {
  const x = BigInt(n);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(x);
  return buf;
}

function u16Le(n) {
  const x = Number(n);
  if (!Number.isInteger(x) || x < 0 || x > 0xffff) throw new Error('Invalid u16');
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(x);
  return buf;
}

export function deriveEscrowPda(paymentHashHex, programId = LN_USDT_ESCROW_PROGRAM_ID) {
  const hash = hexToBytes(paymentHashHex);
  if (hash.length !== 32) throw new Error('paymentHash must be 32 bytes');
  const [pda, bump] = PublicKey.findProgramAddressSync([ESCROW_SEED, hash], programId);
  return { pda, bump };
}

export function deriveConfigPda(programId = LN_USDT_ESCROW_PROGRAM_ID) {
  const [pda, bump] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  return { pda, bump };
}

export async function deriveVaultAta(escrowPda, mint) {
  return getAssociatedTokenAddress(mint, escrowPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export async function deriveFeeVaultAta(configPda, mint) {
  return getAssociatedTokenAddress(mint, configPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function buildInitInstruction({
  paymentHashHex,
  recipient,
  refund,
  refundAfterUnix,
  amount,
  payer,
  payerTokenAccount,
  mint,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const { pda: configPda } = deriveConfigPda(programId);
  const paymentHash = hexToBytes(paymentHashHex);
  const data = Buffer.concat([
    Buffer.from([0]), // Init tag
    paymentHash,
    Buffer.from(recipient.toBytes()),
    Buffer.from(refund.toBytes()),
    i64Le(refundAfterUnix),
    u64Le(amount),
  ]);

  return (vault, feeVaultAta) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: feeVaultAta, isSigner: false, isWritable: true },
      ],
      data,
    });
}

export function buildClaimInstruction({
  preimageHex,
  paymentHashHex,
  recipient,
  recipientTokenAccount,
  feeVaultAta,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const preimage = hexToBytes(preimageHex);
  if (preimage.length !== 32) throw new Error('preimage must be 32 bytes');
  const data = Buffer.concat([Buffer.from([1]), preimage]);

  return (vault) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: recipient, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: feeVaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
}

export function buildRefundInstruction({
  paymentHashHex,
  refund,
  refundTokenAccount,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const data = Buffer.from([2]);
  return (vault) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: refund, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: refundTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
}

export function decodeEscrowState(data) {
  const buf = Buffer.from(data);
  const v = buf.readUInt8(0);
  if (v === 1) {
    if (buf.length < 179) throw new Error('Escrow account too small (v1)');
    const status = buf.readUInt8(1);
    const paymentHash = buf.subarray(2, 34);
    const recipient = new PublicKey(buf.subarray(34, 66));
    const refund = new PublicKey(buf.subarray(66, 98));
    const refundAfter = buf.readBigInt64LE(98);
    const mint = new PublicKey(buf.subarray(106, 138));
    const amount = buf.readBigUInt64LE(138);
    const vault = new PublicKey(buf.subarray(146, 178));
    const bump = buf.readUInt8(178);
    return {
      v,
      status,
      paymentHashHex: paymentHash.toString('hex'),
      recipient,
      refund,
      refundAfter,
      mint,
      amount, // alias for net_amount in v1
      netAmount: amount,
      feeAmount: 0n,
      feeBps: 0,
      feeCollector: null,
      vault,
      bump,
    };
  }

  if (v === 2) {
    if (buf.length < 221) throw new Error('Escrow account too small (v2)');
    const status = buf.readUInt8(1);
    const paymentHash = buf.subarray(2, 34);
    const recipient = new PublicKey(buf.subarray(34, 66));
    const refund = new PublicKey(buf.subarray(66, 98));
    const refundAfter = buf.readBigInt64LE(98);
    const mint = new PublicKey(buf.subarray(106, 138));
    const netAmount = buf.readBigUInt64LE(138);
    const feeAmount = buf.readBigUInt64LE(146);
    const feeBps = buf.readUInt16LE(154);
    const feeCollector = new PublicKey(buf.subarray(156, 188));
    const vault = new PublicKey(buf.subarray(188, 220));
    const bump = buf.readUInt8(220);
    return {
      v,
      status,
      paymentHashHex: paymentHash.toString('hex'),
      recipient,
      refund,
      refundAfter,
      mint,
      amount: netAmount, // backwards compatible alias
      netAmount,
      feeAmount,
      feeBps,
      feeCollector,
      vault,
      bump,
    };
  }

  throw new Error(`Unsupported escrow version v=${v}`);
}

export function decodeConfigState(data) {
  const buf = Buffer.from(data);
  if (buf.length < 68) throw new Error('Config account too small');
  const v = buf.readUInt8(0);
  if (v !== 1) throw new Error(`Unsupported config version v=${v}`);
  const authority = new PublicKey(buf.subarray(1, 33));
  const feeCollector = new PublicKey(buf.subarray(33, 65));
  const feeBps = buf.readUInt16LE(65);
  const bump = buf.readUInt8(67);
  return { v, authority, feeCollector, feeBps, bump };
}

export async function getConfigState(connection, programId = LN_USDT_ESCROW_PROGRAM_ID, commitment = 'confirmed') {
  const { pda } = deriveConfigPda(programId);
  const info = await connection.getAccountInfo(pda, commitment);
  if (!info) return null;
  return decodeConfigState(info.data);
}

export async function getEscrowState(
  connection,
  paymentHashHex,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
  commitment = 'confirmed'
) {
  const { pda } = deriveEscrowPda(paymentHashHex, programId);
  const info = await connection.getAccountInfo(pda, commitment);
  if (!info) return null;
  return decodeEscrowState(info.data);
}

export async function createEscrowTx({
  connection,
  payer,
  payerTokenAccount,
  mint,
  paymentHashHex,
  recipient,
  refund,
  refundAfterUnix,
  amount,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const { pda: configPda } = deriveConfigPda(programId);
  const vault = await deriveVaultAta(escrowPda, mint);
  const feeVaultAta = await deriveFeeVaultAta(configPda, mint);

  const initIxFactory = buildInitInstruction({
    paymentHashHex,
    recipient,
    refund,
    refundAfterUnix,
    amount,
    payer: payer.publicKey,
    payerTokenAccount,
    mint,
    programId,
  });

  const tx = new Transaction();
  // Note: The program CPI creates the escrow PDA and vault ATA; the transaction contains only the init instruction.
  const initIx = initIxFactory(vault, feeVaultAta);
  tx.add(initIx);

  tx.feePayer = payer.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer);
  return { tx, escrowPda, vault, feeVaultAta };
}

export async function claimEscrowTx({
  connection,
  recipient,
  recipientTokenAccount,
  mint,
  paymentHashHex,
  preimageHex,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const { pda: configPda } = deriveConfigPda(programId);
  const vault = await deriveVaultAta(escrowPda, mint);
  const feeVaultAta = await deriveFeeVaultAta(configPda, mint);
  const claimIxFactory = buildClaimInstruction({
    preimageHex,
    paymentHashHex,
    recipient: recipient.publicKey,
    recipientTokenAccount,
    feeVaultAta,
    programId,
  });
  const tx = new Transaction().add(claimIxFactory(vault));
  tx.feePayer = recipient.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(recipient);
  return { tx, escrowPda, vault, feeVaultAta };
}

export async function refundEscrowTx({
  connection,
  refund,
  refundTokenAccount,
  mint,
  paymentHashHex,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
  const vault = await deriveVaultAta(escrowPda, mint);
  const refundIxFactory = buildRefundInstruction({
    paymentHashHex,
    refund: refund.publicKey,
    refundTokenAccount,
    programId,
  });
  const tx = new Transaction().add(refundIxFactory(vault));
  tx.feePayer = refund.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(refund);
  return { tx, escrowPda, vault };
}

export async function initConfigTx({
  connection,
  payer,
  feeCollector,
  feeBps,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: configPda } = deriveConfigPda(programId);
  const data = Buffer.concat([Buffer.from([3]), Buffer.from(feeCollector.toBytes()), u16Le(feeBps)]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer);
  return { tx, configPda };
}

export async function setConfigTx({
  connection,
  authority,
  feeCollector,
  feeBps,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: configPda } = deriveConfigPda(programId);
  const data = Buffer.concat([Buffer.from([4]), Buffer.from(feeCollector.toBytes()), u16Le(feeBps)]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(authority);
  return { tx, configPda };
}

export async function withdrawFeesTx({
  connection,
  feeCollector,
  feeCollectorTokenAccount,
  mint,
  amount,
  programId = LN_USDT_ESCROW_PROGRAM_ID,
}) {
  const { pda: configPda } = deriveConfigPda(programId);
  const feeVaultAta = await deriveFeeVaultAta(configPda, mint);
  const data = Buffer.concat([Buffer.from([5]), u64Le(amount ?? 0)]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: feeCollector.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: feeVaultAta, isSigner: false, isWritable: true },
      { pubkey: feeCollectorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = feeCollector.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(feeCollector);
  return { tx, feeVaultAta, configPda };
}

#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import {
  LN_USDT_ESCROW_PROGRAM_ID,
  deriveConfigPda,
  deriveFeeVaultAta,
  getConfigState,
  getEscrowState,
  initConfigTx,
  setConfigTx,
  withdrawFeesTx,
} from '../src/solana/lnUsdtEscrowClient.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
escrowctl (Solana LN<->SPL escrow program operator tool)

Global flags:
  --solana-rpc-url <url>              (default: http://127.0.0.1:8899)
  --commitment <processed|confirmed|finalized> (default: confirmed)
  --program-id <base58>               (default: LN_USDT_ESCROW_PROGRAM_ID)

Key flags (for signing commands):
  --solana-keypair <path>             (required for config-init/config-set/fees-withdraw)

Commands:
  config-get
  config-init --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  config-set  --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  fees-balance --mint <pubkey>
  fees-withdraw --mint <pubkey> [--amount <u64>] [--create-ata 0|1] [--simulate 0|1]
  escrow-get --payment-hash <hex32>

Notes:
  - In this fork, the program enforces: config authority == fee_collector.
  - For WithdrawFees, --amount 0 (default) means "withdraw all".
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function parseU64(value, label, fallback = 0n) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const x = BigInt(String(value).trim());
    if (x < 0n) die(`Invalid ${label} (negative)`);
    return x;
  } catch (_e) {
    die(`Invalid ${label}`);
  }
}

function readSolanaKeypair(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (_e) {
    throw new Error('Invalid Solana keypair JSON');
  }
  if (!Array.isArray(arr)) throw new Error('Solana keypair must be a JSON array');
  const bytes = Uint8Array.from(arr);
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`Solana keypair must be 64 bytes (solana-keygen) or 32 bytes (seed), got ${bytes.length}`);
  }
  return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
}

async function sendAndConfirm(connection, tx, commitment) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, commitment);
  if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const rpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const commitment = (flags.get('commitment') && String(flags.get('commitment')).trim()) || 'confirmed';
  const programIdStr = (flags.get('program-id') && String(flags.get('program-id')).trim()) || '';
  const programId = programIdStr ? new PublicKey(programIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
  const connection = new Connection(rpcUrl, commitment);

  if (cmd === 'config-get') {
    const { pda: configPda } = deriveConfigPda(programId);
    const state = await getConfigState(connection, programId, commitment);
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'config_state',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          state: state
            ? {
                v: state.v,
                authority: state.authority.toBase58(),
                fee_collector: state.feeCollector.toBase58(),
                fee_bps: state.feeBps,
                bump: state.bump,
              }
            : null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'escrow-get') {
    const paymentHashHex = requireFlag(flags, 'payment-hash').trim().toLowerCase();
    const state = await getEscrowState(connection, paymentHashHex, programId, commitment);
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'escrow_state',
          program_id: programId.toBase58(),
          payment_hash_hex: paymentHashHex,
          state: state
            ? {
                v: state.v,
                status: state.status,
                payment_hash_hex: state.paymentHashHex,
                recipient: state.recipient.toBase58(),
                refund: state.refund.toBase58(),
                refund_after_unix: Number(state.refundAfter),
                mint: state.mint.toBase58(),
                net_amount: state.netAmount !== undefined ? state.netAmount.toString() : state.amount.toString(),
                fee_amount: state.feeAmount ? state.feeAmount.toString() : '0',
                fee_bps: state.feeBps || 0,
                fee_collector: state.feeCollector ? state.feeCollector.toBase58() : null,
                vault: state.vault.toBase58(),
                bump: state.bump,
              }
            : null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'fees-balance') {
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const { pda: configPda } = deriveConfigPda(programId);
    const feeVaultAta = await deriveFeeVaultAta(configPda, mint);
    let amount = 0n;
    try {
      const acct = await getAccount(connection, feeVaultAta, commitment);
      amount = acct.amount;
    } catch (_e) {
      amount = 0n;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'fee_vault_balance',
          program_id: programId.toBase58(),
          mint: mint.toBase58(),
          config_pda: configPda.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          amount: amount.toString(),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  // Signing commands below.
  const keypairPath = requireFlag(flags, 'solana-keypair');
  const signer = readSolanaKeypair(keypairPath);

  if (cmd === 'config-init' || cmd === 'config-set') {
    const feeBps = parseIntFlag(requireFlag(flags, 'fee-bps'), 'fee-bps');
    const feeCollectorStr = (flags.get('fee-collector') && String(flags.get('fee-collector')).trim()) || '';
    const feeCollector = feeCollectorStr ? new PublicKey(feeCollectorStr) : signer.publicKey;
    const simulate = parseBool(flags.get('simulate'), false);

    if (!feeCollector.equals(signer.publicKey)) {
      die('Invalid --fee-collector: this program requires fee_collector == authority (signer).');
    }

    const build = cmd === 'config-init' ? initConfigTx : setConfigTx;
    const { tx, configPda } = await build({
      connection,
      ...(cmd === 'config-init' ? { payer: signer } : { authority: signer }),
      feeCollector,
      feeBps,
      programId,
    });

    if (simulate) {
      const sim = await connection.simulateTransaction(tx, { commitment });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            config_pda: configPda.toBase58(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await sendAndConfirm(connection, tx, commitment);
    process.stdout.write(
      `${JSON.stringify(
        {
          type: cmd === 'config-init' ? 'config_inited' : 'config_set',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          fee_collector: feeCollector.toBase58(),
          fee_bps: feeBps,
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'fees-withdraw') {
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const amount = parseU64(flags.get('amount'), 'amount', 0n);
    const createAta = parseBool(flags.get('create-ata'), true);
    const simulate = parseBool(flags.get('simulate'), false);

    const destAta = await getAssociatedTokenAddress(mint, signer.publicKey, false);
    if (createAta) {
      try {
        await getAccount(connection, destAta, commitment);
      } catch (_e) {
        await createAssociatedTokenAccount(connection, signer, mint, signer.publicKey);
      }
    }

    const { tx, feeVaultAta, configPda } = await withdrawFeesTx({
      connection,
      feeCollector: signer,
      feeCollectorTokenAccount: destAta,
      mint,
      amount,
      programId,
    });

    if (simulate) {
      const sim = await connection.simulateTransaction(tx, { commitment });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            config_pda: configPda.toBase58(),
            fee_vault_ata: feeVaultAta.toBase58(),
            dest_ata: destAta.toBase58(),
            amount: amount.toString(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await sendAndConfirm(connection, tx, commitment);
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'fees_withdrawn',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          mint: mint.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          dest_ata: destAta.toBase58(),
          amount: amount.toString(),
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));


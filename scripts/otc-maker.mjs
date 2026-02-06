#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import { normalizeInvitePayload, normalizeWelcomePayload, createSignedInvite } from '../src/sidechannel/capabilities.js';
import {
  createEscrowTx,
  LN_USDT_ESCROW_PROGRAM_ID,
} from '../src/solana/lnUsdtEscrowClient.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
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

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

async function signViaBridge(sc, payload) {
  const res = await sc.sign(payload);
  if (res.type !== 'signed') throw new Error(`Unexpected sign response: ${JSON.stringify(res).slice(0, 120)}`);
  const signerHex = String(res.signer || '').trim().toLowerCase();
  const sigHex = String(res.sig || '').trim().toLowerCase();
  if (!signerHex || !sigHex) throw new Error('Signing failed (missing signer/sig)');
  return { signerHex, sigHex };
}

async function signSwapEnvelope(sc, unsignedEnvelope) {
  const { signerHex, sigHex } = await signViaBridge(sc, unsignedEnvelope);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: signerHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
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

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function lnCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  args,
}) {
  const useDocker = backend === 'docker';
  const cmd = useDocker ? 'docker' : (cliBin || 'lightning-cli');
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, 'lightning-cli', `--network=${network}`, ...args]
    : [`--network=${network}`, ...args];
  const { stdout } = await execFileP(cmd, fullArgs, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 50 });
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { result: text };
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const otcChannel = (flags.get('otc-channel') && String(flags.get('otc-channel')).trim()) || 'btc-usdt-sol-otc';
  const swapChannelTemplate =
    (flags.get('swap-channel-template') && String(flags.get('swap-channel-template')).trim()) || 'swap:{trade_id}';
  const quoteValidSec = parseIntFlag(flags.get('quote-valid-sec'), 'quote-valid-sec', 60);
  const inviteTtlSec = parseIntFlag(flags.get('invite-ttl-sec'), 'invite-ttl-sec', 7 * 24 * 3600);
  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 750);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const runSwap = parseBool(flags.get('run-swap'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  const termsValidSec = parseIntFlag(flags.get('terms-valid-sec'), 'terms-valid-sec', 300);
  const solRefundAfterSec = parseIntFlag(flags.get('solana-refund-after-sec'), 'solana-refund-after-sec', 3600);

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solDecimals = parseIntFlag(flags.get('solana-decimals'), 'solana-decimals', 6);
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';

  const lnBackend = (flags.get('ln-backend') && String(flags.get('ln-backend')).trim()) || 'docker';
  const lnComposeFile = (flags.get('ln-compose-file') && String(flags.get('ln-compose-file')).trim()) || defaultComposeFile;
  const lnService = flags.get('ln-service') ? String(flags.get('ln-service')).trim() : '';
  const lnNetwork = (flags.get('ln-network') && String(flags.get('ln-network')).trim()) || 'regtest';
  const lnCliBin = flags.get('ln-cli-bin') ? String(flags.get('ln-cli-bin')).trim() : '';

  if (runSwap) {
    if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1)');
    if (!solMintStr) die('Missing --solana-mint (required when --run-swap 1)');
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();
  ensureOk(await sc.join(otcChannel), `join ${otcChannel}`);
  ensureOk(await sc.subscribe([otcChannel]), `subscribe ${otcChannel}`);

  const makerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!makerPubkey) die('SC-Bridge hello missing peer pubkey');

  const quotes = new Map(); // quote_id -> { rfq_id, trade_id, btc_sats, usdt_amount, sol_recipient, sol_mint }
  const swaps = new Map(); // swap_channel -> ctx

  const sol = runSwap
    ? (() => {
        const payer = readSolanaKeypair(solKeypairPath);
        const connection = new Connection(solRpcUrl, 'confirmed');
        const mint = new PublicKey(solMintStr);
        const programId = solProgramIdStr ? new PublicKey(solProgramIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
        return { payer, connection, mint, programId };
      })()
    : null;

  let done = false;

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      sc.close();
      process.exit(0);
    }, delay);
  };

  const cancelSwap = async (ctx, reason) => {
    try {
      const cancelUnsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.CANCEL,
        tradeId: ctx.tradeId,
        body: { reason: String(reason || 'canceled') },
      });
      const cancelSigned = await signSwapEnvelope(sc, cancelUnsigned);
      await sc.send(ctx.swapChannel, cancelSigned);
    } catch (_e) {}
  };

  const createAndSendTerms = async (ctx) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const termsUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId: ctx.tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: ctx.btcSats,
        usdt_amount: ctx.usdtAmount,
        usdt_decimals: solDecimals,
        sol_mint: sol.mint.toBase58(),
        sol_recipient: ctx.solRecipient,
        sol_refund: sol.payer.publicKey.toBase58(),
        sol_refund_after_unix: nowSec + solRefundAfterSec,
        ln_receiver_peer: makerPubkey,
        ln_payer_peer: ctx.inviteePubKey,
        terms_valid_until_unix: nowSec + termsValidSec,
      },
    });
    const signed = await signSwapEnvelope(sc, termsUnsigned);
    const applied = applySwapEnvelope(ctx.trade, signed);
    if (!applied.ok) throw new Error(applied.error);
    ctx.trade = applied.trade;
    ctx.sent.terms = signed;
    await sc.send(ctx.swapChannel, signed);
    process.stdout.write(`${JSON.stringify({ type: 'terms_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel })}\n`);
  };

  const ensureAta = async ({ connection, payer, mint, owner }) => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch (_e) {
      // Create ATA if missing (payer funds rent).
      return createAssociatedTokenAccount(connection, payer, mint, owner);
    }
  };

  const createInvoiceAndEscrow = async (ctx) => {
    if (ctx.startedSettlement) return;
    ctx.startedSettlement = true;

    const sats = ctx.btcSats;
    const invoice = await lnCli({
      backend: lnBackend,
      composeFile: lnComposeFile,
      service: lnService,
      network: lnNetwork,
      cliBin: lnCliBin,
      args: ['invoice', `${sats}sat`, ctx.tradeId, 'swap'],
    });

    const bolt11 = String(invoice?.bolt11 || '').trim();
    const paymentHashHex = String(invoice?.payment_hash || '').trim().toLowerCase();
    if (!bolt11) throw new Error('LN invoice missing bolt11');
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('LN invoice missing payment_hash');

    ctx.paymentHashHex = paymentHashHex;

    const lnInvUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.LN_INVOICE,
      tradeId: ctx.tradeId,
      body: {
        bolt11,
        payment_hash_hex: paymentHashHex,
        amount_msat: String(BigInt(sats) * 1000n),
      },
    });
    const lnInvSigned = await signSwapEnvelope(sc, lnInvUnsigned);
    {
      const r = applySwapEnvelope(ctx.trade, lnInvSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    ctx.sent.invoice = lnInvSigned;
    await sc.send(ctx.swapChannel, lnInvSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_invoice_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, payment_hash_hex: paymentHashHex })}\n`);

    // Solana escrow (locks net + fee, but terms.usdt_amount is the net amount).
    const refundAfterUnix = Number(ctx.trade.terms.sol_refund_after_unix);
    if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) throw new Error('Invalid sol_refund_after_unix');

    const solRecipient = new PublicKey(ctx.solRecipient);
    const payerToken = await ensureAta({ connection: sol.connection, payer: sol.payer, mint: sol.mint, owner: sol.payer.publicKey });

    const { tx: escrowTx, escrowPda, vault } = await createEscrowTx({
      connection: sol.connection,
      payer: sol.payer,
      payerTokenAccount: payerToken,
      mint: sol.mint,
      paymentHashHex,
      recipient: solRecipient,
      refund: sol.payer.publicKey,
      refundAfterUnix,
      amount: BigInt(String(ctx.usdtAmount)),
      programId: sol.programId,
    });
    const escrowSig = await sendAndConfirm(sol.connection, escrowTx);

    const solEscrowUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.SOL_ESCROW_CREATED,
      tradeId: ctx.tradeId,
      body: {
        payment_hash_hex: paymentHashHex,
        program_id: sol.programId.toBase58(),
        escrow_pda: escrowPda.toBase58(),
        vault_ata: vault.toBase58(),
        mint: sol.mint.toBase58(),
        amount: String(ctx.usdtAmount),
        refund_after_unix: refundAfterUnix,
        recipient: solRecipient.toBase58(),
        refund: sol.payer.publicKey.toBase58(),
        tx_sig: escrowSig,
      },
    });
    const solEscrowSigned = await signSwapEnvelope(sc, solEscrowUnsigned);
    {
      const r = applySwapEnvelope(ctx.trade, solEscrowSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    ctx.sent.escrow = solEscrowSigned;
    await sc.send(ctx.swapChannel, solEscrowSigned);
    process.stdout.write(`${JSON.stringify({ type: 'sol_escrow_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, tx_sig: escrowSig })}\n`);
  };

  const startSwapResender = (ctx) => {
    if (ctx.resender) return;
    ctx.resender = setInterval(async () => {
      try {
        if (ctx.done) return;
        if (Date.now() > ctx.deadlineMs) {
          await cancelSwap(ctx, 'swap timeout');
          die(`Swap timeout (swap-timeout-sec=${swapTimeoutSec})`);
        }
        if (ctx.trade.state === STATE.TERMS && ctx.sent.terms) {
          await sc.send(ctx.swapChannel, ctx.sent.terms);
        }
        if ([STATE.ACCEPTED, STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) && ctx.sent.invoice && !ctx.trade.ln_paid) {
          await sc.send(ctx.swapChannel, ctx.sent.invoice);
        }
        if ([STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) && ctx.sent.escrow && !ctx.trade.ln_paid) {
          await sc.send(ctx.swapChannel, ctx.sent.escrow);
        }
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== otcChannel && !swaps.has(evt?.channel)) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      // Swap channel traffic
      if (swaps.has(evt.channel)) {
        const ctx = swaps.get(evt.channel);
        if (!ctx) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const r = applySwapEnvelope(ctx.trade, msg);
        if (!r.ok) {
          if (debug) process.stderr.write(`[maker] swap apply error: ${r.error}\n`);
          return;
        }
        ctx.trade = r.trade;

        if (msg.kind === KIND.ACCEPT && ctx.trade.state === STATE.ACCEPTED && runSwap) {
          await createInvoiceAndEscrow(ctx);
        }

        if (ctx.trade.state === STATE.CLAIMED && !ctx.done) {
          ctx.done = true;
          done = true;
          if (ctx.resender) clearInterval(ctx.resender);
          process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel })}\n`);
          maybeExit();
        }
        return;
      }

      if (msg.kind === KIND.RFQ) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const rfqUnsigned = stripSignature(msg);
        const rfqId = hashUnsignedEnvelope(rfqUnsigned);

        if (msg.body?.valid_until_unix !== undefined) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (Number(msg.body.valid_until_unix) <= nowSec) {
            if (debug) process.stderr.write(`[maker] skip expired rfq trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
            return;
          }
        }

        const solRecipient = msg.body?.sol_recipient ? String(msg.body.sol_recipient).trim() : '';
        if (runSwap && !solRecipient) {
          if (debug) process.stderr.write(`[maker] skip rfq missing sol_recipient trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
          return;
        }

        // Quote "at requested terms" for now (policy comes later).
        const nowSec = Math.floor(Date.now() / 1000);
        const quoteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.QUOTE,
          tradeId: String(msg.trade_id),
          body: {
            rfq_id: rfqId,
            pair: PAIR.BTC_LN__USDT_SOL,
            direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
            btc_sats: msg.body.btc_sats,
            usdt_amount: msg.body.usdt_amount,
            ...(runSwap ? { sol_mint: sol.mint.toBase58(), sol_recipient: solRecipient } : {}),
            valid_until_unix: nowSec + quoteValidSec,
          },
        });
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const signed = await signSwapEnvelope(sc, quoteUnsigned);
        const sent = ensureOk(await sc.send(otcChannel, signed), 'send quote');
        if (debug) process.stderr.write(`[maker] quoted trade_id=${msg.trade_id} rfq_id=${rfqId} quote_id=${quoteId} sent=${sent.type}\n`);
        quotes.set(quoteId, {
          rfq_id: rfqId,
          trade_id: String(msg.trade_id),
          btc_sats: msg.body.btc_sats,
          usdt_amount: msg.body.usdt_amount,
          sol_recipient: solRecipient,
          sol_mint: runSwap ? sol.mint.toBase58() : (msg.body?.sol_mint ? String(msg.body.sol_mint).trim() : ''),
        });
        return;
      }

      if (msg.kind === KIND.QUOTE_ACCEPT) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteId = String(msg.body.quote_id || '').trim().toLowerCase();
        const rfqId = String(msg.body.rfq_id || '').trim().toLowerCase();
        const known = quotes.get(quoteId);
        if (!known) return;
        if (known.rfq_id !== rfqId) return;

        const tradeId = String(msg.trade_id);
        const swapChannel = swapChannelTemplate.replaceAll('{trade_id}', tradeId);
        const inviteePubKey = String(msg.signer || '').trim().toLowerCase();
        if (!inviteePubKey) return;

        // Build welcome + invite signed by this peer (SC-Bridge signing).
        const welcomePayload = normalizeWelcomePayload({
          channel: swapChannel,
          ownerPubKey: makerPubkey,
          text: `swap ${tradeId}`,
          issuedAt: Date.now(),
          version: 1,
        });
        const { sigHex: welcomeSig } = await signViaBridge(sc, welcomePayload);
        const welcome = { payload: welcomePayload, sig: welcomeSig };

        const issuedAt = Date.now();
        const invitePayload = normalizeInvitePayload({
          channel: swapChannel,
          inviteePubKey,
          inviterPubKey: makerPubkey,
          inviterAddress: null,
          issuedAt,
          expiresAt: issuedAt + inviteTtlSec * 1000,
          nonce: Math.random().toString(36).slice(2, 10),
          version: 1,
        });
        const { sigHex: inviteSig } = await signViaBridge(sc, invitePayload);
        const invite = createSignedInvite(invitePayload, () => inviteSig, { welcome });

        const swapInviteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.SWAP_INVITE,
          tradeId,
          body: {
            rfq_id: rfqId,
            quote_id: quoteId,
            swap_channel: swapChannel,
            owner_pubkey: makerPubkey,
            invite,
            welcome,
          },
        });
        const swapInviteSigned = await signSwapEnvelope(sc, swapInviteUnsigned);
        ensureOk(await sc.send(otcChannel, swapInviteSigned), 'send swap_invite');
        ensureOk(await sc.join(swapChannel, { welcome }), `join ${swapChannel}`);
        ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

        process.stdout.write(`${JSON.stringify({ type: 'swap_invite_sent', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId, swap_channel: swapChannel })}\n`);

        if (!runSwap) {
          done = true;
          maybeExit();
          return;
        }

        const ctx = {
          tradeId,
          rfqId,
          quoteId,
          swapChannel,
          inviteePubKey,
          btcSats: Number(known.btc_sats),
          usdtAmount: String(known.usdt_amount),
          solRecipient: String(known.sol_recipient),
          trade: createInitialTrade(tradeId),
          sent: {},
          startedSettlement: false,
          paymentHashHex: null,
          done: false,
          deadlineMs: Date.now() + swapTimeoutSec * 1000,
          resender: null,
        };
        swaps.set(swapChannel, ctx);

        // Begin swap: send terms and start the resend loop.
        await createAndSendTerms(ctx);
        startSwapResender(ctx);
      }
    } catch (err) {
      if (debug) process.stderr.write(`[maker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'maker', otc_channel: otcChannel, pubkey: makerPubkey })}\n`);
  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));

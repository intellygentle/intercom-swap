import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from '@solana/spl-token';

import {
  claimEscrowTx,
  createEscrowTx,
  getEscrowState,
  initConfigTx,
  initTradeConfigTx,
  refundEscrowTx,
  withdrawFeesTx,
  withdrawTradeFeesTx,
  LN_USDT_ESCROW_PROGRAM_ID,
} from '../src/solana/lnUsdtEscrowClient.js';

import { lnInvoice, lnPay } from '../src/ln/client.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const composeFile = path.join(repoRoot, 'dev/lnd-regtest/docker-compose.yml');

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 50,
    ...opts,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

async function dockerCompose(args) {
  return sh('docker', ['compose', '-f', composeFile, ...args]);
}

function parseJsonStream(text) {
  const s = String(text || '').trim();
  if (!s) return { result: '' };
  try {
    return JSON.parse(s);
  } catch (_e) {
    // Extract multiple top-level JSON objects by brace matching; return the last.
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (i >= s.length) break;
      const start = s[i];
      const open = start === '{' ? '{' : start === '[' ? '[' : null;
      const close = start === '{' ? '}' : start === '[' ? ']' : null;
      if (!open) break;
      let depth = 0;
      let inString = false;
      let esc = false;
      let j = i;
      for (; j < s.length; j += 1) {
        const ch = s[j];
        if (inString) {
          if (esc) {
            esc = false;
            continue;
          }
          if (ch === '\\\\') {
            esc = true;
            continue;
          }
          if (ch === '\"') {
            inString = false;
            continue;
          }
          continue;
        }
        if (ch === '\"') {
          inString = true;
          continue;
        }
        if (ch === open) depth += 1;
        if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
      if (depth !== 0) break;
      const chunk = s.slice(i, j).trim();
      try {
        out.push(JSON.parse(chunk));
      } catch (_e2) {}
      i = j;
    }
    if (out.length > 0) return out[out.length - 1];
    return { result: s };
  }
}

async function dockerComposeJson(args) {
  const { stdout } = await dockerCompose(args);
  return parseJsonStream(stdout);
}

async function retry(fn, { tries = 80, delayMs = 500, label = 'retry' } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr?.message ?? String(lastErr)}`);
}

async function btcCli(args) {
  const { stdout } = await dockerCompose([
    'exec',
    '-T',
    'bitcoind',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=rpcuser',
    '-rpcpassword=rpcpass',
    '-rpcport=18443',
    ...args,
  ]);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { result: text };
  }
}

async function lndCli(service, args) {
  return dockerComposeJson(['exec', '-T', service, 'lncli', '--network=regtest', ...args]);
}

async function startSolanaValidator({ soPath, ledgerSuffix }) {
  const ledgerPath = path.join(repoRoot, `onchain/solana/ledger-e2e-lnd-${ledgerSuffix}`);
  const args = [
    '--reset',
    '--ledger',
    ledgerPath,
    '--bind-address',
    '127.0.0.1',
    '--rpc-port',
    '8899',
    '--faucet-port',
    '9900',
    '--bpf-program',
    LN_USDT_ESCROW_PROGRAM_ID.toBase58(),
    soPath,
    '--quiet',
  ];

  const proc = spawn('solana-test-validator', args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const append = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  proc.stdout.on('data', (d) => append(String(d)));
  proc.stderr.on('data', (d) => append(String(d)));

  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  await retry(() => connection.getVersion(), { label: 'solana rpc ready', tries: 120, delayMs: 500 });

  return {
    proc,
    connection,
    tail: () => out,
    stop: async () => {
      proc.kill('SIGINT');
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

test('e2e: LND(regtest) <-> Solana escrow happy+refund', async (t) => {
  const runId = String(Date.now());

  // Ensure our SBF program is built.
  await sh('cargo', ['build-sbf'], { cwd: path.join(repoRoot, 'solana/ln_usdt_escrow') });
  const soPath = path.join(repoRoot, 'solana/ln_usdt_escrow/target/deploy/ln_usdt_escrow.so');

  // Start LND regtest stack.
  await dockerCompose(['up', '-d']);
  t.after(async () => {
    try {
      await dockerCompose(['down', '-v', '--remove-orphans']);
    } catch (_e) {}
  });

  await retry(() => btcCli(['getblockchaininfo']), { label: 'bitcoind ready', tries: 120, delayMs: 500 });
  await retry(() => lndCli('lnd-alice', ['getinfo']), { label: 'lnd-alice ready', tries: 120, delayMs: 500 });
  await retry(() => lndCli('lnd-bob', ['getinfo']), { label: 'lnd-bob ready', tries: 120, delayMs: 500 });

  // Create miner wallet and mine spendable coins.
  try {
    await btcCli(['createwallet', 'miner']);
  } catch (_e) {}
  const minerAddr = (await btcCli(['-rpcwallet=miner', 'getnewaddress'])).result;
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '101', minerAddr]);

  // Wait for LND to sync to chain tip.
  await retry(async () => {
    const info = await lndCli('lnd-alice', ['getinfo']);
    if (!info?.synced_to_chain) throw new Error('alice not synced yet');
    return info;
  }, { label: 'alice synced', tries: 200, delayMs: 250 });
  await retry(async () => {
    const info = await lndCli('lnd-bob', ['getinfo']);
    if (!info?.synced_to_chain) throw new Error('bob not synced yet');
    return info;
  }, { label: 'bob synced', tries: 200, delayMs: 250 });

  // Fund both LND nodes.
  const aliceBtcAddr = String((await lndCli('lnd-alice', ['newaddress', 'p2wkh']))?.address || '').trim();
  const bobBtcAddr = String((await lndCli('lnd-bob', ['newaddress', 'p2wkh']))?.address || '').trim();
  assert.ok(aliceBtcAddr, 'alice newaddress must return address');
  assert.ok(bobBtcAddr, 'bob newaddress must return address');
  await btcCli(['-rpcwallet=miner', 'sendtoaddress', aliceBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'sendtoaddress', bobBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  const hasConfirmedBalance = (wb) => BigInt(String(wb?.confirmed_balance ?? 0)) > 0n;
  await retry(async () => {
    const wb = await lndCli('lnd-alice', ['walletbalance']);
    if (!hasConfirmedBalance(wb)) throw new Error('alice wallet not funded yet');
    return wb;
  }, { label: 'alice funded', tries: 120, delayMs: 250 });
  await retry(async () => {
    const wb = await lndCli('lnd-bob', ['walletbalance']);
    if (!hasConfirmedBalance(wb)) throw new Error('bob wallet not funded yet');
    return wb;
  }, { label: 'bob funded', tries: 120, delayMs: 250 });

  // Connect and open channel (bob -> alice).
  const aliceInfo = await lndCli('lnd-alice', ['getinfo']);
  const aliceNodeId = String(aliceInfo?.identity_pubkey || '').trim();
  assert.ok(aliceNodeId, 'alice identity_pubkey required');
  // Make this idempotent across repeated local runs (volumes may persist if a previous run was interrupted).
  try {
    await lndCli('lnd-bob', ['connect', `${aliceNodeId}@lnd-alice:9735`]);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err || '');
    if (!/already connected/i.test(msg)) throw err;
  }

  const existing = await lndCli('lnd-bob', ['listchannels']);
  const hasChan = Boolean(existing?.channels?.some?.((c) => c?.remote_pubkey === aliceNodeId));
  if (!hasChan) {
    await lndCli('lnd-bob', ['openchannel', '--node_key', aliceNodeId, '--local_amt', '1000000']);
  }
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);
  await retry(async () => {
    const chans = await lndCli('lnd-bob', ['listchannels']);
    const c = chans?.channels?.find((x) => x?.remote_pubkey === aliceNodeId) || null;
    if (!c) throw new Error('channel not found yet');
    if (!c.active) throw new Error('channel not active yet');
    return chans;
  }, { label: 'channel active', tries: 160, delayMs: 250 });

  // Start Solana local validator with our program loaded.
  const sol = await startSolanaValidator({ soPath, ledgerSuffix: runId });
  t.after(async () => {
    try {
      await sol.stop();
    } catch (_e) {}
  });
  const connection = sol.connection;

  // Solana identities for settlement layer.
  const solService = Keypair.generate(); // escrow payer/refund authority
  const solClient = Keypair.generate(); // escrow recipient
  await connection.confirmTransaction(await connection.requestAirdrop(solService.publicKey, 2_000_000_000), 'confirmed');
  await connection.confirmTransaction(await connection.requestAirdrop(solClient.publicKey, 2_000_000_000), 'confirmed');

  const mint = await createMint(connection, solService, solService.publicKey, null, 6);
  const serviceToken = await createAssociatedTokenAccount(connection, solService, mint, solService.publicKey);
  const clientToken = await createAssociatedTokenAccount(connection, solService, mint, solClient.publicKey);
  await mintTo(connection, solService, mint, serviceToken, solService, 500_000_000n);

  // Program-wide platform fee config (0.5%).
  const solFeeAuthority = Keypair.generate();
  const solTradeFeeAuthority = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(solFeeAuthority.publicKey, 2_000_000_000), 'confirmed');
  await connection.confirmTransaction(await connection.requestAirdrop(solTradeFeeAuthority.publicKey, 2_000_000_000), 'confirmed');
  const feeCollectorToken = await createAssociatedTokenAccount(connection, solService, mint, solFeeAuthority.publicKey);
  const tradeFeeCollectorToken = await createAssociatedTokenAccount(connection, solService, mint, solTradeFeeAuthority.publicKey);

  const { tx: initCfgTx } = await initConfigTx({
    connection,
    payer: solFeeAuthority,
    feeCollector: solFeeAuthority.publicKey,
    feeBps: 50,
  });
  await sendAndConfirm(connection, initCfgTx);

  const { tx: initTradeCfgTx } = await initTradeConfigTx({
    connection,
    payer: solTradeFeeAuthority,
    feeCollector: solTradeFeeAuthority.publicKey,
    feeBps: 50,
  });
  await sendAndConfirm(connection, initTradeCfgTx);

  const lndAlice = {
    impl: 'lnd',
    backend: 'docker',
    composeFile,
    service: 'lnd-alice',
    network: 'regtest',
    cliBin: '',
    cwd: repoRoot,
  };
  const lndBob = {
    impl: 'lnd',
    backend: 'docker',
    composeFile,
    service: 'lnd-bob',
    network: 'regtest',
    cliBin: '',
    cwd: repoRoot,
  };

  // Happy path: invoice -> escrow -> pay -> claim.
  {
    const usdtNet = 100_000_000n;
    const sats = 50_000;
    const inv = await lnInvoice(lndAlice, {
      amountMsat: (BigInt(sats) * 1000n).toString(),
      label: 'swap-happy',
      description: 'swap happy',
    });
    assert.ok(inv.bolt11, 'invoice must include bolt11');
    assert.match(inv.payment_hash, /^[0-9a-f]{64}$/i, 'invoice must include payment_hash');

    const refundAfterUnix = Math.floor(Date.now() / 1000) + 60;
    const { tx: escrowTx } = await createEscrowTx({
      connection,
      payer: solService,
      payerTokenAccount: serviceToken,
      mint,
      paymentHashHex: inv.payment_hash,
      recipient: solClient.publicKey,
      refund: solService.publicKey,
      refundAfterUnix,
      amount: usdtNet,
      expectedPlatformFeeBps: 50,
      expectedTradeFeeBps: 50,
      tradeFeeCollector: solTradeFeeAuthority.publicKey,
    });
    await sendAndConfirm(connection, escrowTx);

    const onchain = await getEscrowState(connection, inv.payment_hash, LN_USDT_ESCROW_PROGRAM_ID, 'confirmed');
    assert.ok(onchain, 'escrow must exist');
    assert.equal(onchain.paymentHashHex, inv.payment_hash);

    const pay = await lnPay(lndBob, { bolt11: inv.bolt11 });
    assert.match(pay.payment_preimage, /^[0-9a-f]{64}$/i, 'pay must yield preimage');

    const beforeClient = (await getAccount(connection, clientToken, 'confirmed')).amount;
    const { tx: claimTx } = await claimEscrowTx({
      connection,
      recipient: solClient,
      recipientTokenAccount: clientToken,
      mint,
      paymentHashHex: inv.payment_hash,
      preimageHex: pay.payment_preimage,
      tradeFeeCollector: solTradeFeeAuthority.publicKey,
    });
    await sendAndConfirm(connection, claimTx);

    const afterClient = (await getAccount(connection, clientToken, 'confirmed')).amount;
    assert.equal(afterClient - beforeClient, usdtNet, 'client should receive net USDT amount');

    // Fees accrue into the program vaults; collectors withdraw on demand.
    const feeBal0 = (await getAccount(connection, feeCollectorToken, 'confirmed')).amount;
    const tradeFeeBal0 = (await getAccount(connection, tradeFeeCollectorToken, 'confirmed')).amount;
    assert.equal(feeBal0, 0n);
    assert.equal(tradeFeeBal0, 0n);

    const { tx: withdrawTx } = await withdrawFeesTx({
      connection,
      feeCollector: solFeeAuthority,
      feeCollectorTokenAccount: feeCollectorToken,
      mint,
      amount: 0n,
    });
    await sendAndConfirm(connection, withdrawTx);
    const feeBal = (await getAccount(connection, feeCollectorToken, 'confirmed')).amount;
    assert.equal(feeBal, (usdtNet * 50n) / 10_000n, 'platform fee should be withdrawable');

    const { tx: withdrawTradeTx } = await withdrawTradeFeesTx({
      connection,
      feeCollector: solTradeFeeAuthority,
      feeCollectorTokenAccount: tradeFeeCollectorToken,
      mint,
      amount: 0n,
    });
    await sendAndConfirm(connection, withdrawTradeTx);
    const tradeFeeBal = (await getAccount(connection, tradeFeeCollectorToken, 'confirmed')).amount;
    assert.equal(tradeFeeBal, (usdtNet * 50n) / 10_000n, 'trade fee should be withdrawable');
  }

  // Refund path: escrow -> no pay -> refund after timeout.
  {
    const usdtNet = 10_000_000n;
    const sats = 1_000;
    const inv = await lnInvoice(lndAlice, {
      amountMsat: (BigInt(sats) * 1000n).toString(),
      label: 'swap-refund',
      description: 'swap refund',
    });

    const beforeService = (await getAccount(connection, serviceToken, 'confirmed')).amount;
    const refundAfterUnix = Math.floor(Date.now() / 1000) + 2;
    const { tx: escrowTx } = await createEscrowTx({
      connection,
      payer: solService,
      payerTokenAccount: serviceToken,
      mint,
      paymentHashHex: inv.payment_hash,
      recipient: solClient.publicKey,
      refund: solService.publicKey,
      refundAfterUnix,
      amount: usdtNet,
      expectedPlatformFeeBps: 50,
      expectedTradeFeeBps: 50,
      tradeFeeCollector: solTradeFeeAuthority.publicKey,
    });
    await sendAndConfirm(connection, escrowTx);

    // Wait for validator clock to advance, then refund (retry until it passes the on-chain timelock).
    await new Promise((r) => setTimeout(r, 3000));
    await retry(async () => {
      const { tx: refundTx } = await refundEscrowTx({
        connection,
        refund: solService,
        refundTokenAccount: serviceToken,
        mint,
        paymentHashHex: inv.payment_hash,
      });
      await sendAndConfirm(connection, refundTx);
      return true;
    }, { label: 'refund', tries: 40, delayMs: 250 });

    const afterService = (await getAccount(connection, serviceToken, 'confirmed')).amount;
    assert.equal(afterService, beforeService, 'service should be fully refunded');
  }
});

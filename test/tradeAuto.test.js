import test from 'node:test';
import assert from 'node:assert/strict';

import { TradeAutoManager } from '../src/prompt/tradeAuto.js';

const MAKER = 'a'.repeat(64);
const TAKER = 'b'.repeat(64);
const SOL_RECIPIENT = '4gRG1QE1YofRgCtTuwEDftYx9aEr9N1z5bFTJTbPNqmg';

function env(kind, tradeId, signer, body = {}) {
  return {
    v: 1,
    kind,
    trade_id: tradeId,
    ts: Date.now(),
    nonce: `${kind}-${tradeId}`.slice(0, 20),
    body,
    signer,
    sig: 'c'.repeat(128),
  };
}

test('tradeauto: settlement can start from synthetic swap context (no prior swap:* terms event)', async () => {
  const tradeId = 'swap_test_1';
  const sent = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 4, events: [] };
      readOnce = true;
      return { latest_seq: 4, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_terms_post') {
        sent.push({ tool, args });
        return { type: 'terms_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.trade_id, tradeId);
    assert.equal(sent[0].args.channel, `swap:${tradeId}`);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: offer-sourced quote path remains active (service announce -> quote from RFQ)', async () => {
  const tradeId = 'swap_test_offer_1';
  const now = Date.now();
  const posted = [];
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.svc_announce',
      local: true,
      dir: 'out',
      origin: 'local',
      message: env('swap.svc_announce', 'svc:maker:test', MAKER, {
        name: 'maker:test',
        pairs: ['BTC_LN/USDT_SOL'],
        rfq_channels: ['0000intercomswapbtcusdt'],
        offers: [
          {
            pair: 'BTC_LN/USDT_SOL',
            have: 'USDT_SOL',
            want: 'BTC_LN',
            btc_sats: 10000,
            usdt_amount: '1000000',
            max_platform_fee_bps: 50,
            max_trade_fee_bps: 50,
            max_total_fee_bps: 100,
            min_sol_refund_window_sec: 259200,
            max_sol_refund_window_sec: 604800,
          },
        ],
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        pair: 'BTC_LN/USDT_SOL',
        direction: 'BTC_LN->USDT_SOL',
        btc_sats: 10000,
        usdt_amount: '1000000',
        max_platform_fee_bps: 50,
        max_trade_fee_bps: 50,
        max_total_fee_bps: 100,
        min_sol_refund_window_sec: 259200,
        max_sol_refund_window_sec: 604800,
        valid_until_unix: Math.floor((now + 120_000) / 1000),
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 2 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 2, events: [] };
      readOnce = true;
      return { latest_seq: 2, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_quote_post_from_rfq') {
        posted.push({ tool, args });
        return { type: 'quote_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: true,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(posted.length, 1);
    assert.equal(String(posted[0]?.args?.channel || ''), '0000intercomswapbtcusdt');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: backend auto-leaves stale swap channels (expired invite)', async () => {
  const tradeId = 'swap_test_2';
  const left = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now - 10_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 1 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 1, events: [] };
      readOnce = true;
      return { latest_seq: 1, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [`swap:${tradeId}`] };
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
      hygiene_interval_ms: 1_000,
    });
    assert.deepEqual(left, [`swap:${tradeId}`]);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: taker waiting_terms replays quote_accept and then accepts terms', async () => {
  const tradeId = 'swap_test_3';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const rfq = {
    seq: 1,
    ts: now,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.rfq',
    message: env('swap.rfq', tradeId, TAKER, {
      btc_sats: 10000,
      usdt_amount: '1000000',
      sol_recipient: SOL_RECIPIENT,
    }),
  };
  const quote = {
    seq: 2,
    ts: now + 1,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.quote',
    message: env('swap.quote', tradeId, MAKER, {
      rfq_id: 'd'.repeat(64),
      btc_sats: 10000,
      usdt_amount: '1000000',
      trade_fee_collector: SOL_RECIPIENT,
      sol_refund_window_sec: 72 * 3600,
      valid_until_unix: Math.floor((now + 60_000) / 1000),
    }),
  };
  const quoteAccept = {
    seq: 3,
    ts: now + 2,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.quote_accept',
    message: env('swap.quote_accept', tradeId, TAKER, {
      rfq_id: 'd'.repeat(64),
      quote_id: 'e'.repeat(64),
    }),
  };
  const swapInvite = {
    seq: 4,
    ts: now + 3,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.swap_invite',
    message: env('swap.swap_invite', tradeId, MAKER, {
      swap_channel: swapChannel,
      invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
    }),
  };
  const terms = {
    seq: 5,
    ts: now + 100,
    channel: swapChannel,
    kind: 'swap.terms',
    message: env('swap.terms', tradeId, MAKER, {
      btc_sats: 10000,
      usdt_amount: '1000000',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_recipient: SOL_RECIPIENT,
      sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
      sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
      ln_receiver_peer: MAKER,
      ln_payer_peer: TAKER,
      trade_fee_collector: SOL_RECIPIENT,
      app_hash: '727bd54d63839285a7ead6baf7e9fedd130cacb820cd6392ffcba46aff8db87b',
    }),
  };

  let readCount = 0;
  const replayCalls = [];
  const accepted = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 5 }),
    scLogRead: () => {
      readCount += 1;
      if (readCount === 1) return { latest_seq: 4, events: [rfq, quote, quoteAccept, swapInvite] };
      if (readCount === 2) return { latest_seq: 5, events: [terms] };
      return { latest_seq: 5, events: [] };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_sc_send_json') {
        replayCalls.push({ tool, args });
        return { type: 'sent' };
      }
      if (tool === 'intercomswap_terms_accept_from_terms') {
        accepted.push({ tool, args });
        return { type: 'terms_accept_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_ping_cooldown_ms: 1_000,
      waiting_terms_max_wait_ms: 60_000,
    });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && accepted.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(
      replayCalls.some((c) => String(c?.args?.json?.kind || '') === 'swap.quote_accept'),
      'expected quote_accept replay while waiting terms'
    );
    assert.equal(accepted.length, 1);
    assert.equal(String(accepted[0]?.args?.channel || ''), swapChannel);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: waiting_terms timeout auto-leaves swap channel (bounded wait)', async () => {
  const tradeId = 'swap_test_4';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: swapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  const left = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => ({ latest_seq: 4, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      if (tool === 'intercomswap_sc_send_json') return { type: 'sent' };
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_max_pings: 0,
      waiting_terms_max_wait_ms: 5_000,
      waiting_terms_leave_on_timeout: true,
      swap_auto_leave_cooldown_ms: 1_000,
    });

    const deadline = Date.now() + 9_000;
    while (Date.now() < deadline && left.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(left.includes(swapChannel), 'expected timeout leave on stale waiting_terms trade');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: waiting_terms replays latest quote_accept for reposted trade ids', async () => {
  const tradeId = 'swap_test_5';
  const oldSwapChannel = `swap:${tradeId}:old`;
  const newSwapChannel = `swap:${tradeId}:new`;
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '1'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '1'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: oldSwapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
    {
      seq: 5,
      ts: now + 10,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '2'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
      }),
    },
    {
      seq: 6,
      ts: now + 11,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '2'.repeat(64),
      }),
    },
    {
      seq: 7,
      ts: now + 12,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: newSwapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  const replayCalls = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 7 }),
    scLogRead: () => ({ latest_seq: 7, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [newSwapChannel] };
      if (tool === 'intercomswap_join_from_swap_invite') return { type: 'joined', swap_channel: newSwapChannel };
      if (tool === 'intercomswap_sc_send_json') {
        replayCalls.push({ tool, args });
        return { type: 'sent' };
      }
      if (tool === 'intercomswap_swap_status_post') return { type: 'status_posted' };
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_ping_cooldown_ms: 1_000,
      waiting_terms_max_pings: 1,
      waiting_terms_max_wait_ms: 60_000,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && replayCalls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(replayCalls.length >= 1, 'expected waiting_terms replay calls');
    const quoteAcceptReplays = replayCalls
      .filter((c) => c?.args?.json?.kind === 'swap.quote_accept')
      .map((c) => String(c?.args?.json?.body?.quote_id || ''));
    assert.ok(quoteAcceptReplays.length >= 1, 'expected quote_accept replay payload');
    assert.ok(quoteAcceptReplays.every((id) => id === '2'.repeat(64)), 'expected latest quote_accept to be replayed');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

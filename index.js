const WebSocket = require('ws');
const fetch = require('node-fetch');

const HELIUS_API_KEY   = process.env.HELIUS_API_KEY;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const HELIUS_WS   = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_HTTP = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const PROGRAMS = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':  'Orca Whirlpool',
  'LBUZKhRxPF3XUpBCjp4YzTKgLLjLibGSNKfiqdeqe59':  'Meteora DLMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':  'Pump.fun',
};

const INIT_KEYWORDS = [
  'InitializePool','initialize2','initializePool',
  'createPool','openPosition','LiquidityPoolCreated'
];

const MIN_LIQUIDITY_USD  = 5000;
const ALERT_COOLDOWN_MS  = 10000;

const seenPools   = new Set();
const pendingSigs = new Set();
let wsReconnectDelay = 2000;
let poolsDetected    = 0;

function fmtUSD(v) {
  v = parseFloat(v) || 0;
  if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function fmtPrice(v) {
  v = parseFloat(v) || 0;
  if (!v) return '—';
  if (v < 0.000001) return v.toExponential(2);
  if (v < 0.0001)   return v.toFixed(8);
  if (v < 1)        return v.toFixed(6);
  return v.toFixed(4);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) log(`Telegram error: ${JSON.stringify(data)}`);
  } catch(e) {
    log(`Telegram send failed: ${e.message}`);
  }
}

function buildAlert(pool, dexName, detectedAt) {
  const sym      = pool.baseToken?.symbol || 'Unknown';
  const quote    = pool.quoteToken?.symbol || 'SOL';
  const liq      = parseFloat(pool.liquidity?.usd || 0);
  const price    = parseFloat(pool.priceUsd || 0);
  const vol      = parseFloat(pool.volume?.h24 || 0);
  const change   = parseFloat(pool.priceChange?.h24 || 0);
  const addr     = pool.baseToken?.address || '';
  const pairAddr = pool.pairAddress || '';
  const ageSec   = Math.round((Date.now() - detectedAt) / 1000);
  const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;

  return `⚡ <b>NEW POOL DETECTED</b>

🪙 <b>${sym} / ${quote}</b>
🏦 DEX: <b>${dexName}</b>
💧 Liquidity: <b>${fmtUSD(liq)}</b>
💵 Price: <b>$${fmtPrice(price)}</b>
📈 24h Change: <b>${changeStr}</b>
📊 Volume 24h: <b>${fmtUSD(vol)}</b>
⏱ Detected: <b>${ageSec}s ago</b>

📋 <code>${addr}</code>

🔗 <a href="https://dexscreener.com/solana/${pairAddr}">DexScreener</a> · <a href="https://solscan.io/token/${addr}">Solscan</a>`;
}

async function enrichAndAlert(addrs, dexName, detectedAt) {
  for (const addr of addrs) {
    try {
      const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = (data.pairs || []).filter(p => p.chainId === 'solana');

      for (const pool of pairs) {
        const key = pool.pairAddress;
        if (!key || seenPools.has(key)) continue;
        const liq = parseFloat(pool.liquidity?.usd || 0);
        if (liq < MIN_LIQUIDITY_USD) continue;

        seenPools.add(key);
        setTimeout(() => seenPools.delete(key), ALERT_COOLDOWN_MS);

        poolsDetected++;
        log(`🎯 Pool #${poolsDetected}: ${pool.baseToken?.symbol}/${pool.quoteToken?.symbol} on ${dexName} — Liq: ${fmtUSD(liq)}`);
        await sendTelegram(buildAlert(pool, dexName, detectedAt));
        return true;
      }
    } catch(e) { continue; }
  }
  return false;
}

function startWS() {
  log('Connecting to Helius WebSocket…');
  const ws = new WebSocket(HELIUS_WS);

  ws.on('open', () => {
    wsReconnectDelay = 2000;
    log('✅ Helius WebSocket connected');
    Object.keys(PROGRAMS).forEach((prog, i) => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: i + 1,
        method: 'logsSubscribe',
        params: [{ mentions: [prog] }, { commitment: 'confirmed' }]
      }));
    });
    sendTelegram(`🟢 <b>SolScan Bot is live</b>\n\nListening to Raydium, Orca, Meteora and Pump.fun\nMin liquidity alert: <b>${fmtUSD(MIN_LIQUIDITY_USD)}</b>`);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.params?.result) return;

    const val  = msg.params.result.value;
    const logs = val?.logs || [];
    const sig  = val?.signature;

    const isInit = logs.some(l => INIT_KEYWORDS.some(kw => l.includes(kw)));
    if (!isInit || !sig || pendingSigs.has(sig)) return;
    pendingSigs.add(sig);

    const detectedAt = Date.now();
    const mentionedAccts = val?.accountKeys || [];
    const progId  = mentionedAccts.find(k => PROGRAMS[k]);
    const dexName = PROGRAMS[progId] || 'Unknown DEX';

    log(`📡 Pool init detected: ${sig.slice(0,16)}… on ${dexName}`);

    try {
      const txRes = await fetch(HELIUS_HTTP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      const txData = await txRes.json();
      const tx = txData.result;
      if (!tx) { pendingSigs.delete(sig); return; }

      const postBals    = tx.meta?.postTokenBalances || [];
      const newMints    = [...new Set(postBals.map(b => b.mint).filter(Boolean))];
      const allAccts    = (tx.transaction?.message?.accountKeys || []).map(k => k.pubkey || k);
      const searchAddrs = [...newMints, ...allAccts].slice(0, 15);

      let enriched = await enrichAndAlert(searchAddrs, dexName, detectedAt);

      if (!enriched) {
        log(`⏳ Not indexed yet, retrying for ${sig.slice(0,16)}…`);
        for (const delay of [5000, 15000, 30000]) {
          await new Promise(r => setTimeout(r, delay));
          enriched = await enrichAndAlert(searchAddrs, dexName, detectedAt);
          if (enriched) break;
        }
        if (!enriched) log(`❌ Could not enrich ${sig.slice(0,16)}… after retries`);
      }
    } catch(e) {
      log(`Error processing tx: ${e.message}`);
    } finally {
      pendingSigs.delete(sig);
    }
  });

  ws.on('error', (e) => log(`WS error: ${e.message}`));

  ws.on('close', () => {
    log(`WS closed. Reconnecting in ${wsReconnectDelay/1000}s…`);
    sendTelegram(`🔴 <b>SolScan Bot disconnected</b>\nReconnecting in ${wsReconnectDelay/1000}s…`);
    setTimeout(startWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  });
}

setInterval(() => {
  log(`💓 Heartbeat — pools detected: ${poolsDetected}`);
}, 10 * 60 * 1000);

log('🚀 SolScan Bot starting…');
startWS();

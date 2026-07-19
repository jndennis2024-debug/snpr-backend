const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (options.body) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode < 400,
            status: res.statusCode,
            json: () => JSON.parse(data),
            buffer: () => Buffer.from(data)
          });
        } catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'SNPR backend running' }));

app.get('/solprice', async (req, res) => {
  try {
    const r = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    const d = r.json();
    res.json({ success: true, price: parseFloat(d.price) });
  } catch(e) {
    res.json({ success: false, price: 76 });
  }
});

app.get('/tokens', async (req, res) => {
  let tokens = [];

  // SOURCE 1: Pump.fun latest coins (always has fresh tokens)
  try {
    const r = await fetchJSON('https://client-api-2-74b1891ee9f9.herokuapp.com/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false');
    const d = r.json();
    const coins = Array.isArray(d) ? d : (d.coins || []);
    const now = Date.now();
    // Filter out old coins and only keep recent ones
    const freshCoins = coins.filter(c => {
      const age = Math.floor((Date.now() - (c.created_timestamp || Date.now())) / 60000);
      return age < 1440 && c.mint !== 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
    }).slice(0, 20);
    tokens = freshCoins.map(c => {
      const age = Math.floor((now - (c.created_timestamp || now)) / 60000);
      let score = 0;
      if (c.usd_market_cap > 5000) score += 25;
      if (c.usd_market_cap > 20000) score += 20;
      if (c.usd_market_cap < 500000) score += 20; // small cap = more upside
      if (c.reply_count > 5) score += 15;
      if (age < 30) score += 20;
      return {
        name: c.name || 'Unknown',
        ticker: c.symbol || '???',
        address: c.mint || '',
        pairAddress: c.mint || '',
        price: c.usd_market_cap ? (c.usd_market_cap / 1000000000) : 0,
        liq: c.virtual_sol_reserves ? (c.virtual_sol_reserves / 1e9) * 76 : 0,
        buys: c.reply_count || 0,
        sells: 0,
        ch5: 0,
        age,
        score: Math.min(100, score),
        sim: false,
        dexUrl: 'https://pump.fun/' + (c.mint || '')
      };
    });
    if (tokens.length > 0) {
      return res.json({ success: true, tokens, source: 'pump.fun' });
    }
  } catch(e) {}

  // SOURCE 2: DexScreener fallback - search for new tokens not the PUMP token
  try {
    const r = await fetchJSON('https://api.dexscreener.com/token-boosts/latest/v1');
    const d = r.json();
    const now = Date.now();
    // Get token addresses from boosts, then fetch their pair data
    const boosted = Array.isArray(d) ? d.filter(x => x.chainId === 'solana').slice(0, 10) : [];
    if (!boosted.length) throw new Error('No boosted tokens');
    const addrs = boosted.map(x => x.tokenAddress).join(',');
    const r2 = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`);
    const d2 = r2.json();
    const now2 = Date.now();
    const pairs = (d2.pairs || [])
      .filter(p => p && p.chainId === 'solana' && parseFloat(p.liquidity?.usd || 0) > 500
        && p.baseToken?.address !== 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn') // exclude PUMP token
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
      .slice(0, 20);
    tokens = pairs.map(p => {
      const liq = parseFloat(p.liquidity?.usd || 0);
      const buys = p.txns?.h1?.buys || 0;
      const sells = p.txns?.h1?.sells || 0;
      const ch5 = parseFloat(p.priceChange?.m5 || 0);
      const age = Math.floor((now - (p.pairCreatedAt || now)) / 60000);
      let score = 0;
      if (liq > 3000) score += 20;
      if (liq > 10000) score += 15;
      if (buys > sells) score += 20;
      if (buys > 20) score += 15;
      if (ch5 > 0) score += 15;
      return {
        name: p.baseToken?.name || 'Unknown',
        ticker: p.baseToken?.symbol || '???',
        address: p.baseToken?.address || '',
        pairAddress: p.pairAddress || '',
        price: parseFloat(p.priceUsd || 0),
        liq, buys, sells, ch5, age,
        score: Math.min(100, score), sim: false
      };
    });
    if (tokens.length > 0) {
      return res.json({ success: true, tokens, source: 'dexscreener' });
    }
  } catch(e) {}

  res.json({ success: false, tokens: [], error: 'All sources failed' });
});

app.post('/swap/pump', async (req, res) => {
  try {
    const { publicKey, mint, amount } = req.body;
    const body = JSON.stringify({
      publicKey, action: 'buy', mint,
      denominatedInSol: 'true', amount,
      slippage: 25, priorityFee: 0.0005, pool: 'pump'
    });
    const r = await fetchJSON('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!r.ok) throw new Error('PumpPortal HTTP ' + r.status);
    const b64 = r.buffer().toString('base64');
    res.json({ success: true, transaction: b64 });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/swap/jupiter', async (req, res) => {
  try {
    const { publicKey, inputMint, outputMint, amount } = req.body;
    const qr = await fetchJSON(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=2000`);
    const q = qr.json();
    if (!q.outAmount) throw new Error(q.error || 'No route');
    const body = JSON.stringify({
      quoteResponse: q, userPublicKey: publicKey,
      wrapAndUnwrapSol: true, prioritizationFeeLamports: 100000
    });
    const sr = await fetchJSON('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const sd = sr.json();
    if (!sd.swapTransaction) throw new Error(sd.error || 'No tx');
    res.json({ success: true, transaction: sd.swapTransaction });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend running on port', PORT));

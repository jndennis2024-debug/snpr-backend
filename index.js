const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const reqOptions = { ...options };
    if (options.body) {
      reqOptions.headers = { ...reqOptions.headers, 'Content-Length': Buffer.byteLength(options.body) };
    }
    const req = lib.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data), buffer: () => Buffer.from(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'SNPR backend running' }));

app.get('/tokens', async (req, res) => {
  try {
    let allPairs = [];
    for (const q of ['pump', 'solana']) {
      try {
        const r = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
        const d = r.json();
        if (d.pairs) allPairs = allPairs.concat(d.pairs);
      } catch(e) {}
    }
    const now = Date.now();
    const seen = {};
    const tokens = allPairs
      .filter(p => {
        if (!p || p.chainId !== 'solana') return false;
        if (!p.pairCreatedAt || seen[p.pairAddress]) return false;
        seen[p.pairAddress] = true;
        const age = (now - p.pairCreatedAt) / 60000;
        return age < 1440 && parseFloat(p.liquidity?.usd || 0) > 500;
      })
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
      .slice(0, 20)
      .map(p => {
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
          liq, buys, sells, ch5,
          age, score: Math.min(100, score), sim: false
        };
      });
    res.json({ success: true, tokens });
  } catch (e) {
    res.json({ success: false, error: e.message, tokens: [] });
  }
});

app.post('/swap/pump', async (req, res) => {
  try {
    const { publicKey, mint, amount } = req.body;
    const body = JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount, slippage: 25, priorityFee: 0.0005, pool: 'pump' });
    const r = await fetchJSON('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!r.ok) throw new Error('PumpPortal HTTP ' + r.status);
    const b64 = r.buffer().toString('base64');
    res.json({ success: true, transaction: b64 });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/swap/jupiter', async (req, res) => {
  try {
    const { publicKey, inputMint, outputMint, amount } = req.body;
    const qr = await fetchJSON(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=2000`);
    const q = qr.json();
    if (!q.outAmount) throw new Error(q.error || 'No route');
    const body = JSON.stringify({ quoteResponse: q, userPublicKey: publicKey, wrapAndUnwrapSol: true, prioritizationFeeLamports: 100000 });
    const sr = await fetchJSON('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const sd = sr.json();
    if (!sd.swapTransaction) throw new Error(sd.error || 'No tx');
    res.json({ success: true, transaction: sd.swapTransaction });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend running on port', PORT));

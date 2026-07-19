const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'SNPR backend running' }));

app.get('/tokens', async (req, res) => {
  try {
    let allPairs = [];
    const searches = ['pump', 'solana meme'];
    for (const q of searches) {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
      const d = await r.json();
      if (d.pairs) allPairs = allPairs.concat(d.pairs);
    }
    const now = Date.now();
    const seen = {};
    const tokens = allPairs
      .filter(p => {
        if (!p || p.chainId !== 'solana') return false;
        if (!p.pairCreatedAt) return false;
        if (seen[p.pairAddress]) return false;
        seen[p.pairAddress] = true;
        const age = (now - p.pairCreatedAt) / 60000;
        return age < 120 && parseFloat(p.liquidity?.usd || 0) > 500;
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
          age, score: Math.min(100, score),
          sim: false
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
    const r = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount, slippage: 25, priorityFee: 0.0005, pool: 'pump' })
    });
    if (!r.ok) throw new Error('PumpPortal HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    res.json({ success: true, transaction: b64 });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/swap/jupiter', async (req, res) => {
  try {
    const { publicKey, inputMint, outputMint, amount } = req.body;
    const qr = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=2000`);
    const q = await qr.json();
    if (!q.outAmount) throw new Error(q.error || 'No route');
    const sr = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: publicKey, wrapAndUnwrapSol: true, prioritizationFeeLamports: 100000 })
    });
    const sd = await sr.json();
    if (!sd.swapTransaction) throw new Error(sd.error || 'No tx');
    res.json({ success: true, transaction: sd.swapTransaction });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend on port', PORT));

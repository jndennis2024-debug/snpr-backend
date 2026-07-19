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
    if (options.body) reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data), buffer: () => Buffer.from(data) }); }
        catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function pumpBuy(publicKey, mint, amount) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount, slippage: 25, priorityFee: 0.005, pool: 'pump' });
    const bodyBuf = Buffer.from(body);
    const opts = { hostname: 'pumpportal.fun', path: '/api/trade-local', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(bodyBuf); req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'SNPR backend running v2' }));

app.get('/solprice', async (req, res) => {
  try {
    const r = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    res.json({ success: true, price: parseFloat(r.json().price) });
  } catch(e) { res.json({ success: false, price: 76 }); }
});

app.get('/tokens', async (req, res) => {
  // Try pump.fun endpoints for bonding curve tokens
  const endpoints = [
    'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://client-api-2-74b1891ee9f9.herokuapp.com/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false'
  ];

  for (const url of endpoints) {
    try {
      const r = await fetchJSON(url);
      const d = r.json();
      const coins = Array.isArray(d) ? d : (d.coins || []);
      if (!coins.length) continue;
      const now = Date.now();
      const tokens = coins
        .filter(c => {
          const age = Math.floor((now - (c.created_timestamp || now)) / 60000);
          return age < 120 && !c.complete && (c.usd_market_cap || 0) > 500;
        })
        .slice(0, 20)
        .map(c => {
          const age = Math.floor((now - (c.created_timestamp || now)) / 60000);
          const liq = c.virtual_sol_reserves ? (c.virtual_sol_reserves / 1e9) * 76 : 0;
          let score = 0;
          if ((c.usd_market_cap||0) > 5000) score += 20;
          if ((c.usd_market_cap||0) > 20000) score += 25;
          if ((c.reply_count||0) > 5) score += 15;
          if ((c.reply_count||0) > 20) score += 15;
          if (age < 10) score += 25;
          else if (age < 30) score += 10;
          return {
            name: c.name || 'Unknown', ticker: c.symbol || '???',
            address: c.mint || '', pairAddress: c.mint || '',
            price: (c.usd_market_cap||0) / 1e9,
            liq, buys: c.reply_count || 0, sells: 0, ch5: 0,
            age, score: Math.min(100, score), sim: false,
            dexUrl: 'https://pump.fun/' + (c.mint||'')
          };
        });
      if (tokens.length > 0) return res.json({ success: true, tokens, source: url.includes('frontend') ? 'pump-frontend' : 'pump-heroku' });
    } catch(e) { continue; }
  }

  // DexScreener fallback
  try {
    const r = await fetchJSON('https://api.dexscreener.com/token-boosts/latest/v1');
    const d = r.json();
    const boosted = (Array.isArray(d) ? d : []).filter(x => x.chainId === 'solana').slice(0, 10);
    if (!boosted.length) throw new Error('no boosts');
    const addrs = boosted.map(x => x.tokenAddress).join(',');
    const r2 = await fetchJSON('https://api.dexscreener.com/latest/dex/tokens/' + addrs);
    const d2 = r2.json();
    const now = Date.now();
    const tokens = (d2.pairs||[])
      .filter(p => p && p.chainId === 'solana' && parseFloat(p.liquidity?.usd||0) > 500 && p.baseToken?.address !== 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn')
      .sort((a,b) => (b.pairCreatedAt||0)-(a.pairCreatedAt||0)).slice(0, 20)
      .map(p => {
        const liq = parseFloat(p.liquidity?.usd||0), buys = p.txns?.h1?.buys||0, sells = p.txns?.h1?.sells||0;
        const ch5 = parseFloat(p.priceChange?.m5||0), age = Math.floor((now-(p.pairCreatedAt||now))/60000);
        let score = 0;
        if(liq>3000)score+=20; if(liq>10000)score+=15;
        if(buys>sells)score+=20; if(buys>20)score+=15; if(ch5>0)score+=15;
        return { name: p.baseToken?.name||'Unknown', ticker: p.baseToken?.symbol||'???',
          address: p.baseToken?.address||'', pairAddress: p.pairAddress||'',
          price: parseFloat(p.priceUsd||0), liq, buys, sells, ch5, age, score: Math.min(100,score), sim: false };
      });
    return res.json({ success: true, tokens, source: 'dexscreener' });
  } catch(e) {}

  res.json({ success: false, tokens: [], error: 'All sources failed' });
});

app.post('/swap/auto', async (req, res) => {
  try {
    const { publicKey, mint, amount } = req.body;
    const rawBytes = await pumpBuy(publicKey, mint, amount);
    if (rawBytes && rawBytes.length > 100) {
      return res.json({ success: true, transaction: rawBytes.toString('base64'), source: 'pump' });
    }
    throw new Error('Empty pump response');
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend v2 running on port', PORT));

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const BIRDEYE_KEY = '1eac17369423494f870737d134b2771e';

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

app.get('/', (req, res) => res.json({ status: 'SNPR backend v3 - Birdeye powered' }));

app.get('/debug-birdeye', async (req, res) => {
  try {
    const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=5&min_liquidity=500', {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    res.json({ status: r.status, ok: r.ok, data: r.json() });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/solprice', async (req, res) => {
  try {
    const r = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    res.json({ success: true, price: parseFloat(r.json().price) });
  } catch(e) { res.json({ success: false, price: 76 }); }
});

app.get('/tokens', async (req, res) => {
  // SOURCE 1: Birdeye new listings on Solana
  try {
    const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&min_liquidity=1000', {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    const d = r.json();
    const items = (d.data?.items || []).filter(i => i.liquidity > 1000);
    if (items.length > 0) {
      const now = Date.now();
      const tokens = items.slice(0, 15).map(item => {
        const addedAt = item.liquidityAddedAt ? new Date(item.liquidityAddedAt).getTime() : now;
        const age = Math.floor((now - addedAt) / 60000);
        const liq = item.liquidity || 0;
        let score = 0;
        if (liq > 2000) score += 20;
        if (liq > 10000) score += 20;
        if (liq > 30000) score += 15;
        if (age < 5) score += 25;
        else if (age < 15) score += 15;
        else if (age < 30) score += 5;
        // pump_amm = still on bonding curve = can buy via pump
        if (item.source === 'pump_amm') score += 20;
        return {
          name: item.name || 'Unknown',
          ticker: item.symbol || '???',
          address: item.address,
          pairAddress: item.address,
          price: 0, liq,
          buys: 0, sells: 0, ch5: 0,
          age, score: Math.min(100, score),
          sim: false,
          source: item.source,
          dexUrl: item.source === 'pump_amm' ? 'https://pump.fun/' + item.address : 'https://jup.ag/swap/SOL-' + item.address
        };
      });
      return res.json({ success: true, tokens, source: 'birdeye' });
    }
  } catch(e) {}

  // SOURCE 2: Birdeye trending tokens as fallback
  try {
    const r = await fetchJSON('https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20', {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    const d = r.json();
    const items = d.data?.tokens || d.data?.items || [];
    if (items.length > 0) {
      const now = Date.now();
      const tokens = items.slice(0, 15).map(t => {
        const age = t.createdAt ? Math.floor((now - t.createdAt * 1000) / 60000) : 999;
        const liq = t.liquidity || 0;
        const ch5 = t.priceChange5m || t.price5mChangePercent || 0;
        let score = 0;
        if (liq > 2000) score += 20; if (liq > 10000) score += 15;
        if (ch5 > 0) score += 20; if (ch5 > 10) score += 15;
        if (age < 30) score += 20; if (age < 10) score += 10;
        return {
          name: t.name || 'Unknown', ticker: t.symbol || '???',
          address: t.address, pairAddress: t.address,
          price: t.price || 0, liq, buys: t.trade5m || 0, sells: 0,
          ch5, age, score: Math.min(100, score), sim: false,
          dexUrl: 'https://pump.fun/' + t.address
        };
      }).filter(t => t.liq > 500);
      if (tokens.length > 0) return res.json({ success: true, tokens, source: 'birdeye-trending' });
    }
  } catch(e) {}

  // SOURCE 3: DexScreener last resort
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
    const preview = rawBytes ? rawBytes.slice(0,4).toString('hex') : 'null';
    console.log('PumpPortal response: bytes='+rawBytes?.length+' preview='+preview);
    if (rawBytes && rawBytes.length > 100 && rawBytes[0] === 1) {
      return res.json({ success: true, transaction: rawBytes.toString('base64'), source: 'pump' });
    }
    // If response looks like text/JSON error, log it
    const text = rawBytes ? rawBytes.toString('utf8').slice(0,200) : 'empty';
    console.log('PumpPortal text response:', text);
    throw new Error('PumpPortal: ' + text.slice(0,100));
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend v3 running on port', PORT));

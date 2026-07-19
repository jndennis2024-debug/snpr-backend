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

function pumpBuy(publicKey, mint, amount, pool) {
  pool = pool || 'pump';
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount, slippage: 25, priorityFee: 0.005, pool: pool });
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
    const { publicKey, mint, amount, tokenSource } = req.body;
    
    // pump_amm = graduated to Raydium, use 'raydium' pool
    // pump bonding curve = use 'pump' pool
    const pools = tokenSource === 'pump_amm' ? ['raydium', 'pump'] : ['pump', 'raydium'];
    
    for (const pool of pools) {
      try {
        const rawBytes = await pumpBuy(publicKey, mint, amount, pool);
        const text = rawBytes ? rawBytes.toString('utf8').slice(0,100) : 'empty';
        console.log('Pool '+pool+': bytes='+rawBytes?.length+' text='+text.slice(0,50));
        if (rawBytes && rawBytes.length > 100 && rawBytes[0] === 1) {
          return res.json({ success: true, transaction: rawBytes.toString('base64'), source: 'pump-'+pool });
        }
      } catch(pe) { console.log('Pool '+pool+' error: '+pe.message); }
    }
    throw new Error('All pools failed for ' + mint);
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR backend v3 running on port', PORT));

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────
const TG_TOKEN = '8601216988:AAEMde9_gBTndYMe2_wBNjC5nk1Rm0Yg3FE';
const TG_CHAT  = '8883767485';
const BIRDEYE_KEY2 = '1eac17369423494f870737d134b2771e';

function tgSend(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const buf = Buffer.from(body);
  return new Promise((res, rej) => {
    const opts = {
      hostname: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length }
    };
    const req = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); });
    req.on('error', rej);
    req.write(buf); req.end();
  });
}

// Track positions and sent alerts
var tgPositions = {};
var tgAlerted = {};

async function runTgBot() {
  try {
    // Fetch fresh tokens
    const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&min_liquidity=1000', {
      headers: { 'X-API-KEY': BIRDEYE_KEY2, 'x-chain': 'solana' }
    });
    const d = r.json();
    const items = (d.data?.items || []).filter(i => i.liquidity > 1000);
    const now = Date.now();

    for (const item of items) {
      const age = Math.floor((now - new Date(item.liquidityAddedAt).getTime()) / 60000);
      const liq = item.liquidity || 0;
      const addr = item.address;
      const name = item.name || 'Unknown';
      const ticker = item.symbol || '???';

      // Score
      let score = 0;
      if (liq > 5000) score += 20;
      if (liq > 20000) score += 20;
      if (liq > 50000) score += 15;
      if (age < 5) score += 30;
      else if (age < 15) score += 15;
      if (item.source === 'pump_amm') score += 15;

      // Send BUY alert if score high enough and not already alerted
      if (score >= 60 && !tgAlerted[addr] && age < 15) {
        tgAlerted[addr] = true;
        const jupLink = 'https://jup.ag/swap/SOL-' + addr;
        const msg =
          '🟢 <b>BUY SIGNAL: ' + name + ' ($' + ticker + ')</b>\n\n' +
          '💧 Liquidity: $' + (liq >= 1000 ? (liq/1000).toFixed(1)+'K' : liq.toFixed(0)) + '\n' +
          '⏱ Age: ' + age + ' minutes old\n' +
          '📊 Score: ' + score + '/100\n' +
          '🔗 Source: ' + (item.source || 'unknown') + '\n\n' +
          '👇 <b>To buy:</b>\n' +
          '1. Open Jupiter: ' + jupLink + '\n' +
          '2. Click "Paste CA" and paste:\n<code>' + addr + '</code>\n\n' +
          'Reply with how much SOL you bought (e.g. "bought 0.05") to track your position.';

        await tgSend(msg);
        console.log('TG BUY alert sent for ' + name);

        // Auto-clear alert after 30 mins so it can re-alert if still relevant
        setTimeout(() => { delete tgAlerted[addr]; }, 30 * 60 * 1000);
      }
    }

    // Check open positions for sell signals
    for (const addr in tgPositions) {
      const pos = tgPositions[addr];
      try {
        const pr = await fetchJSON('https://public-api.birdeye.so/defi/price?address=' + addr, {
          headers: { 'X-API-KEY': BIRDEYE_KEY2, 'x-chain': 'solana' }
        });
        const pd = pr.json();
        const currentPrice = pd.data?.value || 0;
        if (!currentPrice || !pos.entryPrice) continue;

        const pct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
        pos.currentPrice = currentPrice;
        pos.pct = pct;

        // Sell signals
        if (pct >= 200 && !pos.tp3xSent) {
          pos.tp3xSent = true;
          await tgSend(
            '🎯 <b>TAKE PROFIT: ' + pos.name + '</b>\n\n' +
            '🚀 Up <b>+' + pct.toFixed(0) + '%</b> (3x hit!)\n' +
            'Entry: $' + pos.entryPrice.toFixed(8) + '\n' +
            'Now: $' + currentPrice.toFixed(8) + '\n\n' +
            '💰 Sell on Jupiter:\nhttps://jup.ag/swap/' + addr + '-SOL\n\n' +
            'Reply "sold" to close position.'
          );
        } else if (pct <= -50 && !pos.slSent) {
          pos.slSent = true;
          await tgSend(
            '⚠️ <b>STOP LOSS: ' + pos.name + '</b>\n\n' +
            '📉 Down <b>' + pct.toFixed(0) + '%</b>\n' +
            'Entry: $' + pos.entryPrice.toFixed(8) + '\n' +
            'Now: $' + currentPrice.toFixed(8) + '\n\n' +
            '🔴 Consider cutting losses:\nhttps://jup.ag/swap/' + addr + '-SOL'
          );
        } else if (pct >= 50 && !pos.tp50Sent) {
          pos.tp50Sent = true;
          await tgSend(
            '📈 <b>UP 50%: ' + pos.name + '</b>\n\n' +
            'Currently at +' + pct.toFixed(0) + '%. Consider taking some profit or moving stop loss to breakeven.'
          );
        }
      } catch(e) {}
    }
  } catch(e) {
    console.log('TG bot error:', e.message);
  }
}

// Poll Telegram for user replies
let tgOffset = 0;
async function pollTg() {
  try {
    const r = await fetchJSON('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=5');
    const d = r.json();
    for (const update of (d.result || [])) {
      tgOffset = update.update_id + 1;
      const text = update.message?.text?.toLowerCase() || '';

      if (text.includes('bought')) {
        // Parse: "bought 0.05 SOL" or just "bought"
        const match = text.match(/[\d.]+/);
        const sol = match ? parseFloat(match[0]) : 0.05;
        // Find most recently alerted token
        const recentAddr = Object.keys(tgAlerted)[Object.keys(tgAlerted).length - 1];
        if (recentAddr) {
          // Get current price
          try {
            const pr = await fetchJSON('https://public-api.birdeye.so/defi/price?address=' + recentAddr, {
              headers: { 'X-API-KEY': BIRDEYE_KEY2, 'x-chain': 'solana' }
            });
            const pd = pr.json();
            const price = pd.data?.value || 0;
            tgPositions[recentAddr] = { name: recentAddr.slice(0,8)+'...', entryPrice: price, sol, pct: 0 };
            await tgSend('✅ Position tracked!\nEntry price: $' + price.toFixed(8) + '\n' + sol + ' SOL\nI\'ll alert you at +50%, 3x, or -50%.');
          } catch(e) {}
        } else {
          await tgSend('Send me a token address to track: "track [address]"');
        }
      } else if (text.includes('sold')) {
        const addrs = Object.keys(tgPositions);
        if (addrs.length > 0) {
          const addr = addrs[addrs.length - 1];
          const pos = tgPositions[addr];
          delete tgPositions[addr];
          await tgSend('✅ Position closed!\nFinal P&L: ' + (pos.pct >= 0 ? '+' : '') + pos.pct.toFixed(1) + '%\nGood trade! 🎉');
        }
      } else if (text.includes('status')) {
        const lines = Object.entries(tgPositions).map(([a, p]) => p.name + ': ' + (p.pct >= 0 ? '+' : '') + (p.pct || 0).toFixed(1) + '%');
        await tgSend(lines.length ? '📊 Open positions:\n' + lines.join('\n') : 'No open positions.');
      } else if (text === '/start' || text === 'hi' || text === 'hello') {
        await tgSend('👋 SNPR bot ready!\n\nI\'ll send you buy signals automatically.\n\nCommands:\n• Reply "bought 0.05" after buying\n• Reply "sold" to close position\n• Reply "status" to see open positions');
      }
    }
  } catch(e) {}
}

// Start bot loops
setInterval(runTgBot, 30000);  // scan every 30s
setInterval(pollTg, 3000);     // check replies every 3s
runTgBot();                     // run immediately
console.log('Telegram bot started for chat', TG_CHAT);

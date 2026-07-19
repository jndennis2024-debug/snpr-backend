const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const BIRDEYE_KEY = '1eac17369423494f870737d134b2771e';
const TG_TOKEN = '8601216988:AAEMde9_gBTndYMe2_wBNjC5nk1Rm0Yg3FE';
const TG_CHAT = '8883767485';

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
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data) }); }
        catch(e) { reject(new Error('Parse failed: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
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
    const req = https.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
    req.on('error', rej);
    req.write(buf); req.end();
  });
}

// ─── STATE ───────────────────────────────────────────────────────────────────
var positions = {};   // addr -> { name, ticker, amount, entryPrice, pct, pnlUsd, alerts }
var alerted = {};     // addr -> token name (recently alerted buy signals)
var pendingBought = {}; // ticker -> { amount } waiting for address
var tgOffset = 0;

// ─── PRICE LOOKUP ────────────────────────────────────────────────────────────
async function getPrice(addr) {
  const r = await fetchJSON('https://public-api.birdeye.so/defi/price?address=' + addr, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  return parseFloat(r.json().data?.value || 0);
}

async function findTokenByTicker(ticker) {
  // Search Birdeye for ticker
  const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=50&min_liquidity=100', {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  const items = r.json().data?.items || [];
  const found = items.find(t => t.symbol?.toUpperCase() === ticker.toUpperCase());
  if (found) return { address: found.address, name: found.name, ticker: found.symbol };

  // Also check alerted tokens
  for (const [addr, info] of Object.entries(alerted)) {
    if (info.ticker && info.ticker.toUpperCase() === ticker.toUpperCase()) {
      return { address: addr, name: info.name, ticker: info.ticker };
    }
  }
  return null;
}

// ─── POSITION MONITOR ────────────────────────────────────────────────────────
async function checkPositions() {
  for (const [addr, pos] of Object.entries(positions)) {
    try {
      const price = await getPrice(addr);
      if (!price || !pos.entryPrice) continue;
      const pct = (price - pos.entryPrice) / pos.entryPrice * 100;
      const pnlUsd = (pct / 100) * pos.amount * pos.entryPrice;
      pos.pct = pct;
      pos.pnlUsd = pnlUsd;
      pos.currentPrice = price;

      // Sell alerts — only send each once
      if (pct >= 200 && !pos.alerts?.tp3x) {
        pos.alerts = pos.alerts || {};
        pos.alerts.tp3x = true;
        await tgSend('🎯 <b>3X HIT: ' + pos.name + '</b>\n\n🚀 Up <b>+' + pct.toFixed(0) + '%</b>\nEntry: $' + pos.entryPrice.toFixed(8) + '\nNow: $' + price.toFixed(8) + '\n\n💰 Consider selling! Reply "sold ' + pos.ticker + '" to close.');
      } else if (pct >= 100 && !pos.alerts?.tp2x) {
        pos.alerts = pos.alerts || {};
        pos.alerts.tp2x = true;
        await tgSend('📈 <b>2X: ' + pos.name + '</b>\n\nUp <b>+' + pct.toFixed(0) + '%</b> — consider taking some profit.\nReply "sold ' + pos.ticker + '" to close.');
      } else if (pct >= 50 && !pos.alerts?.tp50) {
        pos.alerts = pos.alerts || {};
        pos.alerts.tp50 = true;
        await tgSend('📈 <b>UP 50%: ' + pos.name + '</b>\n\n+' + pct.toFixed(1) + '% — moving nicely. Watch for pullback.');
      } else if (pct <= -50 && !pos.alerts?.sl) {
        pos.alerts = pos.alerts || {};
        pos.alerts.sl = true;
        await tgSend('⚠️ <b>STOP LOSS: ' + pos.name + '</b>\n\n📉 Down <b>' + pct.toFixed(0) + '%</b>\nConsider cutting losses. Reply "sold ' + pos.ticker + '" to close.');
      }
    } catch(e) {}
  }
}

// ─── TOKEN SCANNER ───────────────────────────────────────────────────────────
async function scanTokens() {
  try {
    const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&min_liquidity=1000', {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    const items = (r.json().data?.items || []).filter(i => i.liquidity > 1000);
    const now = Date.now();

    for (const item of items) {
      const age = Math.floor((now - new Date(item.liquidityAddedAt).getTime()) / 60000);
      const liq = item.liquidity || 0;
      const addr = item.address;
      const name = item.name || 'Unknown';
      const ticker = item.symbol || '???';

      let score = 0;
      if (liq > 5000) score += 20;
      if (liq > 20000) score += 20;
      if (liq > 50000) score += 15;
      if (age < 5) score += 30;
      else if (age < 15) score += 15;
      if (item.source === 'pump_amm') score += 15;

      if (score >= 60 && !alerted[addr] && age < 15) {
        alerted[addr] = { name, ticker };
        setTimeout(() => { delete alerted[addr]; }, 60 * 60 * 1000); // clear after 1hr

        const msg =
          '🟢 <b>' + name + ' ($' + ticker + ')</b>\n\n' +
          '💧 Liq: $' + (liq >= 1000 ? (liq/1000).toFixed(1)+'K' : liq.toFixed(0)) + '\n' +
          '⏱ Age: ' + age + 'm old\n' +
          '📊 Score: ' + score + '/100\n\n' +
          '👇 Buy in Phantom → Swap → paste CA:\n' +
          '<code>' + addr + '</code>\n\n' +
          'Then reply: <b>"bought 118.72 of ' + ticker + '"</b>';

        await tgSend(msg);
        await tgSend(addr); // separate message for easy copy
        console.log('Signal sent: ' + name);
      }
    }
  } catch(e) { console.log('Scan error:', e.message); }
}

// ─── TELEGRAM POLLING ────────────────────────────────────────────────────────
async function pollTg() {
  try {
    const r = await fetchJSON('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=5');
    const updates = r.json().result || [];

    for (const update of updates) {
      tgOffset = update.update_id + 1;
      const raw = update.message?.text || '';
      const lower = raw.toLowerCase().trim();

      // BOUGHT: "bought 118.72 of BMCRISE"
      if (lower.startsWith('bought')) {
        const numMatch = raw.match(/[\d,.]+/);
        const amount = numMatch ? parseFloat(numMatch[0].replace(',', '')) : 0;
        const ofMatch = raw.match(/\bof\s+([A-Za-z0-9]+)/i);
        const capsMatch = raw.match(/\b([A-Z]{2,10})\b/g);
        const ticker = ofMatch ? ofMatch[1].toUpperCase() : (capsMatch ? capsMatch[capsMatch.length - 1] : null);

        if (!amount || !ticker) {
          await tgSend('Format: "bought 118.72 of BMCRISE"');
          continue;
        }

        await tgSend('🔍 Looking up ' + ticker + '...');

        const token = await findTokenByTicker(ticker).catch(() => null);
        if (!token) {
          await tgSend('❌ Could not find $' + ticker + '. Make sure the symbol matches exactly.');
          continue;
        }

        const price = await getPrice(token.address).catch(() => 0);
        positions[token.address] = {
          name: token.name, ticker,
          amount, entryPrice: price,
          pct: 0, pnlUsd: 0, alerts: {}
        };

        await tgSend('✅ <b>Tracking ' + token.name + '</b>\n\nAmount: ' + amount.toLocaleString() + ' tokens\nEntry: $' + price.toFixed(8) + '\n\nI\'ll alert you at +50%, 2x, 3x, and -50% stop loss.');
      }

      // SOLD: "sold BMCRISE" or just "sold"
      else if (lower.startsWith('sold')) {
        const tickerMatch = raw.match(/\b([A-Z]{2,10})\b/);
        const ticker = tickerMatch ? tickerMatch[1] : null;
        const addr = ticker
          ? Object.keys(positions).find(a => positions[a].ticker === ticker)
          : Object.keys(positions)[Object.keys(positions).length - 1];

        if (addr && positions[addr]) {
          const pos = positions[addr];
          delete positions[addr];
          await tgSend('✅ <b>Closed ' + pos.name + '</b>\n\nP&L: ' + (pos.pct >= 0 ? '+' : '') + pos.pct.toFixed(1) + '% ($' + (pos.pnlUsd >= 0 ? '+' : '') + pos.pnlUsd.toFixed(2) + ')');
        } else {
          await tgSend('No position found for that ticker. Try "sold BMCRISE"');
        }
      }

      // STATUS
      else if (lower === 'status' || lower === '/status') {
        if (!Object.keys(positions).length) { await tgSend('No open positions.'); continue; }
        let msg = '📊 <b>Positions</b>\n\n';
        for (const [addr, pos] of Object.entries(positions)) {
          try {
            const price = await getPrice(addr);
            const pct = (price - pos.entryPrice) / pos.entryPrice * 100;
            const pnl = (pct / 100) * pos.amount * pos.entryPrice;
            pos.pct = pct; pos.pnlUsd = pnl; pos.currentPrice = price;
            msg += '<b>' + pos.name + ' ($' + pos.ticker + ')</b>\n';
            msg += (pct >= 0 ? '▲ +' : '▼ ') + pct.toFixed(1) + '% | ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '\n';
            msg += 'Entry $' + pos.entryPrice.toFixed(8) + ' → $' + price.toFixed(8) + '\n\n';
          } catch(e) { msg += pos.name + ': unavailable\n\n'; }
        }
        await tgSend(msg);
      }

      // ADDRESS: "address BMCRISE AbC123..."
      else if (lower.startsWith('address ')) {
        const parts = raw.trim().split(/\s+/);
        const ticker = parts[1]?.toUpperCase();
        const addr = parts[2];
        if (ticker && addr && addr.length > 30) {
          const pending = pendingBought[ticker];
          const amount = pending?.amount || 0;
          delete pendingBought[ticker];
          try {
            const price = await getPrice(addr).catch(() => 0);
            positions[addr] = { name: ticker, ticker, amount, entryPrice: price, pct: 0, pnlUsd: 0, alerts: {} };
            await tgSend('✅ <b>Tracking $' + ticker + '</b>

Amount: ' + (amount||'?').toLocaleString() + ' tokens
Entry: $' + price.toFixed(8) + '

I'll alert you at +50%, 2x, 3x, and -50%.');
          } catch(e) { await tgSend('❌ Could not get price for that address.'); }
        } else {
          await tgSend('Format: "address BMCRISE [CONTRACT_ADDRESS]"');
        }
      }

      // RESET
      else if (lower === 'reset holdings' || lower === 'reset') {
        positions = {};
        await tgSend('🔄 All positions cleared.');
      }

      // HELP / START
      else if (lower === '/start' || lower === 'hi' || lower === 'hello' || lower === 'help') {
        await tgSend('👋 <b>SNPR Bot</b>\n\nI send buy signals every 5 mins and monitor your positions.\n\n<b>Commands:</b>\n• <code>bought 118.72 of BMCRISE</code>\n• <code>sold BMCRISE</code>\n• <code>status</code> — see P&L\n• <code>reset holdings</code> — clear all positions');
      }
    }
  } catch(e) { console.log('pollTg error:', e.message); }
}

// ─── EXPRESS ROUTES ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'SNPR bot running', positions: Object.keys(positions).length }));

app.get('/tokens', async (req, res) => {
  try {
    const r = await fetchJSON('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&min_liquidity=1000', {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
    });
    const items = (r.json().data?.items || []);
    const now = Date.now();
    const tokens = items.map(item => {
      const age = Math.floor((now - new Date(item.liquidityAddedAt).getTime()) / 60000);
      const liq = item.liquidity || 0;
      let score = 0;
      if (liq > 2000) score += 20; if (liq > 10000) score += 20; if (liq > 30000) score += 15;
      if (age < 5) score += 25; else if (age < 15) score += 15; else if (age < 30) score += 5;
      if (item.source === 'pump_amm') score += 20;
      return { name: item.name, ticker: item.symbol, address: item.address, liq, age, score: Math.min(100, score), source: item.source };
    });
    res.json({ success: true, tokens, source: 'birdeye' });
  } catch(e) { res.json({ success: false, tokens: [], error: e.message }); }
});

app.get('/solprice', async (req, res) => {
  try {
    const r = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    res.json({ price: parseFloat(r.json().price) });
  } catch(e) { res.json({ price: 76 }); }
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SNPR running on port', PORT));

setInterval(scanTokens, 300000);   // scan every 5 mins
setInterval(checkPositions, 30000); // check positions every 30s
setInterval(pollTg, 3000);          // check replies every 3s

scanTokens();  // run immediately
pollTg();
tgSend('🤖 SNPR bot started! Send "help" for commands.');
console.log('Bot live for chat', TG_CHAT);

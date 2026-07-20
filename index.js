const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY_B58 = '2YSyQHCmxXvJ2MfoqbbpJrj2exJCkpFB8KYfE5j2RUEyPw1Qzdac17RNqVAmtkKnc6oWhdY9i8JWDtHMgkthCWPv';
const WALLET_ADDR     = 'qeLQghrpmbVrVyActpBe2nK1tVdejvGykQ6D9qZKJLU';
const BIRDEYE_KEY     = '1eac17369423494f870737d134b2771e';
const TG_TOKEN        = '8601216988:AAEMde9_gBTndYMe2_wBNjC5nk1Rm0Yg3FE';
const TG_CHAT         = '8883767485';
const HELIUS_RPC      = 'https://mainnet.helius-rpc.com/?api-key=2a3b07b9-e919-4be1-aa6f-6d42d17c0175';

const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  BTC:  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH:  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function fetch2(url, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: options.method || 'GET', headers: options.headers || {}
    };
    if (options.body) {
      var buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      opts.headers['Content-Length'] = buf.length;
    }
    var r = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok: res.statusCode < 400,
          buffer: raw,
          text: raw.toString(),
          json: function() { return JSON.parse(raw.toString()); }
        });
      });
    });
    r.on('error', reject);
    if (options.body) r.write(Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body));
    r.end();
  });
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
function tg(text) {
  var body = JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'HTML', disable_web_page_preview: true });
  return fetch2('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
  }).catch(function() {});
}

// ─── SOLANA RPC ───────────────────────────────────────────────────────────────
function rpc(method, params) {
  var body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params });
  return fetch2(HELIUS_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
  }).then(function(r) { return r.json(); });
}

async function getSOLBalance() {
  var d = await rpc('getBalance', [WALLET_ADDR]);
  console.log('getBalance response:', JSON.stringify(d));
  return (d.result && d.result.value ? d.result.value : 0) / 1e9;
}

// ─── KEYPAIR ──────────────────────────────────────────────────────────────────
var B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromB58(str) {
  var result = BigInt(0);
  for (var i = 0; i < str.length; i++) result = result * BigInt(58) + BigInt(B58A.indexOf(str[i]));
  var hex = result.toString(16).padStart(128, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

var nacl = require('tweetnacl');
var secretKey = fromB58(PRIVATE_KEY_B58);
var keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
console.log('Keypair loaded:', WALLET_ADDR);

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
var priceHist = { SOL: [], BTC: [], ETH: [] };
var latestPrice = { SOL: 0, BTC: 0, ETH: 0 };

async function fetchPrices() {
  var syms = { SOL: MINTS.SOL, BTC: MINTS.BTC, ETH: MINTS.ETH };
  for (var sym in syms) {
    try {
      var r = await fetch2('https://public-api.birdeye.so/defi/price?address=' + syms[sym], {
        headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
      });
      var price = parseFloat(r.json().data && r.json().data.value ? r.json().data.value : 0);
      if (price > 0) {
        latestPrice[sym] = price;
        priceHist[sym].push({ price: price, time: Date.now() });
        if (priceHist[sym].length > 300) priceHist[sym].shift();
      }
    } catch(e) {}
  }
  console.log('Prices:', JSON.stringify(latestPrice));
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function calcEMA(hist, n) {
  if (hist.length < n) return hist.length ? hist[hist.length-1].price : 0;
  var k = 2/(n+1), e = 0;
  for (var i = 0; i < n; i++) e += hist[i].price;
  e /= n;
  for (var i = n; i < hist.length; i++) e = hist[i].price * k + e * (1-k);
  return e;
}
function calcRSI(hist, n) {
  n = n || 14;
  if (hist.length < n+1) return 50;
  var g = 0, l = 0;
  for (var i = hist.length-n; i < hist.length; i++) {
    var d = hist[i].price - hist[i-1].price;
    if (d > 0) g += d; else l -= d;
  }
  return 100 - (100 / (1 + (g / (l || 0.001))));
}
function calcMACD(hist) { return calcEMA(hist,12) - calcEMA(hist,26); }
function calcMom(hist, n) {
  n = n || 5;
  if (hist.length < n+1) return 0;
  return (hist[hist.length-1].price - hist[hist.length-1-n].price) / hist[hist.length-1-n].price * 100;
}

function getSignal(sym) {
  var hist = priceHist[sym];
  if (hist.length < 30) return { action: 'hold', score: 0, reasons: ['Building data (' + hist.length + '/30)...'] };
  var price = hist[hist.length-1].price;
  var r = calcRSI(hist), m = calcMACD(hist), e9 = calcEMA(hist,9), e21 = calcEMA(hist,21), mom = calcMom(hist);
  var buy = 0, sell = 0, reasons = [];
  if (r < 35) { buy += 25; reasons.push('RSI oversold ' + r.toFixed(0)); }
  else if (r > 65) { sell += 25; reasons.push('RSI overbought ' + r.toFixed(0)); }
  if (m > 0) { buy += 20; reasons.push('MACD positive'); } else { sell += 20; reasons.push('MACD negative'); }
  if (e9 > e21) { buy += 20; reasons.push('EMA bullish'); } else { sell += 20; reasons.push('EMA bearish'); }
  if (mom > 1) { buy += 15; reasons.push('Momentum +' + mom.toFixed(1) + '%'); }
  else if (mom < -1) { sell += 15; reasons.push('Momentum ' + mom.toFixed(1) + '%'); }
  var score = Math.max(buy, sell);
  if (buy >= 55) return { action: 'buy', score: score, reasons: reasons, rsi: r, macd: m, mom: mom, price: price };
  if (sell >= 55) return { action: 'sell', score: score, reasons: reasons, rsi: r, macd: m, mom: mom, price: price };
  return { action: 'hold', score: score, reasons: reasons, rsi: r, macd: m, mom: mom, price: price };
}

// ─── JUPITER SWAP ─────────────────────────────────────────────────────────────
async function jupSwap(inputMint, outputMint, amountLamports) {
  var qr = await fetch2(
    'https://quote-api.jup.ag/v6/quote?inputMint=' + inputMint + '&outputMint=' + outputMint +
    '&amount=' + amountLamports + '&slippageBps=150'
  );
  var quote = qr.json();
  if (quote.error || !quote.outAmount) throw new Error('No route: ' + (quote.error || 'no outAmount'));

  var body = JSON.stringify({ quoteResponse: quote, userPublicKey: WALLET_ADDR, wrapAndUnwrapSol: true, prioritizationFeeLamports: 300000 });
  var sr = await fetch2('https://quote-api.jup.ag/v6/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
  });
  var swapData = sr.json();
  if (!swapData.swapTransaction) throw new Error('No swapTransaction in response');

  var txBytes = Buffer.from(swapData.swapTransaction, 'base64');
  var numSigs = txBytes[1];
  var sigsEnd = 1 + 1 + numSigs * 64;
  var msgBytes = txBytes.slice(sigsEnd);
  var sig = nacl.sign.detached(msgBytes, keypair.secretKey);
  txBytes.set(sig, 2);

  var txB64 = txBytes.toString('base64');
  var sendBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [txB64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }] });
  var sendR = await fetch2(HELIUS_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sendBody });
  var sendD = sendR.json();
  if (sendD.error) throw new Error('RPC error: ' + sendD.error.message);
  return { signature: sendD.result, outAmount: quote.outAmount };
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var isRunning = false;
var positions = {};
var trades = [];
var sessionPnl = 0;
var wins = 0, losses = 0;
var lastTradeTime = {};
var MIN_INTERVAL = 3 * 60 * 1000;

// ─── TRADING CYCLE ────────────────────────────────────────────────────────────
async function tradeCycle() {
  if (!isRunning) return;
  var solBal = await getSOLBalance().catch(function() { return 0; });
  if (solBal < 0.002) { console.log('Balance too low:', solBal); return; }

  for (var sym of ['SOL', 'BTC', 'ETH']) {
    var price = latestPrice[sym];
    if (!price) continue;
    var now = Date.now();
    if (now - (lastTradeTime[sym] || 0) < MIN_INTERVAL) continue;

    var sig = getSignal(sym);
    var inPos = !!positions[sym];

    if (sig.action === 'buy' && !inPos && solBal > 0.01) {
      var allocate = Math.min(solBal * 0.4, solBal - 0.005);
      if (allocate < 0.001) continue;
      try {
        if (sym === 'SOL') {
          positions[sym] = { entryPrice: price, solSpent: allocate, time: now };
          trades.push({ sym: sym, action: 'buy', price: price, solSpent: allocate, time: now });
          lastTradeTime[sym] = now;
          await tg('⚡ <b>BUY ' + sym + '</b>\n' + allocate.toFixed(4) + ' SOL @ $' + price.toFixed(2) + '\nSignal: ' + sig.score + '/100\n' + sig.reasons.slice(0,2).join(' · '));
        } else {
          var lam = Math.floor(allocate * 1e9);
          var result = await jupSwap(MINTS.SOL, MINTS[sym], lam);
          positions[sym] = { entryPrice: price, solSpent: allocate, time: now, sig: result.signature };
          trades.push({ sym: sym, action: 'buy', price: price, solSpent: allocate, time: now });
          lastTradeTime[sym] = now;
          await tg('⚡ <b>BUY ' + sym + '</b>\n' + allocate.toFixed(4) + ' SOL @ $' + price.toFixed(2) + '\n<a href="https://solscan.io/tx/' + result.signature + '">Solscan ↗</a>');
        }
      } catch(e) {
        console.log('Buy error', sym, e.message);
        await tg('❌ Buy ' + sym + ' failed: ' + e.message.slice(0,80));
      }
    }

    if (sig.action === 'sell' && inPos) {
      var pos = positions[sym];
      var pct = (price - pos.entryPrice) / pos.entryPrice * 100;
      var pnlUsd = pct / 100 * pos.solSpent * (latestPrice.SOL || 76);
      try {
        delete positions[sym];
        sessionPnl += pnlUsd;
        if (pct >= 0) wins++; else losses++;
        trades.push({ sym: sym, action: 'sell', price: price, pct: pct, pnlUsd: pnlUsd, time: now });
        lastTradeTime[sym] = now;
        await tg((pct >= 0 ? '✅' : '🔴') + ' <b>SELL ' + sym + '</b>\n' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% ($' + (pnlUsd >= 0 ? '+' : '') + pnlUsd.toFixed(2) + ')\nSession P&L: $' + sessionPnl.toFixed(2));
      } catch(e) {
        console.log('Sell error', sym, e.message);
      }
    }

    // Stop loss at -8%
    if (inPos) {
      var pos = positions[sym];
      var pct = (price - pos.entryPrice) / pos.entryPrice * 100;
      if (pct <= -8 && now - (lastTradeTime[sym] || 0) >= MIN_INTERVAL) {
        var pnlUsd = pct / 100 * pos.solSpent * (latestPrice.SOL || 76);
        delete positions[sym];
        sessionPnl += pnlUsd;
        losses++;
        lastTradeTime[sym] = now;
        await tg('🛑 <b>STOP LOSS: ' + sym + '</b>\nDown ' + pct.toFixed(1) + '% | -$' + Math.abs(pnlUsd).toFixed(2));
      }
    }
  }
}

// ─── TELEGRAM POLLING ─────────────────────────────────────────────────────────
var tgOffset = 0;
async function pollTg() {
  try {
    var r = await fetch2('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=5');
    var updates = r.json().result || [];
    for (var u of updates) {
      tgOffset = u.update_id + 1;
      var text = ((u.message && u.message.text) || '').toLowerCase().trim();
      if (text === 'status' || text === '/status') {
        var bal = await getSOLBalance().catch(function() { return 0; });
        var msg = '📊 <b>Status</b>\n\nBalance: ' + bal.toFixed(4) + ' SOL (~$' + (bal * (latestPrice.SOL || 76)).toFixed(2) + ')\n';
        msg += 'P&L: ' + (sessionPnl >= 0 ? '+' : '') + '$' + sessionPnl.toFixed(2) + '\n';
        msg += 'Trades: ' + trades.length + ' | W:' + wins + ' L:' + losses + '\n';
        msg += 'Bot: ' + (isRunning ? '🟢 Running' : '🔴 Stopped') + '\n\n';
        for (var sym in positions) {
          var pos = positions[sym];
          var pct = latestPrice[sym] ? (latestPrice[sym] - pos.entryPrice) / pos.entryPrice * 100 : 0;
          msg += sym + ': ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% open\n';
        }
        msg += '\nPrices: SOL $' + (latestPrice.SOL || 0).toFixed(2) + ' | BTC $' + (latestPrice.BTC || 0).toFixed(0) + ' | ETH $' + (latestPrice.ETH || 0).toFixed(0);
        await tg(msg);
      } else if (text === 'stop') {
        isRunning = false;
        await tg('⏹ Bot stopped.');
      } else if (text === 'start') {
        isRunning = true;
        await tg('🚀 Bot started!');
      } else if (text === 'prices') {
        var msg = '💹 Prices\n\n';
        for (var sym of ['SOL','BTC','ETH']) {
          var sig = getSignal(sym);
          msg += sym + ': $' + (latestPrice[sym]||0).toLocaleString() + ' — ' + sig.action.toUpperCase() + ' (' + sig.score + ')\n';
        }
        await tg(msg);
      } else if (text === '/start' || text === 'hi' || text === 'help') {
        await tg('👋 <b>ALGO Trader</b>\n\nTrading SOL/BTC/ETH 24/7\n\nCommands:\n• status\n• prices\n• start / stop');
      }
    }
  } catch(e) { console.log('pollTg error:', e.message); }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({ running: isRunning, trades: trades.length, sessionPnl: sessionPnl, wallet: WALLET_ADDR, prices: latestPrice });
});

app.get('/debug', async function(req, res) {
  try {
    var bal = await getSOLBalance();
    res.json({ wallet: WALLET_ADDR, balance: bal, prices: latestPrice, histLen: { SOL: priceHist.SOL.length, BTC: priceHist.BTC.length, ETH: priceHist.ETH.length } });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/prices', function(req, res) {
  var sigs = {};
  for (var sym of ['SOL','BTC','ETH']) sigs[sym] = getSignal(sym);
  res.json({ prices: latestPrice, signals: sigs });
});

// ─── START ────────────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, async function() {
  console.log('ALGO trader on port', PORT);
  await fetchPrices();
  var bal = await getSOLBalance().catch(function() { return 0; });
  console.log('Balance:', bal, 'SOL');
  await tg('🚀 <b>ALGO Trader Started</b>\n\nWallet: ' + WALLET_ADDR.slice(0,8) + '...\nBalance: ' + bal.toFixed(4) + ' SOL (~$' + (bal * (latestPrice.SOL || 76)).toFixed(2) + ')\n\nMonitoring SOL, BTC, ETH\nSend "start" to begin trading\nSend "status" anytime for updates');
  setInterval(fetchPrices, 15000);
  setInterval(tradeCycle, 30000);
  setInterval(pollTg, 3000);
});

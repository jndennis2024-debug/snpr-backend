const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PRIVATE_KEY_B58 = '2YSyQHCmxXvJ2MfoqbbpJrj2exJCkpFB8KYfE5j2RUEyPw1Qzdac17RNqVAmtkKnc6oWhdY9i8JWDtHMgkthCWPv';
const WALLET_ADDR     = 'qeLQghrpmbVrVyActpBe2nK1tVdejvGykQ6D9qZKJLU';
const BIRDEYE_KEY     = '1eac17369423494f870737d134b2771e';
const TG_TOKEN        = '8601216988:AAEMde9_gBTndYMe2_wBNjC5nk1Rm0Yg3FE';
const TG_CHAT         = '8883767485';
const RPC             = 'https://api.mainnet-beta.solana.com';

// Token mints
const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  BTC:  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',  // Wormhole wBTC (most liquid on Jupiter)
  ETH:  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // Wormhole wETH
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

// ─── SOLANA KEYPAIR ───────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromB58(str) {
  let result = BigInt(0);
  for (const c of str) {
    result = result * BigInt(58) + BigInt(B58.indexOf(c));
  }
  const hex = result.toString(16).padStart(128, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
function toB58(buf) {
  let digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return digits.reverse().map(d => B58[d]).join('');
}

let keypair;
try {
  // Import tweetnacl for signing
  const nacl = require('tweetnacl');
  const secretKey = fromB58(PRIVATE_KEY_B58);
  keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  console.log('Keypair loaded:', WALLET_ADDR);
} catch(e) {
  console.log('Keypair error:', e.message);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function req(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (options.body) {
      const buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      opts.headers['Content-Length'] = buf.length;
    }
    const r = lib.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ok: res.statusCode < 400, buffer: raw,
          text: raw.toString(), json: () => JSON.parse(raw.toString()) });
      });
    });
    r.on('error', reject);
    if (options.body) r.write(Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body));
    r.end();
  });
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
function tg(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return req('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  }).catch(() => {});
}

// ─── SOLANA RPC ───────────────────────────────────────────────────────────────
async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = await req(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return r.json();
}

async function getSOLBalance() {
  const d = await rpcCall('getBalance', [WALLET_ADDR]);
  return (d.result?.value || 0) / 1e9;
}

async function getRecentBlockhash() {
  const d = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return d.result?.value?.blockhash;
}

async function sendRawTx(serialized) {
  const b64 = Buffer.from(serialized).toString('base64');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
    params: [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]
  });
  const r = await req(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const d = r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result; // signature
}

// ─── JUPITER SWAP ─────────────────────────────────────────────────────────────
async function jupiterSwap(inputMint, outputMint, amountLamports) {
  // Get quote
  const qr = await req(
    'https://quote-api.jup.ag/v6/quote?inputMint=' + inputMint +
    '&outputMint=' + outputMint + '&amount=' + amountLamports + '&slippageBps=150'
  );
  const quote = qr.json();
  if (quote.error || !quote.outAmount) throw new Error('No route: ' + (quote.error || 'unknown'));

  // Build swap tx
  const body = JSON.stringify({
    quoteResponse: quote,
    userPublicKey: WALLET_ADDR,
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: 300000
  });
  const sr = await req('https://quote-api.jup.ag/v6/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  });
  const swapData = sr.json();
  if (!swapData.swapTransaction) throw new Error('No swap tx');

  // Deserialize, sign, send
  const nacl = require('tweetnacl');
  const txBytes = Buffer.from(swapData.swapTransaction, 'base64');

  // Parse versioned transaction and sign
  // Versioned tx starts with 0x80 (version prefix)
  // We sign the message portion
  const version = txBytes[0];
  const messageBytes = txBytes.slice(1); // skip version byte for signing

  // Actually for versioned txs we sign the full message bytes
  // The message starts after the signatures array
  // signatures count is first byte after version
  const numSigs = txBytes[1];
  const sigsEnd = 1 + 1 + numSigs * 64;
  const messageToSign = txBytes.slice(sigsEnd);

  const sig = nacl.sign.detached(messageToSign, keypair.secretKey);

  // Replace first signature slot
  txBytes.set(sig, 2); // after version byte and sig count byte

  const signature = await sendRawTx(txBytes);
  return { signature, outAmount: quote.outAmount, inputAmount: amountLamports };
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
const priceHist = { SOL: [], BTC: [], ETH: [] };
const latestPrice = { SOL: 0, BTC: 0, ETH: 0 };

async function fetchPrices() {
  for (const [sym, mint] of Object.entries({ SOL: MINTS.SOL, BTC: MINTS.BTC, ETH: MINTS.ETH })) {
    try {
      const r = await req('https://public-api.birdeye.so/defi/price?address=' + mint, {
        headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
      });
      const price = parseFloat(r.json().data?.value || 0);
      if (price > 0) {
        latestPrice[sym] = price;
        priceHist[sym].push({ price, time: Date.now() });
        if (priceHist[sym].length > 300) priceHist[sym].shift();
      }
    } catch(e) {}
  }
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function ema(hist, n) {
  if (hist.length < n) return hist[hist.length-1]?.price || 0;
  const k = 2/(n+1);
  let e = hist.slice(0,n).reduce((a,b)=>a+b.price,0)/n;
  for (let i=n;i<hist.length;i++) e=hist[i].price*k+e*(1-k);
  return e;
}
function rsi(hist, n=14) {
  if (hist.length < n+1) return 50;
  let g=0,l=0;
  for (let i=hist.length-n;i<hist.length;i++) {
    const d=hist[i].price-hist[i-1].price;
    if(d>0)g+=d;else l-=d;
  }
  return 100-(100/(1+(g/(l||0.001))));
}
function macd(hist) { return ema(hist,12)-ema(hist,26); }
function bb(hist,n=20) {
  if(hist.length<n) return {upper:0,lower:0,mid:0};
  const s=hist.slice(-n), m=s.reduce((a,b)=>a+b.price,0)/n;
  const std=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b.price-m,2),0)/n);
  return {upper:m+2*std,lower:m-2*std,mid:m};
}
function momentum(hist,n=5) {
  if(hist.length<n+1) return 0;
  return (hist[hist.length-1].price-hist[hist.length-1-n].price)/hist[hist.length-1-n].price*100;
}

function signal(sym) {
  const hist = priceHist[sym];
  if (hist.length < 30) return { action:'hold', score:0, reasons:['Building data...'] };
  const price = hist[hist.length-1].price;
  const r = rsi(hist), m = macd(hist), e9 = ema(hist,9), e21 = ema(hist,21);
  const b = bb(hist), mom = momentum(hist);

  let buy=0, sell=0, reasons=[];
  if(r<35){buy+=25;reasons.push('RSI oversold '+r.toFixed(0));}
  else if(r>65){sell+=25;reasons.push('RSI overbought '+r.toFixed(0));}
  if(m>0){buy+=20;reasons.push('MACD positive');}else{sell+=20;reasons.push('MACD negative');}
  if(e9>e21){buy+=20;reasons.push('EMA bullish');}else{sell+=20;reasons.push('EMA bearish');}
  if(price<b.lower){buy+=20;reasons.push('Below BB lower');}
  else if(price>b.upper){sell+=20;reasons.push('Above BB upper');}
  if(mom>1){buy+=15;reasons.push('Momentum +'+mom.toFixed(1)+'%');}
  else if(mom<-1){sell+=15;reasons.push('Momentum '+mom.toFixed(1)+'%');}

  const score = Math.max(buy,sell);
  if(buy>=55) return {action:'buy',score,reasons,rsi:r,macd:m,ema9:e9,ema21:e21,bb:b,mom,price};
  if(sell>=55) return {action:'sell',score,reasons,rsi:r,macd:m,ema9:e9,ema21:e21,bb:b,mom,price};
  return {action:'hold',score,reasons,rsi:r,macd:m,ema9:e9,ema21:e21,bb:b,mom,price};
}

// ─── TRADING STATE ────────────────────────────────────────────────────────────
let isRunning = false;
let positions = {}; // sym -> { entryPrice, solSpent, entryTime }
let trades = [];
let sessionPnl = 0;
let wins=0, losses=0;
let lastTradeTime = {};
const MIN_TRADE_INTERVAL = 3 * 60 * 1000; // 3 min between trades per asset

// ─── TRADING CYCLE ────────────────────────────────────────────────────────────
async function tradingCycle() {
  if (!isRunning || !keypair) return;

  const solBal = await getSOLBalance().catch(() => 0);
  const totalSOL = solBal;

  for (const sym of ['SOL','BTC','ETH'].filter(s => latestPrice[s] > 0)) {
    const sig = signal(sym);
    const price = latestPrice[sym];
    if (!price) continue;

    const now = Date.now();
    const lastTrade = lastTradeTime[sym] || 0;
    if (now - lastTrade < MIN_TRADE_INTERVAL) continue;

    const inPos = !!positions[sym];

    // BUY
    if (sig.action === 'buy' && !inPos && totalSOL > 0.01) {
      const allocate = Math.min(totalSOL * 0.4, totalSOL - 0.005); // use 40% per trade, keep 0.005 for fees
      if (allocate < 0.001) continue;
      const lamports = Math.floor(allocate * 1e9);

      try {
        console.log('BUY ' + sym + ' with ' + allocate.toFixed(4) + ' SOL');
        let signature;

        if (sym === 'SOL') {
          // For SOL we just track it (already holding SOL)
          positions[sym] = { entryPrice: price, solSpent: allocate, entryTime: now };
          trades.push({ sym, action:'buy', price, solSpent: allocate, time: now });
          lastTradeTime[sym] = now;
          await tg('⚡ <b>BUY ' + sym + '</b>\n' + allocate.toFixed(4) + ' SOL @ $' + price.toFixed(2) + '\nScore: ' + sig.score + '\n' + sig.reasons.slice(0,2).join(' · '));
        } else {
          // Swap SOL → token
          const result = await jupiterSwap(MINTS.SOL, MINTS[sym], lamports);
          signature = result.signature;
          positions[sym] = { entryPrice: price, solSpent: allocate, entryTime: now, sig: signature };
          trades.push({ sym, action:'buy', price, solSpent: allocate, time: now, sig: signature });
          lastTradeTime[sym] = now;
          await tg('⚡ <b>BUY ' + sym + '</b>\n' + allocate.toFixed(4) + ' SOL @ $' + price.toFixed(2) + '\nTX: <a href="https://solscan.io/tx/'+signature+'">Solscan</a>\nScore: ' + sig.score);
        }
      } catch(e) {
        console.log('Buy error ' + sym + ':', e.message);
        await tg('❌ Buy ' + sym + ' failed: ' + e.message.slice(0,80));
      }
    }

    // SELL
    if (sig.action === 'sell' && inPos) {
      const pos = positions[sym];
      const pct = (price - pos.entryPrice) / pos.entryPrice * 100;
      const pnlUsd = pct / 100 * pos.solSpent * (latestPrice.SOL || 76);

      try {
        if (sym === 'SOL') {
          // Just close tracked position
          delete positions[sym];
          sessionPnl += pnlUsd;
          if(pct>=0)wins++;else losses++;
          trades.push({ sym, action:'sell', price, pct, pnlUsd, time: now });
          lastTradeTime[sym] = now;
          await tg((pct>=0?'✅':'🔴') + ' <b>SELL ' + sym + '</b>\n' + (pct>=0?'+':'') + pct.toFixed(1) + '% ($' + (pnlUsd>=0?'+':'') + pnlUsd.toFixed(2) + ')\nSession P&L: $' + sessionPnl.toFixed(2));
        } else {
          // Swap token back to SOL — use approximate token amount
          const tokenDecimals = sym === 'BTC' ? 8 : 8;
          const tokenAmt = Math.floor((pos.solSpent / pos.entryPrice) * price * Math.pow(10, tokenDecimals) * 0.98);
          const result = await jupiterSwap(MINTS[sym], MINTS.SOL, tokenAmt);
          delete positions[sym];
          sessionPnl += pnlUsd;
          if(pct>=0)wins++;else losses++;
          trades.push({ sym, action:'sell', price, pct, pnlUsd, time: now, sig: result.signature });
          lastTradeTime[sym] = now;
          await tg((pct>=0?'✅':'🔴') + ' <b>SELL ' + sym + '</b>\n' + (pct>=0?'+':'') + pct.toFixed(1) + '% ($' + (pnlUsd>=0?'+':'') + pnlUsd.toFixed(2) + ')\nTX: <a href="https://solscan.io/tx/'+result.signature+'">Solscan</a>');
        }
      } catch(e) {
        console.log('Sell error ' + sym + ':', e.message);
        await tg('❌ Sell ' + sym + ' failed: ' + e.message.slice(0,80));
      }
    }

    // Stop loss: -8%
    if (inPos) {
      const pos = positions[sym];
      const pct = (price - pos.entryPrice) / pos.entryPrice * 100;
      if (pct <= -8) {
        await tg('🛑 <b>STOP LOSS: ' + sym + '</b>\nDown ' + pct.toFixed(1) + '% — closing position');
        // Force sell signal
        signal(sym).action = 'sell';
      }
    }
  }
}

// ─── TELEGRAM POLLING ─────────────────────────────────────────────────────────
let tgOffset = 0;
async function pollTg() {
  try {
    const r = await req('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=5');
    for (const u of (r.json().result || [])) {
      tgOffset = u.update_id + 1;
      const text = (u.message?.text || '').toLowerCase().trim();
      if (text === 'status' || text === '/status') {
        const bal = await getSOLBalance().catch(()=>0);
        let msg = '📊 <b>Status</b>\n\n';
        msg += 'Balance: ' + bal.toFixed(4) + ' SOL (~$' + (bal*(latestPrice.SOL||76)).toFixed(2) + ')\n';
        msg += 'Session P&L: ' + (sessionPnl>=0?'+':'') + '$' + sessionPnl.toFixed(2) + '\n';
        msg += 'Trades: ' + trades.length + ' | W:' + wins + ' L:' + losses + '\n';
        msg += 'Bot: ' + (isRunning ? '🟢 Running' : '🔴 Stopped') + '\n\n';
        for (const [sym, pos] of Object.entries(positions)) {
          const pct = (latestPrice[sym]-pos.entryPrice)/pos.entryPrice*100;
          msg += sym + ': ' + (pct>=0?'+':'') + pct.toFixed(1) + '% open\n';
        }
        await tg(msg);
      } else if (text === 'prices' || text === '/prices') {
        let msg = '💹 <b>Prices & Signals</b>\n\n';
        for (const sym of ['SOL','BTC','ETH'].filter(s => latestPrice[s] > 0)) {
          const sig = signal(sym);
          msg += '<b>' + sym + '</b>: $' + (latestPrice[sym]||0).toLocaleString() + ' — ' + sig.action.toUpperCase() + ' (' + sig.score + ')\n';
        }
        await tg(msg);
      } else if (text === 'stop') {
        isRunning = false;
        await tg('⏹ Bot stopped.');
      } else if (text === 'start') {
        isRunning = true;
        await tg('🚀 Bot started!');
      } else if (text === 'start' || text === '/start' || text === 'hi' || text === 'help') {
        await tg('👋 <b>ALGO Trader</b>\n\nTrading SOL/BTC/ETH 24/7\n\nCommands:\n• status\n• prices\n• start / stop');
      }
    }
  } catch(e) {}
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ running: isRunning, trades: trades.length, sessionPnl, wallet: WALLET_ADDR }));
app.get('/prices', (req, res) => {
  const sigs = {};
  for (const sym of ['SOL','BTC','ETH']) sigs[sym] = signal(sym);
  res.json({ prices: latestPrice, signals: sigs, positions, histLen: { SOL: priceHist.SOL.length, BTC: priceHist.BTC.length, ETH: priceHist.ETH.length } });
});
app.get('/portfolio', (req, res) => res.json({ positions, trades: trades.slice(-50), sessionPnl, wins, losses }));
app.get('/balance', async (req, res) => {
  const bal = await getSOLBalance().catch(()=>0);
  res.json({ sol: bal, usd: bal * (latestPrice.SOL||76) });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('ALGO trader on port', PORT);
  // Install tweetnacl if needed
  try { require('tweetnacl'); } catch(e) { console.log('tweetnacl not found — install it'); }
  await fetchPrices();
  const bal = await getSOLBalance().catch(()=>0);
  await tg('🚀 <b>ALGO Trader Started</b>\n\nWallet: ' + WALLET_ADDR.slice(0,8) + '...\nBalance: ' + bal.toFixed(4) + ' SOL (~$' + (bal*latestPrice.SOL||0).toFixed(2) + ')\n\nMonitoring SOL, BTC, ETH\nSend "start" to begin trading');
  setInterval(fetchPrices, 15000);
  setInterval(tradingCycle, 30000);
  setInterval(pollTg, 3000);
});

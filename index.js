app.get('/tokens', async (req, res) => {
  try {
    let allPairs = [];
    let debugInfo = [];
    for (const q of ['pump', 'solana', 'meme']) {
      try {
        const r = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
        const d = r.json();
        const total = d.pairs?.length || 0;
        const solana = (d.pairs || []).filter(p => p.chainId === 'solana').length;
        debugInfo.push(`${q}: ${total} total, ${solana} solana`);
        if (d.pairs) allPairs = allPairs.concat(d.pairs);
      } catch(e) { debugInfo.push(`${q}: error ${e.message}`); }
    }
    const now = Date.now();
    const seen = {};
    const all = allPairs.filter(p => p && p.chainId === 'solana' && !seen[p.pairAddress] && (seen[p.pairAddress] = true));
    const withAge = all.filter(p => p.pairCreatedAt);
    const recent = withAge.filter(p => (now - p.pairCreatedAt) / 60000 < 1440);
    const withLiq = recent.filter(p => parseFloat(p.liquidity?.usd || 0) > 500);
    const tokens = withLiq
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
    res.json({ success: true, tokens, debug: { queries: debugInfo, totalPairs: allPairs.length, solana: all.length, withAge: withAge.length, recent: recent.length, withLiq: withLiq.length } });
  } catch (e) {
    res.json({ success: false, error: e.message, tokens: [] });
  }
});

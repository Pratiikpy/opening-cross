# Measures what happens in the first block of real Meteora DBC launches, from GeckoTerminal's public trade feed.
# For each recent DBC pool with a complete trade history (the feed returns the latest 300 trades of 24 h): how much of the buy volume
# arrived in the pool's first block, from how many wallets, and what those wallets made or lost over the rest of the feed.
# Run: python launch-race-analysis.py  (writes launch-race-analysis.json next to it)
import json, time, statistics, urllib.request, sys, os
API = 'https://api.geckoterminal.com/api/v2/networks/solana'
def get(path, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + path, headers={'accept': 'application/json;version=20230302'}), timeout=30) as r:
                return json.load(r)
        except Exception as e:
            time.sleep(4 * (i + 1))
    return None
pools = []
for page in range(1, 6):
    d = get(f'/dexes/meteora-dbc/pools?page={page}')
    if not d: break
    pools += d['data']
    time.sleep(2.2)
rows = []
for p in pools:
    a = p['attributes']
    addr = a['address']
    t = get(f'/pools/{addr}/trades')
    time.sleep(2.2)
    if not t: continue
    tr = t['data']
    if len(tr) >= 300 or len(tr) < 20: continue  # incomplete history or too small
    tr = sorted(tr, key=lambda x: (x['attributes']['block_number'], x['attributes']['block_timestamp']))
    first_block = tr[0]['attributes']['block_number']
    buys = [x['attributes'] for x in tr if x['attributes']['kind'] == 'buy']
    sells = [x['attributes'] for x in tr if x['attributes']['kind'] == 'sell']
    usd = lambda x: float(x['volume_in_usd'])
    total_buy = sum(usd(b) for b in buys)
    if total_buy <= 0: continue
    fb_buys = [b for b in buys if b['block_number'] <= first_block + 1]
    fb_wallets = {b['tx_from_address'] for b in fb_buys}
    fb_buy_usd = sum(usd(b) for b in fb_buys)
    fb_sell_usd = sum(usd(s) for s in sells if s['tx_from_address'] in fb_wallets)
    all_wallets = {b['tx_from_address'] for b in buys}
    rows.append({
        'pool': addr, 'name': a['name'], 'created': a['pool_created_at'], 'trades': len(tr), 'buyWallets': len(all_wallets),
        'firstBlock': first_block, 'firstTwoBlocksBuyShare': fb_buy_usd / total_buy, 'firstTwoBlocksWallets': len(fb_wallets),
        'firstWalletsBoughtUsd': fb_buy_usd, 'firstWalletsSoldUsd': fb_sell_usd,
    })
out = {'source': 'GeckoTerminal public API, dex meteora-dbc, latest trades per pool', 'measuredAt': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'poolsListed': len(pools), 'poolsAnalysed': len(rows), 'pools': rows}
if rows:
    sh = [r['firstTwoBlocksBuyShare'] for r in rows]
    out['summary'] = {
        'medianFirstTwoBlocksBuyShare': statistics.median(sh), 'meanFirstTwoBlocksBuyShare': statistics.mean(sh),
        'poolsWithOver50PctInFirstTwoBlocks': sum(1 for s in sh if s > 0.5),
        'medianWalletsInFirstTwoBlocks': statistics.median(r['firstTwoBlocksWallets'] for r in rows),
        'poolsWhereFirstWalletsSoldMoreThanBought': sum(1 for r in rows if r['firstWalletsSoldUsd'] > r['firstWalletsBoughtUsd']),
    }
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'launch-race-analysis.json'), 'w'), indent=1)
print(json.dumps(out.get('summary'), indent=1), len(rows), 'pools analysed of', len(pools))

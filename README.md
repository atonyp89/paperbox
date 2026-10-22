# Paperbox

A Chrome extension for [Papertrade](https://exchange.papertrade.xyz) (high-leverage perps on HyperEVM, priced at
the Hyperliquid order-book mid).

A small floating panel on **exchange.papertrade.xyz** that shows how backed up Papertrade's order queue is,
so you can check before sending an order. It can also create a **session key** for this extension, which
your wallet (e.g. Rabby with a Ledger) authorizes with one signature, and **open positions** with that key.
In full screen, a **PAPER staking** strip shows PAPER's total supply and lets you stake PAPER and claim
rewards (see [PAPER staking](#paper-staking)).

It shows the same numbers as the **Status** tab on Papertrade's trade page, without having to switch tabs, in its
first two lines: `Paperbox • Congestion LOW` in the header, then `~3s to clear · 4 pending tx ↑3`. The panel has a
fixed width with room for the widest case (MEDIUM, up to 10,000 pending tx), so it doesn't jump as the numbers
change:

| | Meaning |
|---|---|
| **Congestion** | LOW / MEDIUM / HIGH: how many blocks the queued + submitted orders need to clear (≤ 1, ≤ 5, more). Hover for the blocks needed and avg tx per recent block. |
| **Time to clear** | About one second per block needed (at least ~3s while anything is pending); minutes past 2m, hours past 100m |
| **Pending tx** | Orders waiting for the relayer right now (hover for submitted vs. waiting for a batch) |
| **↑ / ↓** | The change in pending over the last minute, shown when it moves. ↑ in amber means the queue is growing. |

Minimize the **Paperbox** panel with **–**: it keeps just those two lines, at the same width, so
nothing jumps. Expand it with **+** or a click on the header. Drag it anywhere by the header. Position and minimized
state are remembered. When the queue feed is down, the row says *connecting…* or *unavailable* (hover for how old
the data is).

If the data stops arriving it says so ("stale, data 7s old") rather than showing old numbers, and it
reconnects on its own. While the tab is in the background for more than 30s it disconnects, and it
reconnects when you come back.

## Session key

The panel's **Session key** section creates a key that belongs to this extension, separate from the one
Papertrade's web app uses. The extension uses it to place orders (see [Open position](#open-position)).

1. **Connect wallet** (if asked). It reads the address connected on Papertrade; Rabby may ask you to approve.
2. **Create session key.** The extension generates a new key, then Rabby opens a `RegisterSessionKey`
   signature request from exchange.papertrade.xyz. Check it before approving:
   - `user` is your wallet address;
   - `key` is the new session key (shown in the panel);
   - `expiry` is 30 days from now;
   - `feeAddress` is `0x0000000000000000000000000000000000000000`;
   - the domain is `String`, version `1`, chain 999, contract `0x6cd5661646289fb6e65ea5c032310fded797d0a2`.

   Confirm on your Ledger. If Rabby isn't on HyperEVM, it first asks to switch (or add) the network.
3. The extension checks your signature really came from your wallet, then sends it to Papertrade, just as
   the web app does. The section shows **waiting for Papertrade…** until the queue executes it (usually
   under a minute, longer when congestion is HIGH), then **active** with its expiry date.

Declining in Rabby or on the Ledger sends nothing.

**What the key can do:** open and close positions on your account until it expires (30 days). It can't
withdraw or stake; those need your wallet.

**Where it's kept:** in this extension's storage, encrypted with a key that Chrome holds as non-extractable.
Only the extension's background worker can use it. Papertrade's page, other sites and other extensions can't
read it, and nothing else is ever told the private key. It's still a key on your computer, so treat this
Chrome profile accordingly.

**Removing it** (the *Remove* link) deletes it from the extension. Papertrade has no "revoke" action that
we know of, so a removed key stays valid on Papertrade until its expiry date, but nothing holds it any more.

**Ledger notes:**
- The Ethereum app on the Ledger must be open.
- Depending on the model and firmware it may show the full message (clear signing) or only hashes, in which
  case you may need to enable **blind signing** in the Ethereum app's settings.
- The Rabby window and the Ledger prompt both time out; if one does, click the button again.

If Papertrade refuses the registration, the panel says why: no deposit on the account yet, the account
already has the maximum number of session keys, registration paused, or an invalid signature. That last one
would mean the signing format changed. Registration and orders from this extension were confirmed working
live on 2026-10-17.

## Orders (batches)

**This places real orders with real USDC.**

Once the session key is **active**, the panel lets you build a batch of orders and send them all at once.

**Build:**
- **Opens:** pick the market (BTC or ETH), **Margin (USDC)** (up to 6 decimals; minimum $10) and
  **Leverage ×** (a whole number within the market's range, 1–1000× today). Click **+ Long** or **+ Short**
  to add that order. Position size = margin × leverage, and must be at least $1,000. Add as many as you like,
  mixing markets, sides and sizes.
- **Closes:** pick one of your open positions in the list (`#id side market size @ entry`) and click
  **+ Close**. Each close is the full position.
- Staged orders are listed, numbered; **✕** removes one.
- Each addition is checked against Papertrade's live rules:
  - trading or the market paused or close-only;
  - leverage range;
  - minimum margin and size;
  - maximum position;
  - your available balance, counting everything already staged;
  - the side's open-interest room.

**Three protections**, all optional (blank turns any of them off):
- **Keep within queue distance** (default **5**): the queue guard, below.
- **Send when pending tx below** (default **20**): only send when Papertrade's queue is quiet.
- **Send when OI cap room above** (default **2**, in millions of USD): only send when there's enough room
  left under the open-interest cap. Papertrade caps open interest per market and per side; the room is
  `cap − current OI` on that side, priced at the Hyperliquid mid (the same formula Papertrade's web app uses;
  a side with no cap always passes).
  - This is **stricter than Papertrade on purpose.** Papertrade accepts any open smaller than the room, so
    with $0.9M of room it takes a $1,000 order while a $2M buffer makes the batch wait. Lower the buffer (or
    leave it blank) to send whenever the order fits.
  - It checks only the sides the batch opens on. A batch of BTC longs checks the BTC long cap; BTC shorts
    check the BTC short cap; a batch with both checks both, and a batch with BTC and ETH opens checks
    each market.
  - Closes aren't checked (they reduce open interest), so a batch of only closes skips it.
  - It compares the room as it is now with the buffer; your own batch's size isn't subtracted (staging
    already refuses an order bigger than the room).
  - The caps are re-fetched right before the decision and every 5s while a batch waits, and data older
    than 15s counts as unknown, so it never sends on stale caps.

**Submit:** a confirmation lists every order, the total margin, the queue congestion and pending tx, the
OI room on each side it opens on, when it will send, and the guard. Cancel there and nothing is signed or
sent. On confirm:
- **If every check passes** (pending tx below the limit, enough OI room, or the checks are blank), the batch
  goes out right away.
- **Otherwise the batch waits.** Its header says why, e.g. `waiting: pending 312 ≥ 20` or
  `waiting: BTC long OI room $1.00M < $2.00M`, with a **cancel** link. It sends automatically the first
  moment every check passes. While the status feed or the caps are stale or unavailable it keeps waiting;
  it never sends blind. **Keep the tab open:** a waiting batch lives
  in the tab, and reloading drops it (nothing is sent).

When the batch is sent:
1. It's re-checked first: your available balance, every market still open, every position to close still
   open. Anything that's changed stops the batch with **not sent: reason**.
2. Every order is signed by the extension's session key, at that moment, so the one-hour deadline starts
   then. If any signature fails, **nothing is sent**.
3. All of them are sent to Papertrade at the same moment.
3. The batch appears below and is tracked live:
   - each order's **queue rank** (`#20`; 1 = next in line, refreshed every 2s);
   - **sent to chain** once it leaves the queue;
   - **filled @ price** for opens, **closed +$PnL** for closes;
   - or **expired** / **failed** / **cancelled** / **refused** with the reason.

### Execution quality

Ideally every order of a batch fills at the same mark price; the queue can spread them out. Once **every** order
of a batch has filled, the batch shows how close together they filled:

- **Fill prices:** an open fills at its entry price. A close fills at its exit price, which Papertrade only
  publishes in the trade history, so it's looked up there (the batch says "looking up the close prices…" for the
  few seconds the history takes to catch up; it gives up after two minutes).
- **Spread** = (highest fill − lowest fill) ÷ lowest fill, in basis points, compared within each market.
- **GOOD** when the spread is under **1 bp** (0.01%), otherwise **BAD**, e.g.
  `Execution GOOD · fills 0.62 bps apart · BTC 81,250 – 81,255` or
  `Execution BAD · fills 6.15 bps apart · BTC 81,250 – 81,300`. With BTC and ETH orders in one batch, each market
  is checked on its own and the widest spread decides.
- **No grade** when an order didn't fill (cancelled, refused, expired), when every order is on a different
  market (nothing to compare), or for a single order. A liquidated position isn't a fill of its close.

### The queue guard

After it's accepted, every order has its own place in Papertrade's queue. The guard keeps the batch's
orders close together **while they are all still waiting**. It only applies to batches of **2 or more
orders**; a single order is sent without it (the batch header says `single order`):
- **The spread** is the furthest-back queue rank minus the furthest-forward. The batch header shows it live,
  e.g. `spread 4 / 10`.
- **If the spread goes over your distance**, every order of the batch is cancelled. So are the rest if
  **any** order in it is refused, expires or fails, so you're never left with half a batch waiting.
- **Once any order of the batch has executed** (filled, closed, or left the queue for the chain), the guard
  **stands down for good** and never cancels the others: at that point cancelling would itself leave half a
  batch. The header shows `guard off: LONG BTC … filled; nothing cancelled`, and the rest stay in the queue.
- **Before it cancels anything**, it re-reads the queue fresh. If an order has left the queue in the
  meantime, it stands down instead. If the spread is back within the distance, it keeps watching. If the
  queue can't be read, or an order isn't listed yet, it cancels nothing and checks again on the next poll.
- It only judges once every queued order has a rank, so it doesn't misfire in the first seconds.

Example, distance 10, a long and a short:
- **#20 and #30:** spread 10, fine.
- **#20 and #31:** spread 11, so both are cancelled.
- **The long fills (or goes to chain) while the short is still at #15:** the guard stands down; the short
  stays queued.

**Pending tx vs. queue distance:** they protect different things.
- **Pending tx** decides *when* the batch goes out: only into a quiet queue, where orders are less likely to
  be split up.
- **Queue distance** watches the batch *after* it's in: if its orders drift apart anyway, it cancels what's
  still queued.

**Limits:**
- **It can only cancel orders still queued.** One that has already been sent to chain or filled can't be
  pulled back; the batch says so if a cancel comes too late.
- **Cancelling is signed by the session key**, and Papertrade won't accept it within about an hour of the
  key's expiry. So with the guard on, the extension refuses to submit if the key expires within 2 hours.
  Replace it first.
- **The guard runs in this tab.** If you close or reload it, tracking and the guard stop. Orders that were
  sent stay in Papertrade's queue as normal.
- **Ranks move as the queue moves.** Papertrade fills larger orders first, so new big orders can slip in
  between yours. Pick a distance with some room for that, and watch congestion.
- **Cancelling a queued order is free**, and so is an order that expires unfilled.

## Hyperliquid positions (full screen)

The **Positions** tab has two sections: **Papertrade** (your positions there, Close All, Roll, and the pending
queue) and, under it, **Hyperliquid**: your open **perp positions on Hyperliquid**, for the main account and every
subaccount. It's **read-only**: nothing is signed, and it uses only Hyperliquid's
public info API.

- **Which account:** the connected wallet by default; Hyperliquid uses the same address. Type another master
  address in the bar to watch that one instead (it's remembered; clear it to go back to the wallet).
- **Positions:** account (main or the subaccount's name), market and side, leverage (cross or isolated), size,
  notional, entry, mark, unrealized PnL with ROE, liquidation price, margin, and funding received since open
  (negative means paid). Largest first. **Net exposure** rows at the bottom add each coin up across all accounts.
- **Open orders**, with a **Papertrade match** for each. The idea: every Papertrade position has a resting
  Hyperliquid order in the **same direction at its bust price**, so if Papertrade liquidates the position the order
  fills and you stay delta neutral.
  - An order matches a Papertrade position when it's the same coin, the same direction (a buy for a long, a sell
    for a short), and its price is within **±$1** of the position's bust price (for a trigger order, the trigger
    price). Closest pairs are matched first, one order per position.
  - A matched order shows **✓ #id LONG/SHORT**, the bust price, the gap (Δ), and whether its size equals the
    position's size in coins (within 1%; otherwise the percentage it covers).
  - An unmatched order says **no matching position**, with the nearest bust in the same coin and direction.
  - The heading says how many Papertrade positions are covered and lists the ones with **no order at their bust**.
  - Orders are read for the main account and every subaccount that holds money or positions.
- **Hedge warnings** (re-checked every second against your current Papertrade positions):
  - **A badge in the top bar**, on every tab: **✓ 4 of 4 hedged**, or in red **⚠ 1 unhedged · 1 stray HL order**.
    Click it to jump to the Hyperliquid orders. It says "checking…" until Hyperliquid's orders have loaded, and
    "Hyperliquid unavailable" if they can't be read, so it never claims you're hedged without data.
  - **Unhedged:** a Papertrade position with no matching Hyperliquid order. Its row shows **no HL hedge** under the
    bust price (hedged rows show **HL hedge ✓**).
  - **Stray:** a Hyperliquid order that matches no Papertrade position, e.g. left behind after you closed one. If
    price reaches it, it would open a position you no longer need. Stray rows are tinted in the orders table.
  - The Positions tab's count gets a ⚠ while anything is unhedged or stray.
- **Accounts:** account value, margin used, notional and withdrawable for the main account and every subaccount
  with money or positions; empty subaccounts are counted, not listed.
- It refreshes every 10 seconds while full screen is open: `clearinghouseState` for the main account,
  `subAccounts` for the rest, and `frontendOpenOrders` for each account that holds money or positions. The section's
  heading says how many positions are open.

## Payoff (full screen)

The **Payoff** tab charts the PnL of **every position in one market, Papertrade and Hyperliquid together**, if the
price moved to each level in a range right now.

- **Papertrade** positions are valued the way Papertrade pays out: a linear loss up to the bust price; past the bust
  the position is liquidated and the whole margin is lost; gains after the carve-out, the impact haircut and the
  2% win fee.
- **Hyperliquid** positions are linear: size × (price − entry). Their liquidation prices are dotted red lines.
- **Resting Hyperliquid orders** (on by default; untick to compare) count as filled when the move passes their
  price, and are linear from there. That's how your bust-price hedges take over from liquidated Papertrade positions.
- **Lines:** Total (solid), Papertrade (dashed), Hyperliquid (dotted), over green / red shading for profit and loss.
  Red markers along the bottom are Papertrade bust prices; green ones along the top are Hyperliquid orders.
- **Above the chart:** PnL now, **net delta** (in coins and dollars per 1% move), and the worst and best PnL in the
  range with the price where each happens. Hover the chart for the PnL at any price, split by venue.
- **Controls:** BTC or ETH, and the range (±5%, ±10%, ±20%, ±30%). It redraws every 2 seconds.

It's an instant-move picture: it doesn't model time, funding, or Hyperliquid's cross-margin liquidation beyond
marking the price.

## Roll (full screen)

**Roll** is an automatic loss reset for a single position. When a position's **PnL if closed now** falls to your
threshold, Roll closes it and opens the same position again (same market, side, margin and leverage). That realizes
the loss, which mints PAPER for it, and the new position starts again from a PnL of zero. Then it keeps watching the
new position.

**The trigger is per position:** a loss in dollars, typed when you press **Roll** on that row (e.g. `50` means roll
when its PnL if closed now reaches −$50). The box is pre-filled with your last amount. It never acts on a position in
profit.

**Roll checks** (the bar above the positions table, remembered, shared by every roll): **queue distance**,
**pending tx below** and **OI room above** (millions of USD), the same checks as batch orders, applied to each roll's
batch. Leave one blank to turn it off. Editing them updates every armed roll; a batch already sent keeps its checks.

**Using it:**
- Each row in the table has **Close** and **Roll**. Roll only shows while the session key is active.
- **Roll** explains what it will do and asks for the dollar amount. OK starts it. After that, every roll is signed
  by the session key with no further prompt.
- An armed row shows **at −$50** (with the number of rolls so far, e.g. `· 2×`) and **stop roll**. Click
  **at −$50** to change that position's amount. The amount carries over to the replacement position.

**What happens when it triggers:**
1. The PnL has to stay at or below the threshold for **2 seconds**, on Hyperliquid prices no more than 5 seconds old.
2. It sends a **2-order batch**, labelled `Roll #id` in the batch list: close the position, and open the same one.
   The queue-distance guard, pending-tx gate and OI check work exactly as for batches you submit yourself.
3. While the batch waits on a gate, it's re-checked. If the PnL recovers above the threshold, or the position
   closes, the batch is withdrawn and nothing is sent.
4. When both orders fill, the roll moves to the new position and keeps watching it.

**When it doesn't go to plan:**
- **The close fills but the reopen fails:** the roll stops (you're left with no position).
- **The reopen fills but the close doesn't** (for example, it was refused after the reopen had already
  executed): the roll stops and says so, because you now hold both positions.
- **Both fail, or the batch isn't sent:** the roll stays armed and tries again 30 seconds later.
- **The position closes some other way** (by hand, or liquidated): the roll stops.

**Limits:**
- **You need the new position's margin available** when it triggers. Both orders go out at once, so the old
  position's margin hasn't come back yet. If it isn't there, the roll waits and says how much it needs.
- **Each roll reopens at the price of the moment.** The new position's PnL starts with the usual small entry cost.
  A later recovery is a fresh win on the new position, so it pays the normal 2% win fee and haircut.
- **It only runs while this full-screen tab is open.** Closing or reloading the tab stops every roll; nothing runs
  in the background.

## PAPER staking

PAPER staking lives in **full screen**, as a strip of cells between the top bar and the equity cards. It isn't
shown on the normal Papertrade page.

**Protocol figures** (from `/query/protocol/summary`, refreshed every minute; no wallet needed):
- **Total supply** of PAPER, and **total staked** with its share of the supply. Hover a figure for the exact amount.
- **Staker rewards**: USDC paid to stakers since launch (`fees.lifetime`).

**Your PAPER** (once your wallet is connected; the strip has its own **Connect wallet** button):
- **In your wallet**, and **your stake** with your share of everything staked (plus any stake still queued).

**Stake all** (beside **In your wallet**):
- Stakes your whole wallet balance, exact to the last decimal (minus any stake already in the queue). There's no
  amount to type. It's off when there's nothing to stake, when the balance is under Papertrade's minimum stake
  (currently **1,000 PAPER**, and it says so), or when Papertrade has paused staking.
- Rabby opens a `Stake` request with `user` = your address and `amount` in 18-decimal units (3,492.19 PAPER =
  `3492186503347517471804`). It shows **Submitted (queued)**, then **Staked 3,492.19 PAPER** once it executes (or
  why it didn't).

**Claim rewards:**
- **Rewards (USDC)** is what you can claim now: `pendingBase + staked × accRewardPerShare / 1e27 − rewardDebt`.
- **Claim** asks Rabby to sign a `Claim` request (`user`, `nonce`, `deadline`; there's no amount: it claims
  everything owed when Papertrade executes it). The button is off when there's nothing to claim, a claim is already
  in the queue, or Papertrade has paused claiming.

**How they're signed:** stakes and claims are signed by **your wallet**, not the session key, on the
`PaperStaking` domain (version `1`, chain 999, contract `0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016`). Check the
request in Rabby and confirm on your Ledger; the extension checks the signature came from your wallet before
sending it. They use their own nonce counter, separate from trading. Unstaking is done on Papertrade.

## Full screen

Click **⤢** in the panel's header to open a full dashboard in a new tab. It is a Papertrade tab
(`exchange.papertrade.xyz/trade/btc#papertrade-full`) that the overlay covers completely, so everything the
overlay can do works there too: the live socket, your account, Rabby, and sending orders. **Back to
overlay** (top right) turns that tab back into a normal Papertrade tab. The extension remembers which tabs are
full screen, so reloading keeps the mode.

What it shows:
- **Top bar:** congestion, pending tx, avg tx/block, time to clear, latest block; your wallet; and the
  **session key**: its status and expiry, with **Replace…** / **Remove** (or **Create session key** /
  **Connect wallet** when needed). Messages from the wallet flow appear there too.
- **Cards:**
  - equity;
  - open PnL;
  - close cost on winners;
  - available;
  - margin in use;
  - open notional;
  - number of positions;
  - lifetime realized PnL.
- **Positions | History tabs**, laid out like the tab strip under Papertrade's trade page. The tab you pick
  is remembered for that browser tab.
- **Positions tab: open positions**
  - ID, market, side;
  - **leverage**, **size** in the asset's units (notional ÷ entry, e.g. `1.2312` BTC) and **notional**, each in
    its own column (hover the notional for the margin);
  - entry;
  - the live **mark price** (Hyperliquid best bid/ask midpoint, the price Papertrade settles at), with the
    move since entry signed for the side (green = in the position's favour);
  - **PnL if closed now** (after Papertrade's haircut and the 2% win fee, with % of margin);
  - **close cost** (haircut + fee, with % of the raw gain);
  - bust price;
  - risk (how far price has moved toward bust);
  - how long it's been open.

  **Net exposure** rows close the table, one per market: the net size (in the asset) and net notional
  (long − short, margin × leverage) under the Size and Notional columns, tagged NET LONG / NET SHORT, with the
  long and short totals beside them (e.g. `BTC NET LONG +1.3638 +$100,000 · long $400,000 · short $300,000`).

  Each row has a **Close** button that adds the close to the batch in the right-hand column, and a **Roll**
  button (see [Roll](#roll-full-screen)). **Close All**
  (in the tab bar) adds every open position's close; nothing is sent until you submit the batch.
- **Positions tab: pending queue** (under the positions): every queued intent on your account (opens, closes and others) with its place in line
  and how long it's waited.
- **History tab:** closed and liquidated positions, newest first:
  - ID, market, side, then leverage, size (asset units, notional ÷ entry) and notional in their own columns;
  - **entry → exit** and the **move %**;
  - **net PnL** and the fee paid;
  - PAPER minted;
  - how long it was held, when it closed, and the outcome.

  25 trades per page. **‹ Prev** / **Next ›** step through them, and Next fetches older trades from
  Papertrade (75 at a time) when you reach the end of what's loaded. Newly closed trades are added at the top
  without losing your place.
- **PAPER staking strip** (under the top bar): supply, total staked, your wallet and stake, Stake and Claim.
- **House fund strip** (under that), from `/state/house/current`, refreshed every 5 seconds, as Papertrade's
  House page shows them:
  - **House funds** = LP balance + open house PnL − queue debt;
  - **LP balance**: the house bankroll (free LP plus the payout reserve);
  - **Open house PnL**: the inverse of traders' combined open PnL (green when the house is up);
  - **Queue debt**: USDC owed to winners still waiting in the queue (amber when it isn't zero);
  - **Staker tier**, under LP balance: the share of realized trader losses going to stakers, worked out like
    Papertrade's staking page from LP + reserve − queue against the staker reward threshold (`paper.cap`, $5M
    now): 0% below $0, 1% (the fee share) up to the threshold, 99% at or above it (the fee plus 98% LP excess).
    It shows how far the LP is from the threshold, or how far past it. Open PnL doesn't count, so House funds can
    be over the threshold while the tier is still 1%;
  - **Net take rate**: how much of every $1 traders lose reaches stakers, as total staker rewards ÷ gross trader
    losses (about 21.1¢ on 2026-10-22). Gross losses aren't published, so they're estimated from the PAPER
    minted: up to the 2026-10-21 upgrade, the old curve's ratchet progress plus the supply minted at the early flat
    rate; since then, from supply growth under the new mint rule (about 0.11% of supply per $1M lost). Hover for
    the figures;
  - **Net open interest**: long − short notional, total and per market (BTC, ETH); the house carries the
    opposite side. Hover for the long and short totals.

  The strip's title says **live**, or **stale** with the age if updates stop.
- **Right column:** the order builder, batches and guards. The queue status box and the session key aren't
  repeated there, since the top bar shows both.

PnL here uses Papertrade's exact valuation (deadband, carve-out on small wins, impact haircut, win fee), checked
identical to the web app's own code on 120,000 random positions. It follows the exchange implementation and
off-hours flag Papertrade reports: the **PnL** header says *off-hours* when the stronger carve-out is in force, and
its tooltip spells out the rules. Under the new implementation a mark at or through the bust counts as a full loss. It matches what Papertrade's own
positions table shows. On a narrow window the dashboard stacks into one column.

## Install

1. Build it: `npm install`, then `npm run build`. This writes the extension to `dist/`.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dist` folder.
4. Open or reload https://exchange.papertrade.xyz. The panel appears bottom-left.

The manifest pins the extension's ID (`edjloodgopjlgmgclejehgemfmmklcko`) with a `key`, so it stays the same
wherever the folder lives. Its storage (panel position, encrypted session key) is kept under that ID.

If you rebuild or move the folder, load the new `dist/` and the extension keeps its data; only a build with a
different `key` in the manifest would start fresh (then create a new session key from the panel).

## Development

```
npm run dev        # rebuild dist/ on every change
npm run check      # typecheck, syntax-check the plain scripts, build
npm run zip        # build + paperbox.zip
```

After a rebuild, click the reload icon on the extension's card, then reload the Papertrade tab. Until you do, Chrome
keeps that tab's old copy of Paperbox cut off from the extension. The panel says so and offers **Reload this page**,
and orders fail with that message instead of "Extension context invalidated".

```
manifest.json         the extension manifest (copied to dist/)
src/content.js        the overlay and full-screen dashboard, session-key flow, batches, guards (plain JS)
src/bridge.js         runs in the page's own context to reach the wallet (plain JS)
src/background.ts     service worker: session key, signing (bundled with viem)
src/intents.ts        EIP-712 types, wire encoding and intent ids, matching Papertrade's web app
scripts/build.mjs     the build
docs/PAPERTRADE_API.md  how Papertrade's API works (endpoints, socket, valuation, signing)
```

## How it works

- `content.js` runs only on `https://exchange.papertrade.xyz/*`. It's plain JavaScript with no dependencies;
  the build only copies it.
- It subscribes to Papertrade's realtime socket (`wss://stream.papertrade.xyz`, channel `pressure:current`),
  the same feed the site's Status tab uses. The status part only reads; the session-key section sends one
  thing, the registration you sign.
- **The connection has to come from the content script.** Papertrade's socket only accepts connections from
  its own site (`Origin: https://exchange.papertrade.xyz`). A content script connects as the page, so it works;
  a background service worker would connect as `chrome-extension://…` and be refused.
- The overlay lives in a Shadow DOM, so the site's styles and the overlay's can't interfere.
- **It uses Papertrade's own theme.** Its colours come from the site's design tokens (`--pt-panel`,
  `--pt-ink`, `--pt-border`, `--pt-pos`, `--pt-neg`, …), which reach inside the Shadow DOM. So it matches the
  site's light ("paper") or dark ("night") theme, in Inter, and switches the moment you change the site's
  theme. If Papertrade ever drops those tokens, it falls back to its own dark palette.
- The only permission is `storage`, for the panel's position and the encrypted session key.
- **Files:**
  - `content.js`: the overlay and the full-screen dashboard, the session-key flow, the batch builder, order
    tracking and the queue guard.
  - `bridge.js`: runs in the page's own context (`"world": "MAIN"`), the only place Rabby is reachable. It
    only reports the connected account, switches to HyperEVM, and requests `eth_signTypedData_v4`.
  - `background.js` (built from `src/background.ts` and `src/intents.ts`): creates and stores the key, builds the message, checks your
    signature, and signs opens, closes and cancels (re-checking every field). It also opens full-screen tabs
    and remembers which tabs are full screen. It only answers this extension's own content script on
    Papertrade.
- The signed registration is sent from the content script, so Papertrade sees the same origin as its own app.
  Papertrade's read endpoints and socket refuse `chrome-extension://` origins, and sending from the page
  avoids finding out whether `/intents` does too.

The formulas and the socket protocol are documented in [`docs/PAPERTRADE_API.md`](docs/PAPERTRADE_API.md)
(§8).

**History:** this started in an earlier project that also had a local web dashboard, a terminal positions
viewer, the PAPER MILL trading bot and a Hyperliquid prices extension. Only the extension was carried over.

## Ideas for next

- Order fills by size (what size gets filled fastest right now), from the public trade feed.
- A warning near Papertrade's order button when congestion is HIGH.

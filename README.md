# Paperbox

A Chrome extension for [Papertrade](https://exchange.papertrade.xyz) (high-leverage perps on HyperEVM, priced at
the Hyperliquid order-book mid).

A small floating panel on **exchange.papertrade.xyz** that shows how backed up Papertrade's order queue is,
so you can check before sending an order. It can also create a **session key** for this extension, which
your wallet (e.g. Rabby with a Ledger) authorizes with one signature, and **open positions** with that key.
A separate **PAPER widget** shows PAPER's total supply and lets you stake PAPER and claim rewards (see
[PAPER widget](#paper-widget)).

It shows the same numbers as the **Status** tab on Papertrade's trade page, without having to switch tabs:

| | Meaning |
|---|---|
| **Congestion** | LOW / MEDIUM / HIGH: how many blocks the queued + submitted orders need to clear (≤ 1, ≤ 5, more) |
| **Time to clear** | About one second per block needed (at least ~3s while anything is pending) |
| **Pending tx** | Orders waiting for the relayer right now (hover for submitted vs. waiting for a batch) |
| **Avg tx / block** | Transactions per recent HyperEVM block |
| **Sparkline** | Pending orders over the last 5 minutes, with the change over the last minute. ↑ in amber means the queue is growing. |

Collapse it to a one-line pill (e.g. `● HIGH · 1,205 pending · ~2.2m`) with **–**. Click the pill to expand
it. Drag either one anywhere. Position and collapsed state are remembered.

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

## PAPER widget

PAPER has its own floating widget, separate from the queue panel. It starts as a pill to the right of the
panel (e.g. `PAPER · staked 756.8K · $3.41`); click it to open, drag the pill or the header to move it, and **–**
to collapse it again. Its position is remembered separately. In full screen it sits in the right-hand column under
the panel.

**Protocol figures** (from `/query/protocol/summary`, refreshed every minute; no wallet needed):
- **Total supply** of PAPER, and **total staked** with its share of the supply. Hover a figure for the exact amount.

**Your PAPER** (once your wallet is connected; the widget has its own **Connect wallet** button):
- **In your wallet**, and **your stake** with your share of everything staked (plus any stake still queued).

**Stake:**
- Type an amount, or press **Max** for your whole wallet balance (exact to the last decimal), then **Stake**.
  It checks the amount first: at least Papertrade's minimum stake (currently **1,000 PAPER**), and no more than
  your wallet balance minus stakes already in the queue. It also checks that Papertrade hasn't paused staking.
- Rabby opens a `Stake` request with `user` = your address and `amount` in 18-decimal units (1,500 PAPER =
  `1500000000000000000000`). It shows **Submitted (queued)**, then **Staked 1,500 PAPER** once it executes (or why
  it didn't).

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
- **Top bar:** congestion, pending tx, avg tx/block, time to clear, latest block; your wallet and session key.
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

  Each row has a **Close** button that adds the close to the batch in the right-hand column. **Close All**
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
- **Right column:** the same session key, order builder, batches and queue guard as the overlay.

PnL here uses Papertrade's exact valuation (deadband, impact haircut, win fee), checked identical to Papertrade's
own formula on 8,000 random positions. It matches what Papertrade's own
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

After a rebuild, click the reload icon on the extension's card, then reload the Papertrade tab.

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

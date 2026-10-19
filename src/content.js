// Paperbox: a floating panel on exchange.papertrade.xyz showing how backed up the
// order queue is, so you can check before sending an order.
//
// Data: Papertrade's relayer publishes queue/chain "pressure" on its realtime socket
// (wss://stream.papertrade.xyz, Centrifugo, channel `pressure:current`) several times a second. The
// numbers are computed exactly as the Status tab on Papertrade's trade page does (see
// docs/PAPERTRADE_API.md §8.1 in this repo). Read-only: nothing is sent except the subscription.
(() => {
  if (window.__papertradeStatusOverlay) return; // guard against double injection
  window.__papertradeStatusOverlay = true;

  const STREAM_WS = 'wss://stream.papertrade.xyz/connection/websocket';
  const CHANNEL = 'pressure:current';
  const STALE_MS = 5_000; // the web app treats a snapshot older than this as unavailable
  const SOCKET_SILENT_MS = 45_000; // server pings every 20s
  const DATA_SILENT_MS = 15_000; // pressure publishes several times a second
  const HISTORY_MS = 5 * 60_000; // sparkline window
  const HIDDEN_DISCONNECT_MS = 30_000; // close the socket when the tab has been in the background this long
  const STORE_KEY = 'papertradeStatusOverlay';

  // ---- Status math (same as the trade page's Status tab) ----
  function computeStatus(s, now = Date.now()) {
    const live = !!s && s.ok && !s.stale && now - s.ts < STALE_MS;
    const blocks = s?.chain?.blocks ?? [];
    let needed = null;
    if (live) {
      const limit = BigInt(s.blockGasLimit);
      const gas = BigInt(s.totalSubmittedGas) + BigInt(s.totalQueuedGas);
      needed = limit > 0n ? Number(gas === 0n ? 0n : (gas + limit - 1n) / limit) : null;
    }
    return {
      live,
      ts: s?.ts ?? null,
      congestion: needed === null ? null : needed <= 1 ? 'LOW' : needed <= 5 ? 'MEDIUM' : 'HIGH',
      neededBlocks: needed,
      pending: live ? s.pendingCount : null,
      submitted: live ? s.submittedIntents : null,
      queued: live ? s.queuedIntents : null,
      avgTx: live && blocks.length ? blocks.reduce((a, b) => a + b.transactionCount, 0) / blocks.length : null,
      clearS: needed === null ? null : s.pendingCount ? Math.max(3, needed) : 0, // ~1 block per second
      block: blocks.length ? blocks[blocks.length - 1].number : null,
    };
  }

  // ---- Centrifugo subscription that recovers from silent drops ----
  // A socket can die without firing `close`, and the server can drop a subscription while still
  // pinging, so restart on errors, unsubscribe/disconnect pushes, and silence.
  function watchPressure(onSnapshot, onState) {
    let ws = null, retry, attempt = 0, lastFrame = 0, lastData = 0, stopped = false;
    const restart = (why) => {
      if (stopped) return;
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} }
      ws = null;
      clearTimeout(retry);
      onState('reconnecting', why);
      retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };
    const watchdog = setInterval(() => {
      if (!ws) return;
      if (Date.now() - lastFrame > SOCKET_SILENT_MS) restart('socket silent');
      else if (Date.now() - lastData > DATA_SILENT_MS) restart('no data');
    }, 5_000);
    function connect() {
      if (stopped) return;
      lastFrame = lastData = Date.now();
      onState('connecting');
      let sock;
      try { sock = new WebSocket(STREAM_WS); } catch (e) { return restart(String(e)); }
      ws = sock;
      sock.onopen = () => {
        sock.send(JSON.stringify({ id: 1, connect: { name: 'js' } }));
        sock.send(JSON.stringify({ id: 2, subscribe: { channel: CHANNEL } }));
      };
      sock.onmessage = (e) => {
        if (ws !== sock) return;
        lastFrame = Date.now();
        for (const line of String(e.data).split('\n')) {
          if (!line) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (Object.keys(m).length === 0) sock.send('{}'); // ping → pong
          else if (m.error || m.push?.disconnect || (m.push?.channel === CHANNEL && m.push.unsubscribe)) return restart('server dropped us');
          else if (m.id === 2) for (const p of m.subscribe?.publications ?? []) deliver(p.data);
          else if (m.push?.channel === CHANNEL && m.push.pub) deliver(m.push.pub.data);
        }
      };
      sock.onclose = sock.onerror = () => { if (ws === sock) restart('socket closed'); };
    }
    function deliver(data) {
      if (!data?.snapshot) return;
      lastData = Date.now();
      attempt = 0;
      onState('live');
      onSnapshot(data.snapshot);
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} }
      ws = null;
    };
  }

  // ---- Settings (position, collapsed) ----
  const storage = {
    async get() {
      try {
        if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] ?? {};
        return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
      } catch { return {}; }
    },
    set(v) {
      try {
        if (globalThis.chrome?.storage?.local) chrome.storage.local.set({ [STORE_KEY]: v });
        else localStorage.setItem(STORE_KEY, JSON.stringify(v));
      } catch { /* not critical */ }
    },
  };

  // ---- UI ----
  // Full-screen dashboard state (see "Full-screen mode" below); declared first because layout code reads it.
  const full = { on: false, marks: {}, winFeeRaw: null, history: [], histFor: null, cursor: null, historyStale: true, historyLoading: false, ranks: {}, tab: 'positions', page: 0 };
  const HIST_PAGE = 25;
  try { if (sessionStorage.getItem('pt-full-tab') === 'history') full.tab = 'history'; } catch { /* storage blocked: default tab */ }
  const host = document.createElement('div');
  host.id = 'papertrade-status-overlay';
  host.style.cssText = 'position:fixed;z-index:2147483646;left:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host {
    all: initial;
    /* Papertrade's design tokens follow its light/dark theme (html[data-theme]); custom properties cross the
       shadow boundary, so the overlay matches the site and switches with it. Fallbacks = standalone dark. */
    --o-page: var(--pt-page, var(--o-raised));
    --o-panel: var(--pt-panel, var(--o-panel));
    --o-raised: var(--pt-panel-raised, #171a1f);
    --o-sunken: var(--pt-panel-sunken, var(--o-raised));
    --o-ink: var(--pt-ink, var(--o-ink));
    --o-muted: var(--pt-ink-muted, var(--o-muted));
    --o-faint: var(--pt-ink-faint, var(--o-faint));
    --o-border: var(--pt-border, var(--o-border));
    --o-pos: var(--pt-pos, var(--o-pos));
    --o-neg: var(--pt-neg, var(--o-neg));
    --o-warn: var(--pt-chart-warning, var(--o-warn));
    --o-chart: var(--pt-chart-accent, var(--o-chart));
    --o-primary: var(--pt-ink, #2563eb);
    --o-on-primary: var(--pt-on-ink, #ffffff);
    --o-shadow: var(--pt-popover-shadow, 0 8px 24px rgba(0,0,0,.35));
    --o-font: var(--font-ui, Inter, ui-sans-serif, system-ui, -apple-system, sans-serif);
    --o-radius: var(--pt-radius, 8px);
  }
  *, *::before, *::after { box-sizing: border-box !important; }
  [hidden] { display: none !important; }
  .wrap { font: 12px/1.4 var(--o-font); color: var(--o-ink); -webkit-font-smoothing: antialiased; }
  .pill, .panel { background: var(--o-panel); border: 1px solid var(--o-border); border-radius: var(--o-radius);
    box-shadow: var(--o-shadow);  }
  .pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: grab; user-select: none;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pill:active { cursor: grabbing; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--o-faint); flex: none; }
  .panel { width: 304px; max-width: calc(100vw - 32px); max-height: calc(100vh - 16px); overflow: hidden auto; }
  .head { position: sticky; top: 0; z-index: 1; background: var(--o-panel); }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--o-border); cursor: grab; user-select: none; }
  .head:active { cursor: grabbing; }
  .title { font-weight: 600; font-size: 12px; flex: 1; }
  .btn { all: unset; cursor: pointer; color: var(--o-muted); padding: 0 4px; font-size: 14px; line-height: 1; }
  .btn:hover { color: var(--o-ink); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1px; background: var(--o-border); }
  .cell { background: var(--o-panel); padding: 8px 12px; }
  .lbl { display: block; color: var(--o-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .level { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .05em; padding: 1px 7px; border-radius: 4px; }
  .LOW { color: var(--o-pos); background: color-mix(in srgb, var(--o-pos) 14%, transparent); }
  .MEDIUM { color: var(--o-warn); background: color-mix(in srgb, var(--o-warn) 14%, transparent); }
  .HIGH { color: var(--o-neg); background: color-mix(in srgb, var(--o-neg) 14%, transparent); }
  .dot.LOW { background: var(--o-pos); } .dot.MEDIUM { background: var(--o-warn); } .dot.HIGH { background: var(--o-neg); }
  .spark { padding: 8px 12px 4px; border-top: 1px solid var(--o-border); }
  .spark svg { display: block; width: 100%; height: 40px; }
  .spark .area { fill: var(--o-chart); opacity: .16; } .spark .line { fill: none; stroke: var(--o-chart); stroke-width: 1.5; }
  .trend { display: flex; justify-content: space-between; color: var(--o-muted); font-size: 11px; }
  .foot { padding: 6px 12px 8px; color: var(--o-muted); font-size: 11px; display: flex; justify-content: space-between; gap: 8px; }
  .warn { color: var(--o-warn); }
  .ok { color: var(--o-pos); }
  .bad { color: var(--o-neg); }
  .session { padding: 8px 12px; border-top: 1px solid var(--o-border); display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
  .small { font-size: 11px; color: var(--o-muted); overflow-wrap: anywhere; }
  .small.ok { color: var(--o-pos); } .small.bad { color: var(--o-neg); } .small.warn { color: var(--o-warn); }
  .actions { display: flex; gap: 8px; align-items: center; }
  .action { all: unset; cursor: pointer; background: var(--o-primary); color: var(--o-on-primary); font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 4px; }
  .action:hover { opacity: .88; }
  .action[disabled] { opacity: .5; cursor: default; }
  .link { all: unset; cursor: pointer; color: var(--o-muted); font-size: 11px; text-decoration: underline; }
  .link:hover { color: var(--o-ink); }
  .order { padding: 8px 12px 10px; border-top: 1px solid var(--o-border); display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .seg2 { display: inline-flex; border: 1px solid var(--o-border); border-radius: 4px; overflow: hidden; }
  .seg2 button { all: unset; cursor: pointer; padding: 3px 12px; font-size: 12px; color: var(--o-muted); }
  .seg2 button.on { background: color-mix(in srgb, var(--o-ink) 10%, transparent); color: var(--o-ink); }
  .fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .field { display: grid; gap: 3px; }
  .field input { all: unset; box-sizing: border-box; width: 100%; min-width: 0; background: var(--o-raised); border: 1px solid var(--o-border); border-radius: 4px;
    padding: 5px 8px; font: 600 13px var(--o-font); font-variant-numeric: tabular-nums; color: var(--o-ink); }
  .field input:focus { border-color: var(--o-chart); }
  .stake { padding: 8px 12px 10px; border-top: 1px solid var(--o-border); display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .stake[hidden] { display: none; }
  .stakerow { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .stakerow input { all: unset; box-sizing: border-box; flex: 1 1 0; width: 0; min-width: 0; background: var(--o-raised); border: 1px solid var(--o-border); border-radius: 4px;
    padding: 5px 8px; font: 600 13px var(--o-font); font-variant-numeric: tabular-nums; color: var(--o-ink); }
  .stakerow input:focus { border-color: var(--o-chart); }
  .stakerow .action:disabled { opacity: .45; cursor: default; }
  .sides { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .side { all: unset; text-align: center; cursor: pointer; padding: 7px 0; border-radius: 4px; font-weight: 700; font-size: 13px; color: var(--o-raised); }
  .side.long { background: var(--o-pos); } .side.long:hover { background: color-mix(in srgb, var(--o-pos) 85%, black); }
  .side.short { background: var(--o-neg); } .side.short:hover { background: color-mix(in srgb, var(--o-neg) 85%, black); }
  .side[disabled] { opacity: .4; cursor: default; }
  .orders { display: grid; gap: 3px; }
  /* Batch tracking: each batch is a block of rows; each row is "what" on the left, "status" on the right. */
  .orders { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .batch > div { font-size: 11px; color: var(--o-muted); font-variant-numeric: tabular-nums; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
  .batch > div > span:first-child, .staged div > span { min-width: 0; overflow-wrap: break-word; }
  .batch > div > span:last-child { flex: none; max-width: 55%; text-align: right; }
  .adds { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .add { all: unset; text-align: center; cursor: pointer; padding: 5px 0; border-radius: 4px; font-weight: 700; font-size: 12px; border: 1px solid; }
  .add.long { color: var(--o-pos); background: color-mix(in srgb, var(--o-pos) 12%, transparent); border-color: transparent; } .add.long:hover { background: color-mix(in srgb, var(--o-pos) 20%, transparent); }
  .add.short { color: var(--o-neg); background: color-mix(in srgb, var(--o-neg) 12%, transparent); border-color: transparent; } .add.short:hover { background: color-mix(in srgb, var(--o-neg) 20%, transparent); }
  .add.close { color: var(--o-ink); border-color: var(--o-border); padding: 5px 10px; flex: none; } .add.close:hover { background: color-mix(in srgb, var(--o-ink) 10%, transparent); }
  .add[disabled] { opacity: .4; cursor: default; background: none; }
  .closerow { display: flex; gap: 8px; min-width: 0; }
  .closerow select { all: unset; flex: 1 1 0; min-width: 0; width: 0; box-sizing: border-box; background: var(--o-raised); border: 1px solid var(--o-border); border-radius: 4px;
    padding: 5px 8px; font-size: 11px; color: var(--o-ink); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .staged { display: grid; gap: 2px; }
  .staged div { display: flex; justify-content: space-between; align-items: center; gap: 6px; min-width: 0; font-size: 12px; font-variant-numeric: tabular-nums; padding: 3px 0; border-bottom: 1px dashed var(--o-border); }
  .staged .x { all: unset; cursor: pointer; color: var(--o-faint); padding: 0 4px; } .staged .x:hover { color: var(--o-neg); }
  .guard { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--o-muted); }
  .guard input { all: unset; box-sizing: border-box; width: 56px; background: var(--o-raised); border: 1px solid var(--o-border); border-radius: 4px; padding: 3px 6px;
    font: 600 12px var(--o-font); font-variant-numeric: tabular-nums; color: var(--o-ink); text-align: right; }
  .submit { all: unset; text-align: center; cursor: pointer; padding: 7px 0; border-radius: 4px; font-weight: 700; font-size: 13px; background: var(--o-primary); color: var(--o-on-primary); }
  .submit:hover { opacity: .88; } .submit[disabled] { cursor: default; background: var(--o-sunken); color: var(--o-faint); }
  .batch { border-top: 1px solid var(--o-border); padding-top: 6px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .batch > .bhead { color: var(--o-ink); }

  /* ---- Full-screen dashboard (a Papertrade tab opened with ⤢) ---- */
  .full { position: fixed; inset: 0; background: var(--o-page); color: var(--o-ink); display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); overflow: hidden;
    font: 13px/1.45 var(--o-font); }
  .ftop { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--o-border); flex-wrap: wrap; }
  .ftitle { font-weight: 700; font-size: 15px; }
  .fnet { display: flex; gap: 14px; flex-wrap: wrap; font-variant-numeric: tabular-nums; color: var(--o-muted); }
  .fnet b { color: var(--o-ink); font-weight: 600; }
  .fspacer { flex: 1; }
  .fcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--o-border); border-bottom: 1px solid var(--o-border); }
  .fcard { background: var(--o-panel); padding: 10px 20px; }
  .fcard dt { color: var(--o-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .fcard dd { margin: 2px 0 0; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .fexpo { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 24px; padding: 9px 20px; background: var(--o-panel); border-bottom: 1px solid var(--o-border); font-variant-numeric: tabular-nums; }
  .fexpo[hidden] { display: none; }
  .fexpo-label { color: var(--o-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .fexpo-item { display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .fexpo-net { font-size: 15px; font-weight: 600; }
  .fexpo .tag { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; }
  .fbody { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; grid-row: 4; } /* row 3 is the exposure strip (may be hidden) */
  @media (max-width: 1300px) { .fbody { grid-template-columns: minmax(0, 1fr) 304px; } .fmain { padding: 16px 14px 40px; } .fmain .ftable th, .fmain .ftable td { padding: 7px 6px; } }
  .fmain { overflow: auto; padding: 16px 20px 40px; display: grid; grid-auto-rows: max-content; gap: 16px; align-content: start; min-width: 0; }
  .faside { border-left: 1px solid var(--o-border); overflow: auto; min-height: 0; }
  .faside .panel { width: 100%; max-width: none; max-height: none; border: 0; border-radius: 0; box-shadow: none; backdrop-filter: none; background: var(--o-panel); }
  .faside .head { display: none; }
  .fpanel { background: var(--o-panel); border: 1px solid var(--o-border); border-radius: 10px; overflow: hidden; }
  .fph { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--o-border); }
  .fph h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .fscroll { overflow-x: auto; }
  .ftable { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
  .ftable th { color: var(--o-muted); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--o-border); white-space: normal; vertical-align: bottom; line-height: 1.3; }
  .ftable td { padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--o-border) 60%, transparent); text-align: right; }
  .ftable tr:last-child td { border-bottom: 0; }
  .ftable th:nth-child(-n+2), .ftable td:nth-child(-n+2) { text-align: left; }
  .ftable .sub { display: block; color: var(--o-faint); font-size: 10px; }
  .ftable .sub.ok { color: var(--o-pos); } .ftable .sub.bad { color: var(--o-neg); }
  .ftable td .tag { margin-left: 2px; }
  .ftable .tag { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; }
  .tag.LONG { color: var(--o-pos); background: color-mix(in srgb, var(--o-pos) 12%, transparent); } .tag.SHORT { color: var(--o-neg); background: color-mix(in srgb, var(--o-neg) 12%, transparent); }
  .riskbar { display: inline-block; width: 40px; height: 5px; border-radius: 3px; background: var(--o-border); vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .riskbar > i { display: block; height: 100%; }
  .fempty { padding: 18px 14px; color: var(--o-faint); }
  .ftabbar { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 10px 0 5px; background: var(--o-sunken); border-bottom: 1px solid var(--o-border); }
  .tabstrip { display: flex; align-self: stretch; }
  .ftab { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; padding: 0 11px; font-size: 11px; font-weight: 600; color: var(--o-muted); border-bottom: 2px solid transparent; }
  .ftab:hover { color: var(--o-ink); }
  .ftab.on { color: var(--o-ink); border-bottom-color: var(--o-ink); }
  .ftab .cnt { margin-left: 5px; color: var(--o-faint); font-weight: 500; }
  .ftabnote { flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fbtn { all: unset; box-sizing: border-box; cursor: pointer; font-size: 10px; font-weight: 500; color: var(--o-muted); background: var(--o-panel); border: 1px solid var(--o-border); border-radius: 4px; padding: 4px 10px; white-space: nowrap; }
  .fbtn:hover:not(:disabled) { color: var(--o-ink); }
  .fbtn:disabled { opacity: .45; cursor: default; }
  .fbtn[hidden] { display: none; }
  .fsubh { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px 6px; border-top: 1px solid var(--o-border); }
  .fsubh h4 { margin: 0; font-size: 11px; font-weight: 600; color: var(--o-muted); }
  .fpager { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--o-border); }
  /* Narrow windows (below ~1160px): one column, the order builder under the tables; the whole dashboard scrolls. */
  @media (max-width: 1160px) {
    .full { overflow: auto; grid-template-rows: auto auto auto auto; }
    .fbody { grid-template-columns: minmax(0, 1fr); }
    .fmain { overflow: visible; }
    .faside { border-left: 0; border-top: 1px solid var(--o-border); overflow: visible; }
  }
</style>
<div class="full" id="full" hidden>
  <header class="ftop">
    <span class="ftitle">Paperbox</span>
    <span class="fnet" id="f-net"></span>
    <span class="fspacer"></span>
    <span class="small" id="f-account"></span>
    <button class="link" id="f-exit" type="button">Back to overlay</button>
  </header>
  <dl class="fcards" id="f-cards"></dl>
  <div class="fexpo" id="f-expo" hidden></div>
  <div class="fbody">
    <main class="fmain">
      <section class="fpanel">
        <div class="ftabbar">
          <nav class="tabstrip" id="f-tabs">
            <button class="ftab" data-ftab="positions" type="button">Positions<span class="cnt" id="f-pos-count"></span></button>
            <button class="ftab" data-ftab="history" type="button">History</button>
          </nav>
          <span class="small ftabnote" id="f-tab-note"></span>
          <button class="fbtn" id="f-close-all" type="button" title="Stage a close of every open position in the order builder">Close All</button>
        </div>
        <div id="f-tab-positions">
          <div class="fscroll"><table class="ftable" id="f-pos"></table></div>
          <div class="fsubh"><h4>Pending queue</h4><span class="small" id="f-pend-note"></span></div>
          <div class="fscroll"><table class="ftable" id="f-pend"></table></div>
        </div>
        <div id="f-tab-history" hidden>
          <div class="fscroll"><table class="ftable" id="f-hist"></table></div>
          <div class="fpager"><span class="small" id="f-page-rows"></span><span class="fspacer"></span>
            <button class="fbtn" id="f-prev" type="button">‹ Prev</button><span class="small" id="f-page"></span><button class="fbtn" id="f-next" type="button">Next ›</button></div>
        </div>
      </section>
    </main>
    <aside class="faside" id="f-aside"></aside>
  </div>
</div>
<div class="wrap">
  <div class="pill" id="pill" title="Papertrade queue status: click to expand, drag to move">
    <span class="dot" id="pill-dot"></span><span id="pill-text">Connecting…</span>
  </div>
  <div class="panel" id="panel" hidden>
    <div class="head" id="head">
      <span class="dot" id="dot"></span>
      <span class="title">Papertrade queue</span>
      <button class="btn" id="fullscreen" title="Open full screen in a new tab" aria-label="Open full screen in a new tab">⤢</button>
      <button class="btn" id="collapse" title="Collapse" aria-label="Collapse">–</button>
    </div>
    <div class="grid">
      <div class="cell"><span class="lbl">Congestion</span><span class="val" id="congestion">--</span></div>
      <div class="cell"><span class="lbl">Time to clear</span><span class="val" id="clear">--</span></div>
      <div class="cell"><span class="lbl">Pending tx</span><span class="val" id="pending">--</span></div>
      <div class="cell"><span class="lbl">Avg tx / block</span><span class="val" id="avg">--</span></div>
    </div>
    <div class="spark">
      <svg viewBox="0 0 248 40" preserveAspectRatio="none" aria-label="Pending transactions over the last 5 minutes" id="spark"></svg>
      <div class="trend"><span>pending · last 5 min</span><span id="trend"></span></div>
    </div>
    <div class="session" id="session">
      <div class="row"><span class="lbl">Session key</span><span id="sk-status" class="small">checking…</span></div>
      <div id="sk-detail" class="small" hidden></div>
      <div class="actions">
        <button class="action" id="sk-action" hidden></button>
        <button class="link" id="sk-remove" hidden>Remove</button>
      </div>
      <div id="sk-msg" class="small" hidden></div>
    </div>
    <div class="order" id="order" hidden>
      <div class="row"><span class="lbl">Build orders</span>
        <div class="seg2" id="o-market" role="group" aria-label="Market"><button type="button" data-market="BTC" class="on">BTC</button><button type="button" data-market="ETH">ETH</button></div>
      </div>
      <div class="fields">
        <label class="field"><span class="lbl">Margin (USDC)</span><input id="o-margin" inputmode="decimal" value="10" /></label>
        <label class="field"><span class="lbl">Leverage ×</span><input id="o-lev" inputmode="numeric" value="100" /></label>
      </div>
      <div id="o-calc" class="small"></div>
      <div id="o-error" class="small bad" hidden></div>
      <div class="adds">
        <button class="add long" id="o-add-long" type="button">+ Long</button>
        <button class="add short" id="o-add-short" type="button">+ Short</button>
      </div>
      <div class="closerow">
        <select id="o-close" aria-label="Position to close"></select>
        <button class="add close" id="o-add-close" type="button">+ Close</button>
      </div>
      <div class="staged" id="o-staged"></div>
      <label class="guard">
        Keep within queue distance <input id="o-distance" inputmode="numeric" placeholder="off" value="5" /> <span id="o-distance-note"></span>
      </label>
      <div id="o-guard-help" class="small"></div>
      <label class="guard">
        Send when pending tx below <input id="o-maxpending" inputmode="numeric" placeholder="off" value="20" /> <span id="o-maxpending-note"></span>
      </label>
      <div id="o-gate-help" class="small"></div>
      <label class="guard">
        Send when OI cap room above <input id="o-oibuffer" inputmode="decimal" placeholder="off" value="2" /> <span id="o-oibuffer-note"></span>
      </label>
      <div id="o-oi-help" class="small"></div>
      <button class="submit" id="o-submit" type="button" disabled>Submit</button>
      <div class="orders" id="o-batches"></div>
    </div>
    <div class="stake" id="stake" hidden>
      <span class="lbl">Stake PAPER</span>
      <div id="st-bal" class="small"></div>
      <div class="stakerow">
        <input id="st-amount" inputmode="decimal" placeholder="Amount" aria-label="PAPER to stake" autocomplete="off" />
        <button class="link" id="st-max" type="button">Max</button>
        <button class="action" id="st-submit" type="button" disabled>Stake</button>
      </div>
      <div id="st-msg" class="small" hidden></div>
    </div>
    <div class="foot"><span id="state">connecting…</span><span id="block"></span></div>
  </div>
</div>`;
  const $ = (id) => root.getElementById(id);

  let settings = { collapsed: false, left: 16, bottom: 16 };
  const history = []; // [{t, pending}]
  let snapshot = null;
  let streamState = 'connecting';

  const fmtClear = (s) => (s === null ? '--' : s === 0 ? '0s' : s < 120 ? `~${s}s` : `~${(s / 60).toFixed(1)}m`);
  const num = (n) => (n === null ? '--' : n.toLocaleString('en-US'));

  function render() {
    const st = computeStatus(snapshot);
    const level = st.congestion;
    for (const id of ['dot', 'pill-dot']) $(id).className = `dot ${level ?? ''}`;
    $('congestion').innerHTML = level ? `<span class="level ${level}">${level}</span>` : '--';
    $('congestion').title = st.neededBlocks === null ? '' : `Queued + submitted gas needs ${st.neededBlocks} block(s)`;
    $('clear').textContent = fmtClear(st.clearS);
    $('pending').textContent = st.pending === null ? '--' : num(st.pending);
    $('pending').title = st.queued === null ? '' : `${st.submitted} submitted to chain, ${st.queued} waiting for a batch`;
    $('avg').textContent = st.avgTx === null ? '--' : st.avgTx.toFixed(1);
    $('block').textContent = st.block ? `#${num(st.block)}` : '';

    const age = st.ts ? Math.round((Date.now() - st.ts) / 1000) : null;
    if (st.live) {
      $('state').textContent = 'live';
      $('state').className = '';
      $('pill-text').textContent = `${level} · ${num(st.pending)} pending · ${fmtClear(st.clearS)}`;
    } else {
      const why = streamState === 'live' ? 'stale' : streamState;
      $('state').textContent = age === null ? `${why}…` : `${why}, data ${age < 120 ? `${age}s` : `${Math.round(age / 60)}m`} old`;
      $('state').className = 'warn';
      $('pill-text').textContent = age === null ? 'Connecting…' : 'Queue status unavailable';
    }
    renderSpark();
  }

  function renderSpark() {
    const now = Date.now();
    while (history.length && now - history[0].t > HISTORY_MS) history.shift();
    const svg = $('spark');
    if (history.length < 2 || history[history.length - 1].t - history[0].t < 20_000) {
      svg.innerHTML = '<text x="124" y="24" text-anchor="middle" fill="var(--o-faint)" font-size="11">building history…</text>';
      $('trend').textContent = '';
      return;
    }
    const W = 248, H = 40, max = Math.max(1, ...history.map((h) => h.pending));
    const x = (t) => ((t - (now - HISTORY_MS)) / HISTORY_MS) * W;
    const y = (v) => H - 2 - (v / max) * (H - 4);
    const d = history.map((h, i) => `${i ? 'L' : 'M'}${x(h.t).toFixed(1)},${y(h.pending).toFixed(1)}`).join('');
    svg.innerHTML = `<path class="area" d="${d}L${x(history[history.length - 1].t).toFixed(1)},${H}L${x(history[0].t).toFixed(1)},${H}Z"/><path class="line" d="${d}"/>`;
    // Trend: compare now with ~1 minute ago, so you can tell a draining queue from a growing one.
    const nowP = history[history.length - 1].pending;
    const ref = history.find((h) => now - h.t <= 60_000) ?? history[0];
    const diff = nowP - ref.pending;
    const steady = Math.abs(diff) < Math.max(3, ref.pending * 0.05);
    $('trend').textContent = steady ? 'steady' : diff > 0 ? `↑ ${num(diff)} in 1m` : `↓ ${num(-diff)} in 1m`;
    $('trend').className = !steady && diff > 0 ? 'warn' : ''; // a growing queue is the warning sign
  }

  function applyLayout() {
    if (full?.on) return; // full screen: the dashboard fills the tab; nothing to position
    $('pill').hidden = !settings.collapsed;
    $('panel').hidden = settings.collapsed;
    host.style.left = `${settings.left}px`;
    host.style.bottom = `${settings.bottom}px`;
    host.style.top = 'auto';
    host.style.right = 'auto';
    // Keep it on screen (e.g. after expanding a pill parked near an edge, or the window shrinking).
    if (!host.isConnected) return;
    const r = host.getBoundingClientRect();
    const left = Math.max(0, Math.min(settings.left, window.innerWidth - r.width - 8));
    const bottom = Math.max(0, Math.min(settings.bottom, window.innerHeight - r.height - 8));
    host.style.left = `${left}px`;
    host.style.bottom = `${bottom}px`;
  }
  window.addEventListener('resize', () => applyLayout());
  // The panel changes height as sections fill in (e.g. the session-key section); since it's anchored by
  // its bottom edge it grows upward, so re-clamp whenever its size changes to keep the header (the drag
  // handle) on screen.
  new ResizeObserver(() => applyLayout()).observe(host);

  // Drag by the pill or the panel header; a click without movement toggles.
  function draggable(handle, onClick) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.btn')) return;
      const startX = e.clientX, startY = e.clientY, r = host.getBoundingClientRect();
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        settings.left = Math.round(Math.min(Math.max(0, r.left + dx), window.innerWidth - r.width));
        settings.bottom = Math.round(Math.min(Math.max(0, window.innerHeight - r.bottom - dy), window.innerHeight - r.height));
        applyLayout();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (moved) storage.set(settings);
        else onClick?.();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  draggable($('pill'), () => { settings.collapsed = false; applyLayout(); storage.set(settings); });
  draggable($('head'));
  $('collapse').addEventListener('click', () => { settings.collapsed = true; applyLayout(); storage.set(settings); });

  // ---- Session key: created by the background worker, authorized by your wallet (Rabby / Ledger) ----
  const API = 'https://exchange.papertrade.xyz';
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const dateOf = (sec) => new Date(Number(sec) * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // Talk to the page-world bridge (bridge.js), which is the only place Rabby is reachable.
  let bridgeSeq = 0;
  function bridge(method, params, timeoutMs = 30_000) {
    const id = `${Date.now()}-${++bridgeSeq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { window.removeEventListener('message', on); reject(new Error('The wallet did not respond in time.')); }, timeoutMs);
      function on(e) {
        if (e.source !== window || e.data?.type !== 'papertrade-overlay:response' || e.data.id !== id) return;
        clearTimeout(t);
        window.removeEventListener('message', on);
        if (e.data.error) reject(Object.assign(new Error(e.data.error.message), { code: e.data.error.code }));
        else resolve(e.data.result);
      }
      window.addEventListener('message', on);
      window.postMessage({ type: 'papertrade-overlay:request', id, method, params }, window.location.origin);
    });
  }

  // Talk to the background worker, which holds the key.
  async function worker(type, extra = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Extension context unavailable; reload the page.');
    const res = await chrome.runtime.sendMessage({ type, master: sk.master, ...extra });
    if (res?.error) throw new Error(res.error);
    return res?.result;
  }

  const sk = { master: null, local: null, onchain: {}, outcome: null, busy: false, msg: '', msgClass: '' };

  function setMsg(text, cls = '') { sk.msg = text; sk.msgClass = cls; renderSession(); }

  // ---- PAPER staking: the master wallet signs each Stake (Rabby / Ledger); the session key isn't involved ----
  const stake = { busy: false, msg: '', cls: '', intentId: null, amountRaw: null };
  const fmtPaper = (raw) => (Number(raw) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });
  // Exact decimal string for a raw amount (for the input; no float rounding), e.g. 3492.186503347517471804.
  const fromWad = (raw) => { const f = (raw % WAD).toString().padStart(18, '0').replace(/0+$/, ''); return `${raw / WAD}${f ? `.${f}` : ''}`; };
  const pendingStakes = () => [...acct.ops.values()].filter((o) => o.action === 'paperStake' && o.amountRaw !== null).reduce((a, o) => a + o.amountRaw, 0n);
  // What can still be staked: wallet PAPER minus stakes already waiting in the queue (as the web app checks).
  const freePaper = () => { if (!acct.paper) return null; const f = acct.paper.balance - pendingStakes(); return f > 0n ? f : 0n; };
  // Claimable USDC rewards: pendingBase + max(0, staked × accRewardPerShare / 1e27 − rewardDebt).
  const claimable = () => {
    if (!acct.paper || trading?.accRewardRaw == null) return null;
    const accrued = (acct.paper.staked * trading.accRewardRaw) / 10n ** 27n - acct.paper.rewardDebt;
    return acct.paper.pendingBase + (accrued > 0n ? accrued : 0n);
  };

  function readStake() {
    const v = $('st-amount').value.trim().replace(/,/g, '');
    if (v === '') return { empty: true };
    if (!/^\d+(\.\d{1,18})?$/.test(v)) return { error: 'Amount: a number of PAPER, up to 18 decimals.' };
    const amountRaw = BigInt(toWad(v));
    if (amountRaw <= 0n) return { error: 'Enter more than 0 PAPER.' };
    if (!trading || trading.error) return { error: trading?.error ?? 'Loading Papertrade’s rules…' };
    if (trading.paused.includes('paperStake')) return { error: 'Papertrade has paused staking right now.' };
    if (trading.minStakeRaw > 0n && amountRaw < trading.minStakeRaw) return { error: `The minimum stake is ${fmtPaper(trading.minStakeRaw)} PAPER.` };
    const free = freePaper();
    if (free === null) return { error: 'Waiting for your PAPER balance…' };
    if (amountRaw > free) return { error: `You have ${fmtPaper(free)} PAPER to stake${pendingStakes() > 0n ? ' (after stakes already in the queue)' : ''}.` };
    return { amountRaw };
  }

  function renderStake() {
    $('stake').hidden = !sk.master;
    if (!sk.master) return;
    const p = acct.paper, c = claimable(), pend = pendingStakes();
    $('st-bal').textContent = p
      ? `wallet ${fmtPaper(p.balance)} · staked ${fmtPaper(p.staked)}${pend > 0n ? ` (+${fmtPaper(pend)} queued)` : ''}${c !== null ? ` · rewards $${(Number(c) / 1e18).toFixed(2)}` : ''}`
      : 'loading…';
    const r = readStake();
    $('st-submit').disabled = stake.busy || !!r.empty || !!r.error;
    $('st-submit').textContent = stake.busy ? 'Staking…' : 'Stake';
    $('st-max').disabled = stake.busy || !freePaper();
    // A problem with what's typed comes first; otherwise the last step of the stake flow.
    const invalid = !stake.busy && r.error && !r.empty;
    const msg = invalid ? r.error : stake.msg;
    $('st-msg').hidden = !msg;
    $('st-msg').textContent = msg;
    $('st-msg').className = `small ${invalid ? 'bad' : stake.cls}`;
  }
  const setStakeMsg = (text, cls = '') => { stake.msg = text; stake.cls = cls; renderStake(); };

  async function doStake() {
    const r = readStake();
    if (stake.busy || r.error || r.empty) return;
    const amountRaw = r.amountRaw;
    const ok = confirm(
      `Stake ${fmtPaper(amountRaw)} PAPER?\n\n` +
      `Your wallet (${short(sk.master)}) signs a "Stake" message on the PaperStaking contract (0xaad6…f016, HyperEVM). ` +
      `Rabby shows the exact amount; confirm it on your Ledger.\n\n` +
      `Staked PAPER earns a share of Papertrade's fees, paid in USDC. Unstaking is a separate action on Papertrade.`);
    if (!ok) return;
    stake.busy = true;
    stake.intentId = null;
    try {
      setStakeMsg('Preparing…');
      const { typedData } = await worker('stake:prepare', { amountRaw: amountRaw.toString() });
      setStakeMsg(`Approve "Stake" for ${fmtPaper(amountRaw)} PAPER in Rabby, then confirm on your Ledger.`, 'warn');
      const signature = await bridge('sign', { address: sk.master, typedData }, 5 * 60_000);
      setStakeMsg('Checking the signature…');
      const { body, intentId } = await worker('stake:finalize', { signature });
      setStakeMsg('Sending to Papertrade…');
      const res = await fetch(`${API}/intents`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || json.ok === false) {
        const code = json.code ?? json.error ?? `HTTP ${res.status}`;
        const why = {
          below_minimum_paper_stake: `Below Papertrade's minimum stake${json.minimumPaperStakeRaw ? ` of ${fmtPaper(BigInt(json.minimumPaperStakeRaw))} PAPER` : ''}.`,
          intake_action_paused: 'Papertrade has paused staking right now.',
          deadline_expired: 'The signed request expired. Try again.',
          invalid_intent: 'Papertrade rejected the signed message as invalid.',
          unauthorized_intent: 'Papertrade says the signature does not match this account.',
          rate_limited: 'Papertrade is rate-limiting requests. Wait a minute and try again.',
        }[code] ?? { paperBalance: 'Not enough PAPER in the wallet.', alreadyQueued: 'A stake is already waiting in the queue.' }[json.reason];
        throw new Error(why ?? `Papertrade refused it: ${refusal(json, res.status)}`);
      }
      stake.intentId = json.intentId ?? intentId;
      stake.amountRaw = amountRaw;
      $('st-amount').value = '';
      setStakeMsg(`Submitted (${json.state ?? 'queued'}). ${fmtPaper(amountRaw)} PAPER is staked once Papertrade executes it, usually within a minute.`, 'ok');
    } catch (err) {
      const declined = err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '');
      setStakeMsg(declined ? 'You declined in the wallet. Nothing was sent.' : err.message, 'bad');
      await worker('stake:cancel').catch(() => {});
    } finally {
      stake.busy = false;
      renderStake();
    }
  }

  function onStakeOutcome(outcome) {
    const amt = stake.amountRaw === null ? '' : `${fmtPaper(stake.amountRaw)} `;
    if (outcome === 'succeeded') setStakeMsg(`Staked ${amt}PAPER.`, 'ok');
    else setStakeMsg(`The stake of ${amt}PAPER ${outcome}. Nothing was staked.`, 'bad');
    stake.intentId = null;
  }

  function renderSession() {
    renderStake();
    const status = $('sk-status'), detail = $('sk-detail'), action = $('sk-action'), remove = $('sk-remove'), msg = $('sk-msg');
    msg.hidden = !sk.msg;
    msg.textContent = sk.msg;
    msg.className = `small ${sk.msgClass}`;
    detail.hidden = true;
    remove.hidden = true;
    action.hidden = false;
    action.disabled = sk.busy;
    action.className = 'action';

    $('order').hidden = true;
    if (!sk.master) {
      status.textContent = 'wallet not connected';
      status.className = 'small';
      action.textContent = 'Connect wallet';
      action.onclick = () => run(connect);
      return;
    }
    const local = sk.local;
    const expiry = local ? sk.onchain[local.address] : undefined;
    const now = Date.now() / 1000;
    if (!local) {
      status.textContent = 'none in this extension';
      status.className = 'small';
      detail.hidden = false;
      detail.textContent = `For ${short(sk.master)}. Your wallet signs once to authorize a new key for 30 days.`;
      action.textContent = 'Create session key';
      action.onclick = () => run(() => register(false));
      return;
    }
    detail.hidden = false;
    remove.hidden = false;
    remove.onclick = () => run(removeKey);
    $('order').hidden = !(local && expiry !== undefined && Number(expiry) > now + 3600);
    if (expiry !== undefined && Number(expiry) > now + 3600) {
      if (sk.msgClass === 'ok') { sk.msg = ''; msg.hidden = true; } // "Submitted…" has done its job
      status.textContent = 'active';
      status.className = 'small ok';
      detail.textContent = `${short(local.address)} · expires ${dateOf(expiry)}`;
      action.textContent = 'Replace…';
      action.className = 'link'; // the key is fine; keep the order form the focus
      action.onclick = () => run(() => register(true));
    } else if (local.pending?.submittedAt) {
      const waited = (Date.now() - local.pending.submittedAt) / 1000;
      const slow = waited > 120; // usually executes within a minute; past this, let the user retry
      status.textContent = sk.outcome ? `registration ${sk.outcome}` : slow ? 'still not registered' : 'waiting for Papertrade…';
      status.className = sk.outcome ? 'small bad' : 'small warn';
      detail.textContent = sk.outcome
        ? `${short(local.address)} was not registered. Try again.`
        : `${short(local.address)} · submitted ${waited < 120 ? `${Math.round(waited)}s` : `${Math.round(waited / 60)}m`} ago${slow ? '. The queue may be backed up (see congestion above), or it was dropped.' : '; it becomes active once the queue executes it.'}`;
      // Don't invite a duplicate registration while the first one may still land.
      action.hidden = !(sk.outcome || slow);
      action.textContent = 'Try again';
      action.onclick = () => run(() => register(false));
    } else if (expiry !== undefined) {
      status.textContent = 'expired';
      status.className = 'small bad';
      detail.textContent = `${short(local.address)} expired ${dateOf(expiry)}.`;
      action.textContent = 'Create a new one';
      action.onclick = () => run(() => register(true));
    } else {
      status.textContent = 'not registered yet';
      status.className = 'small warn';
      detail.textContent = `${short(local.address)} is waiting for your wallet's signature.`;
      action.textContent = 'Sign & register';
      action.onclick = () => run(() => register(false));
    }
  }

  async function run(fn) {
    if (sk.busy) return;
    sk.busy = true;
    renderSession();
    try { await fn(); }
    catch (err) {
      const declined = err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '');
      setMsg(declined ? 'You declined in the wallet. Nothing was sent.' : err.message, 'bad');
      if (sk.master) await worker('session:cancel').catch(() => {});
    } finally {
      sk.busy = false;
      await refreshLocal().catch(() => {});
      renderSession();
    }
  }

  async function connect() {
    const { accounts } = await bridge('accounts', { prompt: true }, 120_000);
    if (!accounts.length) throw new Error('No account was connected.');
    sk.master = accounts[0];
    setMsg('');
    watchAccount();
  }

  async function refreshLocal() {
    if (sk.master) sk.local = await worker('session:get');
  }

  async function register(replace) {
    if (replace && !confirm('Create a new session key? The current one stays valid on Papertrade until it expires; this extension will stop using it.')) return;
    sk.outcome = null;
    setMsg('Preparing the authorization…');
    const { typedData, sessionAddress } = await worker('session:prepare', { replace });
    setMsg(`Approve "RegisterSessionKey" in Rabby, then confirm on your Ledger. It authorizes ${short(sessionAddress)} to trade for this account for 30 days.`, 'warn');
    const signature = await bridge('sign', { address: sk.master, typedData }, 5 * 60_000);
    setMsg('Checking the signature…');
    const { body, intentId } = await worker('session:finalize', { signature });
    setMsg('Sending to Papertrade…');
    const res = await fetch(`${API}/intents`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error || json.ok === false) {
      const code = json.code ?? json.error ?? `HTTP ${res.status}`;
      const why = {
        noDeposit: 'This account has no deposit yet. Deposit on Papertrade first.',
        sessionKeyLimit: 'This account already has the maximum number of session keys.',
        intake_action_paused: 'Papertrade has paused session-key registration right now.',
        deadline_expired: 'The signed request expired. Try again.',
        invalid_intent: 'Papertrade rejected the signed message as invalid.',
        unauthorized_intent: 'Papertrade says the signature does not match this account.',
      }[json.reason] ?? {
        intake_action_paused: 'Papertrade has paused session-key registration right now.',
        deadline_expired: 'The signed request expired. Try again.',
        invalid_intent: 'Papertrade rejected the signed message as invalid.',
        unauthorized_intent: 'Papertrade says the signature does not match this account.',
        rate_limited: 'Papertrade is rate-limiting requests. Wait a minute and try again.',
      }[code];
      throw new Error(why ?? `Papertrade refused it: ${code}${json.reason ? ` (${json.reason})` : ''}`);
    }
    await worker('session:submitted', { intentId: json.intentId ?? intentId });
    setMsg(`Submitted (${json.state ?? 'queued'}). It becomes active once Papertrade executes it, usually within a minute.`, 'ok');
  }

  async function removeKey() {
    const exp = sk.local && sk.onchain[sk.local.address];
    if (!confirm(`Remove this session key from the extension?${exp ? ` It stays valid on Papertrade until ${dateOf(exp)}.` : ''}`)) return;
    await worker('session:remove');
    setMsg('Removed from this browser.');
  }

  // The account's live stream tells us which session keys Papertrade has registered (and when they expire).
  let accountStream = null;
  function watchAccount() {
    accountStream?.close();
    if (!sk.master) return;
    let revision = null;
    const es = new EventSource(`${API}/state/user/live?wallet=${sk.master}`);
    accountStream = es;
    const applyKeys = (pairs) => { sk.onchain = Object.fromEntries((pairs ?? []).map(([k, exp]) => [k.toLowerCase(), exp])); };
    es.addEventListener('wallet', (e) => {
      acct.streamLive = true;
      const m = JSON.parse(e.data);
      if (!('baseAccountRevision' in m)) {
        applyKeys(m.sessionKeys);
        acct.available = m.funds ? Number(BigInt(m.funds.availableBalance)) / 1e18 : null;
        applyFunds(m);
        acct.realizedRaw = m.lifetime ? BigInt(m.lifetime.realizedPnlRaw) : null;
        acct.paper = null;
        applyPaper(m.paper);
        acct.positions = new Map();
        acct.ops = new Map((m.operations ?? []).map((t) => [t[0], opOf(t)]));
        for (const t of m.openPositions ?? []) onPosition(t);
      } else if (revision !== null && m.baseAccountRevision !== revision) { es.close(); setTimeout(watchAccount, 1000); return; }
      else {
        if (m.state?.sessionKeys) applyKeys(m.state.sessionKeys);
        if (m.state?.funds) acct.available = Number(BigInt(m.state.funds.availableBalance)) / 1e18;
        if (m.state) applyFunds(m.state);
        if (m.lifetime) acct.realizedRaw = BigInt(m.lifetime.realizedPnlRaw);
        applyPaper(m.state?.paper ?? m.paper);
        for (const id of m.removedOperationIds ?? []) acct.ops.delete(id);
        for (const t of m.addedOperations ?? []) acct.ops.set(t[0], opOf(t));
        if (m.closedPositions?.length) full.historyStale = true;
        for (const id of m.removedPositionIds ?? []) acct.positions.delete(String(id));
        for (const t of m.addedPositions ?? []) onPosition(t);
        for (const c of m.closedPositions ?? []) onClosed(c);
      }
      for (const [id, outcome] of m.intentOutcomes ?? []) {
        if (id === sk.local?.pending?.intentId && outcome !== 'succeeded') sk.outcome = outcome;
        if (id === stake.intentId) onStakeOutcome(outcome);
        onOutcome(id, outcome);
      }
      revision = m.accountRevision;
      renderSession();
      renderOrder();
    });
    es.onerror = () => {
      acct.streamLive = false; // e.g. a 429 from Papertrade: EventSource stops for good, so reconnect ourselves
      if (es.readyState === 2) setTimeout(() => accountStream === es && watchAccount(), 5000);
    };
  }

  // ---- Orders: build a batch, submit it all at once, track it, keep it together in the queue ----
  // positions: id → { id, market, isLong, margin, leverage, entry, raw fields… }; ops: intentId → queued intent
  const acct = { available: null, positions: new Map(), ops: new Map(), balanceRaw: 0n, queuedRaw: 0n, availRaw: 0n, availQueuedRaw: 0n, realizedRaw: null, paper: null };
  // PAPER: { balance, staked, pendingBase, rewardDebt }, raw 18-decimal bigints (null until the stream sends it).
  const applyPaper = (p) => {
    if (!p || p.balance === undefined) return;
    acct.paper = { balance: BigInt(p.balance), staked: BigInt(p.staked ?? '0'), pendingBase: BigInt(p.pendingBase ?? '0'), rewardDebt: BigInt(p.rewardDebt ?? '0') };
  };
  const applyFunds = (m) => {
    if (m.balance !== undefined) acct.balanceRaw = BigInt(m.balance);
    if (m.queued !== undefined) acct.queuedRaw = BigInt(m.queued);
    if (m.funds) { acct.availRaw = BigInt(m.funds.availableBalance ?? 0); acct.availQueuedRaw = BigInt(m.funds.availableQueued ?? 0); }
  };
  const opOf = (t) => ({ intentId: t[0], action: t[1], instrumentId: t[2], isLong: t[3], amountRaw: t[5] === null ? null : BigInt(t[5]), leverage: t[6], acceptedAtMs: t[7], positionIds: t[9] });
  const form = { market: 'BTC' };
  let staged = []; // { kind: 'open', market, isLong, marginStr, margin, leverage, notional } | { kind: 'close', positionId }
  const batches = []; // newest first: { at, distance, orders, guard: { state, spread, note } }
  let trading = null; // parsed /state/trading
  let mids = {}; // Hyperliquid mid price per coin (estimates only)
  const BAD = new Set(['refused', 'expired', 'failed', 'cancelled', 'error']);

  // Open-interest room on one side, in the asset's units, exactly as Papertrade's web app computes it:
  // cap − OI (never below 0), and a cap of 0 or 2^128−1 means the side has no cap (Infinity).
  const NO_CAP = (1n << 128n) - 1n;
  function oiRoom(capRaw, oiRaw) {
    const cap = BigInt(capRaw), oi = BigInt(oiRaw);
    if (cap === 0n || cap === NO_CAP) return Infinity;
    return Number(cap > oi ? cap - oi : 0n) / 1e18;
  }

  async function loadTrading() {
    try {
      const d = await (await fetch(`${API}/state/trading`, { cache: 'no-store' })).json();
      const inst = {};
      for (const t of d.instruments ?? []) {
        if (t.length !== 23) throw new Error('Papertrade changed its market format; refusing to trade until the overlay is updated.');
        inst[t[1]] = { id: t[0], symbol: t[1], priceScale: Number(t[3]), active: t[4], paused: t[5], terminal: t[6], closeOnly: t[8],
          maxLeverage: t[14], maxNotional: Number(BigInt(t[15])) / 1e18, bustBuffer: Number(BigInt(t[16])) / 1e18,
          longRoom: oiRoom(t[21], t[19]), shortRoom: oiRoom(t[22], t[20]),
          // Exact integers for PnL (see valuation below).
          priceScaleRaw: BigInt(t[3]), frozenBidRaw: t[9] === null ? null : BigInt(t[9]), frozenAskRaw: t[10] === null ? null : BigInt(t[10]),
          rateMultiplierRaw: BigInt(t[12]), positionMultiplierRaw: BigInt(t[13]), baseRateRaw: BigInt(t[17]), referenceNotionalRaw: BigInt(t[18]) };
      }
      // `intakeControls` = [revision, minimumPaperStake, pausedActions]; older builds used `intake` with an extra slot.
      const paused = d.intakeControls?.[2] ?? d.intake?.[3];
      if (!Array.isArray(paused)) throw new Error('Papertrade changed its trading-rules format; refusing to trade until the overlay is updated.');
      trading = { inst, tradingPaused: d.tradingPaused, paused, minStakeRaw: BigInt(d.intakeControls?.[1] ?? d.intake?.[1] ?? '0'),
        accRewardRaw: d.accRewardPerShareRaw === undefined ? null : BigInt(d.accRewardPerShareRaw), minMargin: Number(BigInt(d.minimumTradeSizeRaw)) / 1e18,
        minNotional: Number(BigInt(d.minimumOpenNotionalRaw)) / 1e18, maxLev: d.maximumLeverage ?? 0, minLev: d.minimumLeverage ?? 0, error: null, at: Date.now() };
    } catch (err) {
      trading = { error: err.message };
    }
    renderOrder();
    renderStake();
  }

  async function loadMids() {
    try {
      mids = await (await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) })).json();
      renderOrder();
    } catch { /* estimates only */ }
  }

  const usd = (v) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v < 100 ? 2 : 0 });
  const instById = (id) => Object.values(trading?.inst ?? {}).find((i) => i.id === id);
  const px = (v, inst) => v.toLocaleString('en-US', { maximumFractionDigits: inst?.priceScale >= 100 ? 2 : 1 });

  // Parse the input row and check it against the live rules. Returns { error } or the order terms.
  function readForm() {
    if (!trading) return { error: 'Loading market rules…' };
    if (trading.error) return { error: trading.error };
    const inst = trading.inst[form.market];
    if (!inst) return { error: `Papertrade doesn't list ${form.market}.` };
    const marginStr = $('o-margin').value.trim(), levStr = $('o-lev').value.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(marginStr)) return { error: 'Margin: a USDC amount with up to 6 decimals.' };
    if (!/^\d+$/.test(levStr)) return { error: 'Leverage: a whole number.' };
    const margin = Number(marginStr), leverage = Number(levStr), notional = margin * leverage;
    const maxLev = trading.maxLev > 0 ? Math.min(inst.maxLeverage, trading.maxLev) : inst.maxLeverage;
    const minLev = Math.max(1, trading.maxLev > 0 ? Math.min(trading.minLev, trading.maxLev) : trading.minLev);
    const mid = Number(mids[form.market]) || null;
    const base = { inst, margin, leverage, notional, mid, marginStr };
    if (trading.tradingPaused || trading.paused.includes('openPosition')) return { ...base, error: 'Papertrade has paused new positions.' };
    if (!inst.active || inst.paused || inst.terminal || inst.closeOnly) return { ...base, error: `${form.market} isn't open for new positions.` };
    if (leverage < minLev || leverage > maxLev) return { ...base, error: `Leverage must be ${minLev}–${maxLev}×.` };
    if (margin < trading.minMargin) return { ...base, error: `Minimum margin is ${usd(trading.minMargin)}.` };
    if (notional < trading.minNotional) return { ...base, error: `Minimum position size (margin × leverage) is ${usd(trading.minNotional)}.` };
    if (notional > inst.maxNotional) return { ...base, error: `Maximum position size is ${usd(inst.maxNotional)}.` };
    return base;
  }

  // Bust price estimate: the trigger sits (1/leverage − bustBuffer) from entry.
  const bustOf = (o, isLong) => o.mid && o.mid * (1 + (isLong ? -1 : 1) * (1 / o.leverage - o.inst.bustBuffer));
  const stagedMargin = () => staged.reduce((a, o) => a + (o.kind === 'open' ? o.margin : 0), 0);
  const describe = (o) => {
    if (o.kind === 'open') return `${o.isLong ? 'LONG' : 'SHORT'} ${o.market} ${usd(o.notional)} (${usd(o.margin)} × ${o.leverage})`;
    const p = acct.positions.get(o.positionId) ?? o.snapshot;
    return p ? `CLOSE #${o.positionId} ${p.isLong ? 'long' : 'short'} ${p.market} ${usd(p.margin * p.leverage)}` : `CLOSE #${o.positionId}`;
  };

  function stageOpen(isLong) {
    const o = readForm();
    if (o.error) return;
    if (acct.available !== null && stagedMargin() + o.margin > acct.available + 1e-9) {
      return flashError(`These orders' margin would exceed your available ${usd(acct.available)}.`);
    }
    // Open-interest caps are per side, in the asset's units; count what's already staged on that side.
    const room = isLong ? o.inst.longRoom : o.inst.shortRoom;
    const sameSide = staged.filter((x) => x.kind === 'open' && x.market === form.market && x.isLong === isLong).reduce((a, x) => a + x.notional, 0);
    if (o.mid && (sameSide + o.notional) / o.mid > room) {
      return flashError(`${form.market} ${isLong ? 'long' : 'short'} side only has room for about ${usd(room * o.mid)} more open interest.`);
    }
    staged.push({ kind: 'open', market: form.market, isLong, marginStr: o.marginStr, margin: o.margin, leverage: o.leverage, notional: o.notional, instrumentId: o.inst.id });
    if (Date.now() - (trading?.at ?? 0) > OI_FRESH_MS) loadTrading(); // fresh OI caps for the buffer check
    renderOrder();
  }

  function stageClose() {
    const id = $('o-close').value;
    if (!id || staged.some((x) => x.kind === 'close' && x.positionId === id)) return;
    staged.push({ kind: 'close', positionId: id, snapshot: acct.positions.get(id) });
    renderOrder();
  }

  // A message about the last action (e.g. why a batch wasn't sent); stays up for a few seconds.
  let flash = { text: '', until: 0 };
  function flashError(text, ms = 8000) {
    flash = { text, until: Date.now() + ms };
    renderOrder();
    setTimeout(renderOrder, ms + 50);
  }

  function readMaxPending() {
    const v = $('o-maxpending').value.trim();
    if (v === '') return { maxPending: null };
    if (!/^\d+$/.test(v) || Number(v) < 1) return { error: 'Pending tx limit: a whole number of at least 1, or blank to send right away.' };
    return { maxPending: Number(v) };
  }

  function readOiBuffer() {
    const v = $('o-oibuffer').value.trim();
    if (v === '') return { oiBuffer: null };
    if (!/^\d+(\.\d+)?$/.test(v)) return { error: 'OI cap buffer: an amount in millions of USD (e.g. 2), or blank for no check.' };
    return { oiBuffer: Number(v) * 1e6 };
  }

  // Open-interest room left under a side's cap, in USD (room is in the asset's units; priced at the Hyperliquid mid).
  // null when unknown: market rules missing or older than 15s, or no price.
  const OI_FRESH_MS = 15_000;
  function oiRoomUsd(market, isLong, { anyAge = false } = {}) {
    const inst = trading?.inst?.[market], mid = Number(mids[market]) || null;
    if (!inst || !mid || !trading.at || (!anyAge && Date.now() - trading.at > OI_FRESH_MS)) return null;
    return Math.max(0, isLong ? inst.longRoom : inst.shortRoom) * mid;
  }
  // The sides a set of orders opens on: a batch of longs only checks the long cap, shorts only the short cap, both if mixed.
  const oiSides = (orders) => {
    const seen = new Map();
    for (const o of orders) if (o.kind === 'open') seen.set(`${o.market}:${o.isLong}`, { market: o.market, isLong: o.isLong });
    return [...seen.values()];
  };
  const fmtM = (v) => (v === Infinity ? 'no cap' : `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`);
  const sideName = (x) => `${x.market} ${x.isLong ? 'long' : 'short'}`;

  // Why a batch can't go out yet (pending-tx gate, OI cap buffer), or null when it may send now.
  function holdReason(b) {
    const why = [];
    if (b.maxPending !== null) {
      const now = computeStatus(snapshot);
      if (!now.live || now.pending === null) why.push('status unavailable');
      else if (now.pending >= b.maxPending) why.push(`pending ${now.pending} ≥ ${b.maxPending}`);
    }
    if (b.oiBuffer !== null) {
      for (const x of oiSides(b.orders)) {
        const room = oiRoomUsd(x.market, x.isLong);
        if (room === null) why.push(`${sideName(x)} OI room unknown`);
        else if (room < b.oiBuffer) why.push(`${sideName(x)} OI room ${fmtM(room)} < your ${fmtM(b.oiBuffer)} buffer`);
      }
    }
    return why.length ? why.join(' · ') : null;
  }

  function readDistance() {
    const v = $('o-distance').value.trim();
    if (v === '') return { distance: null };
    if (!/^\d+$/.test(v)) return { error: 'Queue distance: a whole number, or blank for no guard.' };
    return { distance: Number(v) };
  }

  function renderOrder() {
    if ($('order').hidden) return;
    const o = readForm();
    for (const b of $('o-market').querySelectorAll('button')) b.classList.toggle('on', b.dataset.market === form.market);
    const parts = [];
    if (o.notional) parts.push(`size ${usd(o.notional)}`);
    if (o.mid && o.leverage) parts.push(`bust ≈ ${px(bustOf(o, true), o.inst)} long / ${px(bustOf(o, false), o.inst)} short`);
    if (acct.available !== null) parts.push(`available ${usd(acct.available - stagedMargin())}${staged.length ? ' after these' : ''}`);
    $('o-calc').textContent = parts.join(' · ');
    const message = Date.now() < flash.until ? flash.text : o.error;
    $('o-error').hidden = !message;
    $('o-error').textContent = message ?? '';
    for (const id of ['o-add-long', 'o-add-short']) $(id).disabled = !!o.error || submitting;

    // Close picker: the account's open positions, newest first, minus the ones already staged.
    const sel = $('o-close'), keep = sel.value;
    const options = [...acct.positions.values()].sort((a, b) => Number(b.id) - Number(a.id))
      .filter((p) => !staged.some((x) => x.kind === 'close' && x.positionId === p.id))
      .map((p) => `<option value="${p.id}">#${p.id} ${p.isLong ? 'LONG' : 'SHORT'} ${p.market} ${usd(p.margin * p.leverage)} @ ${px(p.entry, instById(p.instrumentId))}</option>`);
    sel.innerHTML = options.length ? options.join('') : '<option value="">No open positions</option>';
    if ([...sel.options].some((x) => x.value === keep)) sel.value = keep;
    $('o-add-close').disabled = !options.length || submitting;

    $('o-staged').innerHTML = staged.map((x, i) => `<div><span>${i + 1}. ${describe(x)}</span><button class="x" data-i="${i}" title="Remove" aria-label="Remove">✕</button></div>`).join('');
    const d = readDistance();
    $('o-distance-note').textContent = d.error ? '⚠' : d.distance === null ? '' : 'places';
    $('o-distance-note').className = d.error ? 'bad' : '';
    $('o-guard-help').textContent = d.error ? d.error
      : d.distance === null ? 'Optional: cancel the batch if its orders drift apart in the queue.'
      : staged.length === 1 ? 'Only applies to batches of 2 or more orders; a single order is sent without the guard.'
      : `While all ${staged.length || 'the'} orders are still queued, if they end up more than ${d.distance} places apart, or one is refused or expires, they are all cancelled. Once one executes, nothing is cancelled.`;
    $('o-guard-help').className = `small ${d.error ? 'bad' : ''}`;
    const g = readMaxPending(), live = computeStatus(snapshot);
    $('o-maxpending-note').textContent = g.error ? '⚠' : g.maxPending === null ? '' : 'tx';
    $('o-maxpending-note').className = g.error ? 'bad' : '';
    $('o-gate-help').textContent = g.error ? g.error
      : g.maxPending === null ? 'Sends as soon as you submit.'
      : `Waits until Papertrade has fewer than ${g.maxPending} pending transactions (now ${live.pending === null ? 'unknown' : live.pending}), then sends.`;
    $('o-gate-help').className = `small ${g.error ? 'bad' : live.pending !== null && g.maxPending !== null && live.pending >= g.maxPending ? 'warn' : ''}`;
    const oi = readOiBuffer(), sides = oiSides(staged);
    $('o-oibuffer-note').textContent = oi.error ? '⚠' : oi.oiBuffer === null ? '' : 'M USD';
    $('o-oibuffer-note').className = oi.error ? 'bad' : '';
    const rooms = sides.map((x) => ({ ...x, room: oiRoomUsd(x.market, x.isLong, { anyAge: true }) })); // display only; sending needs fresh caps
    $('o-oi-help').textContent = oi.error ? oi.error
      : oi.oiBuffer === null ? 'No open-interest cap check.'
      : !sides.length ? `Opens wait until their side's cap has more than ${fmtM(oi.oiBuffer)} of room (closes aren't checked).`
      : `Waits until ${rooms.map((x) => `${sideName(x)} has more than ${fmtM(oi.oiBuffer)} of room (now ${x.room === null ? 'unknown' : fmtM(x.room)})`).join(' and ')}, then sends.`
        + (rooms.some((x) => x.room !== null && x.room < oi.oiBuffer) ? ' Papertrade itself accepts any open smaller than the room; lower the buffer to send sooner.' : '');
    $('o-oi-help').className = `small ${oi.error ? 'bad' : oi.oiBuffer !== null && rooms.some((x) => x.room !== null && x.room < oi.oiBuffer) ? 'warn' : ''}`;
    const submit = $('o-submit');
    submit.disabled = !staged.length || submitting || !!d.error || !!g.error || !!oi.error;
    submit.textContent = submitting ? 'Sending…' : staged.length ? `Submit ${staged.length} order${staged.length > 1 ? 's' : ''}` : 'Add orders to submit';

    $('o-batches').innerHTML = batches.slice(0, 3).map(renderBatch).join('');
  }

  function renderBatch(b) {
    const time = new Date(b.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const g = b.guard;
    if (b.state === 'waiting') {
      const why = holdReason(b) ?? 'sending…';
      const waited = Math.round((Date.now() - b.at) / 1000);
      const rows = b.orders.map((r) => `<div><span>${describe(r)}</span><span>waiting</span></div>`).join('');
      return `<div class="batch"><div class="bhead"><span>Batch ${time}</span><span class="warn">waiting: ${why} · ${waited < 120 ? `${waited}s` : `${Math.round(waited / 60)}m`} <button class="link" data-cancel-batch="${b.id}">cancel</button></span></div>${rows}</div>`;
    }
    if (b.state === 'failed') {
      return `<div class="batch"><div class="bhead"><span>Batch ${time}</span><span class="bad">not sent: ${b.note}</span></div>${b.orders.map((r) => `<div><span>${describe(r)}</span><span>not sent</span></div>`).join('')}</div>`;
    }
    if (b.state === 'withdrawn') {
      return `<div class="batch"><div class="bhead"><span>Batch ${time}</span><span>${b.note}</span></div>${b.orders.map((r) => `<div><span>${describe(r)}</span><span>not sent</span></div>`).join('')}</div>`;
    }
    const guard = b.distance === null ? `<span>${b.orders.length < 2 ? 'single order' : 'no queue guard'}</span>`
      : g.state === 'tripped' ? `<span class="bad">guard tripped: ${g.note}</span>`
      : g.state === 'done' ? `<span class="ok">kept together (≤ ${b.distance})</span>`
      : g.state === 'released' ? `<span class="ok">guard off: ${g.note}</span>`
      : g.state === 'checking' ? '<span class="warn">guard: re-checking the queue…</span>'
      : `<span class="${g.spread !== null && g.spread > b.distance * 0.7 ? 'warn' : ''}">spread ${g.spread ?? '…'} / ${b.distance}</span>`;
    const now = Date.now();
    const rows = b.orders.map((r) => {
      const age = Math.round((now - r.sentAt) / 1000);
      const state = r.state === 'queued'
        ? `<span class="warn">${r.rank ? `#${r.rank}` : r.leftQueue ? 'sent to chain' : 'queued'} · ${age < 120 ? `${age}s` : `${Math.round(age / 60)}m`}</span>`
        : r.state === 'cancelling' ? '<span class="warn">cancelling…</span>'
        : r.state === 'filled' ? `<span class="ok">${r.kind === 'close' ? 'closed' : 'filled'}${r.detail ? ` ${r.detail}` : ''}</span>`
        : r.state === 'signing' || r.state === 'sending' ? `<span>${r.state}…</span>`
        : `<span class="bad">${r.state}${r.detail ? `: ${r.detail}` : ''}</span>`;
      return `<div><span>${describe(r)}</span>${state}</div>`;
    }).join('');
    return `<div class="batch"><div class="bhead"><span>Batch ${time}</span>${guard}</div>${rows}</div>`;
  }

  const REFUSAL = {
    openInterest: 'open-interest cap reached on that side',
    funding: 'not enough available balance',
    belowMinimum: 'margin below the minimum',
    belowMinimumNotional: 'size below the minimum',
    leverageTooHigh: 'leverage too high',
    positionTooLarge: 'position too large',
    marketPaused: 'market paused',
    tradingPaused: 'trading paused',
    inactiveInstrument: 'market not active',
    noOpenPositions: 'position already closed',
    intake_action_paused: 'paused by Papertrade',
    unauthorized_intent: 'session key not accepted (expired or not registered?)',
    invalid_intent: 'signed order rejected as invalid',
    deadline_expired: 'signed order expired',
    intent_conflict: 'conflicts with another pending order',
    rate_limited: 'rate-limited; wait a moment',
  };
  const refusal = (json, status) => { const code = json.reason || json.code || json.error || `HTTP ${status}`; return REFUSAL[code] ?? code; };

  let submitting = false;
  let batchSeq = 0;
  async function submitBatch() {
    if (!staged.length || submitting) return;
    const { distance: wanted, error } = readDistance();
    const distance = staged.length >= 2 ? wanted : null; // the queue guard only makes sense for 2+ orders
    if (error) return flashError(error);
    const gate = readMaxPending();
    if (gate.error) return flashError(gate.error);
    const oi = readOiBuffer();
    if (oi.error) return flashError(oi.error);
    const sides = oiSides(staged);
    if (oi.oiBuffer !== null && sides.length) await loadTrading(); // decide on fresh caps, not the last 60s poll
    if (acct.available !== null && stagedMargin() > acct.available + 1e-9) return flashError(`These orders' margin exceeds your available ${usd(acct.available)}.`);
    // The web app won't cancel when the session key expires within ~1 hour; the guard needs to be able to.
    const exp = sk.local && sk.onchain[sk.local.address];
    if (distance !== null && exp && Number(exp) * 1000 < Date.now() + 2 * 3600_000) {
      return flashError('The session key expires within 2 hours, so the guard might not be able to cancel. Replace the key first.');
    }
    const now = computeStatus(snapshot);
    const hold = holdReason({ maxPending: gate.maxPending, oiBuffer: oi.oiBuffer, orders: staged });
    const waitNow = hold !== null;
    const rooms = sides.map((x) => `${sideName(x)} ${(() => { const r = oiRoomUsd(x.market, x.isLong); return r === null ? 'unknown' : fmtM(r); })()}`).join(', ');
    const ok = confirm(
      `Submit ${staged.length} order${staged.length > 1 ? 's' : ''} at once:\n\n` +
      staged.map((x, i) => `${i + 1}. ${describe(x)}`).join('\n') +
      `\n\nTotal margin for opens: ${usd(stagedMargin())}` +
      (now.congestion ? `\nQueue congestion: ${now.congestion} (${now.pending} pending tx)` : '') +
      (gate.maxPending === null ? '\nPending tx gate: off' : `\nPending tx gate: below ${gate.maxPending} (now ${now.pending ?? 'unknown'})`) +
      (oi.oiBuffer === null ? '\nOI cap buffer: off'
        : sides.length ? `\nOI cap buffer: more than ${fmtM(oi.oiBuffer)} of room on ${sides.map(sideName).join(' and ')} (now ${rooms})`
        : '\nOI cap buffer: not needed (no opens)') +
      (waitNow ? `\nSend: WAIT (${hold}). The batch is signed and sent automatically once every check passes; you can cancel it while it waits. Keep this tab open.`
        : '\nSend: now') +
      (distance === null ? (wanted !== null && staged.length < 2 ? '\nQueue guard: off (single order)' : '\nQueue guard: off')
        : `\nQueue guard: keep every order within ${distance} queue positions of each other. While all are still queued, if they drift further apart, or any order is refused or expires, they are all cancelled. Once any order executes, nothing is cancelled.`) +
      `\n\nSigned by this extension's session key and sent to Papertrade's queue. Opens fill at the market price when executed; unexecuted orders expire after 1 hour.`);
    if (!ok) return;

    const batch = {
      id: ++batchSeq, at: Date.now(), distance, maxPending: gate.maxPending, oiBuffer: oi.oiBuffer, state: waitNow ? 'waiting' : 'sending', note: '',
      orders: staged.map((x) => ({ ...x, state: waitNow ? 'waiting' : 'signing', detail: '', rank: null, leftQueue: false, sentAt: Date.now() })),
      guard: { state: 'watching', spread: null, note: '' },
    };
    staged = [];
    batches.unshift(batch);
    renderOrder();
    if (!waitNow) await sendBatch(batch);
  }

  // Waiting batches go out the moment every check passes: pending tx below the limit and enough OI cap room
  // (never on stale data: holdReason treats an old snapshot or old market rules as "unknown").
  function checkWaiting() {
    for (const b of [...batches].reverse()) { // oldest first
      if (b.state === 'waiting' && !submitting && holdReason(b) === null) sendBatch(b);
    }
  }

  function withdrawBatch(id, note) {
    const b = batches.find((x) => x.id === id);
    if (!b || b.state !== 'waiting') return;
    b.state = 'withdrawn';
    b.note = note;
    for (const r of b.orders) { r.state = 'cancelled'; r.detail = 'not sent'; }
    renderOrder();
  }

  // Re-check (things may have changed while the batch waited), sign everything, then send it all at once.
  async function sendBatch(batch) {
    if (submitting) return;
    submitting = true;
    batch.state = 'sending';
    for (const r of batch.orders) r.state = 'signing';
    renderOrder();
    try {
      const margin = batch.orders.reduce((a, r) => a + (r.kind === 'open' ? r.margin : 0), 0);
      if (acct.available !== null && margin > acct.available + 1e-9) throw new Error(`margin ${usd(margin)} is now more than your available ${usd(acct.available)}`);
      for (const r of batch.orders) {
        if (r.kind === 'close' && !acct.positions.has(r.positionId)) throw new Error(`position #${r.positionId} is no longer open`);
        if (r.kind === 'open') {
          const inst = trading?.inst?.[r.market];
          if (!inst || trading.tradingPaused || trading.paused.includes('openPosition') || !inst.active || inst.paused || inst.terminal || inst.closeOnly) throw new Error(`${r.market} isn't open for new positions right now`);
        }
      }
      // Sign everything first: if any signature fails, nothing is sent.
      const signed = [];
      for (const r of batch.orders) {
        const res = r.kind === 'open'
          ? await worker('order:open', { instrumentId: r.instrumentId, isLong: r.isLong, marginRaw: toWad(r.marginStr), leverage: r.leverage })
          : await worker('order:close', { positionIds: [r.positionId] });
        signed.push(res);
      }
      // Then send them all at the same moment.
      for (const r of batch.orders) r.state = 'sending';
      renderOrder();
      const sentAt = Date.now();
      await Promise.all(batch.orders.map(async (r, i) => {
        r.sentAt = sentAt;
        try {
          const res = await fetch(`${API}/intents`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(signed[i].body) });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json.error || json.ok === false) { r.state = 'refused'; r.detail = refusal(json, res.status); }
          else { r.intentId = json.intentId ?? signed[i].intentId; r.state = 'queued'; }
        } catch (err) {
          r.state = 'error';
          r.detail = `couldn't reach Papertrade (${err.message}); check your positions`;
        }
      }));
      batch.state = 'sent';
    } catch (err) {
      // A failed re-check or signature: nothing was sent.
      for (const r of batch.orders) if (r.state === 'signing' || r.state === 'sending') { r.state = 'error'; r.detail = 'not sent'; }
      batch.state = 'failed';
      batch.note = err.message;
      flashError(`Batch not sent: ${err.message}.`);
    } finally {
      submitting = false;
      evaluateGuard(batch);
      pollRanks();
      renderOrder();
    }
  }

  // "12.5" → "12500000000000000000" (18 decimals), without floating point.
  function toWad(str) {
    const [i, f = ''] = str.split('.');
    return (BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString();
  }

  // ---- Tracking ----
  const allOrders = () => batches.flatMap((b) => b.orders);

  function onPosition(t) {
    const inst = instById(t[1]);
    const pos = { id: String(t[0]), instrumentId: t[1], market: inst?.symbol ?? `#${t[1]}`, isLong: t[2], entry: Number(t[4]) / (inst?.priceScale ?? 1),
      margin: Number(BigInt(t[5])) / 1e18, leverage: t[6],
      entryRaw: BigInt(t[4]), marginRaw: BigInt(t[5]), bustRaw: BigInt(t[7]), openedAtMs: t[8], intentId: t[9] };
    acct.positions.set(pos.id, pos);
    const r = allOrders().find((x) => x.kind === 'open' && x.intentId && x.intentId === t[9]);
    if (r && r.state !== 'filled') { r.state = 'filled'; r.detail = `@ ${px(pos.entry, inst)}`; r.rank = null; }
  }

  function onClosed(c) {
    const id = String(c[0]);
    acct.positions.delete(id);
    const r = allOrders().find((x) => x.kind === 'close' && x.positionId === id && (x.state === 'queued' || x.state === 'cancelling'));
    if (r) { r.state = 'filled'; r.detail = `${Number(BigInt(c[6])) >= 0 ? '+' : ''}${usd(Number(BigInt(c[6])) / 1e18)}${c[5] ? ' (liquidated)' : ''}`; r.rank = null; }
  }

  function onOutcome(intentId, outcome) {
    const r = allOrders().find((x) => x.intentId === intentId);
    if (r && (r.state === 'queued' || r.state === 'cancelling') && outcome !== 'succeeded') { r.state = outcome; r.rank = null; } // expired / failed / cancelled
    for (const b of batches) if (b.orders.includes(r)) evaluateGuard(b);
  }

  // Queue ranks for this account's queued intents (1 = next in line).
  let rankTimer = null;
  async function pollRanks() {
    clearTimeout(rankTimer);
    const pending = allOrders().filter((r) => r.state === 'queued' || r.state === 'cancelling');
    if (!pending.length || !sk.master) return;
    try {
      const d = await (await fetch(`${API}/queue-rank/accounts/${sk.master}`, { cache: 'no-store' })).json();
      const ranks = Object.fromEntries((d.entries ?? []).map((e) => [e.intentId, Number(e.position)]));
      for (const r of pending) {
        if (ranks[r.intentId]) { r.rank = ranks[r.intentId]; r.seenInQueue = true; }
        else if (r.seenInQueue) { r.rank = null; r.leftQueue = true; } // out of the queue: handed to the chain (or about to fill/close)
      }
      for (const b of batches) evaluateGuard(b);
      renderOrder();
    } catch { /* try again next tick */ }
    rankTimer = setTimeout(pollRanks, 2000);
  }

  // The queue-distance guard: while every order of the batch is still queued, keep their ranks within the
  // distance; cancel the rest if they drift apart or one is refused / expires. Once ANY order of the batch has
  // executed (filled, closed, or left the queue for the chain), the guard stands down for good: cancelling the
  // others then would leave exactly the half-batch it exists to prevent.
  const executedOrder = (b) => b.orders.find((r) => r.state === 'filled' || r.leftQueue);
  function standDown(b, r) {
    b.guard.state = 'released';
    b.guard.note = `${describe(r)} ${r.state === 'filled' ? (r.kind === 'close' ? 'closed' : 'filled') : 'went to chain'}; nothing cancelled`;
  }

  function evaluateGuard(b) {
    if (b.state === 'waiting' || b.state === 'withdrawn' || b.state === 'failed') return;
    if (b.distance === null || ['tripped', 'done', 'released', 'checking'].includes(b.guard.state)) return;
    const ex = executedOrder(b);
    if (ex) return standDown(b, ex);
    const queued = b.orders.filter((r) => r.state === 'queued');
    const broken = b.orders.find((r) => BAD.has(r.state));
    if (broken && queued.length) return trip(b, () => {
      const nowBroken = b.orders.find((r) => BAD.has(r.state));
      return nowBroken ? `${describe(nowBroken)} was ${nowBroken.state}` : null;
    });
    if (!queued.length && !b.orders.some((r) => r.state === 'cancelling' || r.state === 'signing' || r.state === 'sending')) {
      b.guard.state = broken ? 'tripped' : 'done';
      if (broken && !b.guard.note) b.guard.note = `${describe(broken)} was ${broken.state}; nothing left to cancel`;
      return;
    }
    const spread = () => {
      const pos = b.orders.filter((r) => r.state === 'queued').map((r) => r.rank);
      return pos.length && pos.every(Boolean) ? Math.max(...pos) - Math.min(...pos) : null; // wait until every order has a rank
    };
    b.guard.spread = spread();
    if (b.guard.spread !== null && b.guard.spread > b.distance) {
      trip(b, () => { const s = spread(); return s !== null && s > b.distance ? `spread ${s} > ${b.distance}` : null; });
    }
  }

  // Before cancelling anything, re-read the queue fresh: if any order of the batch has meanwhile left it (or
  // filled), stand down instead; if the reason no longer holds, keep watching. `reason()` re-checks it on the
  // fresh ranks and returns the note, or null.
  async function trip(b, reason) {
    b.guard.state = 'checking';
    renderOrder();
    let ranks;
    try {
      const d = await (await fetch(`${API}/queue-rank/accounts/${sk.master}`, { cache: 'no-store' })).json();
      if (!Array.isArray(d.entries)) throw new Error('no queue data');
      ranks = Object.fromEntries(d.entries.map((e) => [e.intentId, Number(e.position)]));
    } catch {
      b.guard.state = 'watching'; // couldn't confirm: don't cancel on stale data; the next poll re-evaluates
      renderOrder();
      return;
    }
    let unsure = false;
    for (const r of b.orders) {
      if (r.state !== 'queued') continue;
      if (ranks[r.intentId]) { r.rank = ranks[r.intentId]; r.seenInQueue = true; }
      else if (r.seenInQueue) { r.rank = null; r.leftQueue = true; } // gone from the queue: executing (or executed), never cancel around it
      else unsure = true; // never seen in the queue yet: it may already have executed, or not be listed yet
    }
    const ex = executedOrder(b);
    if (ex) { standDown(b, ex); renderOrder(); return; }
    if (unsure) { b.guard.state = 'watching'; renderOrder(); return; } // decide once every order is accounted for
    const why = reason();
    if (!why) { b.guard.state = 'watching'; renderOrder(); return; }
    b.guard.state = 'tripped';
    const toCancel = b.orders.filter((r) => r.state === 'queued');
    b.guard.note = `${why}; cancelling ${toCancel.length}`;
    for (const r of toCancel) cancelOrder(r, b);
    renderOrder();
  }

  async function cancelOrder(r, b) {
    r.state = 'cancelling';
    renderOrder();
    try {
      const { path, body } = await worker('order:cancel', { intentId: r.intentId });
      const res = await fetch(`${API}${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || json.ok === false) {
        // Usually: it already left the queue (sent to chain or filled), so it can't be cancelled any more.
        r.state = r.state === 'cancelling' ? 'queued' : r.state;
        r.cancelError = refusal(json, res.status);
        b.guard.note += ` · couldn't cancel ${describe(r)}: ${r.cancelError}`;
      } else if (r.state === 'cancelling') {
        r.state = 'cancelled';
      }
    } catch (err) {
      if (r.state === 'cancelling') r.state = 'queued';
      b.guard.note += ` · cancel failed for ${describe(r)}: ${err.message}`;
    }
    renderOrder();
  }

  // ---- Wiring ----
  for (const b of $('o-market').querySelectorAll('button')) b.addEventListener('click', () => { form.market = b.dataset.market; renderOrder(); });
  for (const id of ['o-margin', 'o-lev', 'o-distance', 'o-maxpending', 'o-oibuffer']) {
    $(id).addEventListener('input', () => renderOrder());
    // Keep typing in the panel from triggering the site's keyboard shortcuts.
    for (const ev of ['keydown', 'keyup', 'keypress']) $(id).addEventListener(ev, (e) => e.stopPropagation());
  }
  $('o-add-long').addEventListener('click', () => stageOpen(true));
  $('o-add-short').addEventListener('click', () => stageOpen(false));
  $('o-add-close').addEventListener('click', stageClose);
  $('o-staged').addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (!x) return;
    staged.splice(Number(x.dataset.i), 1);
    renderOrder();
  });
  $('o-submit').addEventListener('click', submitBatch);
  $('st-amount').addEventListener('input', () => { if (stake.cls === 'bad') stake.msg = ''; renderStake(); });
  for (const ev of ['keydown', 'keyup', 'keypress']) $('st-amount').addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'keydown' && e.key === 'Enter') doStake(); });
  $('st-max').addEventListener('click', () => { const f = freePaper(); if (f) { $('st-amount').value = fromWad(f); renderStake(); } });
  $('st-submit').addEventListener('click', doStake);
  $('o-batches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cancel-batch]');
    if (b) withdrawBatch(Number(b.dataset.cancelBatch), 'cancelled while waiting');
  });
  setInterval(() => { checkWaiting(); if (batches.some((b) => b.state === 'waiting')) renderOrder(); }, 1_000);
  loadTrading();
  loadMids();
  setInterval(loadTrading, 60_000);
  // While a batch waits on OI room, or opens are staged, keep the caps fresh enough for the check (15s limit).
  setInterval(() => {
    const needs = batches.some((b) => b.state === 'waiting' && b.oiBuffer !== null && oiSides(b.orders).length)
      || (!$('order').hidden && oiSides(staged).length);
    if (needs) loadTrading();
  }, 5_000);
  setInterval(() => !$('order').hidden && loadMids(), 3_000);
  setInterval(() => allOrders().some((r) => r.state === 'queued') && renderOrder(), 1_000);

  async function initSession() {
    try {
      const { accounts } = await bridge('accounts', { prompt: false }, 10_000);
      sk.master = accounts[0] ?? null;
      await refreshLocal();
      if (sk.master) watchAccount();
    } catch (err) {
      setMsg(err.message, 'bad');
    }
    renderSession();
    setInterval(() => sk.local?.pending?.submittedAt && renderSession(), 5_000); // keeps "submitted Ns ago" fresh
  }

  // ---- Full-screen mode ----
  // A Papertrade tab opened with ⤢ renders this dashboard over the whole page. It is still a Papertrade
  // page, so the socket, the API and Rabby all work exactly as in the overlay.
  const WAD = 10n ** 18n, MAX36 = 10n ** 36n, HUGE = (1n << 256n) - 1n;

  // Exact port of Papertrade's valuation (src/lib/papertrade.ts `adjustedPnl`): losses linear and capped at
  // the margin; wins measured 0.2 bps less favourably (entry / 50000), then scaled by the impact haircut.
  function adjustedPnl(p, inst, markRaw) {
    const entry = p.entryRaw, threshold = entry / 50_000n;
    let exit = markRaw;
    if (p.isLong) { if (markRaw > entry + threshold) exit = markRaw - threshold; else if (markRaw > entry) exit = entry; }
    else { if (markRaw + threshold < entry) exit = markRaw + threshold; else if (markRaw < entry) exit = entry; }
    const move = p.isLong ? exit - entry : entry - exit;
    const raw = (p.marginRaw * BigInt(p.leverage) * move) / entry;
    if (raw <= 0n) return raw < -p.marginRaw ? -p.marginRaw : raw;
    const absMove = exit > entry ? exit - entry : entry - exit;
    if (absMove === 0n) return 0n;
    const ratio = (absMove * WAD) / entry;
    const rateTerm = (ratio * inst.rateMultiplierRaw) / WAD;
    const b = rateTerm > 0n ? MAX36 / rateTerm : HUGE;
    const sizeTerm = (1_000_000n * ratio * inst.positionMultiplierRaw) / WAD;
    const sT = sizeTerm > 0n ? (inst.referenceNotionalRaw * WAD) / sizeTerm : HUGE;
    if (b > MAX36 || sT > MAX36) return 0n;
    const factor = ((WAD - inst.baseRateRaw) * WAD) / (WAD + b + sT);
    return (raw * factor) / WAD;
  }
  const linearPnl = (p, markRaw) => {
    const v = (p.marginRaw * BigInt(p.leverage) * (p.isLong ? markRaw - p.entryRaw : p.entryRaw - markRaw)) / p.entryRaw;
    return v < -p.marginRaw ? -p.marginRaw : v;
  };
  const payout = (pnl) => (pnl <= 0n || full.winFeeRaw === null ? pnl : pnl - (pnl * full.winFeeRaw) / WAD);
  const riskPct = (p, markRaw) => {
    const room = p.isLong ? p.entryRaw - p.bustRaw : p.bustRaw - p.entryRaw;
    const adverse = p.isLong ? p.entryRaw - markRaw : markRaw - p.entryRaw;
    return room <= 0n || adverse <= 0n ? 0 : adverse >= room ? 100 : Number((adverse * 10000n) / room) / 100;
  };
  const toRawPx = (px, scale) => { const [i = '', f = ''] = String(px).split('.'); return (BigInt(i + f) * scale) / 10n ** BigInt(f.length); };
  const wadNum = (v) => Number(v) / 1e18;
  const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`;
  const tone = (v) => (v > 0 ? 'ok' : v < 0 ? 'bad' : '');
  const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDur = (ms) => { const s = Math.max(0, ms / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`; };

  // The mark Papertrade settles at: the Hyperliquid best bid/ask midpoint (frozen mid on a settled market).
  function markOf(inst) {
    if (inst.terminal && inst.frozenBidRaw !== null && inst.frozenAskRaw !== null) return (inst.frozenBidRaw + inst.frozenAskRaw) / 2n;
    return full.marks[inst.symbol] ?? null;
  }
  function watchBbo() {
    let ws, retry;
    const connect = () => {
      ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
      ws.onopen = () => { for (const coin of Object.keys(trading?.inst ?? { BTC: 1, ETH: 1 })) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } })); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.channel !== 'bbo') return;
        const inst = trading?.inst?.[m.data?.coin];
        const [bid, ask] = m.data?.bbo ?? [];
        if (inst && bid && ask) full.marks[inst.symbol] = (toRawPx(bid.px, inst.priceScaleRaw) + toRawPx(ask.px, inst.priceScaleRaw)) / 2n;
      };
      ws.onclose = () => { clearTimeout(retry); retry = setTimeout(connect, 2000); };
    };
    connect();
  }
  async function loadWinFee() {
    try {
      const res = await fetch('https://rpc.hyperliquid.xyz/evm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x6cd5661646289fb6e65ea5c032310fded797d0a2', data: '0x48ee5e08' }, 'latest'] }) });
      full.winFeeRaw = BigInt((await res.json()).result);
    } catch { /* keep the last value; PnL shows pre-fee until it loads */ }
  }
  async function loadHistory(more = false) {
    if (!sk.master || full.historyLoading) return;
    if (more && full.histFor !== sk.master) more = false;
    full.historyLoading = true;
    try {
      // Like the web app: `filter=all` on every page (the cursor encodes it; without it page 2 is refused).
      const q = new URLSearchParams({ limit: '75', filter: 'all' });
      if (more && full.cursor) q.set('cursor', full.cursor);
      q.sort(); // Papertrade refuses query parameters that aren't in alphabetical order
      const d = await (await fetch(`${API}/query/accounts/${sk.master}/trades?${q}`, { cache: 'no-store' })).json();
      const items = d.items ?? [];
      const next = d.nextCursor ?? null;
      if (full.histFor !== sk.master) { full.history = []; full.cursor = null; full.page = 0; full.histFor = sk.master; }
      const known = new Set(full.history.map((h) => `${h.txHash}:${h.positionId}`));
      const fresh = items.filter((x) => !known.has(`${x.txHash}:${x.positionId}`));
      if (more) {
        full.history = [...full.history, ...fresh];
        full.cursor = next === full.cursor ? null : next; // a repeated cursor means there's nothing further
      } else if (!full.history.length) {
        full.history = items;
        full.cursor = next;
      } else {
        full.history = [...fresh, ...full.history]; // newly closed trades; keep the pages already loaded (and their cursor)
      }
      full.historyStale = false;
    } catch { /* retried on the next refresh */ }
    full.historyLoading = false;
    renderFull();
  }
  async function pollAccountRanks() {
    if (!sk.master || !acct.ops.size) { full.ranks = {}; return; }
    try {
      const d = await (await fetch(`${API}/queue-rank/accounts/${sk.master}`, { cache: 'no-store' })).json();
      full.ranks = Object.fromEntries((d.entries ?? []).map((e) => [e.intentId, Number(e.position)]));
    } catch { /* next tick */ }
  }

  // Position size in the asset's units: notional / entry price (e.g. 1.2312 BTC).
  const shares = (notional, entry) => {
    if (!(entry > 0)) return '–';
    const n = notional / entry;
    return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 1 : n >= 100 ? 2 : n >= 1 ? 4 : 6 });
  };

  function renderFull() {
    if (!full.on) return;
    const st = computeStatus(snapshot);
    $('f-net').innerHTML = st.live
      ? `<span>congestion <b class="${st.congestion === 'HIGH' ? 'bad' : st.congestion === 'MEDIUM' ? 'warn' : 'ok'}">${st.congestion}</b></span><span>pending <b>${num(st.pending)}</b></span><span>avg tx/block <b>${st.avgTx?.toFixed(1)}</b></span><span>clear <b>${fmtClear(st.clearS)}</b></span><span>block <b>#${num(st.block)}</b></span>`
      : '<span class="warn">network status unavailable</span>';
    $('f-account').textContent = sk.master ? `${short(sk.master)}${sk.local ? ` · key ${short(sk.local.address)}` : ''}` : 'wallet not connected';

    // Positions, valued exactly like the Papertrade UI.
    let adjustedSum = 0n, payoutSum = 0n, costSum = 0n, marginSum = 0n, notionalSum = 0n, priced = true;
    const rows = [...acct.positions.values()].sort((a, b) => Number(b.id) - Number(a.id)).map((p) => {
      const inst = instById(p.instrumentId);
      const scale = inst ? inst.priceScale : null; // prices are computed here, so a snapshot that beat the market rules still shows right
      const price = (raw) => (scale ? px(Number(raw) / scale, inst) : '–');
      const mark = inst && markOf(inst);
      marginSum += p.marginRaw;
      notionalSum += p.marginRaw * BigInt(p.leverage);
      let pnlCell = '<td>–</td>', costCell = '<td>–</td>', riskCell = `<td>${price(p.bustRaw)}</td>`, markCell = '<td>–</td>';
      if (inst && mark) {
        const adj = adjustedPnl(p, inst, mark), pay = payout(adj), lin = linearPnl(p, mark);
        const cost = lin > adj ? lin - adj + (adj - pay) : adj - pay;
        adjustedSum += adj; payoutSum += pay; costSum += cost > 0n ? cost : 0n;
        const pct = (wadNum(pay) / wadNum(p.marginRaw)) * 100;
        const risk = riskPct(p, mark);
        // Move since entry, signed for the side: positive = in the position's favour.
        const move = ((Number(mark) - Number(p.entryRaw)) / Number(p.entryRaw)) * 100 * (p.isLong ? 1 : -1);
        markCell = `<td>${price(mark)}<span class="sub ${move > 0 ? 'ok' : move < 0 ? 'bad' : ''}">${move >= 0 ? '+' : ''}${move.toFixed(2)}%</span></td>`;
        pnlCell = `<td class="${tone(wadNum(pay))}">${signed(wadNum(pay))}<span class="sub">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% of margin</span></td>`;
        costCell = `<td>${cost > 0n ? usd(wadNum(cost)) : '<span class="small">none</span>'}${cost > 0n && lin > 0n ? `<span class="sub">${((wadNum(cost) / wadNum(lin)) * 100).toFixed(1)}%</span>` : ''}</td>`;
        riskCell = `<td>${price(p.bustRaw)}<span class="sub"><span class="riskbar"><i style="width:${risk}%;background:${risk >= 75 ? 'var(--o-neg)' : risk >= 40 ? 'var(--o-warn)' : 'var(--o-pos)'}"></i></span>${risk.toFixed(0)}% risk</span></td>`;
      } else {
        priced = false;
      }
      const staged_ = staged.some((x) => x.kind === 'close' && x.positionId === p.id);
      return `<tr>
        <td title="Opened ${fmtTime(p.openedAtMs)}">#${p.id}<span class="sub">open ${fmtDur(Date.now() - p.openedAtMs)}</span></td>
        <td>${inst?.symbol ?? p.market} <span class="tag ${p.isLong ? 'LONG' : 'SHORT'}">${p.isLong ? 'LONG' : 'SHORT'}</span></td>
        <td>${p.leverage}×</td>
        <td>${scale ? shares(p.margin * p.leverage, Number(p.entryRaw) / scale) : '–'}</td>
        <td title="${usd(p.margin)} margin × ${p.leverage}">${usd(p.margin * p.leverage)}</td>
        <td>${price(p.entryRaw)}</td>${markCell}${pnlCell}${costCell}${riskCell}
        <td>${staged_ ? '<span class="small">staged</span>' : `<button class="link" data-stage-close="${p.id}">Close</button>`}</td></tr>`;
    });
    $('f-pos').innerHTML = rows.length
      ? `<thead><tr><th>Position<span class="sub">open for</span></th><th>Market</th><th>Leverage</th><th>Size</th><th>Notional</th><th>Entry</th><th>Mark<span class="sub">move</span></th><th>PnL<span class="sub">if closed now</span></th><th>Close cost<span class="sub">of the gain</span></th><th>Bust<span class="sub">risk</span></th><th></th></tr></thead><tbody>${rows.join('')}</tbody>`
      : `<tbody><tr><td class="fempty">${acct.streamLive === false ? 'Waiting for your account from Papertrade…' : 'No open positions.'}</td></tr></tbody>`;
    const posNote = acct.streamLive === false
      ? 'Account stream reconnecting (Papertrade may be rate-limiting); showing the last data received'
      : full.winFeeRaw === null ? 'loading win fee…' : 'marked at the Hyperliquid best bid/ask midpoint · PnL after haircut and 2% win fee';
    $('f-pos-count').textContent = acct.positions.size ? String(acct.positions.size) : '';
    const unstaged = [...acct.positions.keys()].filter((id) => !staged.some((x) => x.kind === 'close' && x.positionId === id));
    $('f-close-all').hidden = full.tab !== 'positions';
    $('f-close-all').disabled = !unstaged.length;

    // Summary cards (equity as the web app computes it).
    const reserved = acct.balanceRaw + acct.queuedRaw - acct.availRaw - acct.availQueuedRaw;
    const equity = acct.availRaw + acct.availQueuedRaw + marginSum + (reserved > 0n ? reserved : 0n) + adjustedSum;
    const card = (label, value, cls = '') => `<div class="fcard"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
    // Net exposure per market: long notional − short notional (margin × leverage), plus the net size in the asset.
    const expo = new Map();
    for (const p of acct.positions.values()) {
      const inst = instById(p.instrumentId), sym = inst?.symbol ?? p.market;
      const e = expo.get(sym) ?? { long: 0, short: 0, units: 0, unitsKnown: true };
      const notional = p.margin * p.leverage, entry = inst ? Number(p.entryRaw) / inst.priceScale : 0;
      e[p.isLong ? 'long' : 'short'] += notional;
      if (entry > 0) e.units += (p.isLong ? 1 : -1) * (notional / entry); else e.unitsKnown = false;
      expo.set(sym, e);
    }
    const usd0 = (v) => (v === 0 ? '$0' : usd(v));
    const expoItems = [...expo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sym, e]) => {
      const net = e.long - e.short;
      const side = Math.abs(net) < 0.005 ? 'flat' : net > 0 ? 'long' : 'short';
      const units = e.unitsKnown ? `${e.units >= 0 ? '+' : '−'}${shares(Math.abs(e.units), 1)} ${sym}` : '';
      return `<span class="fexpo-item"><b>${sym}</b> <span class="fexpo-net">${net > 0 ? '+' : net < 0 ? '−' : ''}${usd0(Math.abs(net))}</span>${side === 'flat' ? '' : ` <span class="tag ${side === 'long' ? 'LONG' : 'SHORT'}">NET ${side.toUpperCase()}</span>`}
        <span class="small">long ${usd0(e.long)} · short ${usd0(e.short)}${units ? ` · ${units}` : ''}</span></span>`;
    });
    $('f-expo').innerHTML = expoItems.length ? `<span class="fexpo-label">Net exposure</span>${expoItems.join('')}` : '';
    $('f-expo').hidden = !expoItems.length;
    $('f-cards').innerHTML = [
      card('Equity', priced ? usd(wadNum(equity)) : '–'),
      card('Open PnL', priced ? signed(wadNum(payoutSum)) : '–', priced ? tone(wadNum(payoutSum)) : ''),
      card('Close cost (winners)', priced ? usd(wadNum(costSum)) : '–', costSum > 0n ? 'warn' : ''),
      card('Available', usd(wadNum(acct.availRaw))),
      card('Margin in use', usd(wadNum(marginSum))),
      card('Open notional', usd(wadNum(notionalSum))),
      card('Positions', String(acct.positions.size)),
      card('Realized PnL (lifetime)', acct.realizedRaw === null ? '–' : signed(wadNum(acct.realizedRaw)), acct.realizedRaw === null ? '' : tone(wadNum(acct.realizedRaw))),
    ].join('');

    // Pending queue: every queued intent on the account, with its place in line.
    const ops = [...acct.ops.values()].sort((a, b) => (full.ranks[a.intentId] ?? 1e9) - (full.ranks[b.intentId] ?? 1e9) || a.acceptedAtMs - b.acceptedAtMs);
    $('f-pend').innerHTML = ops.length
      ? `<thead><tr><th>Rank</th><th>Action</th><th>Detail</th><th>Size</th><th>Waiting</th></tr></thead><tbody>${ops.map((o) => {
          const inst = instById(o.instrumentId);
          const what = o.action === 'openPosition' ? `<span class="tag ${o.isLong ? 'LONG' : 'SHORT'}">${o.isLong ? 'LONG' : 'SHORT'}</span> ${inst?.symbol ?? ''} ${o.leverage}×`
            : o.action === 'closePositions' ? `close ${(o.positionIds ?? []).map((x) => `#${x}`).join(', ')}`
            : o.action === 'paperStake' && o.amountRaw !== null ? `stake ${fmtPaper(o.amountRaw)} PAPER` : o.action;
          const size = o.action === 'openPosition' && o.amountRaw !== null ? usd(wadNum(o.amountRaw) * o.leverage) : '';
          return `<tr><td>${full.ranks[o.intentId] ? `#${full.ranks[o.intentId]}` : '–'}</td><td>${o.action}</td><td>${what}</td><td>${size}</td><td>${fmtDur(Date.now() - o.acceptedAtMs)}</td></tr>`;
        }).join('')}</tbody>`
      : '<tbody><tr><td class="fempty">Nothing queued.</td></tr></tbody>';
    $('f-pend-note').textContent = ops.length ? `${ops.length} queued` : '';

    // Trade history: closed and liquidated positions, entry → exit.
    const pages = Math.max(1, Math.ceil(full.history.length / HIST_PAGE));
    if (full.page >= pages && !full.historyLoading) full.page = pages - 1;
    const from = full.page * HIST_PAGE;
    const h = full.history.slice(from, from + HIST_PAGE);
    $('f-hist').innerHTML = h.length
      ? `<thead><tr><th>Position<span class="sub">held</span></th><th>Market</th><th>Leverage</th><th>Size</th><th>Notional</th><th>Entry → exit<span class="sub">move</span></th><th>PnL<span class="sub">fee</span></th><th>PAPER</th><th>Closed<span class="sub">outcome</span></th></tr></thead><tbody>${h.map((t) => {
          const scale = Number(t.priceScaleRaw) || 1, inst = instById(t.instrumentId);
          const entry = Number(t.entryPriceRaw) / scale, exit = t.exitPriceRaw ? Number(t.exitPriceRaw) / scale : null;
          const net = wadNum(BigInt(t.adjustedPnlRaw ?? '0') - BigInt(t.userPaidFeeRaw ?? '0'));
          const fee = BigInt(t.userPaidFeeRaw ?? '0');
          const move = exit === null ? null : ((exit - entry) / entry) * 100 * (t.isLong ? 1 : -1);
          const liq = t.kind === 'Liquidated';
          const margin = wadNum(BigInt(t.marginRaw));
          return `<tr>
            <td>#${t.positionId}<span class="sub">${t.openedAtMs ? fmtDur(t.timestampMs - t.openedAtMs) : '–'}</span></td>
            <td>${t.symbol} <span class="tag ${t.isLong ? 'LONG' : 'SHORT'}">${t.isLong ? 'LONG' : 'SHORT'}</span></td>
            <td>${t.leverage}×</td>
            <td>${shares(margin * t.leverage, entry)}</td>
            <td title="${usd(margin)} margin × ${t.leverage}">${usd(margin * t.leverage)}</td>
            <td>${px(entry, inst)} → ${exit === null ? '–' : px(exit, inst)}<span class="sub ${move === null ? '' : tone(move)}">${move === null ? '' : `${move >= 0 ? '+' : ''}${move.toFixed(3)}%`}</span></td>
            <td class="${tone(net)}">${signed(net)}<span class="sub">${fee > 0n ? `fee ${usd(wadNum(fee))}` : 'no fee'}</span></td>
            <td>${BigInt(t.paperMintedRaw ?? '0') > 0n ? Math.round(wadNum(BigInt(t.paperMintedRaw))).toLocaleString('en-US') : '–'}</td>
            <td>${fmtTime(t.timestampMs)}<span class="sub ${liq ? 'bad' : ''}">${liq ? 'liquidated' : 'closed'}</span></td></tr>`;
        }).join('')}</tbody>`
      : `<tbody><tr><td class="fempty">${full.historyLoading ? 'Loading…' : 'No closed trades yet.'}</td></tr></tbody>`;
    const more = full.cursor ? '+' : '';
    $('f-page-rows').textContent = h.length ? `${from + 1}–${from + h.length} of ${full.history.length}${more}` : '';
    $('f-page').textContent = `Page ${full.page + 1} of ${pages}${more}`;
    $('f-prev').disabled = full.page === 0;
    $('f-next').disabled = !(from + HIST_PAGE < full.history.length || full.cursor) || full.historyLoading;

    // Tabs.
    for (const b of $('f-tabs').querySelectorAll('[data-ftab]')) b.classList.toggle('on', b.dataset.ftab === full.tab);
    $('f-tab-positions').hidden = full.tab !== 'positions';
    $('f-tab-history').hidden = full.tab !== 'history';
    const note = $('f-tab-note');
    note.textContent = full.tab === 'positions' ? posNote : 'closed and liquidated positions · PnL net of fee';
    note.className = `small ftabnote ${full.tab === 'positions' && acct.streamLive === false ? 'warn' : ''}`;
  }

  async function enterFull() {
    full.on = true;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
    $('full').hidden = false;
    $('pill').hidden = true;
    $('panel').hidden = false;
    $('f-aside').appendChild($('panel')); // the same status / session / order builder, now as the sidebar
    document.documentElement.style.overflow = 'hidden'; // the dashboard covers the page; don't scroll it underneath
    watchBbo();
    loadWinFee();
    setInterval(loadWinFee, 10 * 60_000);
    setInterval(() => { renderFull(); }, 1_000);
    setInterval(() => { if (full.historyStale || Date.now() % 30_000 < 1_000) loadHistory(); }, 1_000);
    setInterval(pollAccountRanks, 2_000);
    renderFull();
  }

  $('fullscreen').addEventListener('click', () => chrome.runtime?.sendMessage?.({ type: 'ui:openFull' }));
  $('f-exit').addEventListener('click', async () => {
    await chrome.runtime?.sendMessage?.({ type: 'ui:leaveFull' }).catch(() => {});
    location.hash = '';
    location.reload();
  });
  $('f-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ftab]');
    if (!b) return;
    full.tab = b.dataset.ftab;
    try { sessionStorage.setItem('pt-full-tab', full.tab); } catch { /* not remembered */ }
    renderFull();
  });
  $('f-prev').addEventListener('click', () => { full.page = Math.max(0, full.page - 1); renderFull(); });
  $('f-next').addEventListener('click', () => {
    full.page++;
    // Fetch the next 75 from Papertrade when this page runs past what's loaded.
    if ((full.page + 1) * HIST_PAGE > full.history.length && full.cursor) loadHistory(true);
    renderFull();
  });
  $('f-close-all').addEventListener('click', () => {
    for (const [id, p] of acct.positions) {
      if (!staged.some((x) => x.kind === 'close' && x.positionId === id)) staged.push({ kind: 'close', positionId: id, snapshot: p });
    }
    renderOrder();
    renderFull();
  });
  $('f-pos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stage-close]');
    if (!b) return;
    if (!staged.some((x) => x.kind === 'close' && x.positionId === b.dataset.stageClose)) {
      staged.push({ kind: 'close', positionId: b.dataset.stageClose, snapshot: acct.positions.get(b.dataset.stageClose) });
    }
    renderOrder();
    renderFull();
  });

  // ---- Wire up ----
  let stop = null;
  let lastRender = 0;
  const start = () => {
    if (stop) return;
    stop = watchPressure((s) => {
      snapshot = s;
      if (!history.length || s.ts - history[history.length - 1].t >= 2_000) history.push({ t: s.ts, pending: s.pendingCount });
      if (Date.now() - lastRender > 250) { lastRender = Date.now(); render(); }
      checkWaiting?.(); // a waiting batch goes out on the first snapshot that's below its limit
    }, (state) => { streamState = state; });
  };
  const halt = () => { stop?.(); stop = null; streamState = 'paused'; };

  // Pause the socket while the tab is in the background; resume when it's back.
  let hiddenTimer;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(halt, HIDDEN_DISCONNECT_MS);
    else start();
  });

  const isFullTab = async () => {
    if (location.hash.includes('papertrade-full')) return true;
    try { return (await chrome.runtime.sendMessage({ type: 'ui:isFull' }))?.result === true; } catch { return false; }
  };
  Promise.all([storage.get(), isFullTab()]).then(([s, fullTab]) => {
    settings = { ...settings, ...s };
    (document.body ?? document.documentElement).appendChild(host);
    applyLayout();
    render();
    start();
    setInterval(render, 1000); // keeps "data Ns old" and the stale state current
    initSession();
    if (fullTab) enterFull();
  });
})();

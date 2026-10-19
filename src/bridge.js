// Page-world bridge to the wallet (Rabby). Runs in the page's own JavaScript context (manifest
// "world": "MAIN"), because that's the only place an injected wallet is reachable; the overlay's content
// script runs in an isolated world and talks to this bridge with window.postMessage.
//
// It does exactly three things, each of which the wallet itself asks you to approve when needed:
//   accounts  → the connected address (eth_accounts, or eth_requestAccounts if `prompt`)
//   sign      → switch to HyperEVM (chain 999) if needed, then eth_signTypedData_v4
// No keys or signatures are stored here.
(() => {
  if (window.__papertradeOverlayBridge) return;
  window.__papertradeOverlayBridge = true;

  const IN = 'papertrade-overlay:request';
  const OUT = 'papertrade-overlay:response';
  const HYPEREVM = {
    chainId: '0x3e7', // 999
    chainName: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    blockExplorerUrls: ['https://hyperevmscan.io'],
  };

  // Prefer Rabby via EIP-6963 wallet discovery (several wallets can fight over window.ethereum).
  const announced = [];
  window.addEventListener('eip6963:announceProvider', (e) => announced.push(e.detail));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const provider = () =>
    announced.find((d) => d.info?.rdns === 'io.rabby')?.provider ??
    window.ethereum?.providers?.find?.((p) => p.isRabby) ??
    window.ethereum;

  async function ensureHyperEvm(eth) {
    const current = await eth.request({ method: 'eth_chainId' });
    if (String(current).toLowerCase() === HYPEREVM.chainId) return;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HYPEREVM.chainId }] });
    } catch (err) {
      if (err?.code !== 4902) throw err; // 4902 = chain not added yet
      await eth.request({ method: 'wallet_addEthereumChain', params: [HYPEREVM] });
    }
  }

  const handlers = {
    async accounts({ prompt }) {
      const eth = provider();
      if (!eth) throw new Error('No wallet found. Install or unlock Rabby.');
      let accounts = await eth.request({ method: 'eth_accounts' });
      if (!accounts?.length && prompt) accounts = await eth.request({ method: 'eth_requestAccounts' });
      return { accounts: (accounts ?? []).map((a) => String(a).toLowerCase()), wallet: eth.isRabby ? 'Rabby' : 'wallet' };
    },
    async sign({ address, typedData }) {
      const eth = provider();
      if (!eth) throw new Error('No wallet found. Install or unlock Rabby.');
      await ensureHyperEvm(eth);
      return eth.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(typedData)] });
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.type !== IN || !handlers[e.data.method]) return;
    const { id, method, params } = e.data;
    try {
      const result = await handlers[method](params ?? {});
      window.postMessage({ type: OUT, id, result }, window.location.origin);
    } catch (err) {
      window.postMessage({ type: OUT, id, error: { message: err?.message ?? String(err), code: err?.code } }, window.location.origin);
    }
  });
})();

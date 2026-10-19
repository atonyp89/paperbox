// Background service worker: owns this extension's Papertrade session key.
//
// - Generates a fresh secp256k1 key per master wallet and keeps it encrypted at rest: the key is
//   sealed with an AES-GCM key that is created non-extractable and lives in this extension's
//   IndexedDB, and only the ciphertext goes to chrome.storage.local. The private key never leaves this
//   worker: content scripts get the session *address* and signed payloads, nothing else.
// - Builds the RegisterSessionKey message for the master wallet to sign (in Rabby), then checks the
//   returned signature really comes from the master wallet before anything is sent.
//
// Signing format and intent ids come from ./intents.ts (tested to match the web app byte for byte).
// Built to chrome-extension/background.js by `npm run build:overlay`.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { cancelIntent, closePositions, openPosition, registrationMessage, seal, typedData, type NonceSource } from './intents';

type Master = string; // lowercase 0x address

interface SessionRecord {
  master: Master;
  address: string; // session key address, lowercase
  iv: number[];
  ciphertext: number[]; // AES-GCM(privateKey)
  createdAt: number;
  // The registration waiting for (or already given) the master wallet's signature.
  pending?: { message: Record<string, string>; createdAt: number; submittedAt?: number; intentId?: string };
}

const STORE = 'papertradeSessions'; // chrome.storage.local key: { [master]: SessionRecord }
const NONCES = 'papertradeNonces'; // { [master]: next session-scope nonce }

// ---- Encryption at rest ----

function wrappingKey(): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('papertrade-overlay', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction('keys').objectStore('keys').get('wrap');
      get.onerror = () => reject(get.error);
      get.onsuccess = async () => {
        if (get.result) return resolve(get.result as CryptoKey);
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const put = db.transaction('keys', 'readwrite').objectStore('keys').put(key, 'wrap');
        put.onerror = () => reject(put.error);
        put.onsuccess = () => resolve(key);
      };
    };
  });
}

async function encrypt(privateKey: Hex) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrappingKey(), new TextEncoder().encode(privateKey));
  return { iv: [...iv], ciphertext: [...new Uint8Array(ct)] };
}

async function decrypt(rec: SessionRecord): Promise<Hex> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv) }, await wrappingKey(), new Uint8Array(rec.ciphertext));
  return new TextDecoder().decode(pt) as Hex;
}

// ---- Storage ----

async function loadAll(): Promise<Record<Master, SessionRecord>> {
  return ((await chrome.storage.local.get(STORE))[STORE] as Record<Master, SessionRecord>) ?? {};
}
async function save(rec: SessionRecord) {
  const all = await loadAll();
  all[rec.master] = rec;
  await chrome.storage.local.set({ [STORE]: all });
}

// Session-scope nonces, persisted. Like the web app, a new counter starts at a random 24-bit value × 256.
async function takeNonce(master: Master): Promise<bigint> {
  const all = ((await chrome.storage.local.get(NONCES))[NONCES] as Record<Master, string>) ?? {};
  const rand = new Uint8Array(3);
  crypto.getRandomValues(rand);
  const fresh = (BigInt((rand[0]! << 16) | (rand[1]! << 8) | rand[2]!) || 1n) * 256n;
  const next = all[master] ? BigInt(all[master]) : fresh;
  all[master] = String(next + 1n);
  await chrome.storage.local.set({ [NONCES]: all });
  return next;
}

const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const fromWire = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, /^\d+$/.test(v) ? BigInt(v) : v])) as Record<string, bigint | string>;

// ---- Actions ----

/** Status for the overlay: no private material. */
async function getSession(master: Master) {
  const rec = (await loadAll())[master];
  if (!rec) return null;
  return { address: rec.address, createdAt: rec.createdAt, pending: rec.pending ? { createdAt: rec.pending.createdAt, submittedAt: rec.pending.submittedAt, intentId: rec.pending.intentId, deadline: rec.pending.message.deadline } : null };
}

/**
 * Create a key for `master` (or reuse the one that isn't registered yet) and return the typed data the
 * master wallet must sign. `replace` forces a brand-new key.
 */
async function prepare(master: Master, replace: boolean) {
  let rec = (await loadAll())[master];
  if (!rec || replace) {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    rec = { master, address: address.toLowerCase(), ...(await encrypt(privateKey)), createdAt: Date.now() };
  }
  const nonce = await takeNonce(master);
  const nonces = { take: () => nonce } satisfies NonceSource;
  const message = registrationMessage(master, rec.address, nonces);
  rec.pending = { message: jsonSafe(message), createdAt: Date.now() };
  await save(rec);
  // eth_signTypedData_v4 wants EIP712Domain spelled out (viem adds it implicitly when hashing; same digest).
  const td = jsonSafe(typedData('RegisterSessionKey', message));
  td.types = {
    EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ],
    ...td.types,
  };
  return { sessionAddress: rec.address, typedData: td };
}

/** Check the master wallet's signature and return the exact POST /intents body. */
async function finalize(master: Master, signature: Hex) {
  const rec = (await loadAll())[master];
  if (!rec?.pending) throw new Error('No registration is waiting for a signature. Start again.');
  if (BigInt(rec.pending.message.deadline!) * 1000n < BigInt(Date.now())) throw new Error('The registration request expired (1 hour). Start again.');
  const intent = await seal('RegisterSessionKey', fromWire(rec.pending.message) as never, { signature, expectedSigner: master });
  rec.pending.intentId = intent.intentId;
  await save(rec);
  return { intentId: intent.intentId, body: { action: intent.action, signed: intent.signed } };
}

async function markSubmitted(master: Master, intentId: string) {
  const rec = (await loadAll())[master];
  if (rec?.pending && rec.pending.intentId === intentId) {
    rec.pending.submittedAt = Date.now();
    await save(rec);
  }
}

async function clearPending(master: Master) {
  const rec = (await loadAll())[master];
  if (rec?.pending) {
    delete rec.pending;
    await save(rec);
  }
}

/** Forget the key in this browser. It stays valid on Papertrade until it expires. */
async function remove(master: Master) {
  const all = await loadAll();
  delete all[master];
  await chrome.storage.local.set({ [STORE]: all });
}

export async function sessionAccount(master: Master) {
  const rec = (await loadAll())[master];
  if (!rec) throw new Error('No session key in this extension for this wallet. Create one first.');
  return privateKeyToAccount(await decrypt(rec));
}

/**
 * Sign an OpenPosition with the session key. Inputs are re-checked here (the content script also checks
 * them against live market rules); the key is decrypted only for this signature.
 */
async function signOpen(master: Master, p: { instrumentId: unknown; isLong: unknown; marginRaw: unknown; leverage: unknown }) {
  const instrumentId = Number(p.instrumentId);
  const leverage = Number(p.leverage);
  if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 0xffffffff) throw new Error('Invalid market');
  if (typeof p.isLong !== 'boolean') throw new Error('Invalid side');
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 1000) throw new Error('Leverage must be a whole number from 1 to 1000');
  if (typeof p.marginRaw !== 'string' || !/^[1-9]\d*$/.test(p.marginRaw)) throw new Error('Invalid margin');
  const marginRaw = BigInt(p.marginRaw);
  if (marginRaw >= 1n << 128n) throw new Error('Margin too large');
  const session = await sessionAccount(master);
  const nonce = await takeNonce(master);
  const intent = await openPosition(session, master, { take: () => nonce } satisfies NonceSource, { instrumentId, isLong: p.isLong, marginRaw, leverage });
  return { intentId: intent.intentId, body: { action: intent.action, signed: intent.signed } };
}

/** Sign a Close for 1–12 of the account's positions (each closes in full). */
async function signClose(master: Master, ids: unknown) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 12 || !ids.every((x) => typeof x === 'string' && /^\d+$/.test(x))) {
    throw new Error('Close takes 1–12 position ids');
  }
  const session = await sessionAccount(master);
  const nonce = await takeNonce(master);
  const intent = await closePositions(session, master, { take: () => nonce } satisfies NonceSource, ids.map((x) => BigInt(x as string)));
  return { intentId: intent.intentId, body: { action: intent.action, signed: intent.signed } };
}

/** Sign a CancelIntent for one of this account's queued intents. */
async function signCancel(master: Master, intentId: unknown) {
  if (typeof intentId !== 'string' || !/^0x[0-9a-f]{64}$/.test(intentId)) throw new Error('Invalid intent id');
  return cancelIntent(await sessionAccount(master), master, intentId);
}

// ---- Messages from the overlay ----

const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// ---- Full-screen tabs: Papertrade tabs opened by the overlay's ⤢ button, which render the full dashboard ----
// Remembered by tab id (session storage), so a reload or in-app navigation keeps the mode.
const FULL_TABS = 'papertradeFullTabs';
const fullTabs = async () => ((await chrome.storage.session.get(FULL_TABS))[FULL_TABS] as number[] | undefined) ?? [];
async function openFull() {
  const tab = await chrome.tabs.create({ url: 'https://exchange.papertrade.xyz/trade/btc#papertrade-full' });
  if (tab.id !== undefined) await chrome.storage.session.set({ [FULL_TABS]: [...(await fullTabs()), tab.id] });
}
chrome.tabs.onRemoved.addListener(async (id) => {
  const tabs = await fullTabs();
  if (tabs.includes(id)) await chrome.storage.session.set({ [FULL_TABS]: tabs.filter((t) => t !== id) });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only our own content script on Papertrade may ask.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith('https://exchange.papertrade.xyz/')) return false;
  if (msg?.type === 'ui:openFull') {
    openFull().then(() => reply({ result: true }), (err) => reply({ error: String(err) }));
    return true;
  }
  if (msg?.type === 'ui:isFull') {
    fullTabs().then((tabs) => reply({ result: sender.tab?.id !== undefined && tabs.includes(sender.tab.id) }));
    return true;
  }
  if (msg?.type === 'ui:leaveFull') {
    fullTabs().then(async (tabs) => {
      await chrome.storage.session.set({ [FULL_TABS]: tabs.filter((t) => t !== sender.tab?.id) });
      reply({ result: true });
    });
    return true;
  }
  const master = typeof msg?.master === 'string' ? msg.master.toLowerCase() : '';
  if (!isAddress(master)) {
    reply({ error: 'Invalid wallet address' });
    return false;
  }
  const run: Record<string, () => Promise<unknown>> = {
    'session:get': () => getSession(master),
    'session:prepare': () => prepare(master, msg.replace === true),
    'session:finalize': () => finalize(master, msg.signature),
    'session:submitted': () => markSubmitted(master, msg.intentId),
    'session:cancel': () => clearPending(master),
    'session:remove': () => remove(master),
    'order:open': () => signOpen(master, msg),
    'order:close': () => signClose(master, msg.positionIds),
    'order:cancel': () => signCancel(master, msg.intentId),
  };
  const fn = run[msg?.type];
  if (!fn) return false;
  fn().then((result) => reply({ result }), (err) => reply({ error: err instanceof Error ? err.message : String(err) }));
  return true; // async reply
});

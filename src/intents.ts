// Signed intents, mirroring what exchange.papertrade.xyz's web app sends to POST /intents.
//
// Trading (OpenPosition, Close, CancelIntent) is signed by a session key on behalf of the master wallet
// (`user`). The session key is authorized once by a RegisterSessionKey intent that the master wallet signs.
// PAPER staking (Stake) is signed by the master wallet itself, on the PaperStaking domain.

import { concat, hashTypedData, keccak256, recoverAddress, parseSignature, stringToBytes, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';

/**
 * Where the next nonce comes from. The web app keeps one counter per scope (`session` for the exchange domain,
 * `paper` for staking), starting at a random 24-bit value × 256 and counting up.
 */
export interface NonceSource {
  take(scope: 'session' | 'paper'): bigint;
}

export const CHAIN_ID = 999; // HyperEVM
export const EXCHANGE = '0x6cd5661646289fb6e65ea5c032310fded797d0a2';
export const PAPER_STAKING = '0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016';
const FEE_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEADLINE_S = 3600; // the web app signs every intent valid for one hour
export const SESSION_TTL_MS = 30 * 24 * 3600_000; // and registers session keys for 30 days

const DOMAINS = {
  exchange: { name: 'String', version: '1', chainId: CHAIN_ID, verifyingContract: EXCHANGE },
  paper: { name: 'PaperStaking', version: '1', chainId: CHAIN_ID, verifyingContract: PAPER_STAKING },
  // Cancelling a queued intent has its own domain (on the exchange contract).
  cancellation: { name: 'PaperTrade Intent Cancel', version: '2', chainId: CHAIN_ID, verifyingContract: EXCHANGE },
} as const;

const TYPES = {
  RegisterSessionKey: [
    { name: 'user', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  OpenPosition: [
    { name: 'user', type: 'address' }, { name: 'instrumentId', type: 'uint32' }, { name: 'isLong', type: 'bool' },
    { name: 'size', type: 'uint128' }, { name: 'leverage', type: 'uint32' }, { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Close: [
    { name: 'user', type: 'address' }, { name: 'positionIds', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Stake: [
    { name: 'user', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  CancelIntent: [{ name: 'user', type: 'address' }, { name: 'intentId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }],
} as const;

type PrimaryType = keyof typeof TYPES;
type Message = Record<string, bigint | boolean | string | bigint[]>;

const ROUTES: Record<PrimaryType, { action: string; domain: keyof typeof DOMAINS }> = {
  RegisterSessionKey: { action: 'registerSessionKey', domain: 'exchange' },
  OpenPosition: { action: 'openPosition', domain: 'exchange' },
  Close: { action: 'closePositions', domain: 'exchange' },
  Stake: { action: 'paperStake', domain: 'paper' },
  CancelIntent: { action: 'cancelIntent', domain: 'cancellation' }, // not a POST /intents action; see cancelIntent()
};

const INTENT_ID_TAG = keccak256(stringToBytes('papertrade:intent-id:v2'));

export interface SignedIntent {
  action: string;
  intentId: Hex;
  signed: Record<string, string | boolean | string[]>;
}

/** The exact EIP-712 payload for `primaryType`, e.g. to sign with an external wallet. */
export function typedData(primaryType: PrimaryType, message: Message) {
  return {
    domain: DOMAINS[ROUTES[primaryType].domain],
    types: { [primaryType]: TYPES[primaryType] },
    primaryType,
    message,
  } as const;
}

// The API wants every field as a string: integers in decimal, addresses and bytes lowercase, bools as-is.
function wire(primaryType: PrimaryType, message: Message): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (const { name, type } of TYPES[primaryType]) {
    const v = message[name];
    out[name] = Array.isArray(v) ? v.map(String) : typeof v === 'boolean' ? v
      : type === 'address' || type.startsWith('bytes') ? String(v).toLowerCase() : String(v);
  }
  return out;
}

/**
 * Attach a signature (from `signer`, or an externally produced `signature`) and derive the
 * intent id the server will report: keccak256(tag ‖ digest ‖ signer).
 */
export async function seal(
  primaryType: PrimaryType,
  message: Message,
  by: { signer: LocalAccount } | { signature: Hex; expectedSigner: string },
): Promise<SignedIntent> {
  const td = typedData(primaryType, message);
  const signature = 'signer' in by ? await by.signer.signTypedData(td as never) : by.signature;
  const digest = hashTypedData(td as never);
  const recovered = (await recoverAddress({ hash: digest, signature })).toLowerCase();
  const expected = 'signer' in by ? by.signer.address.toLowerCase() : by.expectedSigner.toLowerCase();
  if (recovered !== expected) throw new Error(`Signature is from ${recovered}, expected ${expected}`);
  const { r, s, yParity } = parseSignature(signature);
  return {
    action: ROUTES[primaryType].action,
    intentId: keccak256(concat([INTENT_ID_TAG, digest, recovered as Hex])),
    signed: { ...wire(primaryType, message), v: String(27 + (yParity ?? 0)), r: r.toLowerCase(), s: s.toLowerCase() },
  };
}

export const deadline = (nowMs = Date.now()) => BigInt(Math.floor(nowMs / 1000) + DEADLINE_S);

// ---- Builders ----

export async function openPosition(
  session: LocalAccount, user: string, nonces: NonceSource,
  p: { instrumentId: number; isLong: boolean; marginRaw: bigint; leverage: number },
) {
  return seal('OpenPosition', {
    user, instrumentId: BigInt(p.instrumentId), isLong: p.isLong, size: p.marginRaw, leverage: BigInt(p.leverage),
    useDebt: false, nonce: nonces.take('session'), deadline: deadline(),
  }, { signer: session });
}

export async function closePositions(session: LocalAccount, user: string, nonces: NonceSource, positionIds: bigint[]) {
  if (positionIds.length < 1 || positionIds.length > 12) throw new Error('A close takes 1–12 positions');
  return seal('Close', { user, positionIds, nonce: nonces.take('session'), deadline: deadline() }, { signer: session });
}

export function registrationMessage(user: string, sessionKey: string, nonces: NonceSource, nowMs = Date.now()): Message {
  return {
    user, key: sessionKey, expiry: BigInt(Math.floor((nowMs + SESSION_TTL_MS) / 1000)),
    feeAddress: FEE_ADDRESS, nonce: nonces.take('session'), deadline: deadline(nowMs),
  };
}

/**
 * Cancel a queued intent (an open, or a close of a single position, still in state `queued`). Signed by
 * the session key; sent as POST /intents/{intentId}/cancel with the signed fields minus `intentId`.
 * The web app refuses when the session key expires within ~1 hour; do the same.
 */
export async function cancelIntent(session: LocalAccount, user: string, intentId: string) {
  if (!/^0x[0-9a-f]{64}$/.test(intentId)) throw new Error('Invalid intent id');
  const sealed = await seal('CancelIntent', { user, intentId, deadline: deadline() }, { signer: session });
  const { intentId: _omit, ...body } = sealed.signed;
  return { path: `/intents/${intentId}/cancel`, body };
}

/** The Stake message for `amount` PAPER (raw, 18 decimals). The master wallet signs it; nonce scope `paper`. */
export function stakeMessage(user: string, amount: bigint, nonces: NonceSource, nowMs = Date.now()): Message {
  if (amount <= 0n || amount >= 1n << 256n) throw new Error('Invalid PAPER amount');
  return { user, amount, nonce: nonces.take('paper'), deadline: deadline(nowMs) };
}

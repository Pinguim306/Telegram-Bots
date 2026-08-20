/**
 * Parsing do mint account do SPL Token — puro, sem RPC, para ser testável.
 *
 * Layout do Mint (82 bytes; Token-2022 usa o mesmo prefixo e acrescenta
 * extensões depois):
 *   [ 0.. 4)  mintAuthorityOption   u32 LE (1 = existe authority)
 *   [ 4..36)  mintAuthority         Pubkey
 *   [36..44)  supply                u64 LE
 *   [44]      decimals              u8
 *   [45]      isInitialized         u8
 *   [46..50)  freezeAuthorityOption u32 LE
 *   [50..82)  freezeAuthority       Pubkey
 */

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const MINT_ACCOUNT_MIN_SIZE = 82;

export interface ParsedMint {
  supplyRaw: bigint;
  decimals: number;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  initialized: boolean;
}

export function parseMintAccount(data: Uint8Array): ParsedMint | null {
  if (data.length < MINT_ACCOUNT_MIN_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const mintAuthorityOption = view.getUint32(0, true);
  const supplyRaw = view.getBigUint64(36, true);
  const decimals = data[44]!;
  const initialized = data[45] === 1;
  const freezeAuthorityOption = view.getUint32(46, true);

  if (!initialized) return null;

  return {
    supplyRaw,
    decimals,
    mintAuthorityActive: mintAuthorityOption === 1,
    freezeAuthorityActive: freezeAuthorityOption === 1,
    initialized,
  };
}

/** Converte supply cru para unidades de UI sem passar por float intermediário gigante. */
export function rawToUi(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw - whole * base;
  return Number(whole) + Number(frac) / Number(base);
}

// ─────────────────────────────────────────────────────────────
//  Extensões do Token-2022
// ─────────────────────────────────────────────────────────────
//
// O pump.fun minta em Token-2022 desde 2025 — vetar o programa inteiro tiraria
// o bot do próprio mercado que ele opera. O que importa é QUAIS extensões o
// mint carrega: metadata é inofensivo; permanent delegate confisca token do
// holder; transfer hook roda código arbitrário no transfer (honeypot clássico).

/**
 * Nomes por tipo (enum ExtensionType do spl-token-2022, conferido contra o
 * fonte oficial em solana-program/token-2022 interface/src/extension/mod.rs —
 * a numeração do fim do enum já foi errada aqui uma vez: 24 é
 * ConfidentialMintBurn, 25 é ScaledUiAmount e Pausable é o 26).
 */
const EXTENSION_NAMES: Record<number, string> = {
  1: 'transferFeeConfig',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  6: 'defaultAccountState',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  12: 'permanentDelegate',
  14: 'transferHook',
  16: 'confidentialTransferFeeConfig',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
  24: 'confidentialMintBurn',
  25: 'scaledUiAmount',
  26: 'pausable',
  27: 'pausableAccount',
};

/**
 * Extensões que permitem travar, confiscar ou taxar o holder — cada uma é um
 * vetor de honeypot conhecido:
 *   - defaultAccountState: contas novas podem nascer congeladas
 *   - nonTransferable: não dá para transferir (nem vender)
 *   - permanentDelegate: o emissor move os SEUS tokens sem a sua assinatura
 *   - transferHook: código arbitrário decide se o transfer passa
 *   - pausable: o emissor pausa todas as transferências
 */
const DANGEROUS_EXTENSIONS = new Set([6, 9, 12, 14, 26]);

/** Extensões que mexem no que você recebe, sem chegar a bloquear a venda. */
const TAXING_EXTENSIONS = new Set([1, 10, 25]);

export interface MintExtensions {
  all: string[];
  /** Vetores de honeypot — veto incondicional no motor de risco. */
  dangerous: string[];
  /** Taxa/juros/escala — pontua risco, mas não bloqueia sozinho. */
  taxing: string[];
}

/**
 * Varre o TLV do Token-2022 depois do layout base.
 *
 * Layout: bytes [82..165) são padding, byte 165 é o tipo da conta (1 = Mint) e
 * as entradas TLV começam em 166: [tipo u16 LE][tamanho u16 LE][dados].
 */
export function parseToken2022Extensions(data: Uint8Array): MintExtensions {
  const none: MintExtensions = { all: [], dangerous: [], taxing: [] };
  if (data.length <= 166 || data[165] !== 1) return none;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const all: string[] = [];
  const dangerous: string[] = [];
  const taxing: string[] = [];

  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (type === 0) break; // padding no fim
    const name = EXTENSION_NAMES[type] ?? `ext_${type}`;
    all.push(name);
    if (DANGEROUS_EXTENSIONS.has(type)) dangerous.push(name);
    if (TAXING_EXTENSIONS.has(type)) taxing.push(name);
    offset += 4 + length;
  }
  return { all, dangerous, taxing };
}

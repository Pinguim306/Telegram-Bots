import { erc20Abi, hexToString, type Address, type Hex } from 'viem';
import type { ChainClient } from './chain.js';
import { logger } from './logger.js';

export interface TokenMeta {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  isErc20: boolean;
}

/** Tokens antigos declaram name/symbol como bytes32 em vez de string. */
const bytes32MetaAbi = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

const ownableAbi = [
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * Lê metadados de vários tokens de uma vez (multicall3 quando disponível).
 *
 * `isErc20: false` quando decimals ou totalSupply falham — é o filtro que separa
 * token de verdade de NFT, contrato de staking e proxy quebrado, todos os quais
 * também emitem `Transfer`.
 */
export async function readTokenMetas(
  chain: ChainClient,
  addresses: Address[],
): Promise<Map<Address, TokenMeta>> {
  const out = new Map<Address, TokenMeta>();
  if (addresses.length === 0) return out;

  const calls = addresses.flatMap((address) => [
    { address, abi: erc20Abi, functionName: 'name' },
    { address, abi: erc20Abi, functionName: 'symbol' },
    { address, abi: erc20Abi, functionName: 'decimals' },
    { address, abi: erc20Abi, functionName: 'totalSupply' },
  ]);

  const results = await chain.multicall(calls);

  const retryBytes32: Address[] = [];

  addresses.forEach((address, i) => {
    const name = results[i * 4];
    const symbol = results[i * 4 + 1];
    const decimals = results[i * 4 + 2];
    const supply = results[i * 4 + 3];

    const decimalsOk = decimals?.status === 'success' && typeof decimals.result === 'number';
    const supplyOk = supply?.status === 'success' && typeof supply.result === 'bigint';

    if (!decimalsOk || !supplyOk) {
      out.set(address, {
        address,
        name: '',
        symbol: '',
        decimals: 18,
        totalSupply: 0n,
        isErc20: false,
      });
      return;
    }

    const nameOk = name?.status === 'success' && typeof name.result === 'string';
    const symbolOk = symbol?.status === 'success' && typeof symbol.result === 'string';
    if (!nameOk || !symbolOk) retryBytes32.push(address);

    out.set(address, {
      address,
      name: nameOk ? (name.result as string) : '',
      symbol: symbolOk ? (symbol.result as string) : '',
      decimals: decimals.result as number,
      totalSupply: supply.result as bigint,
      isErc20: true,
    });
  });

  if (retryBytes32.length > 0) {
    const b32 = await chain.multicall(
      retryBytes32.flatMap((address) => [
        { address, abi: bytes32MetaAbi, functionName: 'name' },
        { address, abi: bytes32MetaAbi, functionName: 'symbol' },
      ]),
    );
    retryBytes32.forEach((address, i) => {
      const meta = out.get(address);
      if (!meta) return;
      const name = b32[i * 2];
      const symbol = b32[i * 2 + 1];
      if (!meta.name && name?.status === 'success') meta.name = decodeBytes32(name.result as Hex);
      if (!meta.symbol && symbol?.status === 'success') meta.symbol = decodeBytes32(symbol.result as Hex);
    });
  }

  for (const meta of out.values()) {
    if (!meta.symbol) meta.symbol = meta.name || '???';
    if (!meta.name) meta.name = meta.symbol;
  }

  return out;
}

function decodeBytes32(value: Hex): string {
  try {
    return hexToString(value, { size: 32 }).replace(/\0+$/, '').trim();
  } catch {
    return '';
  }
}

/** Seletores de funções que mudam o comportamento do token depois do launch. */
const RISKY_SELECTORS: Array<{ selector: string; flag: RiskFlag }> = [
  { selector: '40c10f19', flag: 'mint' }, // mint(address,uint256)
  { selector: 'a0712d68', flag: 'mint' }, // mint(uint256)
  { selector: '8456cb59', flag: 'pausable' }, // pause()
  { selector: '3f4ba83a', flag: 'pausable' }, // unpause()
  { selector: 'f9f92be4', flag: 'blacklist' }, // blacklist(address)
  { selector: '44337ea1', flag: 'blacklist' }, // addBlackList(address)
  { selector: '1a8952f8', flag: 'blacklist' }, // blackList(address)
  { selector: '4e71d92d', flag: 'other' }, // claim()
];

/** Slot de implementação do EIP-1967 — presença indica token atualizável. */
const EIP1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export type RiskFlag = 'mint' | 'pausable' | 'blacklist' | 'upgradeable' | 'no_code' | 'other';

export interface TokenRisk {
  owner: Address | null;
  /** owner == address(0) — ninguém pode mais mexer no contrato. */
  renounced: boolean;
  flags: RiskFlag[];
  /** 0 (limpo) a 100 (perigoso). Heurístico — não é auditoria. */
  score: number;
}

/**
 * Heurística de risco a partir do bytecode e do owner.
 *
 * Deixando claro o limite: isto NÃO detecta honeypot. Honeypot de verdade se
 * esconde em lógica de transferência, não em seletor exposto. Isto pega o que dá
 * para pegar barato — mint aberto, pausa, blacklist, proxy atualizável, owner ativo.
 */
export async function assessRisk(chain: ChainClient, token: Address): Promise<TokenRisk> {
  const flags = new Set<RiskFlag>();
  let owner: Address | null = null;

  const code = await chain.getCode(token).catch(() => undefined);
  if (!code || code === '0x') {
    return { owner: null, renounced: false, flags: ['no_code'], score: 100 };
  }

  const codeBody = code.slice(2).toLowerCase();
  for (const { selector, flag } of RISKY_SELECTORS) {
    if (codeBody.includes(selector)) flags.add(flag);
  }

  try {
    const [ownerResult, implSlot] = await Promise.all([
      chain.multicall<Address>([{ address: token, abi: ownableAbi, functionName: 'owner' }]),
      chain.client.getStorageAt({ address: token, slot: EIP1967_IMPL_SLOT }),
    ]);

    const first = ownerResult[0];
    if (first?.status === 'success' && typeof first.result === 'string') {
      owner = first.result.toLowerCase() as Address;
    }
    if (implSlot && BigInt(implSlot) !== 0n) flags.add('upgradeable');
  } catch (err) {
    logger.debug({ err, token }, 'assessRisk: leitura parcial');
  }

  const renounced = owner !== null && BigInt(owner) === 0n;

  let score = 0;
  if (flags.has('mint') && !renounced) score += 35;
  if (flags.has('blacklist')) score += 30;
  if (flags.has('pausable')) score += 15;
  if (flags.has('upgradeable')) score += 25;
  if (owner && !renounced) score += 10;

  return { owner, renounced, flags: [...flags], score: Math.min(100, score) };
}

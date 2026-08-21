import {
  createPublicClient,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  isAddress,
  type PublicClient,
} from 'viem';
import { bsc } from 'viem/chains';
import type { Logger } from '../../log.js';
import type { ChainAdapter, ChainKey, HolderStats, OnchainTokenInfo } from '../../types.js';

/**
 * Adapter da BSC (EVM) via viem — a FASE 1 (paper) só precisa de LEITURA:
 * saldo, ERC-20, decimals/supply. Execução live (PancakeSwap, approve, nonce)
 * é a fase 2 e é bloqueada no boot pelo assertLiveAllowed.
 *
 * Diferença de mundos no risco: na Solana as travas moram em flags do
 * programa SPL (lidas aqui no adapter); na EVM cada token é um CONTRATO
 * arbitrário e a leitura de segurança de verdade vem do GoPlus (datasource) —
 * por isso getOnchainTokenInfo aqui devolve o "esqueleto honesto" (decimals,
 * supply) sem inventar authorities, e o config da BSC roda com
 * requireRugcheck=true: sem GoPlus, rejeita.
 */
export class BscChain implements ChainAdapter {
  readonly key: ChainKey = 'bsc';

  constructor(
    readonly client: PublicClient,
    private readonly log: Logger,
  ) {}

  static async connect(rpcUrls: string[], log: Logger): Promise<BscChain> {
    const client = createPublicClient({
      chain: bsc,
      transport: fallback(rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 }))),
    });
    const block = await client.getBlockNumber();
    log.info({ rpcs: rpcUrls.length, block: Number(block) }, 'RPC da BSC conectado');
    return new BscChain(client, log);
  }

  walletAddress(): string | null {
    // Fase 1 é paper — sem carteira. A fase 2 (live) traz a conta do viem.
    return null;
  }

  async nativeBalanceSol(): Promise<number> {
    return 0; // sem carteira no paper; o caixa simulado vive no PaperBroker
  }

  async tokenBalanceUi(_mint: string): Promise<number> {
    return 0;
  }

  async getOnchainTokenInfo(mint: string): Promise<OnchainTokenInfo | null> {
    if (!isAddress(mint)) return null;
    try {
      const [decimals, totalSupply] = await Promise.all([
        this.client.readContract({ address: mint, abi: erc20Abi, functionName: 'decimals' }),
        this.client.readContract({ address: mint, abi: erc20Abi, functionName: 'totalSupply' }),
      ]);
      return {
        // Authorities são conceito SPL; o equivalente EVM (mintable, pausable,
        // blacklist) vem do GoPlus como dangerFlags — que o config veta.
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        token2022: false,
        dangerousExtensions: [],
        taxingExtensions: [],
        decimals,
        supplyRaw: totalSupply,
        supplyUi: Number(formatUnits(totalSupply, decimals)),
      };
    } catch (err) {
      this.log.debug({ mint, err: (err as Error).message }, 'Leitura ERC-20 falhou');
      return null;
    }
  }

  async getTopHolders(): Promise<HolderStats | null> {
    // Na BSC os holders vêm do GoPlus (holderCount/top10Pct no RugcheckSummary)
    // — o RPC EVM não tem um "largest accounts" nativo como o da Solana.
    return null;
  }
}

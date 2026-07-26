import { describe, expect, it } from 'vitest';
import {
  loadDexConfig,
  loadLaunchesConfig,
  loadNetwork,
  loadReferrals,
  loadSignalsConfig,
} from '../src/config/load.js';

/**
 * Estes testes leem os arquivos REAIS de `config/`, não fixtures.
 *
 * O modo de falha que eles previnem: alguém ajusta um limiar, erra uma vírgula ou
 * um nome de campo, e o bot só descobre no boot — em produção, de madrugada, no
 * meio de um launch. Aqui isso vira build vermelho.
 *
 * Tudo offline: carregar config é leitura de arquivo mais zod, sem rede.
 */

describe('config/networks.json', () => {
  it('carrega arc-testnet com os valores verificados on-chain', () => {
    const net = loadNetwork('arc-testnet');
    expect(net.chainId).toBe(5_042_002);
    expect(net.rpcUrls.length).toBeGreaterThan(0);
    expect(net.multicall3).toBe('0xca11bde05977b3631167028862be2a173976ca11');
  });

  it('define USDC com 6 decimals — errar isso desloca todo preço por 10^12', () => {
    const usdc = loadNetwork('arc-testnet').quoteTokens.find((q) => q.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.address).toBe('0x3600000000000000000000000000000000000000');
  });

  it('tem ao menos um token de quote — sem isso nenhum preço é calculável', () => {
    expect(loadNetwork('arc-testnet').quoteTokens.length).toBeGreaterThan(0);
  });

  it('falha de forma explícita em arc-mainnet enquanto as vars não existem', () => {
    // Comportamento intencional e documentado: alertar na rede errada é pior
    // do que não alertar. Este teste trava essa garantia.
    const semEnv = { ...process.env };
    delete semEnv.ARC_MAINNET_RPC_URL;
    delete semEnv.ARC_MAINNET_CHAIN_ID;
    delete semEnv.RPC_URL_OVERRIDE;
    const original = process.env;
    process.env = semEnv;
    try {
      expect(() => loadNetwork('arc-mainnet')).toThrow(/incompleta/);
    } finally {
      process.env = original;
    }
  });

  it('rejeita rede inexistente listando as disponíveis', () => {
    expect(() => loadNetwork('rede-que-nao-existe')).toThrow(/Disponíveis/);
  });
});

describe('config/signals.json', () => {
  const cfg = loadSignalsConfig();

  it('é válido contra o schema', () => {
    expect(cfg.rules.length).toBeGreaterThan(0);
  });

  it('tem janelas em ordem crescente', () => {
    // A linha de base de volume é (longa − curta); ordem invertida a zeraria
    // e o spike de volume nunca dispararia.
    expect(cfg.windows.shortSec).toBeLessThan(cfg.windows.mediumSec);
    expect(cfg.windows.mediumSec).toBeLessThan(cfg.windows.longSec);
  });

  it('tem score mínimo alcançável', () => {
    // minScore acima da soma de todas as regras = bot mudo para sempre.
    const maximo = cfg.rules.reduce((soma, r) => soma + r.points, 0) + 5;
    expect(cfg.minScore).toBeLessThanOrEqual(maximo);
    expect(cfg.minScore).toBeGreaterThan(0);
  });

  it('não tem regras duplicadas', () => {
    const ids = cfg.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('usa rótulos acentuados corretamente em português', () => {
    // Os rótulos vão direto para o texto do alerta.
    const labels = cfg.rules.map((r) => r.label);
    expect(labels).toContain('Pressão compradora');
    expect(labels).toContain('Compradores únicos');
  });
});

describe('config/launches.json', () => {
  const cfg = loadLaunchesConfig();

  it('é válido contra o schema', () => {
    expect(cfg.maxAlertsPerHour).toBeGreaterThan(0);
  });

  it('mantém a fila de pools pendentes maior que o intervalo de reavaliação', () => {
    // Janela menor que o intervalo faria o pool sair da fila antes da primeira
    // reavaliação — e todo launch seria perdido, silenciosamente.
    expect(cfg.pendingWindowSec).toBeGreaterThan(cfg.pendingRecheckSec);
  });

  it('não exige liquidez de saída por padrão', () => {
    // Launch de bonding curve nasce com zero USDC. Exigir lado quote aqui
    // descartaria exatamente o que o bot existe para pegar.
    expect(cfg.minQuoteLiquidityUsd).toBe(0);
  });
});

describe('config/referrals.json e dex.json', () => {
  it('referrals é válido e todo template habilitado tem placeholder de token', () => {
    const cfg = loadReferrals();
    for (const p of cfg.platforms.filter((x) => x.enabled)) {
      expect(p.template).toMatch(/\{token\}|\{pool\}/);
    }
  });

  it('nenhuma plataforma habilitada por engano com host de exemplo', () => {
    const cfg = loadReferrals();
    for (const p of cfg.platforms.filter((x) => x.enabled)) {
      expect(p.template).not.toContain('SUA-PLATAFORMA');
      expect(p.template).not.toContain('SEU_TRADING_BOT');
    }
  });

  it('dex.json é válido', () => {
    expect(() => loadDexConfig()).not.toThrow();
  });
});

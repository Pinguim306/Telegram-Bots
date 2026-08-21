import { PublicKey, type Connection } from '@solana/web3.js';

/**
 * Bonding curve do pump.fun lida DIRETO da conta on-chain, com a matemática
 * x*y=k reproduzida localmente. Existe por três motivos, todos vindos da
 * análise dos trades reais:
 *
 *  1. MARCA EXECUTÁVEL sem Jupiter: token novo na curve não tem rota no
 *     agregador — sem isso as saídas caíam no preço de indexador (que mente).
 *  2. CHECAGEM DE CUSTO ROUND-TRIP antes de comprar: 17 das 22 perdas do dia
 *     analisado fecharam ALÉM do stop de -12% (média -26%) — grande parte era
 *     custo de entrar+sair de curva rasa, pago sem nunca ter sido medido.
 *  3. A via de compra por fallback (PumpPortal) não tinha NENHUMA checagem de
 *     impacto — a via Jupiter aborta acima de 10%, a fallback comprava cega.
 */

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Taxa do pump.fun por lado do trade (1%). */
export const PUMP_FEE_BPS = 100n;

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  /** true = curve completou (graduou) — não se negocia mais nela. */
  complete: boolean;
}

/** Endereço (PDA) da conta da bonding curve de um mint. */
export function curveAddress(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

/**
 * Layout da conta (Anchor): discriminator(8) + virtualTokenReserves(u64) +
 * virtualSolReserves(u64) + realTokenReserves(u64) + realSolReserves(u64) +
 * tokenTotalSupply(u64) + complete(u8). Exportado para teste.
 */
export function parseCurveAccount(data: Buffer): CurveState | null {
  if (data.length < 8 + 8 * 5 + 1) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    complete: data.readUInt8(48) !== 0,
  };
}

/** Lê o estado da curve de um mint. null = conta não existe ou ilegível. */
export async function fetchCurveState(conn: Connection, mint: string): Promise<CurveState | null> {
  try {
    const account = await conn.getAccountInfo(curveAddress(mint));
    if (!account) return null;
    return parseCurveAccount(account.data);
  } catch {
    return null;
  }
}

const BPS = 10_000n;

/**
 * Quanto SOL (lamports) uma venda de `tokensRaw` paga AGORA, já descontada a
 * taxa. É a marca executável da curve — o equivalente local da quote de venda.
 */
export function curveSellSolOut(curve: CurveState, tokensRaw: bigint): bigint {
  if (tokensRaw <= 0n || curve.virtualTokenReserves <= 0n) return 0n;
  const gross = (curve.virtualSolReserves * tokensRaw) / (curve.virtualTokenReserves + tokensRaw);
  // A curve nunca paga mais SOL do que realmente tem depositado.
  const capped = gross > curve.realSolReserves ? curve.realSolReserves : gross;
  return (capped * (BPS - PUMP_FEE_BPS)) / BPS;
}

/** Quantos tokens (raw) uma compra de `solLamports` recebe, taxa descontada. */
export function curveBuyTokensOut(curve: CurveState, solLamports: bigint): bigint {
  if (solLamports <= 0n || curve.virtualSolReserves <= 0n) return 0n;
  const solAfterFee = (solLamports * (BPS - PUMP_FEE_BPS)) / BPS;
  const out = (curve.virtualTokenReserves * solAfterFee) / (curve.virtualSolReserves + solAfterFee);
  return out > curve.realTokenReserves ? curve.realTokenReserves : out;
}

/**
 * Custo (%) de comprar `solLamports` e vender TUDO de volta em seguida.
 *
 * Fato matemático (aprendido em teste): em x·y=k o impacto da ida e da volta
 * se CANCELAM — o round-trip imediato devolve o que entrou menos as duas
 * taxas (~2%), independente do tamanho. O que esta função pega, então, não é
 * "impacto": é PATOLOGIA — curve drenada (realSolReserves não cobre a venda),
 * curve completa, ou estado ilegível. As perdas grandes reais vêm do fluxo
 * dos OUTROS entre a compra e a venda — contra isso o que protege é o gate de
 * idade, o teto de posição e a marca executável honesta.
 */
export function curveRoundTripCostPct(curve: CurveState, solLamports: bigint): number {
  if (solLamports <= 0n) return 0;
  const tokens = curveBuyTokensOut(curve, solLamports);
  if (tokens <= 0n) return 100;
  const solAfterFee = (solLamports * (BPS - PUMP_FEE_BPS)) / BPS;
  const after: CurveState = {
    ...curve,
    virtualSolReserves: curve.virtualSolReserves + solAfterFee,
    virtualTokenReserves: curve.virtualTokenReserves - tokens,
    realSolReserves: curve.realSolReserves + solAfterFee,
  };
  const solBack = curveSellSolOut(after, tokens);
  return (1 - Number(solBack) / Number(solLamports)) * 100;
}

import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { TraderEnv } from './config.js';

/**
 * Carrega a keypair da carteira a partir do .env.
 *
 * Formatos aceitos (os dois que existem na prática):
 *   - string base58 de 64 bytes — o export da Phantom/Solflare;
 *   - array JSON de bytes — o arquivo do solana-keygen.
 *
 * A chave NUNCA é logada nem re-serializada para disco. Erros de parsing não
 * incluem o valor recebido — vazar a chave numa mensagem de erro que vai para
 * log seria pior que o bug.
 */
export function loadKeypair(env: Pick<TraderEnv, 'privateKey' | 'keypairFile'>): Keypair | null {
  const material = env.privateKey ?? (env.keypairFile ? readKeypairFile(env.keypairFile) : undefined);
  if (!material) return null;
  return parseSecretKey(material);
}

function readKeypairFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`Não consegui ler SOLANA_KEYPAIR_FILE (${path}): ${(err as Error).message}`);
  }
}

export function parseSecretKey(material: string): Keypair {
  const trimmed = material.trim();
  let bytes: Uint8Array;

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('SOLANA_PRIVATE_KEY parece um array JSON mas não parseia.');
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('SOLANA_PRIVATE_KEY em formato JSON precisa ser um array de bytes (0–255).');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw new Error(
        'SOLANA_PRIVATE_KEY não é base58 válido nem array JSON. Exporte a chave da sua wallet e cole exatamente como veio.',
      );
    }
  }

  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  // Alguns exports trazem só a seed de 32 bytes.
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(
    `Chave com tamanho inesperado (${bytes.length} bytes; esperava 64 ou 32). Confira o export da wallet.`,
  );
}

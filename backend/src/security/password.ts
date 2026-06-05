import bcrypt from 'bcryptjs';
import crypto from 'crypto';

/**
 * Módulo ÚNICO de senhas da plataforma.
 *
 * - Padrão atual: bcrypt (com salt por hash, resistente a rainbow tables).
 * - Compatibilidade: hashes legados em SHA-256 (sem salt) continuam sendo aceitos
 *   no login e são migrados de forma transparente para bcrypt no primeiro acesso
 *   bem-sucedido (ver `needsRehash`).
 *
 * Antes existiam três cópias divergentes de `hashPassword` (auth.ts, database.ts,
 * tenants.ts) + um seed inline — todas SHA-256 puro. Tudo passa a vir daqui.
 */

const BCRYPT_COST = 12;

/** Detecta se o valor armazenado é um hash bcrypt ($2a/$2b/$2y) ou um SHA-256 legado. */
function isBcryptHash(stored: string): boolean {
  return /^\$2[aby]\$/.test(stored);
}

/** Hash legado (SHA-256 sem salt). Mantido SÓ para verificar/migrar credenciais antigas. */
export function hashSha256Legacy(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/** Gera o hash de senha no padrão atual (bcrypt). Use sempre este para gravar. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export interface VerifyResult {
  /** Senha confere com o hash armazenado. */
  ok: boolean;
  /** Confere, porém o hash está no formato legado e deve ser regravado em bcrypt. */
  needsRehash: boolean;
}

/**
 * Verifica a senha contra um hash bcrypt OU um SHA-256 legado.
 * Quando o hash é legado e a senha confere, retorna `needsRehash=true` para que o
 * chamador regrave a credencial em bcrypt (migração transparente, sem logout em massa).
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<VerifyResult> {
  if (!stored) return { ok: false, needsRehash: false };

  if (isBcryptHash(stored)) {
    const ok = await bcrypt.compare(password, stored);
    return { ok, needsRehash: false };
  }

  // Caminho legado: comparação SHA-256 em tempo constante (anti-timing-attack).
  const candidato = Buffer.from(hashSha256Legacy(password));
  const armazenado = Buffer.from(stored);
  const ok =
    candidato.length === armazenado.length &&
    crypto.timingSafeEqual(candidato, armazenado);
  return { ok, needsRehash: ok };
}

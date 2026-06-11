import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, hashSha256Legacy } from '../src/security/password';

describe('security/password', () => {
  it('faz hash bcrypt e verifica (roundtrip)', async () => {
    const h = await hashPassword('s3nh@Forte!');
    expect(h.startsWith('$2')).toBe(true); // formato bcrypt
    const r = await verifyPassword('s3nh@Forte!', h);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(false);
  });

  it('rejeita senha incorreta contra bcrypt', async () => {
    const h = await hashPassword('correta');
    const r = await verifyPassword('errada', h);
    expect(r.ok).toBe(false);
  });

  it('aceita hash legado SHA-256 e sinaliza needsRehash (migração transparente)', async () => {
    const legacy = hashSha256Legacy('123456');
    const r = await verifyPassword('123456', legacy);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(true);
  });

  it('rejeita senha incorreta contra hash legado', async () => {
    const legacy = hashSha256Legacy('123456');
    const r = await verifyPassword('000000', legacy);
    expect(r.ok).toBe(false);
  });

  it('retorna ok=false para hash vazio/nulo', async () => {
    expect((await verifyPassword('x', '')).ok).toBe(false);
    expect((await verifyPassword('x', null)).ok).toBe(false);
  });
});

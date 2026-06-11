import crypto from 'crypto';
import mssql, { Request, Transaction } from '../db';
import { pool } from '../database';

// Único ponto de escrita no LEDGER_FINANCEIRO. Garante a cadeia de hash
// (tamper-evidence): cada lançamento encadeia o hash do anterior. A tabela é
// append-only (trigger TRG_LEDGER_IMUTAVEL bloqueia UPDATE/DELETE no banco).

export type TipoLancamento =
  | 'ABERTURA'
  | 'CREDITO_PAGAMENTO'
  | 'MARCA_ATRASO'
  | 'ESTORNO'
  | 'CANCELAMENTO'
  | 'SUSPENSAO'
  | 'TRANSICAO'
  | 'TRANSICAO_REJEITADA'
  | 'AJUSTE';

export type OrigemLancamento = 'WEBHOOK' | 'MANUAL_ADMIN' | 'DUNNING' | 'SYSTEM';

export interface LancamentoInput {
  empresaId: string;
  assinaturaId?: string;
  faturaId?: string;
  tipo: TipoLancamento;
  valor: number; // positivo = crédito p/ plataforma; negativo = estorno
  origem: OrigemLancamento;
  referenciaExterna?: string; // ex: gateway transaction id
  metadados?: Record<string, unknown>;
  criadoPor?: string; // token admin ou 'SYSTEM'
}

/** Lê o hash do último lançamento (ordem por SEQ). Aceita um executor transacional. */
async function ultimoHash(exec: Request): Promise<string | null> {
  const r = await exec.query(
    'SELECT TOP 1 HASH_ATUAL FROM LEDGER_FINANCEIRO WITH (UPDLOCK, HOLDLOCK) ORDER BY SEQ DESC'
  );
  return r.recordset.length > 0 ? r.recordset[0].HASH_ATUAL : null;
}

function calcularHash(
  id: string,
  l: LancamentoInput,
  criadoEm: string,
  hashAnterior: string | null
): string {
  const base = [
    id,
    l.empresaId,
    l.tipo,
    l.valor.toFixed(2),
    l.referenciaExterna ?? '',
    criadoEm,
    hashAnterior ?? '',
  ].join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

/**
 * Insere um lançamento no ledger. Se `tx` for fornecida, participa da transação
 * do chamador (recomendado: a baixa de fatura e seu lançamento devem ser atômicos).
 * Sem `tx`, abre o próprio escopo no pool.
 */
export async function appendLedger(
  l: LancamentoInput,
  tx?: Transaction
): Promise<{ id: string; hashAtual: string }> {
  const exec = () => (tx ? tx.request() : pool.request());

  const hashAnterior = await ultimoHash(exec());
  const id = crypto.randomUUID();
  const criadoEm = new Date().toISOString();
  const hashAtual = calcularHash(id, l, criadoEm, hashAnterior);

  await exec()
    .input('id', mssql.VarChar, id)
    .input('emp', mssql.VarChar, l.empresaId)
    .input('assId', mssql.VarChar, l.assinaturaId ?? null)
    .input('fatId', mssql.VarChar, l.faturaId ?? null)
    .input('tipo', mssql.VarChar, l.tipo)
    .input('valor', mssql.Decimal(14, 2), l.valor)
    .input('origem', mssql.VarChar, l.origem)
    .input('ref', mssql.VarChar, l.referenciaExterna ?? null)
    .input('meta', mssql.NVarChar, JSON.stringify(l.metadados ?? {}))
    .input('hAnt', mssql.Char(64), hashAnterior)
    .input('hAtu', mssql.Char(64), hashAtual)
    .input('criado', mssql.VarChar, criadoEm)
    .input('por', mssql.VarChar, l.criadoPor ?? 'SYSTEM')
    .query(`
      INSERT INTO LEDGER_FINANCEIRO
        (ID, EMPRESA_ID, ASSINATURA_ID, FATURA_ID, TIPO_LANCAMENTO, VALOR, ORIGEM,
         REFERENCIA_EXTERNA, METADADOS, HASH_ANTERIOR, HASH_ATUAL, CRIADO_EM, CRIADO_POR)
      VALUES
        (@id, @emp, @assId, @fatId, @tipo, @valor, @origem,
         @ref, @meta, @hAnt, @hAtu, @criado, @por)
    `);

  return { id, hashAtual };
}

/**
 * Verifica a integridade da cadeia de hash do ledger. Retorna o primeiro
 * registro adulterado (ou null se a cadeia estiver íntegra). Uso: auditoria.
 */
export async function verificarIntegridadeLedger(): Promise<{ ok: boolean; quebraNoSeq?: number }> {
  const r = await pool.request().query('SELECT * FROM LEDGER_FINANCEIRO ORDER BY SEQ ASC');
  let anterior: string | null = null;
  for (const reg of r.recordset) {
    const esperado = calcularHash(
      reg.ID,
      {
        empresaId: reg.EMPRESA_ID,
        tipo: reg.TIPO_LANCAMENTO,
        valor: Number(reg.VALOR),
        origem: reg.ORIGEM,
        referenciaExterna: reg.REFERENCIA_EXTERNA ?? undefined,
      },
      reg.CRIADO_EM,
      anterior
    );
    if (esperado !== reg.HASH_ATUAL || (reg.HASH_ANTERIOR ?? null) !== anterior) {
      return { ok: false, quebraNoSeq: reg.SEQ };
    }
    anterior = reg.HASH_ATUAL;
  }
  return { ok: true };
}

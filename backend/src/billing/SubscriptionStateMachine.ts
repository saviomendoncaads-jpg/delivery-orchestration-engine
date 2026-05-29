import mssql from 'mssql/msnodesqlv8';
import { pool } from '../database';
import { appendLedger } from './ledgerService';
import { sessions } from '../auth';
import { empresas, lojas } from '../tenants';

// Máquina de estados da assinatura — domínio aditivo (mantém ATIVA/CANCELADA
// existentes e adiciona TRIAL/ATRASADA/SUSPENSA). Centraliza TODAS as mudanças
// de status: transação + UPDLOCK (serializa transições concorrentes da mesma
// assinatura), deriva EMPRESAS.STATUS_FINANCEIRO e registra no ledger. Transição
// inválida é auditada como TRANSICAO_REJEITADA — nunca aplicada em silêncio.

export type StatusAssinatura = 'TRIAL' | 'ATIVA' | 'ATRASADA' | 'SUSPENSA' | 'CANCELADA';

export type EventoAssinatura =
  | 'payment.confirmed'
  | 'payment.overdue'
  | 'payment.failed'
  | 'SUSPENDER'
  | 'CANCELAR'
  | 'subscription.deleted'
  | 'trial.expired';

const TRANSICOES: Record<string, Partial<Record<EventoAssinatura, StatusAssinatura>>> = {
  TRIAL:     { 'payment.confirmed': 'ATIVA', 'trial.expired': 'CANCELADA', 'CANCELAR': 'CANCELADA', 'subscription.deleted': 'CANCELADA' },
  ATIVA:     { 'payment.overdue': 'ATRASADA', 'payment.failed': 'ATRASADA', 'SUSPENDER': 'SUSPENSA', 'CANCELAR': 'CANCELADA', 'subscription.deleted': 'CANCELADA' },
  ATRASADA:  { 'payment.confirmed': 'ATIVA', 'SUSPENDER': 'SUSPENSA', 'CANCELAR': 'CANCELADA', 'subscription.deleted': 'CANCELADA' },
  SUSPENSA:  { 'payment.confirmed': 'ATIVA', 'CANCELAR': 'CANCELADA', 'subscription.deleted': 'CANCELADA' },
  CANCELADA: {},
};

// Deriva o status financeiro da empresa a partir do estado da assinatura.
const STATUS_EMPRESA: Record<StatusAssinatura, string> = {
  TRIAL: 'REGULAR',
  ATIVA: 'REGULAR',
  ATRASADA: 'INADIMPLENTE',
  SUSPENSA: 'SUSPENSO',
  CANCELADA: 'CANCELADO',
};

export interface ResultadoTransicao {
  ok: boolean;
  de?: string;
  para?: string;
  noop?: boolean;
  motivo?: string;
}

export async function transicionar(assinaturaId: string, evento: EventoAssinatura): Promise<ResultadoTransicao> {
  if (!pool) return { ok: false, motivo: 'sem_conexao' };

  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const r = await tx.request()
      .input('id', mssql.VarChar, assinaturaId)
      .query('SELECT * FROM ASSINATURAS_EMPRESAS WITH (UPDLOCK, HOLDLOCK) WHERE ID = @id');

    if (r.recordset.length === 0) {
      await tx.rollback();
      return { ok: false, motivo: 'assinatura_inexistente' };
    }

    const sub = r.recordset[0];
    const atual = sub.STATUS as string;
    const destino = TRANSICOES[atual]?.[evento];

    if (!destino) {
      // Transição inválida: audita e não aplica.
      await appendLedger({
        empresaId: sub.EMPRESA_ID,
        assinaturaId,
        tipo: 'TRANSICAO_REJEITADA',
        valor: 0,
        origem: 'SYSTEM',
        metadados: { de: atual, evento },
        criadoPor: 'SYSTEM',
      }, tx);
      await tx.commit();
      return { ok: false, motivo: 'transicao_invalida', de: atual };
    }

    if (destino === atual) {
      await tx.commit();
      return { ok: true, noop: true, de: atual, para: destino };
    }

    // Atualiza a assinatura (carimbando data quando aplicável).
    const campoData = destino === 'CANCELADA' ? 'CANCELADO_EM' : destino === 'SUSPENSA' ? 'SUSPENSA_EM' : null;
    if (campoData) {
      await tx.request()
        .input('id', mssql.VarChar, assinaturaId)
        .input('s', mssql.VarChar, destino)
        .input('d', mssql.VarChar, new Date().toISOString())
        .query(`UPDATE ASSINATURAS_EMPRESAS SET STATUS = @s, ${campoData} = @d WHERE ID = @id`);
    } else {
      await tx.request()
        .input('id', mssql.VarChar, assinaturaId)
        .input('s', mssql.VarChar, destino)
        .query('UPDATE ASSINATURAS_EMPRESAS SET STATUS = @s WHERE ID = @id');
    }

    // Deriva o status financeiro da empresa (fonte da verdade = assinatura).
    await sincronizarStatusEmpresa(tx, sub.EMPRESA_ID, destino);

    await appendLedger({
      empresaId: sub.EMPRESA_ID,
      assinaturaId,
      tipo: 'TRANSICAO',
      valor: 0,
      origem: 'SYSTEM',
      metadados: { de: atual, para: destino, evento },
      criadoPor: 'SYSTEM',
    }, tx);

    await tx.commit();

    // Efeito de sessão fora da transação: estados severos derrubam o painel da loja.
    if (destino === 'SUSPENSA' || destino === 'CANCELADA') {
      revogarSessoesDaEmpresa(sub.EMPRESA_ID);
    }

    return { ok: true, de: atual, para: destino };
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

async function sincronizarStatusEmpresa(tx: mssql.Transaction, empresaId: string, destino: StatusAssinatura): Promise<void> {
  const novo = STATUS_EMPRESA[destino];
  await tx.request()
    .input('id', mssql.VarChar, empresaId)
    .input('s', mssql.VarChar, novo)
    .query('UPDATE EMPRESAS SET STATUS_FINANCEIRO = @s WHERE ID = @id');
  const emp = empresas.find((e) => e.id === empresaId);
  if (emp) emp.statusFinanceiro = novo;
}

function revogarSessoesDaEmpresa(empresaId: string): void {
  for (const [token, sessao] of sessions.entries()) {
    if (sessao.tipo === 'loja' && sessao.lojaId) {
      const loja = lojas.find((l) => l.id === sessao.lojaId);
      if (loja && loja.empresaId === empresaId) {
        sessions.delete(token);
      }
    }
  }
}

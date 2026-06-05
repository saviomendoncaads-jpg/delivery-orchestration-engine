import mssql from 'mssql/msnodesqlv8';
import { pool } from '../database';

/**
 * Serviço de LIMITES DE PLANO (enforcement de tier + medição de uso).
 *
 * Os planos (PLANOS) definem tetos por loja — LIMITE_MOTORISTAS e
 * LIMITE_ENTREGAS_MES. Até aqui esses limites eram apenas decorativos (existiam
 * no schema/UI mas nada bloqueava). Este módulo torna os tiers REAIS: é a alavanca
 * que faz o cliente precisar dar upgrade para crescer.
 *
 * Princípios:
 *  - Cobrança é POR LOJA: o plano vem da assinatura ATIVA/TRIAL/ATRASADA da loja.
 *  - Medição vem direto do banco (fonte da verdade) — sem acoplar a estruturas em
 *    memória do gateway (evita import circular) e funciona para QUALQUER via de
 *    ingestão (painel, API pública, WhatsApp, import).
 *  - Limite NULL = ilimitado (plano Enterprise).
 *  - Falha-aberto: se o plano não puder ser resolvido (loja sem assinatura, banco
 *    fora) NÃO bloqueamos a operação do cliente — apenas registramos. O teto é sobre
 *    o tier, não sobre a saúde da nossa base. Inadimplência é tratada à parte
 *    (exigirLojaAdimplente).
 *
 * A contagem mensal de entregas exclui os "filhos" gerados por finalize-order
 * (REFERENCIA 'Origem: Pedido ...'), que são a continuação de um pedido já contado
 * na ingestão — assim um restaurante que usa preparo→finalização não conta em dobro.
 */

export type RecursoLimitado = 'MOTORISTAS' | 'ENTREGAS_MES';

export interface PlanoLimites {
  planoId: string;
  planoNome: string;
  limiteEntregasMes: number | null; // null = ilimitado
  limiteMotoristas: number | null;
  limiteLojas: number | null;
  statusAssinatura: string;
}

export interface ResultadoLimite {
  permitido: boolean;
  recurso: RecursoLimitado;
  usado: number;
  limite: number | null; // null = ilimitado
  restante: number | null; // null = ilimitado
  planoNome: string | null;
}

export interface UsoRecurso {
  usado: number;
  limite: number | null;
  restante: number | null;
  percentual: number | null; // 0-100; null quando ilimitado
}

export interface UsoDaLoja {
  planoNome: string | null;
  motoristas: UsoRecurso;
  entregasMes: UsoRecurso;
  referenciaMes: string; // MM/YYYY (mês corrente, fuso local do servidor)
}

const ROTULO_RECURSO: Record<RecursoLimitado, string> = {
  MOTORISTAS: 'motoristas',
  ENTREGAS_MES: 'entregas neste mês',
};

/**
 * Resolve o plano (com limites) da assinatura vigente da loja. Prioriza ATIVA,
 * depois TRIAL, depois ATRASADA (ainda opera no grace period). Ignora CANCELADA.
 */
export async function obterLimitesDaLoja(lojaId: string): Promise<PlanoLimites | null> {
  if (!pool || !lojaId) return null;
  try {
    const r = await pool
      .request()
      .input('lojaId', mssql.VarChar, lojaId)
      .query(`
        SELECT TOP 1
          P.ID  AS PLANO_ID,
          P.NOME AS PLANO_NOME,
          P.LIMITE_ENTREGAS_MES,
          P.LIMITE_MOTORISTAS,
          P.LIMITE_LOJAS,
          AE.STATUS AS STATUS_ASSINATURA
        FROM ASSINATURAS_EMPRESAS AE
        JOIN PLANOS P ON AE.PLANO_ID = P.ID
        WHERE AE.LOJA_ID = @lojaId AND AE.STATUS <> 'CANCELADA'
        ORDER BY
          CASE AE.STATUS
            WHEN 'ATIVA' THEN 0
            WHEN 'TRIAL' THEN 1
            WHEN 'ATRASADA' THEN 2
            ELSE 3
          END,
          AE.CRIADO_EM DESC
      `);
    if (r.recordset.length === 0) return null;
    const row = r.recordset[0];
    const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      planoId: row.PLANO_ID,
      planoNome: row.PLANO_NOME,
      limiteEntregasMes: num(row.LIMITE_ENTREGAS_MES),
      limiteMotoristas: num(row.LIMITE_MOTORISTAS),
      limiteLojas: num(row.LIMITE_LOJAS),
      statusAssinatura: row.STATUS_ASSINATURA,
    };
  } catch (err: any) {
    console.warn(`[PlanLimits] Falha ao resolver plano da loja ${lojaId} (falha-aberto):`, err?.message);
    return null;
  }
}

/** Conta motoristas cadastrados na loja (fonte: tabela MOTORISTAS). */
export async function contarMotoristas(lojaId: string): Promise<number> {
  if (!pool) return 0;
  const r = await pool
    .request()
    .input('lojaId', mssql.VarChar, lojaId)
    .query('SELECT COUNT(*) AS qtd FROM MOTORISTAS WHERE LOJA_ID = @lojaId');
  return Number(r.recordset[0]?.qtd || 0);
}

/** Limites do mês corrente no fuso local do servidor (= fuso do negócio, BR). */
function janelaMesCorrente(ref?: Date): { iniIso: string; fimIso: string; referencia: string } {
  const agora = ref ?? new Date();
  const y = agora.getFullYear();
  const m = agora.getMonth();
  const ini = new Date(y, m, 1); // 1º dia do mês 00:00 local
  const fim = new Date(y, m + 1, 1); // 1º dia do mês seguinte 00:00 local
  const referencia = `${String(m + 1).padStart(2, '0')}/${y}`;
  return { iniIso: ini.toISOString(), fimIso: fim.toISOString(), referencia };
}

/**
 * Conta ENTREGAS ingeridas pela loja no mês corrente. Exclui os filhos de
 * finalize-order (continuação de pedido já contado) para não duplicar.
 */
export async function contarEntregasMes(lojaId: string, ref?: Date): Promise<number> {
  if (!pool) return 0;
  const { iniIso, fimIso } = janelaMesCorrente(ref);
  const r = await pool
    .request()
    .input('lojaId', mssql.VarChar, lojaId)
    .input('ini', mssql.VarChar, iniIso)
    .input('fim', mssql.VarChar, fimIso)
    .query(`
      SELECT COUNT(*) AS qtd
      FROM ENTREGAS
      WHERE LOJA_ID = @lojaId
        AND CRIADO_EM >= @ini AND CRIADO_EM < @fim
        AND (REFERENCIA IS NULL OR REFERENCIA NOT LIKE 'Origem: Pedido %')
    `);
  return Number(r.recordset[0]?.qtd || 0);
}

function montarResultado(
  recurso: RecursoLimitado,
  usado: number,
  limite: number | null,
  planoNome: string | null
): ResultadoLimite {
  const ilimitado = limite === null;
  const permitido = ilimitado || usado < limite!;
  const restante = ilimitado ? null : Math.max(0, limite! - usado);
  return { permitido, recurso, usado, limite, restante, planoNome };
}

/** Verifica se a loja pode cadastrar mais 1 motorista sob o plano vigente. */
export async function verificarLimiteMotoristas(lojaId: string): Promise<ResultadoLimite> {
  const plano = await obterLimitesDaLoja(lojaId);
  if (!plano) return montarResultado('MOTORISTAS', 0, null, null); // falha-aberto
  const usado = await contarMotoristas(lojaId);
  return montarResultado('MOTORISTAS', usado, plano.limiteMotoristas, plano.planoNome);
}

/** Verifica se a loja pode ingerir mais 1 entrega neste mês sob o plano vigente. */
export async function verificarLimiteEntregasMes(lojaId: string): Promise<ResultadoLimite> {
  const plano = await obterLimitesDaLoja(lojaId);
  if (!plano) return montarResultado('ENTREGAS_MES', 0, null, null); // falha-aberto
  const usado = await contarEntregasMes(lojaId);
  return montarResultado('ENTREGAS_MES', usado, plano.limiteEntregasMes, plano.planoNome);
}

/** Snapshot de uso para o painel da loja (alimenta a barra de consumo / nudge de upgrade). */
export async function obterUsoDaLoja(lojaId: string): Promise<UsoDaLoja> {
  const { referencia } = janelaMesCorrente();
  const plano = await obterLimitesDaLoja(lojaId);
  const [motoristasUsados, entregasUsadas] = await Promise.all([
    contarMotoristas(lojaId).catch(() => 0),
    contarEntregasMes(lojaId).catch(() => 0),
  ]);

  const recurso = (usado: number, limite: number | null): UsoRecurso => ({
    usado,
    limite,
    restante: limite === null ? null : Math.max(0, limite - usado),
    percentual: limite === null || limite === 0 ? null : Math.min(100, Math.round((usado / limite) * 100)),
  });

  return {
    planoNome: plano?.planoNome ?? null,
    motoristas: recurso(motoristasUsados, plano?.limiteMotoristas ?? null),
    entregasMes: recurso(entregasUsadas, plano?.limiteEntregasMes ?? null),
    referenciaMes: referencia,
  };
}

/** Corpo padronizado da resposta HTTP 403 quando um limite de plano é atingido. */
export function erroLimite(r: ResultadoLimite) {
  const plano = r.planoNome ? `do plano ${r.planoNome} ` : '';
  return {
    error: `Limite ${plano}atingido: ${r.usado}/${r.limite} ${ROTULO_RECURSO[r.recurso]}. Faça upgrade do plano para continuar.`,
    codigo: 'PLAN_LIMIT_REACHED' as const,
    recurso: r.recurso,
    usado: r.usado,
    limite: r.limite,
    planoNome: r.planoNome,
  };
}

import mssql from 'mssql/msnodesqlv8';
import { pool } from '../database';
import { getGateway } from './gatewayFactory';
import { appendLedger } from './ledgerService';
import { WebhookNormalizado } from './PaymentGatewayAdapter';

// Worker assíncrono que consome a fila WEBHOOK_EVENTS com retry/backoff e DLQ.
// Mesma filosofia do egress de entregas (integrator.ts), mas para eventos de
// ENTRADA do gateway de pagamento. O processamento é idempotente no nível de
// negócio: reprocessar o mesmo evento é no-op (ex.: fatura já PAGA).

const BACKOFF_SEGUNDOS = [0, 5, 25, 120, 600]; // tentativas 1..5; última = DLQ
const LOTE = 20;

let processando = false;

/** Consome os eventos pendentes/vencidos da fila. Seguro contra reentrância. */
export async function processarFilaWebhooks(): Promise<void> {
  if (!pool || processando) return;
  processando = true;
  try {
    const agora = new Date().toISOString();
    const pend = await pool.request()
      .input('agora', mssql.VarChar, agora)
      .query(`SELECT TOP ${LOTE} * FROM WEBHOOK_EVENTS
              WHERE STATUS = 'PENDENTE'
                AND (PROXIMA_TENTATIVA IS NULL OR PROXIMA_TENTATIVA <= @agora)
              ORDER BY RECEBIDO_EM ASC`);

    for (const evt of pend.recordset) {
      try {
        await processarEvento(evt);
        await marcarProcessado(evt.ID);
      } catch (err: any) {
        const tentativa = evt.TENTATIVAS + 1;
        if (tentativa >= BACKOFF_SEGUNDOS.length) {
          await moverParaDLQ(evt.ID, err?.message ?? String(err));
          console.error(`[Webhook] Evento ${evt.ID} (${evt.EVENT_TYPE}) movido para DLQ:`, err?.message);
        } else {
          const proxima = new Date(Date.now() + BACKOFF_SEGUNDOS[tentativa] * 1000).toISOString();
          await reagendar(evt.ID, tentativa, proxima, err?.message ?? String(err));
          console.warn(`[Webhook] Evento ${evt.ID} falhou (tentativa ${tentativa}); reagendado p/ ${proxima}.`);
        }
      }
    }
  } finally {
    processando = false;
  }
}

/** Aplica o efeito de negócio de um evento. Lança em caso de falha (para retry). */
async function processarEvento(evt: any): Promise<void> {
  const gateway = getGateway();
  const norm = gateway.normalizarWebhook(evt.PAYLOAD);

  switch (norm.eventType) {
    case 'payment.confirmed':
      await darBaixaPorWebhook(norm, evt.GATEWAY_EVENT_ID);
      break;
    case 'payment.refunded':
      await estornarPorWebhook(norm, evt.GATEWAY_EVENT_ID);
      break;
    case 'payment.failed':
    case 'payment.overdue':
      await marcarAtrasoPorWebhook(norm);
      break;
    case 'subscription.deleted':
      await cancelarAssinaturaPorWebhook(norm);
      break;
    case 'subscription.created':
      // Sem efeito local nesta fase; apenas auditado pela presença na fila.
      console.log(`[Webhook] subscription.created recebido (${norm.gatewaySubscriptionId}).`);
      break;
    default:
      console.warn(`[Webhook] Tipo de evento não tratado: ${norm.eventType}`);
  }
}

/** payment.confirmed: baixa atômica e idempotente da fatura + ledger de crédito. */
async function darBaixaPorWebhook(norm: WebhookNormalizado, gatewayEventId: string): Promise<void> {
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const fat = await localizarFatura(tx, norm);
    if (!fat) {
      // Sem fatura correspondente: não é erro recuperável — registra e segue (não retenta infinito).
      console.warn(`[Webhook] Fatura não encontrada p/ ${norm.gatewayFaturaId}. Evento aceito sem efeito.`);
      await tx.commit();
      return;
    }
    if (fat.STATUS === 'PAGA') {
      // Idempotência de negócio: já processado. No-op.
      await tx.commit();
      return;
    }

    const pgto = norm.pagoEm || new Date().toISOString();
    const valorLiquido = Number(fat.VALOR_BRUTO) - Number(fat.VALOR_DESCONTO);

    await tx.request()
      .input('id', mssql.VarChar, fat.ID)
      .input('pgto', mssql.VarChar, pgto)
      .query("UPDATE FATURAS SET STATUS = 'PAGA', DATA_PAGAMENTO = @pgto WHERE ID = @id");

    await appendLedger({
      empresaId: fat.EMPRESA_ID,
      assinaturaId: fat.ASSINATURAS_EMPRESAS_ID ?? undefined,
      faturaId: fat.ID,
      tipo: 'CREDITO_PAGAMENTO',
      valor: valorLiquido,
      origem: 'WEBHOOK',
      referenciaExterna: gatewayEventId,
      metadados: { eventType: norm.eventType, gatewayFaturaId: norm.gatewayFaturaId },
      criadoPor: 'SYSTEM',
    }, tx);

    await tx.commit();
    console.log(`[Webhook] Fatura ${fat.ID} baixada via gateway (${gatewayEventId}).`);
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** payment.refunded: reabre a fatura e lança estorno no ledger. */
async function estornarPorWebhook(norm: WebhookNormalizado, gatewayEventId: string): Promise<void> {
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const fat = await localizarFatura(tx, norm);
    if (!fat) { await tx.commit(); return; }

    const valorLiquido = Number(fat.VALOR_BRUTO) - Number(fat.VALOR_DESCONTO);
    await tx.request()
      .input('id', mssql.VarChar, fat.ID)
      .query("UPDATE FATURAS SET STATUS = 'PENDENTE', DATA_PAGAMENTO = NULL WHERE ID = @id");

    await appendLedger({
      empresaId: fat.EMPRESA_ID,
      assinaturaId: fat.ASSINATURAS_EMPRESAS_ID ?? undefined,
      faturaId: fat.ID,
      tipo: 'ESTORNO',
      valor: -valorLiquido, // negativo: saída de saldo
      origem: 'WEBHOOK',
      referenciaExterna: gatewayEventId,
      metadados: { eventType: norm.eventType },
      criadoPor: 'SYSTEM',
    }, tx);

    await tx.commit();
    console.log(`[Webhook] Estorno aplicado à fatura ${fat.ID} (${gatewayEventId}).`);
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** payment.failed/overdue: marca a fatura como ATRASADA (se ainda em aberto). */
async function marcarAtrasoPorWebhook(norm: WebhookNormalizado): Promise<void> {
  const fat = await localizarFatura(null, norm);
  if (!fat || fat.STATUS === 'PAGA' || fat.STATUS === 'CANCELADA') return;
  await pool.request()
    .input('id', mssql.VarChar, fat.ID)
    .query("UPDATE FATURAS SET STATUS = 'ATRASADA' WHERE ID = @id AND STATUS = 'PENDENTE'");
  await appendLedger({
    empresaId: fat.EMPRESA_ID,
    faturaId: fat.ID,
    tipo: 'MARCA_ATRASO',
    valor: 0,
    origem: 'WEBHOOK',
    metadados: { eventType: norm.eventType },
    criadoPor: 'SYSTEM',
  });
}

/** subscription.deleted: cancela a assinatura no domínio atual ('CANCELADA'). */
async function cancelarAssinaturaPorWebhook(norm: WebhookNormalizado): Promise<void> {
  if (!norm.gatewaySubscriptionId) return;
  const subRes = await pool.request()
    .input('gw', mssql.VarChar, norm.gatewaySubscriptionId)
    .query('SELECT * FROM ASSINATURAS_EMPRESAS WHERE GATEWAY_SUBSCRIPTION_ID = @gw');
  if (subRes.recordset.length === 0) return;
  const sub = subRes.recordset[0];

  await pool.request()
    .input('id', mssql.VarChar, sub.ID)
    .input('cancel', mssql.VarChar, new Date().toISOString())
    .query("UPDATE ASSINATURAS_EMPRESAS SET STATUS = 'CANCELADA', CANCELADO_EM = @cancel WHERE ID = @id");

  await appendLedger({
    empresaId: sub.EMPRESA_ID,
    assinaturaId: sub.ID,
    tipo: 'CANCELAMENTO',
    valor: 0,
    origem: 'WEBHOOK',
    metadados: { eventType: norm.eventType, gatewaySubscriptionId: norm.gatewaySubscriptionId },
    criadoPor: 'SYSTEM',
  });
}

/** Localiza a fatura pelo GATEWAY_FATURA_ID (ou pelo ID local como fallback). */
async function localizarFatura(tx: mssql.Transaction | null, norm: WebhookNormalizado): Promise<any | null> {
  if (!norm.gatewayFaturaId) return null;
  const req = tx ? tx.request() : pool.request();
  const lock = tx ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const r = await req
    .input('gw', mssql.VarChar, norm.gatewayFaturaId)
    .query(`SELECT * FROM FATURAS ${lock} WHERE GATEWAY_FATURA_ID = @gw OR ID = @gw`);
  return r.recordset.length > 0 ? r.recordset[0] : null;
}

async function marcarProcessado(id: string): Promise<void> {
  await pool.request()
    .input('id', mssql.VarChar, id)
    .input('em', mssql.VarChar, new Date().toISOString())
    .query("UPDATE WEBHOOK_EVENTS SET STATUS = 'PROCESSADO', PROCESSADO_EM = @em WHERE ID = @id");
}

async function reagendar(id: string, tentativa: number, proxima: string, erro: string): Promise<void> {
  await pool.request()
    .input('id', mssql.VarChar, id)
    .input('t', mssql.Int, tentativa)
    .input('p', mssql.VarChar, proxima)
    .input('e', mssql.NVarChar, erro)
    .query("UPDATE WEBHOOK_EVENTS SET TENTATIVAS = @t, PROXIMA_TENTATIVA = @p, ERRO_ULTIMO = @e WHERE ID = @id");
}

async function moverParaDLQ(id: string, erro: string): Promise<void> {
  await pool.request()
    .input('id', mssql.VarChar, id)
    .input('e', mssql.NVarChar, erro)
    .query("UPDATE WEBHOOK_EVENTS SET STATUS = 'DLQ', ERRO_ULTIMO = @e WHERE ID = @id");
}

/** Rede de segurança: varre a fila periodicamente caso o disparo imediato falhe. */
export function iniciarWorkerWebhooks(): void {
  setInterval(() => {
    processarFilaWebhooks().catch((e) => console.error('[Webhook] Erro no worker:', e));
  }, 30_000);
  console.log('[Webhook] Worker de processamento de webhooks iniciado (intervalo 30s).');
}

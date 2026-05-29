import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import mssql from 'mssql/msnodesqlv8';
import { pool } from '../database';
import { getGateway } from './gatewayFactory';
import { processarFilaWebhooks } from './webhookProcessor';

// Ingress de webhooks do gateway de pagamento.
//
// IMPORTANTE: precisa do corpo BRUTO (Buffer) para validar HMAC. Em index.ts,
// esta rota é montada com express.raw ANTES do express.json global:
//   app.use('/api/billing/webhooks', express.raw({ type: '*/*' }), webhookRoutes);
//
// Estratégia "responde rápido, processa depois":
//   1. valida assinatura (anti-spoofing)
//   2. grava o evento bruto na fila (idempotência via UNIQUE) e responde 200
//   3. dispara o worker assíncrono (não bloqueia a resposta)

const router = Router();

router.post('/pagamento', async (req: Request, res: Response) => {
  if (!pool) {
    res.status(503).json({ error: 'banco indisponivel, retentar' });
    return;
  }

  const gateway = getGateway();
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});

  // 1. Anti-spoofing.
  if (!gateway.validarAssinatura(rawBody, req.headers)) {
    res.status(401).json({ error: 'assinatura invalida' });
    return;
  }

  // 2. Normaliza e grava ANTES de processar (durabilidade).
  let evt;
  try {
    evt = gateway.normalizarWebhook(rawBody);
  } catch {
    res.status(400).json({ error: 'payload invalido' });
    return;
  }

  try {
    await pool.request()
      .input('id', mssql.VarChar, crypto.randomUUID())
      .input('gwEvt', mssql.VarChar, evt.gatewayEventId)
      .input('gw', mssql.VarChar, gateway.nome)
      .input('type', mssql.VarChar, evt.eventType)
      .input('payload', mssql.NVarChar, rawBody)
      .input('hmac', mssql.VarChar, (req.headers['x-signature'] as string) ?? null)
      .input('rec', mssql.VarChar, new Date().toISOString())
      .query(`INSERT INTO WEBHOOK_EVENTS
              (ID, GATEWAY_EVENT_ID, GATEWAY, EVENT_TYPE, PAYLOAD, ASSINATURA_HMAC, STATUS, RECEBIDO_EM)
              VALUES (@id, @gwEvt, @gw, @type, @payload, @hmac, 'PENDENTE', @rec)`);
  } catch (err: any) {
    // Violação de UNIQUE(GATEWAY, GATEWAY_EVENT_ID) = evento repetido.
    // Idempotência: aceita com 200 e ignora. Checagem resiliente ao formato do
    // erro (mssql expõe .number; msnodesqlv8 pode trazer só código/mensagem).
    const msg = String(err?.message ?? '');
    const ehDuplicata =
      err?.number === 2627 || err?.number === 2601 ||
      err?.code === 'EREQUEST' && /duplicate key|UNIQUE KEY|2627|2601/i.test(msg) ||
      /duplicate key|UNIQUE KEY|2627|2601/i.test(msg);
    if (ehDuplicata) {
      res.status(200).json({ duplicado: true });
      return;
    }
    // Falha real de banco: 503 para o gateway RETENTAR (não perdemos o evento).
    console.error('[Webhook] Falha ao enfileirar evento:', err?.message);
    res.status(503).json({ error: 'indisponivel, retentar' });
    return;
  }

  // 3. Dispara o worker sem bloquear a resposta.
  setImmediate(() => {
    processarFilaWebhooks().catch((e) => console.error('[Webhook] Erro ao processar fila:', e));
  });

  res.status(200).json({ recebido: true });
});

export default router;

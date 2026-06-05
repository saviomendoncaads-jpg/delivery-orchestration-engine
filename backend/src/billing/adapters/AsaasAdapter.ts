import crypto from 'crypto';
import mssql from 'mssql/msnodesqlv8';
import { pool } from '../../database';
import {
  PaymentGatewayAdapter,
  CobrancaInput,
  CobrancaResult,
  WebhookNormalizado,
  NomeGateway,
  TipoEventoWebhook,
  MetodoPagamento,
} from '../PaymentGatewayAdapter';

/**
 * Driver real do gateway Asaas (https://docs.asaas.com).
 *
 * Cobre o mercado brasileiro: Pix, Boleto e Cartão. Implementa o contrato
 * PaymentGatewayAdapter — nenhuma regra de negócio conhece a Asaas, só esta classe.
 *
 * Autenticação da API: header `access_token: <ASAAS_API_KEY>`.
 * Autenticação do webhook (Asaas): header `asaas-access-token` igual ao token
 * configurado no painel da Asaas e em `ASAAS_WEBHOOK_TOKEN` (NÃO é HMAC do corpo —
 * é o mecanismo real da Asaas). Validação fail-closed: sem token = rejeita.
 *
 * Variáveis de ambiente:
 *   ASAAS_API_KEY        (obrigatória)  chave da API
 *   ASAAS_ENV            production|sandbox (default: sandbox)
 *   ASAAS_BASE_URL       (opcional)     sobrescreve a URL base
 *   ASAAS_WEBHOOK_TOKEN  (obrigatória p/ webhooks) token de autenticação do webhook
 */
export class AsaasAdapter implements PaymentGatewayAdapter {
  readonly nome: NomeGateway = 'ASAAS';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  /** Cache empresaId → customerId da Asaas, para não recriar cliente a cada cobrança. */
  private readonly clienteCache = new Map<string, string>();

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('AsaasAdapter: ASAAS_API_KEY não definida.');
    this.apiKey = apiKey;
    const env = (process.env.ASAAS_ENV || 'sandbox').toLowerCase();
    this.baseUrl =
      process.env.ASAAS_BASE_URL ||
      (env === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3');
  }

  // ─── Chamada HTTP autenticada à API da Asaas ───────────────────────────────
  private async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        access_token: this.apiKey,
        'User-Agent': 'Distre/1.0',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const texto = await res.text();
    const dados = texto ? JSON.parse(texto) : {};
    if (!res.ok) {
      const detalhe = dados?.errors?.[0]?.description || dados?.message || `HTTP ${res.status}`;
      throw new Error(`Asaas ${method} ${path} falhou: ${detalhe}`);
    }
    return dados as T;
  }

  /** Garante (e cacheia) o cliente na Asaas, vinculado à empresa local via externalReference. */
  private async garantirCliente(empresaId: string, clienteGatewayId?: string): Promise<string> {
    if (clienteGatewayId) return clienteGatewayId;
    const emCache = this.clienteCache.get(empresaId);
    if (emCache) return emCache;

    // Dados fiscais da empresa (nome + CNPJ) — obrigatórios para criar cliente na Asaas.
    const empRes = await pool.request()
      .input('id', mssql.VarChar, empresaId)
      .query('SELECT NOME, CNPJ FROM EMPRESAS WHERE ID = @id');
    if (empRes.recordset.length === 0) {
      throw new Error(`Empresa ${empresaId} não encontrada para criar cliente na Asaas.`);
    }
    const nome: string = empRes.recordset[0].NOME;
    const cpfCnpj: string = String(empRes.recordset[0].CNPJ || '').replace(/\D/g, '');
    if (!cpfCnpj) {
      throw new Error(`Empresa ${empresaId} sem CNPJ — não é possível criar cliente na Asaas.`);
    }

    // Idempotência entre reinícios: procura por externalReference antes de criar.
    const existentes = await this.api<{ data: Array<{ id: string }> }>(
      'GET',
      `/customers?externalReference=${encodeURIComponent(empresaId)}`,
    );
    let customerId = existentes?.data?.[0]?.id;
    if (!customerId) {
      const criado = await this.api<{ id: string }>('POST', '/customers', {
        name: nome,
        cpfCnpj,
        externalReference: empresaId,
      });
      customerId = criado.id;
    }
    this.clienteCache.set(empresaId, customerId);
    return customerId;
  }

  private static billingType(metodo: MetodoPagamento): string {
    switch (metodo) {
      case 'PIX': return 'PIX';
      case 'BOLETO': return 'BOLETO';
      case 'CARTAO': return 'CREDIT_CARD';
    }
  }

  /** Converte ISO 8601 para o formato de data exigido pela Asaas (YYYY-MM-DD). */
  private static dataVencimento(iso: string): string {
    return new Date(iso).toISOString().split('T')[0];
  }

  // ─── Contrato PaymentGatewayAdapter ────────────────────────────────────────

  async criarCobranca(input: CobrancaInput): Promise<CobrancaResult> {
    const customer = await this.garantirCliente(input.empresaId, input.clienteGatewayId);

    const pagamento = await this.api<any>('POST', '/payments', {
      customer,
      billingType: AsaasAdapter.billingType(input.metodo),
      value: input.valor,
      dueDate: AsaasAdapter.dataVencimento(input.vencimento),
      description: input.descricao,
      externalReference: input.faturaId, // casa com a FATURA local (ID) no webhook
    });

    // Pix: busca o copia-e-cola. Best-effort — uma falha aqui não invalida a cobrança.
    let pixCopiaCola: string | undefined;
    if (input.metodo === 'PIX') {
      try {
        const qr = await this.api<{ payload: string }>('GET', `/payments/${pagamento.id}/pixQrCode`);
        pixCopiaCola = qr?.payload;
      } catch (e) {
        console.warn('[Asaas] Não foi possível obter o QR Code Pix:', (e as Error)?.message);
      }
    }

    return {
      gatewayFaturaId: pagamento.id,
      boletoUrl: pagamento.bankSlipUrl ?? undefined,
      pixCopiaCola,
      linkPagamento: pagamento.invoiceUrl ?? undefined,
      status: pagamento.status === 'CONFIRMED' || pagamento.status === 'RECEIVED' ? 'CONFIRMADO' : 'PENDENTE',
    };
  }

  async cancelarCobranca(gatewayFaturaId: string): Promise<void> {
    await this.api('DELETE', `/payments/${gatewayFaturaId}`);
  }

  async reprocessarCartao(gatewayFaturaId: string): Promise<CobrancaResult> {
    // Retentativa de cartão tokenizado/recorrente é gerida pela própria Asaas. Aqui
    // consultamos o estado atual e devolvemos o link de pagamento para a régua/painel.
    const pagamento = await this.api<any>('GET', `/payments/${gatewayFaturaId}`);
    return {
      gatewayFaturaId: pagamento.id ?? gatewayFaturaId,
      linkPagamento: pagamento.invoiceUrl ?? undefined,
      boletoUrl: pagamento.bankSlipUrl ?? undefined,
      status: pagamento.status === 'CONFIRMED' || pagamento.status === 'RECEIVED' ? 'CONFIRMADO' : 'PENDENTE',
    };
  }

  validarAssinatura(_rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
    if (!esperado) {
      console.warn('[Asaas] ASAAS_WEBHOOK_TOKEN não configurado — webhook rejeitado (fail-closed). Configure o token do webhook no painel da Asaas e nesta variável.');
      return false;
    }
    const recebidoRaw = headers['asaas-access-token'];
    const recebido = Array.isArray(recebidoRaw) ? recebidoRaw[0] : recebidoRaw;
    if (!recebido) return false;

    // Comparação em tempo constante (anti-timing).
    const a = Buffer.from(recebido);
    const b = Buffer.from(esperado);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  normalizarWebhook(rawBody: string): WebhookNormalizado {
    const body = JSON.parse(rawBody || '{}');
    const pagamento = body.payment ?? {};
    const eventType = AsaasAdapter.mapearEvento(body.event);

    // gatewayFaturaId: prioriza o externalReference (= ID da FATURA local) para o
    // matching robusto em localizarFatura; cai para o id do pagamento na Asaas.
    const gatewayFaturaId = pagamento.externalReference || pagamento.id || undefined;

    // Event id estável p/ idempotência: usa o id do evento (API nova) ou sintetiza
    // a partir de evento+pagamento (retentativas da Asaas reenviam o mesmo par).
    const gatewayEventId = body.id || `${body.event}_${pagamento.id ?? crypto.randomUUID()}`;

    return {
      gatewayEventId,
      eventType,
      gatewayFaturaId,
      gatewaySubscriptionId: pagamento.subscription || body.subscription?.id || undefined,
      valor: typeof pagamento.value === 'number' ? pagamento.value : undefined,
      pagoEm: pagamento.paymentDate || pagamento.confirmedDate || undefined,
      raw: body,
    };
  }

  /** Traduz os eventos da Asaas para o vocabulário canônico interno. */
  private static mapearEvento(evento: string | undefined): TipoEventoWebhook {
    switch (evento) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED':
      case 'PAYMENT_RECEIVED_IN_CASH':
        return 'payment.confirmed';
      case 'PAYMENT_OVERDUE':
        return 'payment.overdue';
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEBACK_REQUESTED':
      case 'PAYMENT_CHARGEBACK_DISPUTE':
      case 'PAYMENT_PARTIALLY_REFUNDED':
        return 'payment.refunded';
      case 'PAYMENT_DELETED':
      case 'PAYMENT_REPROVED_BY_RISK_ANALYSIS':
        return 'payment.failed';
      case 'SUBSCRIPTION_CREATED':
        return 'subscription.created';
      case 'SUBSCRIPTION_DELETED':
      case 'SUBSCRIPTION_INACTIVATED':
        return 'subscription.deleted';
      default:
        // Evento não mapeado: trata como confirmação só se vier status de pago seria
        // arriscado; por segurança devolvemos overdue (não credita sem ter certeza).
        return 'payment.overdue';
    }
  }
}

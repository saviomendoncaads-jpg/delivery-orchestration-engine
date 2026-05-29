// Contrato único de gateway de pagamento (Adapter Pattern).
// A regra de negócio (faturas, dunning, ledger, state machine) NUNCA importa
// Asaas/Stripe/Iugu diretamente — depende apenas desta interface. Trocar de
// provedor é trocar o driver em gatewayFactory.ts, sem tocar no negócio.

export type MetodoPagamento = 'PIX' | 'BOLETO' | 'CARTAO';

export type NomeGateway = 'ASAAS' | 'STRIPE' | 'IUGU' | 'MOCK';

export type TipoEventoWebhook =
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.overdue'
  | 'payment.refunded'
  | 'subscription.created'
  | 'subscription.deleted';

export interface CobrancaInput {
  empresaId: string;
  faturaId: string;
  valor: number;
  vencimento: string; // ISO 8601
  metodo: MetodoPagamento;
  descricao: string;
  clienteGatewayId?: string; // id do cliente no provedor, se já existir
}

export interface CobrancaResult {
  gatewayFaturaId: string;
  boletoUrl?: string;
  pixCopiaCola?: string;
  linkPagamento?: string;
  status: 'PENDENTE' | 'CONFIRMADO';
}

export interface WebhookNormalizado {
  gatewayEventId: string;
  eventType: TipoEventoWebhook;
  gatewayFaturaId?: string;
  gatewaySubscriptionId?: string;
  valor?: number;
  pagoEm?: string;
  raw: unknown;
}

export interface PaymentGatewayAdapter {
  readonly nome: NomeGateway;

  /** Cria uma cobrança (Pix/Boleto/Cartão) no provedor para uma fatura local. */
  criarCobranca(input: CobrancaInput): Promise<CobrancaResult>;

  /** Cancela uma cobrança ainda não paga no provedor. */
  cancelarCobranca(gatewayFaturaId: string): Promise<void>;

  /** Retenta a cobrança no cartão (usado pela régua de dunning em D+3). */
  reprocessarCartao(gatewayFaturaId: string): Promise<CobrancaResult>;

  /** Valida a assinatura HMAC do webhook (anti-spoofing). */
  validarAssinatura(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;

  /** Traduz o payload específico do provedor para o formato canônico interno. */
  normalizarWebhook(rawBody: string): WebhookNormalizado;
}

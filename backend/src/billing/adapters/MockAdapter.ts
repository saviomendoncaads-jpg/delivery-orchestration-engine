import crypto from 'crypto';
import {
  PaymentGatewayAdapter,
  CobrancaInput,
  CobrancaResult,
  WebhookNormalizado,
  NomeGateway,
  TipoEventoWebhook,
} from '../PaymentGatewayAdapter';

// Driver de desenvolvimento/seed. Reproduz o comportamento atual de boleto/pix
// "fake" que já existia em financeiroService.ts (rota /cobrar-manual), agora
// atrás do contrato PaymentGatewayAdapter. Mantém o sistema 100% funcional
// sem nenhum gateway real configurado.
export class MockAdapter implements PaymentGatewayAdapter {
  readonly nome: NomeGateway = 'MOCK';

  async criarCobranca(input: CobrancaInput): Promise<CobrancaResult> {
    const gatewayFaturaId = `mock_${input.faturaId}`;
    // Mesmo formato de URL/Pix usado hoje no projeto, para compatibilidade visual.
    const boletoUrl = `https://boleto.pagamento.com/faturas/${input.faturaId}`;
    const pixCopiaCola = `00020101021226870014br.gov.bcb.pix2565pix.gateway.com/qr/${input.faturaId}`;

    return {
      gatewayFaturaId,
      boletoUrl: input.metodo === 'BOLETO' || input.metodo === 'PIX' ? boletoUrl : undefined,
      pixCopiaCola: input.metodo === 'PIX' ? pixCopiaCola : undefined,
      linkPagamento: `https://pay.mock.local/${input.faturaId}`,
      status: 'PENDENTE',
    };
  }

  async cancelarCobranca(_gatewayFaturaId: string): Promise<void> {
    // No-op no mock.
  }

  async reprocessarCartao(gatewayFaturaId: string): Promise<CobrancaResult> {
    // No mock a retentativa apenas devolve a mesma cobrança como pendente.
    return {
      gatewayFaturaId,
      status: 'PENDENTE',
      linkPagamento: `https://pay.mock.local/${gatewayFaturaId}`,
    };
  }

  validarAssinatura(_rawBody: string, _headers: Record<string, string | string[] | undefined>): boolean {
    // Mock aceita qualquer requisição (sem segredo real). Drivers reais validam HMAC.
    return true;
  }

  normalizarWebhook(rawBody: string): WebhookNormalizado {
    // Espera um payload simples no formato: { id, event, faturaId?, subscriptionId?, valor?, pagoEm? }
    const body = JSON.parse(rawBody || '{}');
    return {
      gatewayEventId: body.id ?? crypto.randomUUID(),
      eventType: (body.event as TipoEventoWebhook) ?? 'payment.confirmed',
      gatewayFaturaId: body.faturaId,
      gatewaySubscriptionId: body.subscriptionId,
      valor: typeof body.valor === 'number' ? body.valor : undefined,
      pagoEm: body.pagoEm,
      raw: body,
    };
  }
}

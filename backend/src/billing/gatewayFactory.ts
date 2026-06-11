import { PaymentGatewayAdapter } from './PaymentGatewayAdapter';
import { MockAdapter } from './adapters/MockAdapter';
import { AsaasAdapter } from './adapters/AsaasAdapter';

// Seleção do driver de gateway por variável de ambiente. Default = MOCK, para
// que dev/seed continuem funcionando sem credenciais reais.
//
// PAYMENT_GATEWAY=ASAAS + ASAAS_API_KEY ativa a cobrança real (Pix/Boleto/Cartão).
// Nenhuma regra de negócio muda — só esta função conhece os drivers concretos.

let instancia: PaymentGatewayAdapter | null = null;

export function getGateway(): PaymentGatewayAdapter {
  if (instancia) return instancia;

  const escolhido = (process.env.PAYMENT_GATEWAY || 'MOCK').toUpperCase();
  switch (escolhido) {
    case 'ASAAS': {
      const apiKey = process.env.ASAAS_API_KEY;
      if (!apiKey) {
        console.warn('[Billing] PAYMENT_GATEWAY=ASAAS mas ASAAS_API_KEY ausente. Caindo para MockAdapter.');
        instancia = new MockAdapter();
        return instancia;
      }
      console.log('[Billing] Gateway de pagamento ativo: ASAAS (cobrança real).');
      instancia = new AsaasAdapter(apiKey);
      return instancia;
    }
    case 'MOCK':
    default:
      if (escolhido !== 'MOCK') {
        console.warn(`[Billing] Gateway "${escolhido}" ainda não implementado. Usando MockAdapter.`);
      }
      instancia = new MockAdapter();
      return instancia;
  }
}

/** Reseta o singleton (útil em testes). */
export function _resetGateway() {
  instancia = null;
}

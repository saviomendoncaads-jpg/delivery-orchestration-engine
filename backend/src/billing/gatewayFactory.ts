import { PaymentGatewayAdapter } from './PaymentGatewayAdapter';
import { MockAdapter } from './adapters/MockAdapter';

// Seleção do driver de gateway por variável de ambiente. Default = MOCK, para
// que dev/seed continuem funcionando sem credenciais reais.
//
// Para plugar um provedor real (fase futura), importe e adicione o case aqui:
//   case 'ASAAS':  return new AsaasAdapter(process.env.ASAAS_API_KEY!);
//   case 'STRIPE': return new StripeAdapter(process.env.STRIPE_SECRET!);
//
// Nenhuma regra de negócio muda — só esta função conhece os drivers concretos.

let instancia: PaymentGatewayAdapter | null = null;

export function getGateway(): PaymentGatewayAdapter {
  if (instancia) return instancia;

  const escolhido = (process.env.PAYMENT_GATEWAY || 'MOCK').toUpperCase();
  switch (escolhido) {
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

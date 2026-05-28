import { broker } from './broker';
import { deliveries } from './gateway';
import { MensagemEvento, EstadoAgente, LogWebhook, StatusEntrega } from './types';

export class IntegratorAgent {
  public state: EstadoAgente = {
    id: 'agent-integrator',
    name: 'Agente Integrador (Egress)',
    status: 'idle',
    processedCount: 0,
    lastActive: new Date().toISOString(),
    latencyMs: 0
  };

  private lastSentStatus = new Map<string, StatusEntrega>();

  constructor() {
    this.init();
  }

  private init() {
    // Escuta o tópico entrega.monitorada (inclui atualizações de telemetria e estados finais)
    broker.subscribe('entrega.monitorada', this.state.name, async (event: MensagemEvento) => {
      const { deliveryId, status } = event.payload;
      
      // Só dispara webhooks quando o status mudar para evitar spam com atualizações de telemetria pura
      const statusAnterior = this.lastSentStatus.get(deliveryId);
      if (statusAnterior === status) {
        return; // Sem alteração de status, pula o webhook
      }

      this.state.status = 'active';
      this.state.lastActive = new Date().toISOString();
      const startTime = Date.now();

      this.lastSentStatus.set(deliveryId, status);
      await this.dispatchWebhook(deliveryId, status, event.payload);

      this.state.latencyMs = Date.now() - startTime;
      this.state.processedCount++;
      this.state.status = 'idle';

      // Limpa mapeamento se for um estado terminal (concluido ou devolvido)
      if (status === 'ENTREGUE' || status === 'RECUSADO_INSUCESSO') {
        this.lastSentStatus.delete(deliveryId);
      }
    });

    // Também escuta o evento de despacho (primeira atribuição de rota)
    broker.subscribe('entrega.despachada', this.state.name, async (event: MensagemEvento) => {
      const { deliveryId } = event.payload;
      
      this.state.status = 'active';
      this.state.lastActive = new Date().toISOString();
      const startTime = Date.now();

      this.lastSentStatus.set(deliveryId, 'DESPACHADO');
      const delivery = deliveries.get(deliveryId);
      
      if (delivery) {
        await this.dispatchWebhook(deliveryId, 'DESPACHADO', delivery);
      }

      this.state.latencyMs = Date.now() - startTime;
      this.state.processedCount++;
      this.state.status = 'idle';
    });
  }

  private async dispatchWebhook(
    deliveryId: string, 
    status: StatusEntrega, 
    payload: any, 
    attempt: number = 1
  ): Promise<void> {
    const delivery = deliveries.get(deliveryId);
    if (!delivery || !delivery.urlWebhook) return;

    const url = delivery.urlWebhook;
    
    // Constrói payload do webhook padrão com a estrutura do Módulo 4
    const x = delivery.telemetria?.localizacaoAtual.x || 10;
    const y = delivery.telemetria?.localizacaoAtual.y || 10;
    
    const webhookPayload = {
      event_id: `EVT_${Math.random().toString(36).substring(2, 8).toUpperCase()}_${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
      event_type: status === 'ENTREGUE' ? 'delivery.completed' : 
                  status === 'PRODUTO_RETORNADO_ESTOQUE' ? 'delivery.canceled' : 
                  `delivery.${status.toLowerCase()}`,
      timestamp: new Date().toISOString(),
      data: {
        comanda_id: deliveryId,
        cliente: delivery.nomeCliente,
        entregador: delivery.motorista ? {
          id: delivery.motorista.id,
          nome: delivery.motorista.name
        } : null,
        conclusao: status === 'ENTREGUE' ? {
          coordenadas_entrega: {
            lat: -23.55052 + (y * 0.0001),
            lng: -46.63330 + (x * 0.0001)
          },
          recebedor_nome: delivery.recebedorNome || 'Recebedor Não Informado',
          recebedor_documento: delivery.recebedorCPF || '000.000.000-00',
          assinatura_url: `https://storage.sistema.com/signatures/${deliveryId}.png`,
          foto_fachada_url: `https://storage.sistema.com/photos/${deliveryId}.jpg`
        } : undefined
      }
    };

    console.log(`[Integrator] Disparando webhook para ${deliveryId} (${status}), Tentativa ${attempt}...`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delivery-Engine-Signature': `sha256=${crypto.randomUUID()}`
        },
        body: JSON.stringify(webhookPayload),
        signal: AbortSignal.timeout(4000) // 4 segundos de timeout
      });

      const logEntry: LogWebhook = {
        timestamp: new Date().toISOString(),
        url,
        payload: webhookPayload,
        status: response.ok ? 'sucesso' : 'falha',
        statusCode: response.status,
        attempt
      };

      if (!response.ok) {
        logEntry.errorMessage = `HTTP error status ${response.status}`;
      }

      delivery.logsWebhook.push(logEntry);
      
      if (response.ok) {
        console.log(`[Integrator] Webhook enviado com sucesso para ${url}`);
      } else {
        console.warn(`[Integrator] Webhook falhou com status ${response.status}.`);
        this.scheduleRetry(deliveryId, status, payload, attempt);
      }
    } catch (err: any) {
      console.error(`[Integrator] Erro ao disparar webhook para ${url}:`, err.message);

      const logEntry: LogWebhook = {
        timestamp: new Date().toISOString(),
        url,
        payload: webhookPayload,
        status: 'falha',
        errorMessage: err.message || 'Erro de Rede/Timeout',
        attempt
      };
      
      delivery.logsWebhook.push(logEntry);
      this.scheduleRetry(deliveryId, status, payload, attempt);
    }
  }

  private scheduleRetry(deliveryId: string, status: StatusEntrega, payload: any, attempt: number) {
    if (attempt >= 4) {
      console.error(`[Integrator] Webhook para ${deliveryId} (${status}) falhou após 4 tentativas. Movendo para DLQ.`);
      
      const delivery = deliveries.get(deliveryId);
      if (delivery) {
        delivery.logsWebhook.push({
          timestamp: new Date().toISOString(),
          url: delivery.urlWebhook || '',
          payload: null,
          status: 'falha',
          errorMessage: 'Fila DLQ (Dead Letter Queue) - Excedeu limite de 4 retentativas.',
          attempt: 5
        });
      }
      return;
    }

    const nextAttempt = attempt + 1;
    let delay = 5000; // 5s
    if (nextAttempt === 3) delay = 25000; // 25s
    if (nextAttempt === 4) delay = 120000; // 2m (120s)

    console.log(`[Integrator] Agendando tentativa #${nextAttempt} para ${deliveryId} em ${delay}ms`);

    const delivery = deliveries.get(deliveryId);
    if (delivery) {
      delivery.logsWebhook.push({
        timestamp: new Date().toISOString(),
        url: delivery.urlWebhook || '',
        payload: null,
        status: 'tentando',
        errorMessage: `Tentativa agendada #${nextAttempt} em ${delay / 1000}s`,
        attempt: nextAttempt
      });
    }

    setTimeout(() => {
      this.dispatchWebhook(deliveryId, status, payload, nextAttempt);
    }, delay);
  }

  public getAgentState(): EstadoAgente {
    return this.state;
  }
}

export const integratorAgent = new IntegratorAgent();

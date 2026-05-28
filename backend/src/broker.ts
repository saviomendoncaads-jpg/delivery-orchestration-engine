import { EventEmitter } from 'events';
import { MensagemEvento } from './types';
import { salvarEvento } from './database';

export type BroadcastCallback = (event: MensagemEvento, queueSize: number) => void;

export class MessageBroker {
  private emitter = new EventEmitter();
  private messageHistory: MensagemEvento[] = [];
  private topicQueueSizes: Record<string, number> = {};
  private broadcastCb: BroadcastCallback | null = null;
  private consumerCount: Record<string, number> = {};

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  // Registra callback para transmitir eventos via WebSockets
  public registerBroadcastCallback(cb: BroadcastCallback) {
    this.broadcastCb = cb;
  }

  // Publica um evento no barramento de mensagens
  public publish(topic: string, deliveryId: string, payload: any): void {
    const event: MensagemEvento = {
      id: crypto.randomUUID(),
      topic,
      deliveryId,
      payload: JSON.parse(JSON.stringify(payload)), // Clone profundo
      timestamp: new Date().toISOString(),
    };

    this.messageHistory.push(event);
    if (this.messageHistory.length > 500) {
      this.messageHistory.shift(); // Limita o tamanho do histórico
    }

    // Persiste o log do barramento de eventos no banco de dados
    salvarEvento(event);

    // Incrementa tamanho da fila para visualização
    this.topicQueueSizes[topic] = (this.topicQueueSizes[topic] || 0) + 1;

    // Dispara transmissão para o painel
    if (this.broadcastCb) {
      this.broadcastCb(event, this.topicQueueSizes[topic]);
    }

    // Emite o evento assincronamente para simular atraso da fila
    setTimeout(() => {
      this.emitter.emit(topic, event);
      // Decrementa o tamanho da fila ao processar
      if (this.topicQueueSizes[topic] > 0) {
        this.topicQueueSizes[topic]--;
      }
    }, 300); // Simulação de 300ms de latência de rede no broker
  }

  // Se inscreve em um tópico do barramento
  public subscribe(
    topic: string, 
    agentName: string, 
    handler: (event: MensagemEvento) => Promise<void>
  ): void {
    this.consumerCount[topic] = (this.consumerCount[topic] || 0) + 1;

    this.emitter.on(topic, async (event: MensagemEvento) => {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[Broker] Erro no assinante '${agentName}' do tópico '${topic}':`, err);
        this.publish('entrega.devolvida', event.deliveryId, {
          error: (err as Error).message,
          originalTopic: topic,
          failedAgent: agentName
        });
      }
    });
  }

  public getHistory(): MensagemEvento[] {
    return this.messageHistory;
  }

  public getQueueMetrics() {
    return {
      topicQueueSizes: this.topicQueueSizes,
      historyCount: this.messageHistory.length,
      consumerCount: this.consumerCount
    };
  }

  public clearHistory(): void {
    this.messageHistory = [];
  }
}

// Instância global única (singleton) para simulação de processo único
export const broker = new MessageBroker();

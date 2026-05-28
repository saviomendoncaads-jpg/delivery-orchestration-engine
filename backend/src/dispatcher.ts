import { broker } from './broker';
import { deliveries, drivers } from './gateway';
import { MensagemEvento, EstadoAgente, Motorista, Rota, NoRota, Entrega } from './types';
import { salvarEntrega } from './database';
import { autoDispatchSettings } from './config';

export class DispatcherAgent {
  public state: EstadoAgente = {
    id: 'agent-dispatcher',
    name: 'Agente Dispatcher',
    status: 'idle',
    processedCount: 0,
    lastActive: new Date().toISOString(),
    latencyMs: 0
  };

  private activeAssignments = new Map<string, NodeJS.Timeout>();
  private batchTimer: NodeJS.Timeout | null = null;
  private pendingToProcess: { deliveryId: string; preferredDriverId?: string; x?: number; y?: number }[] = [];

  constructor() {
    this.init();
  }

  private init() {
    // Se inscreve no tópico entrega.recebida
    broker.subscribe('entrega.recebida', this.state.name, async (event: MensagemEvento) => {
      const del = deliveries.get(event.deliveryId);
      const lojaId = del?.lojaId || 'global';
      const isAuto = autoDispatchSettings.get(lojaId) !== false;
      if (!isAuto) {
        console.log(`[Dispatcher] Despacho automático desativado para a loja ${lojaId}. Ignorando processamento automático para entrega ${event.deliveryId}.`);
        return;
      }

      this.pendingToProcess.push({
        deliveryId: event.deliveryId,
        preferredDriverId: event.payload?.driverId,
        x: event.payload?.x,
        y: event.payload?.y
      });

      if (!this.batchTimer) {
        this.batchTimer = setTimeout(async () => {
          this.batchTimer = null;
          const toProcess = [...this.pendingToProcess];
          this.pendingToProcess = [];

          this.state.status = 'active';
          this.state.lastActive = new Date().toISOString();
          const startTime = Date.now();

          for (const item of toProcess) {
            // Pode ter sido agrupada por uma iteração anterior do loop
            const del = deliveries.get(item.deliveryId);
            if (del && del.status === 'RECEBIDO') {
              await this.processDelivery(item.deliveryId, item.preferredDriverId, item.x, item.y);
            }
          }

          this.state.latencyMs = Date.now() - startTime;
          this.state.processedCount += toProcess.length;
          this.state.status = 'idle';
        }, 3000); // 3 segundos de janela de batching
      }
    });
  }

  private async processDelivery(deliveryId: string, preferredDriverId?: string, x?: number, y?: number) {
    const delivery = deliveries.get(deliveryId);
    if (!delivery) {
      console.error(`[Dispatcher] Entrega ${deliveryId} não encontrada no gateway.`);
      return;
    }

    if (delivery.status !== 'RECEBIDO') return; // Pode já ter sido agrupada por outro evento

    console.log(`[Dispatcher] Processando agrupamento/atribuição para Entrega ${deliveryId}...`);

    const lojaId = delivery.lojaId;

    // 1. Gera coordenadas de destino se não existirem
    if (!delivery.destino) {
      delivery.destino = {
        x: x !== undefined ? x : 40 + Math.floor(Math.random() * 55),
        y: y !== undefined ? y : 40 + Math.floor(Math.random() * 55)
      };
    }

    // 2. Agrupamento (Clustering)
    const pendingDeliveries = Array.from(deliveries.values())
      .filter(d => d.status === 'RECEBIDO' && d.lojaId === lojaId && d.tipoCarga === delivery.tipoCarga && d.id !== deliveryId);

    pendingDeliveries.forEach(d => {
      if (!d.destino) {
        d.destino = {
          x: 40 + Math.floor(Math.random() * 55),
          y: 40 + Math.floor(Math.random() * 55)
        };
      }
    });

    const batch = [delivery];
    
    // Procura entregas próximas (raio 50) limitando a 3 por lote
    for (const d of pendingDeliveries) {
      if (batch.length >= 3) break;
      const dist = Math.sqrt(Math.pow(d.destino!.x - delivery.destino!.x, 2) + Math.pow(d.destino!.y - delivery.destino!.y, 2));
      if (dist <= 50) {
        batch.push(d);
      }
    }

    // Ordena o lote com lógica Nearest Neighbor partindo do CD (10, 10)
    let currentX = 10;
    let currentY = 10;
    const orderedBatch = [];
    while (batch.length > 0) {
      let closestIdx = 0;
      let minDst = Infinity;
      for (let i = 0; i < batch.length; i++) {
        const dst = Math.sqrt(Math.pow(batch[i].destino!.x - currentX, 2) + Math.pow(batch[i].destino!.y - currentY, 2));
        if (dst < minDst) {
          minDst = dst;
          closestIdx = i;
        }
      }
      const next = batch.splice(closestIdx, 1)[0];
      orderedBatch.push(next);
      currentX = next.destino!.x;
      currentY = next.destino!.y;
    }

    console.log(`[Dispatcher] Lote gerado: ${orderedBatch.length} entrega(s) agrupada(s).`);

    // 3. Encontra um motorista disponível
    let motorista: Motorista | null = null;
    if (preferredDriverId) {
      motorista = drivers.find(d =>
        d.id === preferredDriverId &&
        d.status === 'ocioso' &&
        (!lojaId || d.lojaId === lojaId)
      ) || null;
    }

    if (!motorista) {
      motorista = this.findDriverForCargo(delivery.tipoCarga, lojaId);
    }

    if (!motorista) {
      console.log(`[Dispatcher] Nenhum motorista disponível. Tentando novamente lote do ${deliveryId} em 5 segundos...`);
      const timeout = setTimeout(() => {
        this.processDelivery(deliveryId, preferredDriverId, x, y);
      }, 5000);
      this.activeAssignments.set(deliveryId, timeout);
      return;
    }

    motorista.status = 'ocupado';

    const activeCount = Array.from(deliveries.values()).filter(d => 
      d.motorista?.id === motorista!.id && 
      (d.status === 'DESPACHADO' || d.status === 'EM_TRANSITO' || d.status === 'NO_LOCAL' || d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA')
    ).length;

    // 4. Gera Rotas e Despacha o Lote
    let seqStartX = 10; // Começa do CD
    let seqStartY = 10;

    for (let i = 0; i < orderedBatch.length; i++) {
      const d = orderedBatch[i];
      d.motorista = motorista;
      d.sequenciaEsperada = activeCount + i + 1;
      
      const destX = d.destino!.x;
      const destY = d.destino!.y;
      
      const rota = this.generateRoute(d.tipoCarga, seqStartX, seqStartY, destX, destY);
      d.rota = rota;
      d.status = 'DESPACHADO';
      d.atualizadoEm = new Date().toISOString();
      await salvarEntrega(d);
      
      console.log(`[Dispatcher] Motorista ${motorista.name} atribuído à entrega ${d.id} (Sequência Esperada: ${d.sequenciaEsperada}).`);
      
      broker.publish('entrega.despachada', d.id, {
        deliveryId: d.id,
        driverId: motorista.id,
        route: rota,
        priority: d.prioridade
      });

      // A próxima perna da rota sairá de onde esta entrega terminou
      seqStartX = destX;
      seqStartY = destY;
    }

    if (this.activeAssignments.has(deliveryId)) {
      this.activeAssignments.delete(deliveryId);
    }
  }

  private findDriverForCargo(tipoCarga: string, lojaId?: string): Motorista | null {
    // Filtra motoristas pelo contexto de tenant (loja)
    const frotas = lojaId ? drivers.filter(d => d.lojaId === lojaId) : drivers;

    // Tenta encontrar um veículo preferencial
    let tiposPreferenciais: string[] = [];
    if (tipoCarga === 'expressa') {
      tiposPreferenciais = ['drone', 'motorcycle'];
    } else if (tipoCarga === 'agendado') {
      tiposPreferenciais = ['refrigerated_truck', 'van'];
    } else if (tipoCarga === 'normal') {
      tiposPreferenciais = ['van', 'motorcycle', 'drone'];
    } else {
      tiposPreferenciais = ['van', 'motorcycle', 'drone', 'refrigerated_truck'];
    }

    const getActiveCount = (driverId: string) => {
      return Array.from(deliveries.values()).filter(d =>
        d.motorista?.id === driverId &&
        (d.status === 'RECEBIDO' || d.status === 'DESPACHADO' || d.status === 'EM_TRANSITO' || d.status === 'NO_LOCAL')
      ).length;
    };

    // Procura na ordem de preferência um motorista que tenha menos de 3 entregas
    for (const tipo of tiposPreferenciais) {
      const motoristasValidos = frotas
        .filter(d => d.vehicleType === tipo)
        .map(d => ({ d, count: getActiveCount(d.id) }))
        .filter(x => x.count < 3)
        .sort((a, b) => a.count - b.count);
      if (motoristasValidos.length > 0) return motoristasValidos[0].d;
    }

    // Fallback para QUALQUER motorista desta frota com menos de 3 entregas
    const motoristasFallback = frotas
      .map(d => ({ d, count: getActiveCount(d.id) }))
      .filter(x => x.count < 3)
      .sort((a, b) => a.count - b.count);
    return motoristasFallback.length > 0 ? motoristasFallback[0].d : null;
  }

  private generateRoute(tipoCarga: string, startX: number, startY: number, destX: number, destY: number): Rota {
    // Usa coords de destino informadas
    const endX = destX;
    const endY = destY;

    // Cria pontos intermediários (ex. 6 waypoints para fluxo visual)
    const passos = 6;
    const path: NoRota[] = [];
    
    path.push({ x: startX, y: startY, name: 'Ponto de Partida' });
    
    for (let i = 1; i < passos; i++) {
      const ratio = i / passos;
      // Adiciona distorção na rota para ficar curvilíneo
      const jitterX = (Math.random() - 0.5) * 15;
      const jitterY = (Math.random() - 0.5) * 15;
      
      const x = Math.min(95, Math.max(5, Math.round(startX + (endX - startX) * ratio + jitterX)));
      const y = Math.min(95, Math.max(5, Math.round(startY + (endY - startY) * ratio + jitterY)));
      path.push({ x, y, name: `Ponto de Rota ${i}` });
    }
    
    path.push({ x: endX, y: endY, name: `Destino Final: Cliente` });

    // Calcula métricas
    const dx = endX - startX;
    const dy = endY - startY;
    const distanceKm = Math.round(Math.sqrt(dx * dx + dy * dy) * 0.25 * 10) / 10; // escala
    
    // Duração básica em segundos
    const durationSec = Math.round(distanceKm * 4); // cada km leva 4s na escala da simulação
    const cost = Math.round(distanceKm * 1.5 * 100) / 100;

    return {
      distanceKm,
      durationSec,
      cost,
      path
    };
  }

  public async manualDispatch(deliveryIds: string[], driverId: string) {
    const batch: Entrega[] = [];
    for (const id of deliveryIds) {
      const del = deliveries.get(id);
      if (del && del.status === 'RECEBIDO') {
        if (!del.destino) {
          del.destino = {
            x: 40 + Math.floor(Math.random() * 55),
            y: 40 + Math.floor(Math.random() * 55)
          };
        }
        batch.push(del);
      }
    }

    if (batch.length === 0) {
      throw new Error("Nenhuma entrega válida em estado RECEBIDO encontrada.");
    }

    const motorista = drivers.find(d => d.id === driverId);
    if (!motorista) {
      throw new Error("Motorista não encontrado.");
    }

    motorista.status = 'ocupado';

    const activeCount = Array.from(deliveries.values()).filter(d => 
      d.motorista?.id === motorista.id && 
      (d.status === 'DESPACHADO' || d.status === 'EM_TRANSITO' || d.status === 'NO_LOCAL' || d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA')
    ).length;

    // Começa do CD (10,10) ou do último destino ativo do motorista
    let currentX = 10;
    let currentY = 10;

    const activeDels = Array.from(deliveries.values())
      .filter(d => d.motorista?.id === motorista.id && (d.status === 'DESPACHADO' || d.status === 'EM_TRANSITO' || d.status === 'NO_LOCAL' || d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA'))
      .sort((a, b) => (a.sequenciaEsperada || 0) - (b.sequenciaEsperada || 0));

    if (activeDels.length > 0) {
      const lastActive = activeDels[activeDels.length - 1];
      if (lastActive.destino) {
        currentX = lastActive.destino.x;
        currentY = lastActive.destino.y;
      }
    }

    const orderedBatch = [];
    while (batch.length > 0) {
      let closestIdx = 0;
      let minDst = Infinity;
      for (let i = 0; i < batch.length; i++) {
        const dst = Math.sqrt(Math.pow(batch[i].destino!.x - currentX, 2) + Math.pow(batch[i].destino!.y - currentY, 2));
        if (dst < minDst) {
          minDst = dst;
          closestIdx = i;
        }
      }
      const next = batch.splice(closestIdx, 1)[0];
      orderedBatch.push(next);
      currentX = next.destino!.x;
      currentY = next.destino!.y;
    }

    let seqStartX = 10;
    let seqStartY = 10;
    if (activeDels.length > 0) {
      const lastActive = activeDels[activeDels.length - 1];
      if (lastActive.destino) {
        seqStartX = lastActive.destino.x;
        seqStartY = lastActive.destino.y;
      }
    }

    for (let i = 0; i < orderedBatch.length; i++) {
      const d = orderedBatch[i];
      d.motorista = motorista;
      d.sequenciaEsperada = activeCount + i + 1;
      
      const destX = d.destino!.x;
      const destY = d.destino!.y;
      
      const rota = this.generateRoute(d.tipoCarga, seqStartX, seqStartY, destX, destY);
      d.rota = rota;
      d.status = 'DESPACHADO';
      d.atualizadoEm = new Date().toISOString();
      await salvarEntrega(d);
      
      console.log(`[Dispatcher - Manual] Motorista ${motorista.name} atribuído à entrega ${d.id} (Sequência Esperada: ${d.sequenciaEsperada}).`);
      
      broker.publish('entrega.despachada', d.id, {
        deliveryId: d.id,
        driverId: motorista.id,
        route: rota,
        priority: d.prioridade
      });
      
      seqStartX = destX;
      seqStartY = destY;
    }
  }

  public getAgentState(): EstadoAgente {
    return this.state;
  }
}

export const dispatcherAgent = new DispatcherAgent();

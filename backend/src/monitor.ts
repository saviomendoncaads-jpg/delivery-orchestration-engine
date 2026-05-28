import { broker } from './broker';
import { deliveries, drivers } from './gateway';
import { MensagemEvento, EstadoAgente, Telemetria, Localizacao, Incidente } from './types';
import { salvarEntrega } from './database';

export class MonitorAgent {
  public state: EstadoAgente = {
    id: 'agent-monitor',
    name: 'Agente Monitor (Supervisor)',
    status: 'idle',
    processedCount: 0,
    lastActive: new Date().toISOString(),
    latencyMs: 0
  };

  private activeIntervals = new Map<string, NodeJS.Timeout>();
  private stationaryTracker = new Map<string, { x: number, y: number, duration: number }>();
  private heartbeatCounts = new Map<string, number>();

  constructor() {
    this.init();
  }

  private init() {
    // Se inscreve no tópico entrega.despachada
    broker.subscribe('entrega.despachada', this.state.name, async (event: MensagemEvento) => {
      this.state.status = 'active';
      this.state.lastActive = new Date().toISOString();
      const startTime = Date.now();

      const delivery = deliveries.get(event.deliveryId);
      if (delivery && delivery.sequenciaEsperada && delivery.sequenciaEsperada > 1) {
        // Verifica se há alguma entrega pendente com sequência menor
        const motoristaId = delivery.motorista?.id;
        const seqEsperada = delivery.sequenciaEsperada;
        const pendentesAnteriores = Array.from(deliveries.values()).some(d => 
          d.motorista?.id === motoristaId &&
          d.id !== delivery.id &&
          d.sequenciaEsperada && d.sequenciaEsperada < seqEsperada &&
          d.status !== 'ENTREGUE' && d.status !== 'RECUSADO_INSUCESSO' && d.status !== 'PRODUTO_RETORNADO_ESTOQUE'
        );
        if (pendentesAnteriores) {
          console.log(`[Monitor] Entrega ${delivery.id} aguardando a vez na sequência (Sequência: ${delivery.sequenciaEsperada}).`);
          this.state.latencyMs = Date.now() - startTime;
          this.state.processedCount++;
          this.state.status = 'idle';
          return;
        }
      }

      this.startTelemetryLoop(event.deliveryId);

      this.state.latencyMs = Date.now() - startTime;
      this.state.processedCount++;
      this.state.status = 'idle';
    });

    // Se inscreve no tópico ALERTA_GERADO para alterar o status do card
    broker.subscribe('ALERTA_GERADO', this.state.name, async (event: MensagemEvento) => {
      this.state.lastActive = new Date().toISOString();
      this.state.processedCount++;
      
      const gravidade = event.payload.gravidade;
      if (gravidade === 'critico') {
        this.state.status = 'critical';
      } else {
        this.state.status = 'warning';
      }
    });

    // Se inscreve no tópico entrega.monitorada para resetar o status quando os alertas sumirem e orquestrar filas
    broker.subscribe('entrega.monitorada', this.state.name, async (event: MensagemEvento) => {
      const activeAlerts = Array.from(deliveries.values()).some(d => 
        (d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA') && 
        d.incidentes.some(i => !i.resolvido)
      );
      if (!activeAlerts && (this.state.status === 'warning' || this.state.status === 'critical')) {
        this.state.status = 'idle';
      }

      // Lógica Sequencial de Agrupamento
      const { deliveryId, status } = event.payload;
      if (status === 'ENTREGUE' || status === 'RECUSADO_INSUCESSO' || status === 'PRODUTO_RETORNADO_ESTOQUE') {
         const finishedDelivery = deliveries.get(deliveryId);
         if (finishedDelivery && finishedDelivery.motorista) {
            const motoristaId = finishedDelivery.motorista.id;
            const seqAtual = finishedDelivery.sequenciaEsperada || 1;
            
            // Procura a próxima entrega na sequência
            const proximaEntrega = Array.from(deliveries.values()).find(d => 
               d.motorista?.id === motoristaId &&
               d.sequenciaEsperada === seqAtual + 1 &&
               d.status === 'DESPACHADO'
            );

            if (proximaEntrega) {
               console.log(`[Monitor] Iniciando telemetria da próxima entrega ${proximaEntrega.id} (Sequência ${proximaEntrega.sequenciaEsperada}).`);
               this.startTelemetryLoop(proximaEntrega.id);
            } else {
               // Verifica se restou alguma em andamento
               const hasActive = Array.from(deliveries.values()).some(d => 
                 d.motorista?.id === motoristaId &&
                 d.status !== 'ENTREGUE' && d.status !== 'RECUSADO_INSUCESSO' && d.status !== 'PRODUTO_RETORNADO_ESTOQUE' && d.status !== 'RECEBIDO'
               );
               if (!hasActive && drivers) {
                 const drv = drivers.find(d => d.id === motoristaId);
                 if (drv) drv.status = 'ocioso';
               }
            }
         }
      }
    });
  }

  private startTelemetryLoop(deliveryId: string) {
    const delivery = deliveries.get(deliveryId);
    if (!delivery || !delivery.rota) return;

    // Limpa qualquer loop existente
    if (this.activeIntervals.has(deliveryId)) {
      clearInterval(this.activeIntervals.get(deliveryId)!);
    }
    this.heartbeatCounts.set(deliveryId, 0);

    // Inicializa Telemetria
    const path = delivery.rota.path;
    const startLoc = path[0];
    
    const telemetria: Telemetria = {
      velocidadeKmh: delivery.motorista?.vehicleType === 'drone' ? 90 : 50,
      combustivelBateriaPct: 100,
      localizacaoAtual: { x: startLoc.x, y: startLoc.y },
      timestamp: new Date().toISOString()
    };

    if (delivery.tipoCarga === 'agendado') {
      telemetria.temperaturaCelsius = -18; // Alvo para cadeia fria / agendado sensível
    }

    delivery.telemetria = telemetria;
    delivery.status = 'EM_TRANSITO';
    delivery.atualizadoEm = new Date().toISOString();

    // Rastreamento do índice do nó e subdivisão
    let currentNodeIdx = 0;
    const stepsPerSegment = 8; // Passos entre cada nó do caminho
    let currentStep = 0;

    const interval = setInterval(async () => {
      // Busca a referência mais recente da entrega caso tenha havido atualizações/incidentes
      const activeDelivery = deliveries.get(deliveryId);
      if (!activeDelivery || activeDelivery.status === 'ENTREGUE' || activeDelivery.status === 'RECUSADO_INSUCESSO' || activeDelivery.status === 'NO_LOCAL') {
        this.stopTelemetry(deliveryId);
        return;
      }

      const activeIncidents = activeDelivery.incidentes.filter(i => !i.resolvido);

      // Incrementa e publica GPS_HEARTBEAT
      const currentHeartbeats = (this.heartbeatCounts.get(deliveryId) || 0) + 1;
      this.heartbeatCounts.set(deliveryId, currentHeartbeats);

      broker.publish('GPS_HEARTBEAT', deliveryId, {
        deliveryId,
        motoristaId: activeDelivery.motorista?.id,
        x: activeDelivery.telemetria?.localizacaoAtual.x,
        y: activeDelivery.telemetria?.localizacaoAtual.y,
        velocidadeKmh: activeDelivery.telemetria?.velocidadeKmh,
        combustivelBateriaPct: activeDelivery.telemetria?.combustivelBateriaPct,
        timestamp: new Date().toISOString()
      });

      // Verificação de parada prolongada (Stale Driver)
      if (activeDelivery.telemetria) {
        const locAtual = activeDelivery.telemetria.localizacaoAtual;
        let stationary = this.stationaryTracker.get(deliveryId) || { x: locAtual.x, y: locAtual.y, duration: 0 };
        
        const dist = Math.sqrt(Math.pow(locAtual.x - stationary.x, 2) + Math.pow(locAtual.y - stationary.y, 2));
        if (dist < 1.0) {
          stationary.duration += 1.5; // O intervalo roda a cada 1.5s
          
          if (stationary.duration >= 10 && !activeDelivery.incidentes.some(i => i.tipo === 'route_deviation' && i.descricao.includes('AlertaParadaProlongada'))) {
            const alertIncident: Incidente = {
              id: `inc-${Math.random().toString(36).substring(2, 6)}`,
              tipo: 'route_deviation',
              descricao: `AlertaParadaProlongada: Parada não programada por mais de 10s (GPS estacionário em x: ${locAtual.x}, y: ${locAtual.y}).`,
              gravidade: 'critico',
              timestamp: new Date().toISOString(),
              resolvido: false
            };
            activeDelivery.incidentes.push(alertIncident);
            activeDelivery.status = 'ALERTA_INCIDENTE';
            activeDelivery.atualizadoEm = new Date().toISOString();
            
            broker.publish('entrega.monitorada', deliveryId, {
              deliveryId,
              status: 'ALERTA_INCIDENTE',
              incidents: activeDelivery.incidentes,
              telemetria: activeDelivery.telemetria,
              paradaProlongada: true,
              tempoParadoSec: Math.round(stationary.duration)
            });

            // Dispara também o alerta do monitor
            broker.publish('ALERTA_GERADO', deliveryId, {
              deliveryId,
              status: 'ALERTA_INCIDENTE',
              mensagem: `AlertaParadaProlongada: Motorista está parado há mais de 10s na entrega ${deliveryId}.`,
              gravidade: 'critico'
            });
          }
        } else {
          stationary = { x: locAtual.x, y: locAtual.y, duration: 0 };
        }
        this.stationaryTracker.set(deliveryId, stationary);
      }

      // Ajusta parâmetros de telemetria com base no tipo do veículo
      let targetSpeed = 50;
      if (activeDelivery.motorista?.vehicleType === 'drone') targetSpeed = 90;
      if (activeDelivery.motorista?.vehicleType === 'van') targetSpeed = 40;
      if (activeDelivery.motorista?.vehicleType === 'refrigerated_truck') targetSpeed = 35;

      // Efeitos dos incidentes
      let isStopped = false;
      for (const incident of activeIncidents) {
        if (incident.tipo === 'flat_tire') {
          targetSpeed = 0;
          isStopped = true;
        } else if (incident.tipo === 'traffic_jam') {
          targetSpeed = Math.round(targetSpeed * 0.2); // Reduzido em 80% (Drástico)
        }
      }

      // Cálculo de ETA a cada 3 batimentos de GPS
      if (currentHeartbeats % 3 === 0 && activeDelivery.motorista && activeDelivery.telemetria) {
        const motoristaId = activeDelivery.motorista.id;
        const pendingDeliveries = Array.from(deliveries.values())
          .filter(d => 
            d.motorista?.id === motoristaId && 
            d.status !== 'ENTREGUE' && 
            d.status !== 'AGUARDANDO_RETORNO_CD' && 
            d.status !== 'PRODUTO_RETORNADO_ESTOQUE' &&
            d.sequenciaEsperada !== undefined
          )
          .sort((a, b) => (a.sequenciaEsperada || 0) - (b.sequenciaEsperada || 0));

        const nextDelivery = pendingDeliveries[0];
        if (nextDelivery && nextDelivery.rota?.path) {
          const path = nextDelivery.rota.path;
          const destination = path[path.length - 1];
          const currentLoc = activeDelivery.telemetria.localizacaoAtual;
          
          const distance = Math.sqrt(Math.pow(destination.x - currentLoc.x, 2) + Math.pow(destination.y - currentLoc.y, 2));
          const currentSpeed = activeDelivery.telemetria.velocidadeKmh;

          // Velocidade nominal caiu drasticamente (abaixo de 30% da nominal)
          if (currentSpeed < targetSpeed * 0.3) {
            if (activeDelivery.status === 'EM_TRANSITO' || activeDelivery.status === 'ALERTA_INCIDENTE') {
              activeDelivery.status = 'SLA_ALERTA';
              activeDelivery.atualizadoEm = new Date().toISOString();
              await salvarEntrega(activeDelivery);

              // Publica o alerta de SLA no barramento
              broker.publish('ALERTA_GERADO', deliveryId, {
                deliveryId,
                status: 'SLA_ALERTA',
                mensagem: `SLA_ALERTA: Velocidade caiu para ${currentSpeed} km/h (Nominal: ${targetSpeed} km/h). Risco de atraso a ${distance.toFixed(1)} unidades do destino.`,
                gravidade: 'critico'
              });
            }
          }
        }
      }

      // 1. Simulando movimento ao longo dos nós da rota
      if (!isStopped) {
        const nextNodeIdx = currentNodeIdx + 1;
        if (nextNodeIdx < path.length) {
          const fromNode = path[currentNodeIdx];
          const toNode = path[nextNodeIdx];

          currentStep++;
          const ratio = currentStep / stepsPerSegment;
          
          activeDelivery.telemetria!.localizacaoAtual = {
            x: Math.round(fromNode.x + (toNode.x - fromNode.x) * ratio),
            y: Math.round(fromNode.y + (toNode.y - fromNode.y) * ratio)
          };

          if (currentStep >= stepsPerSegment) {
            currentNodeIdx++;
            currentStep = 0;
          }
        } else {
          // Chegou no destino!
          await this.arriveAtDestination(activeDelivery);
          return;
        }
      }

      // Atualiza telemetria básica
      activeDelivery.telemetria!.velocidadeKmh = targetSpeed;
      
      // Consome combustível/bateria
      const fuelConsumption = activeDelivery.motorista?.vehicleType === 'drone' ? 1.5 : 0.8;
      activeDelivery.telemetria!.combustivelBateriaPct = Math.max(
        0, 
        Math.round((activeDelivery.telemetria!.combustivelBateriaPct - (isStopped ? 0.1 : fuelConsumption)) * 10) / 10
      );

      // Flutuações da temperatura na cadeia fria
      if (activeDelivery.tipoCarga === 'agendado' && activeDelivery.telemetria!.temperaturaCelsius !== undefined) {
        const hasTempSpike = activeIncidents.some(i => i.tipo === 'temperature_spike');
        if (hasTempSpike) {
          // Temperatura sobe rápido durante o incidente
          activeDelivery.telemetria!.temperaturaCelsius = Math.round((activeDelivery.telemetria!.temperaturaCelsius + 1.2) * 10) / 10;
        } else {
          // Pequenas flutuações em torno do alvo
          const drift = (Math.random() - 0.5) * 0.4;
          activeDelivery.telemetria!.temperaturaCelsius = Math.round((activeDelivery.telemetria!.temperaturaCelsius + drift) * 10) / 10;
        }
      }

      // 2. Avaliação de regras de negócios
      this.evaluateBusinessRules(activeDelivery);

      activeDelivery.atualizadoEm = new Date().toISOString();

      // Persiste as coordenadas atualizadas e incidentes no SQL Server
      await salvarEntrega(activeDelivery);

      // 3. Publica atualização de telemetria no barramento de eventos
      broker.publish('entrega.monitorada', deliveryId, {
        deliveryId,
        status: activeDelivery.status,
        telemetria: activeDelivery.telemetria,
        incidents: activeDelivery.incidentes
      });

    }, 1500); // Atualiza a cada 1.5 segundos

    this.activeIntervals.set(deliveryId, interval);
  }

  private evaluateBusinessRules(delivery: any) {
    const activeIncidents = delivery.incidentes.filter((i: Incidente) => !i.resolvido);

    // Regra: Cadeia fria excedeu limite seguro (-10°C)
    if (
      delivery.tipoCarga === 'agendado' && 
      delivery.telemetria.temperaturaCelsius > -10 &&
      !activeIncidents.some((i: Incidente) => i.tipo === 'temperature_spike')
    ) {
      const incident: Incidente = {
        id: `inc-${Math.random().toString(36).substring(2, 6)}`,
        tipo: 'temperature_spike',
        descricao: 'Alerta Térmico: Temperatura da câmara fria excedeu -10°C!',
        gravidade: 'critico',
        timestamp: new Date().toISOString(),
        resolvido: false
      };
      delivery.incidentes.push(incident);
      delivery.status = 'ALERTA_INCIDENTE';

      broker.publish('ALERTA_GERADO', delivery.id, {
        deliveryId: delivery.id,
        status: 'ALERTA_INCIDENTE',
        mensagem: `Alerta Térmico: Temperatura da câmara fria excedeu -10°C na entrega ${delivery.id}.`,
        gravidade: 'critico'
      });
    }

    // Regra: Bateria ou combustível baixos
    if (
      delivery.telemetria.combustivelBateriaPct < 15 && 
      !activeIncidents.some((i: Incidente) => i.tipo === 'route_deviation')
    ) {
      const incident: Incidente = {
        id: `inc-${Math.random().toString(36).substring(2, 6)}`,
        tipo: 'route_deviation',
        descricao: 'Alerta Bateria: Carga do veículo abaixo de 15%!',
        gravidade: 'aviso',
        timestamp: new Date().toISOString(),
        resolvido: false
      };
      delivery.incidentes.push(incident);
      delivery.status = 'ALERTA_INCIDENTE';

      broker.publish('ALERTA_GERADO', delivery.id, {
        deliveryId: delivery.id,
        status: 'ALERTA_INCIDENTE',
        mensagem: `Alerta Bateria: Carga do veículo da entrega ${delivery.id} está abaixo de 15%.`,
        gravidade: 'aviso'
      });
    }
  }

  private async arriveAtDestination(delivery: any) {
    console.log(`[Monitor] Entrega ${delivery.id} chegou ao local de destino.`);
    
    delivery.status = 'NO_LOCAL';
    delivery.atualizadoEm = new Date().toISOString();

    this.stopTelemetry(delivery.id);

    // Salva no banco de dados local
    await salvarEntrega(delivery);

    // Publica estado de chegada
    broker.publish('entrega.monitorada', delivery.id, {
      deliveryId: delivery.id,
      status: 'NO_LOCAL',
      telemetria: delivery.telemetria,
      incidents: delivery.incidentes
    });
  }

  private stopTelemetry(deliveryId: string) {
    if (this.activeIntervals.has(deliveryId)) {
      clearInterval(this.activeIntervals.get(deliveryId)!);
      this.activeIntervals.delete(deliveryId);
    }
    this.stationaryTracker.delete(deliveryId);
    this.heartbeatCounts.delete(deliveryId);
  }

  public getAgentState(): EstadoAgente {
    return this.state;
  }
}

export const monitorAgent = new MonitorAgent();

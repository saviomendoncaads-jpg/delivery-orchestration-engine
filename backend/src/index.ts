import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import tenantsRouter, { carregarTenantsDoBanco, lojas } from './tenants';
import authRouter, { sessions } from './auth';
import apiRouter, { deliveries, webhooksReceived, drivers, carregarEntregasDoBanco, carregarMotoristasDoBanco, carregarVeiculosDoBanco } from './gateway';
import whatsappRouter, { whatsappBotService, whatsappSessions } from './whatsapp';
import { broker } from './broker';
import { dispatcherAgent } from './dispatcher';
import { monitorAgent } from './monitor';
import { integratorAgent } from './integrator';
import { conectarBanco, salvarMotorista } from './database';
import { Entrega, Motorista } from './types';
import financeiroRouter, { inicializarFinanceiro } from './financeiroService';
import webhookRouter from './billing/webhookRoutes';
import { iniciarWorkerWebhooks } from './billing/webhookProcessor';

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));

// Webhooks do gateway de pagamento: montados ANTES do express.json para receber
// o corpo BRUTO (Buffer) e validar a assinatura HMAC. As demais rotas seguem JSON.
app.use('/api/billing/webhooks', express.raw({ type: '*/*' }), webhookRouter);

app.use(express.json());

// Roteador de autenticação
app.use('/api/auth', authRouter);

// Roteador de gestão de empresas e lojas (multi-tenant)
console.log('[Debug] tenantsRouter:', tenantsRouter, typeof tenantsRouter);
app.use('/api', tenantsRouter);

// Roteador do assistente virtual WhatsApp
app.use('/api/whatsapp', whatsappRouter);

// Roteador do Módulo Financeiro (admin)
app.use('/api/admin/financeiro', financeiroRouter);

// Monta o Roteador de API do Gateway Ingress
app.use('/api', apiRouter);

// Endpoint básico de status de saúde do servidor
app.get('/health', (req, res) => {
  res.json({ 
    status: 'saudavel', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Transmite eventos do Broker para todos os clientes WebSocket
broker.registerBroadcastCallback((event, queueSize) => {
  io.emit('broker_event', {
    event,
    queueSize,
    metrics: broker.getQueueMetrics()
  });
});

// Lógica de conexão do Socket.io com autenticação de sessão
io.on('connection', (socket) => {
  console.log(`[Socket] Cliente conectado: ${socket.id}`);

  // Identifica a sessão pelo token enviado no handshake
  const token = socket.handshake.auth?.token as string | undefined;
  const sessao = token ? sessions.get(token) : undefined;

  // Coloca o socket na sala correta
  if (sessao?.tipo === 'loja' && sessao.lojaId) {
    socket.join(`loja-${sessao.lojaId}`);
  } else if (sessao?.tipo === 'admin') {
    socket.join('admin');
  } else {
    // Se o cliente forneceu um token de autenticação, mas a sessão não foi encontrada (ex: após restart),
    // emitimos um evento de sessão expirada e forçamos desconexão.
    if (token) {
      console.log(`[Socket] Token inválido ou expirado. Forçando desconexão: ${socket.id}`);
      socket.emit('session_expired');
      socket.disconnect(true);
      return;
    }
    socket.join('public'); // Sem token e sem sessão = sala publica sem acesso administrativo/vazamento
  }

  // Filtra entregas e drivers pela loja da sessão
  const todasEntregas = Array.from(deliveries.values());
  let entregasFiltradas: Entrega[] = [];
  let driversFiltrados: Motorista[] = [];

  if (sessao?.tipo === 'loja' && sessao.lojaId) {
    entregasFiltradas = todasEntregas.filter(d => d.lojaId === sessao.lojaId);
    driversFiltrados = drivers.filter(d => d.lojaId === sessao.lojaId);
  } else if (sessao?.tipo === 'admin') {
    entregasFiltradas = todasEntregas;
    driversFiltrados = drivers;
  }

  // Envia dados iniciais ao se conectar (somente se autenticado/admin)
  socket.emit('initial_state', {
    deliveries: entregasFiltradas,
    drivers: driversFiltrados,
    eventHistory: sessao?.tipo === 'admin' ? broker.getHistory() : [],
    webhooksReceived: sessao?.tipo === 'admin' ? webhooksReceived : [],
    agents: {
      dispatcher: dispatcherAgent.getAgentState(),
      monitor: monitorAgent.getAgentState(),
      integrator: integratorAgent.getAgentState()
    },
    queue: broker.getQueueMetrics()
  });

  // Controle de vinculação do socket ao motoboy
  let driverIdVinculado: string | undefined;

  socket.on('driver_register', async (data: { driverId: string }) => {
    const driver = drivers.find(d => d.id === data.driverId);
    if (!driver) return;

    // Se a sessão for de loja e o motorista for de outra loja, recusa
    if (sessao?.tipo === 'loja' && sessao.lojaId !== driver.lojaId) {
      console.warn(`[Socket] Tentativa bloqueada: Loja ${sessao.lojaId} tentando registrar driver ${driver.id} da loja ${driver.lojaId}`);
      socket.emit('driver_register_error', { error: 'O motoboy pertence a outra loja.' });
      return;
    }

    driverIdVinculado = data.driverId;
    console.log(`[Socket] Aparelho móvel registrado para o motoboy: ${data.driverId}`);
    
    // Atualiza status online
    driver.dispositivoConectado = true;
    driver.ultimaAtualizacao = new Date().toISOString();
    await salvarMotorista(driver);

    if (driver.lojaId) {
      // Vincula o socket à sala da loja do motoboy para receber atualizações do sistema filtradas por sua loja
      socket.leave('public');
      socket.leave('admin');
      
      // Sai de outras salas de loja para evitar acumulação/flicker
      Array.from(socket.rooms).forEach(room => {
        if (room.startsWith('loja-') && room !== `loja-${driver.lojaId}`) {
          socket.leave(room);
        }
      });

      socket.join(`loja-${driver.lojaId}`);

      // Envia estado inicial filtrado específico da loja para o motoboy
      const todas = Array.from(deliveries.values());
      const entregasLoja = todas.filter(d => d.lojaId === driver.lojaId);
      const driversLoja = drivers.filter(d => d.lojaId === driver.lojaId);
      socket.emit('initial_state', {
        deliveries: entregasLoja,
        drivers: driversLoja,
        eventHistory: [],
        webhooksReceived: [],
        agents: {
          dispatcher: dispatcherAgent.getAgentState(),
          monitor: monitorAgent.getAgentState(),
          integrator: integratorAgent.getAgentState()
        },
        queue: broker.getQueueMetrics()
      });
    }
  });

  socket.on('driver_gps_update', async (data: { driverId: string, x: number, y: number }) => {
    const { driverId, x, y } = data;
    const driver = drivers.find(d => d.id === driverId);
    if (driver) {
      driver.dispositivoConectado = true;
      driver.localizacaoAtual = { x, y };
      driver.ultimaAtualizacao = new Date().toISOString();
      
      // Se esse motorista estiver em uma entrega ativa ("ocupado"), também atualiza as coordenadas da entrega ativa
      const todasEntregas = Array.from(deliveries.values());
      const getStatusWeight = (status: string) => {
        switch (status) {
          case 'NO_LOCAL': return 4;
          case 'EM_TRANSITO':
          case 'ALERTA_INCIDENTE':
          case 'SLA_ALERTA':
            return 3;
          case 'DESPACHADO': return 2;
          case 'RECEBIDO': return 1;
          default: return 0;
        }
      };
      const motoristaEntregas = todasEntregas.filter(d => 
        d.motorista?.id === driverId && 
        (d.status === 'EM_TRANSITO' || d.status === 'NO_LOCAL' || d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA')
      );
      motoristaEntregas.sort((a, b) => {
        const weightA = getStatusWeight(a.status);
        const weightB = getStatusWeight(b.status);
        if (weightA !== weightB) {
          return weightB - weightA;
        }
        const seqA = a.sequenciaEsperada ?? Infinity;
        const seqB = b.sequenciaEsperada ?? Infinity;
        return seqA - seqB;
      });
      const entregaAtiva = motoristaEntregas[0];
      if (entregaAtiva) {
        if (!entregaAtiva.telemetria) {
          entregaAtiva.telemetria = {
            velocidadeKmh: 45,
            combustivelBateriaPct: 88,
            localizacaoAtual: { x, y },
            timestamp: new Date().toISOString()
          };
        } else {
          entregaAtiva.telemetria.localizacaoAtual = { x, y };
          entregaAtiva.telemetria.timestamp = new Date().toISOString();
        }
      }

      await salvarMotorista(driver);
    }
  });

  // Listeners para o Simulador de WhatsApp
  socket.on('whatsapp_send_msg', async (data: { phone: string; text: string; lojaId: string }) => {
    const { phone, text, lojaId } = data;
    const targetLojaId = sessao?.tipo === 'loja' && sessao.lojaId ? sessao.lojaId : lojaId;
    const room = `loja-${targetLojaId}`;

    // 1. Transmite a mensagem enviada pelo cliente (para atualizar todos os painéis da loja/admin)
    io.to(room).to('admin').emit('whatsapp_msg_received', {
      phone,
      sender: 'customer',
      text,
      timestamp: new Date().toISOString()
    });

    // 2. Simula o indicador "digitando..."
    io.to(room).to('admin').emit('whatsapp_typing', {
      phone,
      isTyping: true
    });

    try {
      // 3. Processa a mensagem do bot
      const reply = await whatsappBotService.processMessage(phone, text, targetLojaId);

      // 4. Aguarda 1.5s antes de enviar a resposta do bot para parecer realista
      setTimeout(() => {
        // Desliga o indicador de digitando
        io.to(room).to('admin').emit('whatsapp_typing', {
          phone,
          isTyping: false
        });

        // Envia a resposta do bot
        io.to(room).to('admin').emit('whatsapp_msg_received', {
          phone,
          sender: 'bot',
          text: reply,
          timestamp: new Date().toISOString()
        });
      }, 1500);
    } catch (error: any) {
      console.error('[Socket WhatsApp Error]', error);
      io.to(room).to('admin').emit('whatsapp_typing', {
        phone,
        isTyping: false
      });
    }
  });

  socket.on('whatsapp_get_history', (data: { phone: string; lojaId: string }) => {
    const { phone, lojaId } = data;
    const targetLojaId = sessao?.tipo === 'loja' && sessao.lojaId ? sessao.lojaId : lojaId;
    const session = whatsappSessions.get(phone);
    socket.emit('whatsapp_history', {
      phone,
      messages: session?.messages || []
    });
  });

  socket.on('disconnect', async () => {
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
    if (driverIdVinculado) {
      const driver = drivers.find(d => d.id === driverIdVinculado);
      if (driver) {
        driver.dispositivoConectado = false;
        driver.ultimaAtualizacao = new Date().toISOString();
        await salvarMotorista(driver);
        console.log(`[Socket] Dispositivo do motoboy ${driverIdVinculado} ficou offline.`);
      }
    }
  });
});

// Transmissão periódica do status do sistema (a cada 1 segundo) — filtrado por sala
setInterval(() => {
  const agentStates = {
    dispatcher: dispatcherAgent.getAgentState(),
    monitor: monitorAgent.getAgentState(),
    integrator: integratorAgent.getAgentState()
  };
  const todasEntregas = Array.from(deliveries.values());

  // Emite para admin/sem-sessão: todos os dados
  io.to('admin').emit('system_status', {
    deliveries: todasEntregas,
    drivers,
    agents: agentStates,
    queue: broker.getQueueMetrics(),
    webhooksReceived,
    timestamp: new Date().toISOString()
  });

  // Emite para cada loja: somente seus próprios dados
  for (const loja of lojas) {
    const entregasLoja = todasEntregas.filter(d => d.lojaId === loja.id);
    const driversLoja = drivers.filter(d => d.lojaId === loja.id);
    io.to(`loja-${loja.id}`).emit('system_status', {
      deliveries: entregasLoja,
      drivers: driversLoja,
      agents: agentStates,
      queue: broker.getQueueMetrics(),
      webhooksReceived: [],
      recebePedidos: loja.recebePedidos,
      timestamp: new Date().toISOString()
    });
  }
}, 1000);

async function startServer() {
  // Conecta ao SQL Server
  await conectarBanco();

  // Carrega os tenants (empresas/lojas) do banco de dados / realiza migração se necessário
  await carregarTenantsDoBanco();

  // Carrega os motoristas cadastrados na tabela do banco de dados
  await carregarMotoristasDoBanco();

  // Carrega os tipos de veículos do banco de dados
  await carregarVeiculosDoBanco();
  
  // Carrega entregas do banco de dados para a memória
  await carregarEntregasDoBanco();

  // Inicializa o módulo financeiro (seed + rotina de inadimplência)
  await inicializarFinanceiro();

  // Inicia o worker que processa a fila de webhooks de pagamento (retry/backoff/DLQ)
  iniciarWorkerWebhooks();

  httpServer.listen(port, () => {
    console.log(`==================================================`);
    console.log(`🚀 Motor de Orquestração de Entregas Backend Rodando`);
    console.log(`📡 Porta: ${port}`);
    console.log(`👉 Health Check: http://localhost:${port}/health`);
    console.log(`==================================================`);
  });
}

startServer(); // Inicializa o servidor completo

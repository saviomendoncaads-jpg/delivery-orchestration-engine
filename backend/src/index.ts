import 'dotenv/config'; // carrega backend/.env ANTES de tudo (database.ts lê process.env no load)
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import tenantsRouter, { carregarTenantsDoBanco, lojas } from './tenants';
import authRouter, { sessions, carregarSessoesDoBanco, verificarApiKeyIntegracao } from './auth';
import apiRouter, { deliveries, webhooksReceived, drivers, carregarEntregasDoBanco, carregarMotoristasDoBanco, carregarVeiculosDoBanco } from './gateway';
import whatsappRouter, { whatsappBotService, whatsappSessions } from './whatsapp';
import { broker } from './broker';
import { dispatcherAgent } from './dispatcher';
import { monitorAgent } from './monitor';
import { integratorAgent } from './integrator';
import { conectarBanco, salvarMotorista, limparSessoesExpiradas } from './database';
import { Entrega, Motorista } from './types';
import financeiroRouter, { inicializarFinanceiro } from './financeiroService';
import integracaoPedidosRouter from './integracaoPedidos';
import integracaoEntregasRouter from './integracaoEntregas';
import vitrineRouter from './vitrine';
import gestaoVitrineRouter, { uploadsDir } from './gestaoVitrine';
import webhookRouter from './billing/webhookRoutes';
import { iniciarWorkerWebhooks } from './billing/webhookProcessor';
import { iniciarDunning } from './billing/dunningScheduler';

const app = express();
const port = process.env.PORT || 5000;

// Atrás de load balancer/reverse proxy (deploy multi-instância ou nginx): habilita a
// leitura de X-Forwarded-* para o IP real do cliente (rate-limit correto) e protocolo.
// Gate por env: sem proxy na frente, NÃO confiar nesses headers (anti-spoofing de IP).
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

// Allowlist de origens do CORS. Em produção defina CORS_ORIGINS (lista separada por
// vírgula, ex.: "https://app.distre.com.br,https://admin.distre.com.br").
// O default cobre o frontend Vite em desenvolvimento.
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Sem header Origin = chamada server-to-server (ERP, gateway de pagamento, curl,
    // app mobile) → liberado. Origens de navegador passam pela allowlist.
    if (!origin) return callback(null, true);
    if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return callback(null, true);
    // Origem não permitida: NÃO lança erro (lançar viraria 500 e quebraria até
    // requisições de MESMA ORIGEM — o navegador manda header Origin em fetch/módulo
    // mesmo same-origin). Apenas omite os headers CORS: same-origin passa normal;
    // cross-origin não-autorizado é bloqueado pelo navegador (resposta sem ACAO).
    return callback(null, false);
  },
  credentials: true,
};

// Cabeçalhos de segurança HTTP. CSP/CORP relaxados porque este serviço é uma API
// JSON consumida por um SPA de outra origem (não serve HTML próprio).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions));

// Webhooks do gateway de pagamento: montados ANTES do express.json para receber
// o corpo BRUTO (Buffer) e validar a assinatura HMAC. As demais rotas seguem JSON.
app.use('/api/billing/webhooks', express.raw({ type: '*/*' }), webhookRouter);

// Gestão da vitrine (painel da loja): CRUD de produtos, logo e upload de imagens.
// Montado ANTES do json global para usar um limite maior (imagens em base64).
app.use('/api/gestao', express.json({ limit: '5mb' }), gestaoVitrineRouter);

app.use(express.json());

// Proteção contra força-bruta de credenciais nas rotas de autenticação.
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de autenticação. Aguarde um minuto e tente novamente.' },
});

// Roteador de autenticação
app.use('/api/auth', authLimiter, authRouter);

// Roteador de gestão de empresas e lojas (multi-tenant)
console.log('[Debug] tenantsRouter:', tenantsRouter, typeof tenantsRouter);
app.use('/api', tenantsRouter);

// Roteador do assistente virtual WhatsApp
app.use('/api/whatsapp', whatsappRouter);

// Roteador do Módulo Financeiro (admin)
app.use('/api/admin/financeiro', financeiroRouter);

// Roteadores de integração ERP: autenticados por API key (X-Api-Key = chaveAcesso da loja)
app.use('/api/integracao', verificarApiKeyIntegracao, integracaoPedidosRouter);
app.use('/api/integracao', verificarApiKeyIntegracao, integracaoEntregasRouter);

// Vitrine pública (Painel do Cliente): cardápio + checkout consumidos direto pelo
// navegador do cliente final. Sem credencial — os preços são validados no servidor
// (vitrine.ts) — e com rate limit próprio por ser rota aberta.
const vitrineLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um instante e tente novamente.' },
});
app.use('/api/vitrine', vitrineLimiter, vitrineRouter);

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

// Produção (1 servidor, 1 origem), com a LANDING pública como porta de entrada:
//   /          -> LANDING (site/index.html): marketing + cadastro self-service + planos
//   /app[/...] -> APP React (frontend/dist): login + painel da loja/admin (SPA)
//   /assets/*  -> assets do app React (referenciados de forma absoluta no build)
// Rotas de API/WebSocket/health são montadas ANTES e têm prioridade.
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
const siteDir = path.join(__dirname, '..', '..', 'site');

// Assets do app React (sempre na raiz /assets).
app.use('/assets', express.static(path.join(frontendDist, 'assets')));

// Imagens enviadas pelo painel (produtos da vitrine, logomarca da loja).
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true }));

// APP em /app — SPA: /app e subrotas servem o index.html do app.
app.get(['/app', '/app/*'], (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

// Cardápio público (Painel do Cliente) em /loja/<lojaId> — mesma SPA React;
// o main.tsx roteia pelo pathname e carrega só o chunk da vitrine.
app.get(['/loja', '/loja/*'], (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

// LANDING pública na raiz (serve site/index.html, favicon, etc.).
app.use(express.static(siteDir));

// Fallback: qualquer outra rota não-API/WS/health/assets cai na LANDING.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io') || req.path === '/health' || req.path.startsWith('/assets') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(siteDir, 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    methods: ['GET', 'POST']
  }
});

// Multi-instância: com REDIS_URL definido, os broadcasts do socket.io são propagados
// entre réplicas via Redis pub/sub. Sem REDIS_URL = instância única (idêntico ao atual).
// NOTA: o estado autoritativo (deliveries/drivers) ainda é por-instância — ver
// docs/ESCALA_MULTI_INSTANCIA.md para o roadmap de estado compartilhado + sticky sessions.
async function configurarAdapterRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (e) => console.error('[Redis] pub error:', e?.message));
    subClient.on('error', (e) => console.error('[Redis] sub error:', e?.message));
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[Socket] Adapter Redis ativo — broadcasts propagados entre instâncias.');
  } catch (e) {
    console.error('[Socket] Falha ao configurar adapter Redis (seguindo single-instance):', (e as Error)?.message);
  }
}

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

  // Emite para admin/sem-sessão: todos os dados.
  // io.local: cada instância envia o snapshot do SEU estado só aos SEUS clientes —
  // evita snapshots conflitantes entre réplicas (o adapter Redis propagaria o full-state).
  io.local.to('admin').emit('system_status', {
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
    io.local.to(`loja-${loja.id}`).emit('system_status', {
      deliveries: entregasLoja,
      drivers: driversLoja,
      agents: agentStates,
      queue: broker.getQueueMetrics(),
      webhooksReceived: [],
      recebePedidos: loja.recebePedidos,
      lojaLat: loja.latitude,
      lojaLng: loja.longitude,
      timestamp: new Date().toISOString()
    });
  }
}, 1000);

async function startServer() {
  // Conecta ao SQL Server
  await conectarBanco();

  // Carrega os tenants (empresas/lojas) do banco de dados / realiza migração se necessário
  await carregarTenantsDoBanco();

  // Restaura as sessões persistidas (sobrevive a restart/deploy) e agenda a limpeza
  // das expiradas. Depende dos tenants já carregados (gate de loja suspensa na hidratação).
  await carregarSessoesDoBanco();
  setInterval(() => { limparSessoesExpiradas().catch(() => {}); }, 60 * 60 * 1000);

  // Carrega os motoristas cadastrados na tabela do banco de dados
  await carregarMotoristasDoBanco();

  // Carrega os tipos de veículos do banco de dados
  await carregarVeiculosDoBanco();
  
  // Carrega entregas do banco de dados para a memória
  await carregarEntregasDoBanco();

  // Inicializa o módulo financeiro (seed + rotina de inadimplência)
  await inicializarFinanceiro();

  // Workers singleton (webhook + dunning): em deploy multi-instância, rode-os em UMA
  // instância (RUN_BACKGROUND_JOBS=true) e desligue nas demais (web) para evitar
  // processamento duplicado da fila de pagamentos e da régua de cobrança. Default = ligado.
  const runJobs = (process.env.RUN_BACKGROUND_JOBS ?? 'true').toLowerCase() !== 'false';
  if (runJobs) {
    iniciarWorkerWebhooks();
    iniciarDunning();
  } else {
    console.log('[Boot] RUN_BACKGROUND_JOBS=false — workers de webhook/dunning desligados nesta instância.');
  }

  // Multi-instância: liga o adapter Redis do socket.io se REDIS_URL estiver definido.
  await configurarAdapterRedis();

  httpServer.listen(port, () => {
    console.log(`==================================================`);
    console.log(`🚀 Motor de Orquestração de Entregas Backend Rodando`);
    console.log(`📡 Porta: ${port}`);
    console.log(`👉 Health Check: http://localhost:${port}/health`);
    console.log(`==================================================`);
  });
}

startServer(); // Inicializa o servidor completo

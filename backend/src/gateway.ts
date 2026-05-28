import { Router, Request, Response } from 'express';
import { broker } from './broker';
import { Entrega, Motorista, StatusEntrega, Prioridade, TipoCarga, FormaPagamento, LogWebhook, Incidente, TipoVeiculo } from './types';
import { salvarEntrega, obterEntregas, obterMotoristas, salvarMotorista, deletarMotorista, obterTiposVeiculos, salvarTipoVeiculo } from './database';
import { obterSessaoDoRequest } from './auth';
import { lojas, empresas } from './tenants';
import { autoDispatchSettings } from './config';
import fs from 'fs';
import path from 'path';

const VEHICLE_TYPES_FILE = path.join(__dirname, '..', 'vehicle_types.json');

export const vehicleTypes: TipoVeiculo[] = [
  { id: 'drone', name: 'Drone' },
  { id: 'motorcycle', name: 'Motocicleta' },
  { id: 'van', name: 'Van' },
  { id: 'refrigerated_truck', name: 'Caminhão Refrigerado' }
];

export const drivers: Motorista[] = [];

// Carrega os tipos de veículos do banco (e migra do arquivo JSON se for o primeiro boot)
export async function carregarVeiculosDoBanco() {
  try {
    console.log('[Gateway] Carregando tipos de veículos do banco de dados...');
    let dbTypes = await obterTiposVeiculos();
    
    // Se existir arquivo local legado, migra seus registros
    if (fs.existsSync(VEHICLE_TYPES_FILE)) {
      console.log('[Gateway] Encontrado vehicle_types.json legado. Migrando para o banco de dados...');
      try {
        const dataJson = JSON.parse(fs.readFileSync(VEHICLE_TYPES_FILE, 'utf-8'));
        if (Array.isArray(dataJson)) {
          for (const vt of dataJson) {
            await salvarTipoVeiculo(vt);
          }
        }
        fs.renameSync(VEHICLE_TYPES_FILE, VEHICLE_TYPES_FILE + '.migrated');
        console.log('[Gateway] Migração de tipos de veículos concluída com sucesso!');
        dbTypes = await obterTiposVeiculos();
      } catch (err: any) {
        console.error('[Gateway] Erro ao migrar vehicle_types.json:', err);
      }
    }

    vehicleTypes.length = 0;
    vehicleTypes.push(...dbTypes);
    console.log(`[Gateway] ${vehicleTypes.length} tipos de veículos carregados em memória.`);
  } catch (err: any) {
    console.error('[Gateway] Erro ao carregar/migrar tipos de veículos:', err);
  }
}

// Carregar motoristas do SQL Server e fazer migração a partir do JSON se for a primeira inicialização
export async function carregarMotoristasDoBanco() {
  try {
    // 1. Tenta carregar do banco de dados
    const listaDb = await obterMotoristas();
    
    if (listaDb.length > 0) {
      drivers.length = 0; // Limpa array
      drivers.push(...listaDb);
      console.log(`[Gateway] ${listaDb.length} motorista(s) carregado(s) do SQL Server.`);
      return;
    }

    // 2. Se a tabela no banco está vazia, tenta fazer a migração do drivers.json
    const caminhosCandidatos = [
      path.join(__dirname, 'drivers.json'),
      path.join(__dirname, '..', 'src', 'drivers.json'),
      path.join(__dirname, '..', 'drivers.json'),
      path.join(process.cwd(), 'backend', 'src', 'drivers.json'),
      path.join(process.cwd(), 'backend', 'drivers.json')
    ];

    let arquivoEncontrado: string | null = null;
    let rawData: string = '';

    for (const p of caminhosCandidatos) {
      if (fs.existsSync(p)) {
        try {
          rawData = fs.readFileSync(p, 'utf-8');
          if (rawData && rawData.trim().startsWith('[')) {
            arquivoEncontrado = p;
            break;
          }
        } catch (err) {
          // ignorar e tentar próximo
        }
      }
    }

    if (arquivoEncontrado) {
      console.log(`[Gateway] Migrando motoristas do arquivo JSON localizado em: ${arquivoEncontrado}`);
      const data = JSON.parse(rawData);
      const tempDrivers: Motorista[] = [];

      data.forEach((drv: any) => {
        if (!drv.lojaId) {
          drv.lojaId = "41869dbf-4b09-4933-8bd2-11e60ccc092d";
        }
        drv.name = drv.name.trim();

        // Dedup por nome e lojaId
        const existingIndex = tempDrivers.findIndex(
          x => x.name.toLowerCase() === drv.name.toLowerCase() && x.lojaId === drv.lojaId
        );
        if (existingIndex === -1) {
          if (!drv.codigoVinculo) {
            drv.codigoVinculo = Math.floor(100000 + Math.random() * 900000).toString();
          }
          tempDrivers.push(drv);
        } else {
          if (drv.dispositivoConectado) {
            tempDrivers[existingIndex] = drv;
          }
        }
      });

      for (const d of tempDrivers) {
        await salvarMotorista(d);
      }

      console.log(`[Gateway] ${tempDrivers.length} motorista(s) migrados com sucesso para o SQL Server.`);

      try {
        fs.renameSync(arquivoEncontrado, `${arquivoEncontrado}.migrated`);
        console.log(`[Gateway] Arquivo de origem renomeado para ${path.basename(arquivoEncontrado)}.migrated.`);
      } catch (e) {
        console.error('[Gateway] Erro ao renomear arquivo drivers.json:', e);
      }
    } else {
      console.log('[Gateway] Nenhum motorista encontrado no banco nem no JSON. Criando motoristas padrão...');
      const defaultDrivers: Motorista[] = [
        {
          id: 'drv-avsq',
          name: 'Sheldon',
          vehicleType: 'motorcycle',
          status: 'ocioso',
          lojaId: '41869dbf-4b09-4933-8bd2-11e60ccc092d',
          codigoVinculo: '433492',
          dispositivoConectado: false
        },
        {
          id: 'drv-ezt6',
          name: 'Jean',
          vehicleType: 'motorcycle',
          status: 'ocioso',
          lojaId: '41869dbf-4b09-4933-8bd2-11e60ccc092d',
          codigoVinculo: '226822',
          dispositivoConectado: false
        },
        {
          id: 'drv-5xgz',
          name: 'Savio',
          vehicleType: 'motorcycle',
          status: 'ocioso',
          lojaId: '41869dbf-4b09-4933-8bd2-11e60ccc092d',
          codigoVinculo: '222007',
          dispositivoConectado: false
        }
      ];

      for (const d of defaultDrivers) {
        await salvarMotorista(d);
      }
    }

    const finalLista = await obterMotoristas();
    drivers.length = 0;
    drivers.push(...finalLista);
  } catch (err) {
    console.error('[Gateway] Erro ao carregar/migrar motoristas:', err);
  }
}

export const deliveries: Map<string, Entrega> = new Map();
export const webhooksReceived: any[] = [];

// Contador sequencial de comandas — incrementado a cada nova entrega criada
let cmdCounter = 0;

function gerarIdComanda(): string {
  cmdCounter += 1;
  return `COMANDA-${String(cmdCounter).padStart(4, '0')}`;
}

export async function carregarEntregasDoBanco() {
  try {
    const lista = await obterEntregas();
    lista.forEach(d => {
      // Se a entrega carregada ainda tem motorista associado em andamento, libera o motorista local
      // para não travar a frota caso o servidor tenha reiniciado
      if (d.motorista && (d.status === 'ENTREGUE' || d.status === 'RECUSADO_INSUCESSO')) {
        const motoristaFrota = drivers.find(drv => drv.id === d.motorista!.id);
        if (motoristaFrota) motoristaFrota.status = 'ocioso';
      } else if (d.motorista && (d.status === 'EM_TRANSITO' || d.status === 'DESPACHADO' || d.status === 'NO_LOCAL')) {
        const motoristaFrota = drivers.find(drv => drv.id === d.motorista!.id);
        if (motoristaFrota) motoristaFrota.status = 'ocupado';
      }
      // Extrai o número sequencial do ID para inicializar o cmdCounter
      if (d.id.startsWith('COMANDA-')) {
        const num = parseInt(d.id.replace('COMANDA-', ''), 10);
        if (!isNaN(num) && num > cmdCounter) {
          cmdCounter = num;
        }
      } else if (d.id.startsWith('CMD-')) {
        const parts = d.id.split('-');
        if (parts.length === 3) {
          const num = parseInt(parts[2], 10);
          if (!isNaN(num) && num > cmdCounter) {
            cmdCounter = num;
          }
        }
      }
      deliveries.set(d.id, d);
    });
    console.log(`[Gateway] ${lista.length} entregas carregadas do SQL Server.`);
  } catch (err) {
    console.error('[Gateway] Erro ao alimentar cache em memória com banco de dados:', err);
  }
}

const router = Router();

// Obter configurações de despacho
router.get('/config', (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  const lojaId = sessao.lojaId || 'global';
  const autoDispatch = autoDispatchSettings.get(lojaId) !== false;
  res.json({ autoDispatch });
});

// Atualizar configurações de despacho
router.post('/config', (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  const { autoDispatch } = req.body;
  const lojaId = sessao.lojaId || 'global';
  if (typeof autoDispatch === 'boolean') {
    autoDispatchSettings.set(lojaId, autoDispatch);
  }
  res.json({ autoDispatch: autoDispatchSettings.get(lojaId) !== false });
});

// Despachar comandas manualmente em lote
router.post('/deliveries/dispatch-batch', async (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  const { deliveryIds, driverId } = req.body;
  if (!Array.isArray(deliveryIds) || !driverId) {
    res.status(400).json({ error: 'Lista de IDs de entregas e ID do motorista são obrigatórios.' });
    return;
  }

  try {
    const { dispatcherAgent } = require('./dispatcher');
    await dispatcherAgent.manualDispatch(deliveryIds, driverId);
    res.json({ success: true, message: `${deliveryIds.length} comanda(s) liberada(s) para entrega com sucesso.` });
  } catch (err: any) {
    console.error('[Gateway] Erro no despacho manual:', err);
    res.status(400).json({ error: err.message });
  }
});

// 1. Ingestar nova entrega
router.post('/deliveries', async (req: Request, res: Response) => {
  const { clientName, clienteDocumento, address, items, priority, cargoType, webhookUrl, formaPagamento, bairro, referencia, valor, driverId, x, y } = req.body;

  if (!clientName || !address || !priority || !cargoType) {
    res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    return;
  }

  const id = gerarIdComanda();

  // Contexto de tenant da sessão autenticada
  const sessao = obterSessaoDoRequest(req);
  let lojaId: string | undefined;
  let nomeLoja: string | undefined;
  let nomeEmpresa: string | undefined;
  if (sessao?.tipo === 'loja' && sessao.lojaId) {
    lojaId = sessao.lojaId;
    nomeLoja = sessao.nomeLoja;
    nomeEmpresa = sessao.nomeEmpresa;
  }

  const newDelivery: Entrega = {
    id,
    nomeCliente: clientName,
    clienteDocumento: clienteDocumento || undefined,
    endereco: address,
    itens: items ? (Array.isArray(items) ? items : [items]) : [],
    prioridade: priority as Prioridade,
    tipoCarga: cargoType as TipoCarga,
    status: 'RECEBIDO',
    valor: valor !== undefined && valor !== null && valor !== '' ? Number(valor) : undefined,
    incidentes: [],
    urlWebhook: webhookUrl || 'http://localhost:5000/api/simulator/webhook',
    logsWebhook: [],
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    formaPagamento: (formaPagamento || 'maquininha') as FormaPagamento,
    bairro: bairro || undefined,
    referencia: referencia || undefined,
    lojaId,
    nomeLoja,
    nomeEmpresa,
  };

  deliveries.set(id, newDelivery);

  // Persiste no SQL Server
  await salvarEntrega(newDelivery);

  // Publica o evento: entrega.recebida
  broker.publish('entrega.recebida', id, {
    deliveryId: id,
    cargoType: newDelivery.tipoCarga,
    priority: newDelivery.prioridade,
    clientName: newDelivery.nomeCliente,
    address: newDelivery.endereco,
    driverId: driverId || undefined,
    x: x !== undefined ? Number(x) : undefined,
    y: y !== undefined ? Number(y) : undefined
  });

  res.status(201).json(newDelivery);
});

// 2. Obter entregas (filtrado por loja se sessão de loja)
router.get('/deliveries', (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  const todas = Array.from(deliveries.values());
  if (sessao.tipo === 'loja' && sessao.lojaId) {
    res.json(todas.filter(d => d.lojaId === sessao.lojaId));
  } else if (sessao.tipo === 'admin') {
    res.json(todas);
  } else {
    res.status(403).json({ error: 'Acesso proibido' });
  }
});

// 3. Obter única entrega
router.get('/deliveries/:id', (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }
  res.json(delivery);
});

// 4. Injetar incidente para simulação
router.post('/deliveries/:id/incident', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const { type, description, severity } = req.body;
  if (!type || !description) {
    res.status(400).json({ error: 'Tipo ou descrição do incidente ausente' });
    return;
  }

  const newIncident: Incidente = {
    id: `inc-${Math.random().toString(36).substring(2, 6)}`,
    tipo: type,
    descricao: description,
    gravidade: (severity || 'aviso') as 'aviso' | 'critico',
    timestamp: new Date().toISOString(),
    resolvido: false
  };

  delivery.incidentes.push(newIncident);
  delivery.status = 'ALERTA_INCIDENTE';
  delivery.atualizadoEm = new Date().toISOString();

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Publica atualizações de telemetria refletindo o incidente
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'ALERTA_INCIDENTE',
    incident: newIncident,
    telemetria: delivery.telemetria
  });

  res.json(delivery);
});

// 5. Obter motoristas disponíveis (filtrado por loja se sessão de loja)
router.get('/drivers', (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  if (sessao.tipo === 'loja' && sessao.lojaId) {
    res.json(drivers.filter(d => d.lojaId === sessao.lojaId));
  } else if (sessao.tipo === 'admin') {
    res.json(drivers);
  } else {
    res.status(403).json({ error: 'Acesso proibido' });
  }
});

// 5.1. Cadastrar novo motorista (vinculado à loja da sessão)
router.post('/drivers', async (req: Request, res: Response) => {
  const { name, vehicleType } = req.body;
  if (!name || !vehicleType) {
    res.status(400).json({ error: 'Nome e tipo de veículo são obrigatórios' });
    return;
  }

  // Vincula o motorista à loja da sessão
  const sessao = obterSessaoDoRequest(req);
  const lojaId = sessao?.tipo === 'loja' ? sessao.lojaId : undefined;

  // Gera código de 6 dígitos único para o pareamento do motoboy
  let codigoVinculo = '';
  do {
    codigoVinculo = Math.floor(100000 + Math.random() * 900000).toString();
  } while (drivers.some(d => d.codigoVinculo === codigoVinculo));

  const id = `drv-${Math.random().toString(36).substring(2, 6)}`;
  const newDriver: Motorista = {
    id,
    name: name.trim(),
    vehicleType,
    status: 'ocioso',
    lojaId,
    codigoVinculo,
    dispositivoConectado: false
  };

  drivers.push(newDriver);
  await salvarMotorista(newDriver);
  res.status(201).json(newDriver);
});

// 5.1.0. Vincular dispositivo móvel do entregador por código
router.post('/drivers/vincular', (req: Request, res: Response) => {
  const { codigoVinculo } = req.body;
  if (!codigoVinculo) {
    res.status(400).json({ error: 'Código de vinculação é obrigatório' });
    return;
  }

  const codeStr = codigoVinculo.toString().replace('-', '').trim();
  const driver = drivers.find(d => d.codigoVinculo === codeStr);
  if (!driver) {
    res.status(404).json({ error: 'Código de pareamento inválido ou motoboy não cadastrado' });
    return;
  }

  // Se houver uma sessão de loja, garante que o motorista pertence a essa loja
  const sessao = obterSessaoDoRequest(req);
  if (sessao?.tipo === 'loja' && sessao.lojaId !== driver.lojaId) {
    res.status(403).json({ error: 'Este motoboy pertence a outra loja e não pode ser vinculado a esta sessão.' });
    return;
  }

  res.json({
    success: true,
    driver: {
      id: driver.id,
      name: driver.name,
      vehicleType: driver.vehicleType,
      lojaId: driver.lojaId
    }
  });
});

// 5.1.1. Remover motorista (respeitando isolamento por loja)
router.delete('/drivers/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const sessao = obterSessaoDoRequest(req);
  const index = drivers.findIndex(d => {
    if (d.id !== id) return false;
    // Sessão de loja: só pode remover seus próprios motoristas
    if (sessao?.tipo === 'loja') return d.lojaId === sessao.lojaId;
    return true;
  });
  if (index === -1) {
    res.status(404).json({ error: 'Motoboy não encontrado' });
    return;
  }

  if (drivers[index].status === 'ocupado') {
    res.status(400).json({ error: 'Não é possível remover um motoboy que está em rota' });
    return;
  }

  drivers.splice(index, 1);
  await deletarMotorista(id as string);
  res.json({ success: true, message: 'Motoboy removido com sucesso' });
});

// 5.2. Obter tipos de veículos
router.get('/vehicle-types', (req: Request, res: Response) => {
  res.json(vehicleTypes);
});

// 5.3. Cadastrar novo tipo de veículo
router.post('/vehicle-types', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Nome do tipo de veículo é obrigatório' });
    return;
  }

  const id = name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(^_+|_+$)/g, '');

  if (vehicleTypes.some(vt => vt.id === id)) {
    res.status(400).json({ error: 'Tipo de veículo já cadastrado' });
    return;
  }

  const newVehicleType = { id, name };
  try {
    await salvarTipoVeiculo(newVehicleType);
    vehicleTypes.push(newVehicleType);
    res.status(201).json(newVehicleType);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar tipo de veículo no banco de dados', details: err.message });
  }
});

// 6. Receptor de webhooks do simulador externo
router.post('/simulator/webhook', (req: Request, res: Response) => {
  const webhookEvent = {
    id: `wh-${Math.random().toString(36).substring(2, 9)}`,
    receivedAt: new Date().toISOString(),
    headers: req.headers,
    body: req.body
  };

  webhooksReceived.unshift(webhookEvent);
  if (webhooksReceived.length > 50) {
    webhooksReceived.pop();
  }

  res.status(200).json({ success: true, message: 'Evento de webhook processado pelo simulador' });
});

// 7. Obter eventos de webhook recebidos
router.get('/simulator/webhooks', (req: Request, res: Response) => {
  res.json(webhooksReceived);
});

// 8. Limpar dados da simulação
router.post('/simulator/clear', (req: Request, res: Response) => {
  deliveries.clear();
  webhooksReceived.length = 0;
  drivers.forEach(d => d.status = 'ocioso');
  broker.clearHistory();
  
  // Limpar tabelas no SQL Server também? Para fins de simulação limpa, apagamos todas as entregas do banco
  import('./database').then(db => {
    if (db.pool) {
      db.pool.request().query('DELETE FROM Entregas').catch(err => {
        console.error('[Gateway] Erro ao limpar entregas no SQL Server:', err);
      });
    }
  });

  res.json({ success: true, message: 'Simulação limpa com sucesso' });
});

// 9. Resolver incidentes
router.post('/deliveries/:id/resolve', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const { incidentId } = req.body;
  
  if (incidentId) {
    const incident = delivery.incidentes.find(i => i.id === incidentId);
    if (incident) {
      incident.resolvido = true;
    }
  } else {
    // Resolve todos
    delivery.incidentes.forEach(i => i.resolvido = true);
  }

  // Se todos os incidentes estiverem resolvidos, restaura status para em_transito
  const activeIncidents = delivery.incidentes.filter(i => !i.resolvido);
  if (activeIncidents.length === 0) {
    delivery.status = 'EM_TRANSITO';
  }

  delivery.atualizadoEm = new Date().toISOString();

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Publica atualização
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: delivery.status,
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes,
    resolvedEvent: true
  });

  res.json(delivery);
});

// 10. Confirmar conclusão da entrega (ENTREGUE - Com critérios POD)
router.post('/deliveries/:id/complete', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const { recebedorNome, recebedorCPF, comprovanteFotoUrl, assinaturaBase64, justificativaDesvioCoordenada } = req.body;

  // Libera o motorista
  if (delivery.motorista) {
    const motoristaFrota = drivers.find(d => d.id === delivery.motorista!.id);
    if (motoristaFrota) motoristaFrota.status = 'ocioso';
    delivery.motorista.status = 'ocioso';
  }

  delivery.status = 'ENTREGUE';
  delivery.recebedorNome = recebedorNome || 'Recebedor Não Informado';
  delivery.recebedorCPF = recebedorCPF || '000.000.000-00';
  delivery.comprovanteFotoUrl = comprovanteFotoUrl || 'mock_canhoto_foto.png';
  delivery.assinaturaBase64 = assinaturaBase64 || 'mock_assinatura';
  delivery.justificativaDesvioCoordenada = justificativaDesvioCoordenada;
  delivery.dataHoraConclusao = new Date().toISOString();
  delivery.atualizadoEm = new Date().toISOString();

  // Se houve desvio justificado, publica o alerta
  if (justificativaDesvioCoordenada) {
    const newIncident: Incidente = {
      id: `inc-${Math.random().toString(36).substring(2, 6)}`,
      tipo: 'route_deviation',
      descricao: `AlertaDesvioCoordenada (POD Justificado): ${justificativaDesvioCoordenada}`,
      gravidade: 'aviso',
      timestamp: new Date().toISOString(),
      resolvido: false
    };
    delivery.incidentes.push(newIncident);
  }

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Checa desvio de rota sequencial (se pulou alguma comanda anterior)
  checarDesvioSequencia(delivery);

  // Publica evento final
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'ENTREGUE',
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes,
    pod: {
      recebedorNome: delivery.recebedorNome,
      recebedorCPF: delivery.recebedorCPF,
      justificativa: delivery.justificativaDesvioCoordenada
    }
  });

  res.json(delivery);
});

// 11. Registrar insucesso/devolução (AGUARDANDO_RETORNO_CD)
router.post('/deliveries/:id/fail', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const { motivoInsucesso } = req.body;

  // O motorista permanece ocupado para custódia temporária
  if (delivery.motorista) {
    const motoristaFrota = drivers.find(d => d.id === delivery.motorista!.id);
    if (motoristaFrota) motoristaFrota.status = 'ocupado';
    delivery.motorista.status = 'ocupado';
  }

  delivery.status = 'AGUARDANDO_RETORNO_CD';
  delivery.dataHoraConclusao = new Date().toISOString();
  delivery.atualizadoEm = new Date().toISOString();

  // Insere um incidente de falha explicativo
  const incident: Incidente = {
    id: `inc-${Math.random().toString(36).substring(2, 6)}`,
    tipo: 'route_deviation',
    descricao: `Entrega Recusada / Insucesso: ${motivoInsucesso || 'Cliente ausente'}`,
    gravidade: 'critico',
    timestamp: new Date().toISOString(),
    resolvido: false
  };
  delivery.incidentes.push(incident);

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Checa desvio de rota sequencial (se pulou alguma comanda anterior)
  checarDesvioSequencia(delivery);

  // Publica evento final
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'AGUARDANDO_RETORNO_CD',
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes,
    motivo: motivoInsucesso
  });

  res.json(delivery);
});

// 11.0. Confirmar chegada ao local de destino (NO_LOCAL)
router.post('/deliveries/:id/arrive', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const statusValidos = ['EM_TRANSITO', 'ALERTA_INCIDENTE', 'SLA_ALERTA'];
  if (!statusValidos.includes(delivery.status)) {
    res.status(400).json({ error: 'A entrega não está em rota de trânsito.' });
    return;
  }

  delivery.status = 'NO_LOCAL';
  delivery.atualizadoEm = new Date().toISOString();

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Publica evento de chegada
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'NO_LOCAL',
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes
  });

  res.json(delivery);
});

// 11.1. Estornar última ação (Rollback de Status)
router.post('/deliveries/:id/rollback', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  if (!delivery.dataHoraConclusao) {
    res.status(400).json({ error: 'Nenhuma ação de conclusão/falha foi realizada.' });
    return;
  }

  const diffMs = Date.now() - new Date(delivery.dataHoraConclusao).getTime();
  if (diffMs > 60000) {
    res.status(400).json({ error: 'Janela de tolerância de 60 segundos expirou.' });
    return;
  }

  // Reverte status
  delivery.status = 'NO_LOCAL';
  delivery.dataHoraConclusao = undefined;
  delivery.atualizadoEm = new Date().toISOString();

  // Restabelece motorista como ocupado
  if (delivery.motorista) {
    const motoristaFrota = drivers.find(d => d.id === delivery.motorista!.id);
    if (motoristaFrota) motoristaFrota.status = 'ocupado';
    delivery.motorista.status = 'ocupado';
  }

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Publica evento de rollback
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'NO_LOCAL',
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes,
    rollback: true
  });

  res.json(delivery);
});

// 11.2. Receber devolução do estoque no CD Central
router.post('/deliveries/:id/return-stock', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  if (delivery.status !== 'AGUARDANDO_RETORNO_CD') {
    res.status(400).json({ error: 'Entrega não está aguardando retorno a Loja.' });
    return;
  }

  // Libera o motorista
  if (delivery.motorista) {
    const motoristaFrota = drivers.find(d => d.id === delivery.motorista!.id);
    if (motoristaFrota) motoristaFrota.status = 'ocioso';
    delivery.motorista.status = 'ocioso';
  }

  delivery.status = 'PRODUTO_RETORNADO_ESTOQUE';
  delivery.atualizadoEm = new Date().toISOString();

  // Persiste no SQL Server
  await salvarEntrega(delivery);

  // Publica evento final
  broker.publish('entrega.monitorada', delivery.id, {
    deliveryId: delivery.id,
    status: 'PRODUTO_RETORNADO_ESTOQUE',
    telemetria: delivery.telemetria,
    incidents: delivery.incidentes
  });

  res.json(delivery);
});

// 12. Receber coordenadas em lote acumuladas offline
router.post('/deliveries/:id/telemetria-bulk', async (req: Request, res: Response) => {
  const delivery = deliveries.get(req.params.id as string);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const { coordenadas } = req.body;
  if (Array.isArray(coordenadas) && coordenadas.length > 0) {
    const lastCoord = coordenadas[coordenadas.length - 1];
    
    // ... rest of logic stays identical ...
    delivery.telemetria = {
      velocidadeKmh: lastCoord.velocidade !== undefined ? lastCoord.velocidade : 45,
      combustivelBateriaPct: lastCoord.bateria !== undefined ? lastCoord.bateria : 90,
      localizacaoAtual: {
        x: lastCoord.x !== undefined ? lastCoord.x : 10,
        y: lastCoord.y !== undefined ? lastCoord.y : 10
      },
      timestamp: lastCoord.timestamp || new Date().toISOString()
    };

    if (delivery.rota) {
      coordenadas.forEach((c: any) => {
        if (c.x !== undefined && c.y !== undefined) {
          delivery.rota!.path.push({
            x: c.x,
            y: c.y,
            name: 'Ponto Sincronizado Offline'
          });
        }
      });
    }

    await salvarEntrega(delivery);

    broker.publish('entrega.monitorada', delivery.id, {
      deliveryId: delivery.id,
      status: delivery.status,
      telemetria: delivery.telemetria,
      incidents: delivery.incidentes,
      bulkUpdate: true
    });
  }

  res.json({ success: true, message: 'Coordenadas offline sincronizadas' });
});

// 12.1. Simulação da API de Pedidos Externos (iFood/VTEX mock)
router.get('/simulator/external-orders-api', (req: Request, res: Response) => {
  const mockOrders = [
    {
      id_pedido_externo: "EXT-1001",
      nome_destinatario: "Carlos Alberto",
      logradouro_entrega: "Alameda Santos, 850, São Paulo",
      bairro_destino: "Cerqueira César",
      itens_pedido: ["Hambúrguer Gourmet", "Batata Rústica", "Refrigerante Lata"],
      valor_total_pedido: 62.90,
      forma_pgto: "pix",
      prioridade_entrega: "alta",
      tipo_carregamento: "normal"
    },
    {
      id_pedido_externo: "EXT-1002",
      nome_destinatario: "Juliana Santos",
      logradouro_entrega: "Rua da Consolação, 2100, São Paulo",
      bairro_destino: "Consolação",
      itens_pedido: ["Vacina Antigripal", "Alcool em Gel 70%"],
      valor_total_pedido: 115.00,
      forma_pgto: "maquininha",
      prioridade_entrega: "critica",
      tipo_carregamento: "agendado"
    },
    {
      id_pedido_externo: "EXT-1003",
      nome_destinatario: "Roberto Albuquerque",
      logradouro_entrega: "Av. Paulista, 1200, São Paulo",
      bairro_destino: "Bela Vista",
      itens_pedido: ["Smartphone Pro 128GB", "Película de Vidro"],
      valor_total_pedido: 4599.00,
      forma_pgto: "pix",
      prioridade_entrega: "media",
      tipo_carregamento: "expressa"
    }
  ];
  res.json(mockOrders);
});

// 12.2. Importador de Pedidos Externos
router.post('/simulator/import-external', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) {
    res.status(400).json({ error: 'URL da API externa não informada' });
    return;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).json({ error: `Erro ao buscar pedidos na API externa: HTTP ${response.status}` });
      return;
    }

    const externalOrders = await response.json();
    if (!Array.isArray(externalOrders)) {
      res.status(400).json({ error: 'Formato inválido: a API externa deve retornar uma lista de pedidos' });
      return;
    }

    const importedIds: string[] = [];

    for (const ord of externalOrders) {
      const alreadyExists = Array.from(deliveries.values()).some(d => 
        d.nomeCliente === ord.nome_destinatario && 
        d.endereco === ord.logradouro_entrega &&
        d.valor === ord.valor_total_pedido
      );

      if (alreadyExists) {
        continue;
      }

      cmdCounter += 1;
      const id = `COMANDA-${String(cmdCounter).padStart(4, '0')}`;

      const newDelivery: Entrega = {
        id,
        nomeCliente: ord.nome_destinatario || 'Cliente Externo',
        endereco: ord.logradouro_entrega || 'Endereço Não Informado',
        itens: Array.isArray(ord.itens_pedido) ? ord.itens_pedido : (ord.itens_pedido ? [ord.itens_pedido] : []),
        prioridade: (ord.prioridade_entrega || 'media') as Prioridade,
        tipoCarga: (ord.tipo_carregamento || 'normal') as TipoCarga,
        status: 'RECEBIDO',
        valor: ord.valor_total_pedido !== undefined ? Number(ord.valor_total_pedido) : undefined,
        incidentes: [],
        urlWebhook: 'http://localhost:5000/api/simulator/webhook',
        logsWebhook: [],
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
        formaPagamento: (ord.forma_pgto === 'pix' ? 'pix' : ord.forma_pgto === 'dinheiro' ? 'dinheiro' : 'maquininha') as FormaPagamento,
        bairro: ord.bairro_destino || undefined,
        referencia: `Importado (${ord.id_pedido_externo || 'Sem ID'})`
      };

      deliveries.set(id, newDelivery);
      await salvarEntrega(newDelivery);

      broker.publish('entrega.recebida', id, {
        deliveryId: id,
        cargoType: newDelivery.tipoCarga,
        priority: newDelivery.prioridade,
        clientName: newDelivery.nomeCliente,
        address: newDelivery.endereco
      });

      importedIds.push(id);
    }

    res.json({ success: true, importedCount: importedIds.length, deliveries: importedIds });
  } catch (err: any) {
    console.error('[Simulator] Erro ao sincronizar pedidos da API externa:', err);
    res.status(500).json({ error: `Falha na conexão com a API externa: ${err.message}` });
  }
});

export async function checarDesvioSequencia(e: Entrega) {
  if (!e.motorista || !e.sequenciaEsperada) return;
  const motoristaId = e.motorista.id;
  const expectedSeq = e.sequenciaEsperada;

  // Busca todas as entregas deste motorista que deveriam ter sido concluídas antes desta
  const skippedDeliveries = Array.from(deliveries.values()).filter(d => 
    d.motorista?.id === motoristaId && 
    d.id !== e.id &&
    d.sequenciaEsperada !== undefined &&
    d.sequenciaEsperada < expectedSeq &&
    d.status !== 'ENTREGUE' &&
    d.status !== 'AGUARDANDO_RETORNO_CD' &&
    d.status !== 'PRODUTO_RETORNADO_ESTOQUE'
  );

  if (skippedDeliveries.length > 0) {
    for (const skipped of skippedDeliveries) {
      const exists = skipped.incidentes.some(i => i.tipo === 'route_deviation' && i.descricao.includes('AlertaDesvioSequencia'));
      if (!exists) {
        const incident: Incidente = {
          id: `inc-${Math.random().toString(36).substring(2, 6)}`,
          tipo: 'route_deviation',
          descricao: `AlertaDesvioSequencia: Sequência ideal de rota quebrada (pedido pulado pelo entregador).`,
          gravidade: 'aviso',
          timestamp: new Date().toISOString(),
          resolvido: false
        };
        skipped.incidentes.push(incident);
        skipped.status = 'ALERTA_INCIDENTE';
        skipped.atualizadoEm = new Date().toISOString();
        await salvarEntrega(skipped);

        // Publica evento de desvio no barramento
        broker.publish('entrega.monitorada', skipped.id, {
          deliveryId: skipped.id,
          status: 'ALERTA_INCIDENTE',
          incidents: skipped.incidentes,
          telemetria: skipped.telemetria,
          desvioSequencia: true
        });
      }
    }
  }
}

export default router;

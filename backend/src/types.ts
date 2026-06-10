export type StatusEntrega =
  | 'RECEBIDO'
  | 'EM_PREPARO'
  | 'DESPACHADO'
  | 'EM_TRANSITO'
  | 'NO_LOCAL'
  | 'ENTREGUE'
  | 'RECUSADO_INSUCESSO'
  | 'ALERTA_INCIDENTE'
  | 'AGUARDANDO_RETORNO_CD'
  | 'PRODUTO_RETORNADO_ESTOQUE'
  | 'SLA_ALERTA'
  | 'CANCELADO';

export type Prioridade = 'baixa' | 'media' | 'alta' | 'critica';
export type TipoCarga = 'normal' | 'expressa' | 'agendado';
export type FormaPagamento = 'maquininha' | 'pix' | 'dinheiro';

export interface Localizacao {
  x: number; // 0 a 100 na representação da grade
  y: number; // 0 a 100 na representação da grade
}

export interface NoRota extends Localizacao {
  name?: string;
}

export interface Motorista {
  id: string;
  name: string;
  vehicleType: string;
  status: 'ocioso' | 'ocupado';
  lojaId?: string; // Isolamento multi-tenant
  codigoVinculo: string; // Código de pareamento (ex: 123456)
  dispositivoConectado?: boolean; // Status online do app móvel
  localizacaoAtual?: Localizacao; // Posição GPS em tempo real
  ultimaAtualizacao?: string; // Timestamp do último ping do GPS
}

export interface Rota {
  distanceKm: number;
  durationSec: number;
  cost: number;
  path: NoRota[];
}

export interface Telemetria {
  velocidadeKmh: number;
  temperaturaCelsius?: number; // Crucial para cadeia_fria
  combustivelBateriaPct: number;
  localizacaoAtual: Localizacao;
  timestamp: string;
}

export interface Incidente {
  id: string;
  tipo: 'traffic_jam' | 'flat_tire' | 'temperature_spike' | 'route_deviation' | 'webhook_timeout';
  descricao: string;
  gravidade: 'aviso' | 'critico';
  timestamp: string;
  resolvido: boolean;
}

export interface Entrega {
  id: string;
  nomeCliente: string;
  clienteDocumento?: string;
  endereco: string;
  itens: string[];
  prioridade: Prioridade;
  tipoCarga: TipoCarga;
  status: StatusEntrega;
  valor?: number;
  motorista?: Motorista;
  rota?: Rota;
  telemetria?: Telemetria;
  incidentes: Incidente[];
  urlWebhook?: string;
  logsWebhook: LogWebhook[];
  criadoEm: string;
  atualizadoEm: string;
  
  // Novos campos para POD (Proof of Delivery)
  recebedorNome?: string;
  recebedorCPF?: string;
  comprovanteFotoUrl?: string;
  assinaturaBase64?: string;
  justificativaDesvioCoordenada?: string;

  // Módulo 6 — Engenharia de Dados
  formaPagamento?: FormaPagamento;
  romaneioId?: string;
  bairro?: string;
  cidade?: string;
  referencia?: string;
  despachadoEm?: string;

  // Controle de exceções
  dataHoraConclusao?: string;
  sequenciaEsperada?: number;
  sequenciaRealizada?: number;

  // Clusterização (Destino antes da rota)
  destino?: Localizacao;

  // Coordenadas geográficas REAIS do destino (resolvidas via geocoder a partir do endereço do cliente).
  // Independem do grid sintético; usadas pelo frontend para plotar o pino no lugar exato no mapa.
  destinoLatitude?: number;
  destinoLongitude?: number;

  // Multi-tenant
  lojaId?: string;
  nomeLoja?: string;
  nomeEmpresa?: string;
  tipoComanda?: 'pedido' | 'entrega';
}

export interface LogWebhook {
  timestamp: string;
  url: string;
  payload: any;
  status: 'sucesso' | 'falha' | 'tentando';
  statusCode?: number;
  errorMessage?: string;
  attempt: number;
}

export interface MensagemEvento {
  id: string;
  topic: string;
  deliveryId: string;
  payload: any;
  timestamp: string;
}

export interface EstadoAgente {
  id: string;
  name: string;
  status: 'active' | 'idle' | 'error' | 'warning' | 'critical';
  processedCount: number;
  lastActive: string;
  latencyMs: number;
}

// ====== MULTI-TENANT ======

export interface Empresa {
  id: string;
  nome: string;
  cnpj: string;
  telefone?: string;
  email?: string;
  ativo: boolean;
  statusFinanceiro?: string;  // 'REGULAR' | 'INADIMPLENTE' | 'SUSPENSO' | 'CANCELADO'
  criadoEm: string;
}

export interface Loja {
  id: string;
  empresaId: string;
  nome: string;
  cnpj?: string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  usuario: string;
  senhaHash: string;    // SHA-256, nunca exposto via API
  chaveAcesso: string;  // Código de referência DISTRE-XXXX-YYYY-ZZZZ
  ativo: boolean;
  criadoEm: string;
  recebePedidos?: boolean;
  statusFinanceiro?: string;  // 'REGULAR' | 'INADIMPLENTE' | 'SUSPENSO' | 'CANCELADO' — billing por loja
  latitude?: number;   // coordenada geográfica resolvida a partir do endereço (Nominatim)
  longitude?: number;
  logoUrl?: string;    // logomarca exibida no cabeçalho da vitrine pública
}

export interface Sessao {
  tipo: 'admin' | 'loja';
  lojaId?: string;
  nomeLoja?: string;
  nomeEmpresa?: string;
  token: string;
  criadoEm: string;
  recebePedidos?: boolean;
  latitude?: number;
  longitude?: number;
}

export interface TipoVeiculo {
  id: string;
  name: string;
}

export interface Produto {
  id: string;
  nome: string;
  preco: number;
  lojaId?: string;
  ativo: boolean;
  imagemUrl?: string;
  descricao?: string;
}

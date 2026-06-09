import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { io, Socket } from 'socket.io-client';
import CentroOperacoes, { type BrokerEvento } from './components/CentroOperacoes';
import KanbanComandas from './components/KanbanComandas';
import './App.css';

declare const L: any;

// Bounding box para Abreu e Lima, Pernambuco, Brasil (Foco da Loja 10)
const CITY_BOUNDS = {
  minLat: -7.925,
  maxLat: -7.875,
  minLng: -34.935,
  maxLng: -34.875
};

// Converte coordenadas da grade (0-100) para latitude e longitude reais
function gridToLatLng(x: number, y: number): [number, number] {
  const lng = CITY_BOUNDS.minLng + (x / 100) * (CITY_BOUNDS.maxLng - CITY_BOUNDS.minLng);
  const lat = CITY_BOUNDS.maxLat - (y / 100) * (CITY_BOUNDS.maxLat - CITY_BOUNDS.minLat);
  return [lat, lng];
}

// Converte latitude e longitude reais de volta para coordenadas da grade (0-100)
function latLngToGrid(lat: number, lng: number): { x: number; y: number } {
  // Clampa nos limites da cidade
  const clLat = Math.min(CITY_BOUNDS.maxLat, Math.max(CITY_BOUNDS.minLat, lat));
  const clLng = Math.min(CITY_BOUNDS.maxLng, Math.max(CITY_BOUNDS.minLng, lng));
  
  const x = ((clLng - CITY_BOUNDS.minLng) / (CITY_BOUNDS.maxLng - CITY_BOUNDS.minLng)) * 100;
  const y = ((CITY_BOUNDS.maxLat - clLat) / (CITY_BOUNDS.maxLat - CITY_BOUNDS.minLat)) * 100;
  
  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

// Cache global de rotas OSRM para evitar requisições redundantes e rate limits
const osrmRoutesCache = new Map<string, [number, number][]>();

// Marcador da loja (hub) no mapa — estilo Waze: badge branco com ícone de loja
// e o NOME da loja exibido logo acima do indicador (via CSS ::after / --hub-name).
function hubIconHtml(name: string): string {
  return `<div class="map-city-hub" style="--hub-name: '${name}'; position: absolute; transform: translate(-50%, -50%); left: 0; top: 0;">`
    + `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">`
    + `<path d="M3 9 L4.4 4.5 H19.6 L21 9" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="M4.5 9 V19.5 H19.5 V9" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/>`
    + `<path d="M9.5 19.5 V14 H14.5 V19.5" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/>`
    + `</svg></div>`;
}

function getVehicleIconHtmlString(type?: string): string {
  switch (type) {
    case 'drone':
      return `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
          <path d="M12 2v20M20 12H4" />
          <circle cx="12" cy="12" r="3" />
          <circle cx="12" cy="2" r="1.5" />
          <circle cx="12" cy="22" r="1.5" />
          <circle cx="20" cy="12" r="1.5" />
          <circle cx="4" cy="12" r="1.5" />
        </svg>
      `;
    case 'motorcycle':
      return `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
          <circle cx="5" cy="18" r="3" />
          <circle cx="19" cy="18" r="3" />
          <path d="M12 18V8H9m6 10l-3-6h-3m4-4h4l2 3" />
        </svg>
      `;
    case 'van':
      return `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
          <path d="M14 18H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" />
          <circle cx="7.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="18" r="2.5" />
          <path d="M13 6v8m5-8l2 3v3" />
        </svg>
      `;
    case 'refrigerated_truck':
      return `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
          <path d="M14 18H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h11v13z" />
          <path d="M14 8h5l3 3v6h-8V8z" />
          <circle cx="5.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="18" r="2.5" />
          <path d="M20 18h2" />
        </svg>
      `;
    default:
      return `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
          <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      `;
  }
}

// Interfaces locais traduzidas para sincronia com o Backend
interface Localizacao {
  x: number;
  y: number;
}

interface NoRota extends Localizacao {
  name?: string;
}

interface Motorista {
  id: string;
  name: string;
  vehicleType: string;
  status: 'ocioso' | 'ocupado';
  codigoVinculo: string;
  dispositivoConectado: boolean;
  localizacaoAtual?: Localizacao;
  ultimaAtualizacao?: string;
  lojaId?: string;
}

interface Rota {
  distanceKm: number;
  durationSec: number;
  cost: number;
  path: NoRota[];
}

interface Telemetria {
  velocidadeKmh: number;
  temperaturaCelsius?: number;
  combustivelBateriaPct: number;
  localizacaoAtual: Localizacao;
  timestamp: string;
}

interface Incidente {
  id: string;
  tipo: 'traffic_jam' | 'flat_tire' | 'temperature_spike' | 'route_deviation' | 'webhook_timeout';
  descricao: string;
  gravidade: 'aviso' | 'critico';
  timestamp: string;
  resolvido: boolean;
}

interface LogWebhook {
  timestamp: string;
  url: string;
  payload: any;
  status: 'sucesso' | 'falha' | 'tentando';
  statusCode?: number;
  errorMessage?: string;
  attempt: number;
}

interface TipoVeiculo {
  id: string;
  name: string;
}

interface Entrega {
  id: string;
  nomeCliente: string;
  clienteDocumento?: string;
  endereco: string;
  itens: string[];
  prioridade: 'baixa' | 'media' | 'alta' | 'critica';
  tipoCarga: 'normal' | 'expressa' | 'agendado';
  status: 'RECEBIDO' | 'EM_PREPARO' | 'DESPACHADO' | 'EM_TRANSITO' | 'NO_LOCAL' | 'ENTREGUE' | 'RECUSADO_INSUCESSO' | 'ALERTA_INCIDENTE' | 'AGUARDANDO_RETORNO_CD' | 'PRODUTO_RETORNADO_ESTOQUE' | 'SLA_ALERTA' | 'CANCELADO';
  valor?: number;
  motorista?: Motorista;
  rota?: Rota;
  telemetria?: Telemetria;
  incidentes: Incidente[];
  urlWebhook?: string;
  logsWebhook: LogWebhook[];
  criadoEm: string;
  atualizadoEm: string;

  // Campos POD
  recebedorNome?: string;
  recebedorCPF?: string;
  comprovanteFotoUrl?: string;
  assinaturaBase64?: string;
  justificativaDesvioCoordenada?: string;

  // Módulo 6 — Engenharia de Dados
  formaPagamento?: 'maquininha' | 'pix' | 'dinheiro';
  romaneioId?: string;
  bairro?: string;
  cidade?: string;
  referencia?: string;
  despachadoEm?: string;
  dataHoraConclusao?: string;
  sequenciaEsperada?: number;

  // Multi-tenant
  lojaId?: string;
  nomeLoja?: string;
  nomeEmpresa?: string;
  tipoComanda?: 'pedido' | 'entrega';
  destinoLatitude?: number;
  destinoLongitude?: number;
}




interface AcaoFilaSincronia {
  id: string;
  acao: 'concluir' | 'falhar' | 'chegar';
  entregaId: string;
  timestamp: string;
  motivoInsucesso?: string;
  recebedorNome?: string;
  recebedorCPF?: string;
  comprovanteFotoUrl?: string;
  assinaturaBase64?: string;
  justificativaDesvioCoordenada?: string;
}

// URL do backend (API + WebSocket). Configurável no build via VITE_BACKEND_URL:
//  - não definido  → dev local (http://localhost:5000)
//  - definido vazio → MESMA ORIGEM (o backend serve o frontend; ideal p/ 1 túnel só)
//  - definido c/ URL → usa a URL (ex.: https://api.seudominio.com.br)
const _viteBackend = (import.meta as any).env?.VITE_BACKEND_URL;
const BACKEND_URL = _viteBackend === undefined ? 'http://localhost:5000' : _viteBackend;

interface DadoPerformanceHistorico {
  id: string;
  data: string; // YYYY-MM-DD
  motoristaId: string;
  motoristaName: string;
  veiculo: string;
  status: 'sucesso' | 'cancelado';
  tempoEntregaMin: number;
  valor: number;
  avaliacao: number;
  bairro?: string;
  formaPagamento?: 'maquininha' | 'pix' | 'dinheiro';
  prioridade?: 'baixa' | 'media' | 'alta' | 'critica';
  incidentesCount?: number;
  incidentesTipos?: string[];
  romaneioId?: string;
  despachadoEm?: string;
}

// Histórico de performance baseado apenas em entregas reais — sem dados mockados estáticos
const HISTORICO_PERFORMANCE: DadoPerformanceHistorico[] = [];

interface Empresa {
  id: string;
  nome: string;
  cnpj: string;
  telefone?: string;
  email?: string;
  ativo: boolean;
  criadoEm: string;
  totalLojas?: number;
  lojasAtivas?: number;
}

interface Loja {
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
  chaveAcesso: string;
  ativo: boolean;
  criadoEm: string;
  recebePedidos?: boolean;
  latitude?: number;
  longitude?: number;
}

interface Sessao {
  tipo: 'admin' | 'loja';
  lojaId?: string;
  nomeLoja?: string;
  nomeEmpresa?: string;
  token: string;
  criadoEm?: string;
  recebePedidos?: boolean;
  latitude?: number;
  longitude?: number;
}

export default function App() {
  // --- ESTADOS MULTI-TENANT & AUTENTICAÇÃO ---
  const [sessao, setSessao] = useState<Sessao | null>(() => {
    const saved = localStorage.getItem('distre_sessao');
    return saved ? JSON.parse(saved) : null;
  });

  const hubName = sessao?.tipo === 'loja' && sessao.nomeLoja
    ? sessao.nomeLoja
    : 'CD Central';

  // --- ESTADOS RASTREAMENTO GPS / VINCULO MOTOBOY ---
  const [driverMobileVinculado, setDriverMobileVinculado] = useState<Motorista | null>(() => {
    const saved = localStorage.getItem('distre_driver_mobile');
    return saved ? JSON.parse(saved) : null;
  });
  const [driverPinInput, setDriverPinInput] = useState('');
  const [driverLocation, setDriverLocation] = useState<Localizacao | null>(() => {
    const savedLoc = localStorage.getItem('distre_driver_location');
    return savedLoc ? JSON.parse(savedLoc) : { x: 10, y: 10 };
  });
  const [loginUsuario, setLoginUsuario] = useState('');
  const [loginSenha, setLoginSenha] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginTab, setLoginTab] = useState<'loja' | 'admin'>('loja');
  const [selectedDriverForDispatch, setSelectedDriverForDispatch] = useState('');

  // Gerenciamento de Empresas no Painel Master
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [lojasDaEmpresa, setLojasDaEmpresa] = useState<Record<string, Loja[]>>({});
  const [expandedEmpresas, setExpandedEmpresas] = useState<string[]>([]);
  
  // Modais de Criação no Painel Master
  const [showNovaEmpresaForm, setShowNovaEmpresaForm] = useState(false);
  const [novaEmpresaNome, setNovaEmpresaNome] = useState('');
  const [novaEmpresaCnpj, setNovaEmpresaCnpj] = useState('');
  const [novaEmpresaTelefone, setNovaEmpresaTelefone] = useState('');
  const [novaEmpresaEmail, setNovaEmpresaEmail] = useState('');

  const [showNovaLojaForm, setShowNovaLojaForm] = useState<string | null>(null); // empresaId
  const [novaLojaNome, setNovaLojaNome] = useState('');
  const [novaLojaCnpj, setNovaLojaCnpj] = useState('');
  const [novaLojaUsuario, setNovaLojaUsuario] = useState('');
  const [novaLojaSenha, setNovaLojaSenha] = useState('');
  const [novaLojaEndereco, setNovaLojaEndereco] = useState('');
  const [novaLojaNumero, setNovaLojaNumero] = useState('');
  const [novaLojaBairro, setNovaLojaBairro] = useState('');
  const [novaLojaCidade, setNovaLojaCidade] = useState('');
  const [novaLojaUf, setNovaLojaUf] = useState('');
  const [novaLojaCep, setNovaLojaCep] = useState('');
  const [novaLojaRecebePedidos, setNovaLojaRecebePedidos] = useState(false);
  const [novaLojaPlanoId, setNovaLojaPlanoId] = useState('');

  const [editingLoja, setEditingLoja] = useState<Loja | null>(null);
  const [editLojaNome, setEditLojaNome] = useState('');
  const [editLojaCnpj, setEditLojaCnpj] = useState('');
  const [editLojaUsuario, setEditLojaUsuario] = useState('');
  const [editLojaSenha, setEditLojaSenha] = useState('');
  const [editLojaEndereco, setEditLojaEndereco] = useState('');
  const [editLojaNumero, setEditLojaNumero] = useState('');
  const [editLojaBairro, setEditLojaBairro] = useState('');
  const [editLojaCidade, setEditLojaCidade] = useState('');
  const [editLojaUf, setEditLojaUf] = useState('');
  const [editLojaCep, setEditLojaCep] = useState('');
  const [editLojaRecebePedidos, setEditLojaRecebePedidos] = useState(false);

  // Loja sendo visualizada pelo Admin Master
  const [lojaVisualizada, setLojaVisualizada] = useState<{ id: string; nome: string; nomeEmpresa: string } | null>(null);

  // --- ESTADOS DO MÓDULO FINANCEIRO ---
  const [adminSubView, setAdminSubView] = useState<'operacional' | 'financeiro'>('operacional');
  const [finSubTab, setFinSubTab] = useState<'faturas' | 'relatorios' | 'planos_config'>('faturas');
  
  const [finDashboard, setFinDashboard] = useState<{
    mrrAtual: number;
    mrrProjetado: number;
    totalFaturasEmAberto: number;
    valorEmAberto: number;
    taxaInadimplencia: number;
    lojasAtivas: number;
    lojasInadimplentes: number;
    totalLojas: number;
    faturamentoBrutoMes: number;
    faturamentoLiquidoMes: number;
  } | null>(null);

  const [finFaturas, setFinFaturas] = useState<any[]>([]);
  const [finPaginaAtual, setFinPaginaAtual] = useState(1);
  const [finTotalPaginas, setFinTotalPaginas] = useState(1);
  const [finFaturasFiltros, setFinFaturasFiltros] = useState({
    status: '',
    empresaId: '',
    dataInicio: '',
    dataFim: '',
    limit: 10
  });

  const [finRelFaturamento, setFinRelFaturamento] = useState<any[]>([]);
  const [finRelInadimplencia, setFinRelInadimplencia] = useState<any[]>([]);
  const [finRelChurn, setFinRelChurn] = useState<any[]>([]);
  const [finRelPrevisibilidade, setFinRelPrevisibilidade] = useState<any[]>([]);
  const [finConfiguracoes, setFinConfiguracoes] = useState<any>(null);
  const [finAssinaturas, setFinAssinaturas] = useState<any[]>([]);
  const [finPlanos, setFinPlanos] = useState<any[]>([]);

  // Modais e formulários
  const [showCobrarManualForm, setShowCobrarManualForm] = useState(false);
  const [manualCobrarEmpresaId, setManualCobrarEmpresaId] = useState('');
  const [manualCobrarValor, setManualCobrarValor] = useState('');
  const [manualCobrarDescricao, setManualCobrarDescricao] = useState('');
  const [manualCobrarVencimento, setManualCobrarVencimento] = useState('');
  const [manualCobrarError, setManualCobrarError] = useState<string | null>(null);

  const [showBaixaManualForm, setShowBaixaManualForm] = useState<string | null>(null); // faturaId
  const [baixaManualComprovante, setBaixaManualComprovante] = useState('');
  const [baixaManualObservacoes, setBaixaManualObservacoes] = useState('');

  const [showContestarForm, setShowContestarForm] = useState<string | null>(null); // faturaId
  const [contestarMotivo, setContestarMotivo] = useState('');

  const [showPlanoForm, setShowPlanoForm] = useState<any>(null); // null ou plano
  const [planoNome, setPlanoNome] = useState('');
  const [planoDescricao, setPlanoDescricao] = useState('');
  const [planoValorMensal, setPlanoValorMensal] = useState('');
  const [planoLimiteEntregas, setPlanoLimiteEntregas] = useState('');
  const [planoLimiteLojas, setPlanoLimiteLojas] = useState('');
  const [planoLimiteMotoristas, setPlanoLimiteMotoristas] = useState('');
  const [planoError, setPlanoError] = useState<string | null>(null);

  // Helper para requisições com Token
  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const token = sessao?.token;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    } as Record<string, string>;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      ...options,
      headers
    });
    if (response.status === 401) {
      console.warn('[API] Token inválido ou expirado. Fazendo logout...');
      handleLogout();
    }
    return response;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);

    const endpoint = loginTab === 'admin' ? '/api/auth/admin' : '/api/auth/login';
    try {
      const res = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: loginUsuario, senha: loginSenha })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao realizar login');
      }
      
      const novaSessao: Sessao = {
        tipo: data.tipo,
        lojaId: data.lojaId,
        nomeLoja: data.nomeLoja,
        nomeEmpresa: data.nomeEmpresa,
        token: data.token
      };

      setSessao(novaSessao);
      localStorage.setItem('distre_sessao', JSON.stringify(novaSessao));
      localStorage.setItem('distre_token', data.token);
      setLoginUsuario('');
      setLoginSenha('');
    } catch (err: any) {
      setLoginError(err.message);
    }
  };

  const handleLogout = async () => {
    try {
      if (sessao?.token) {
        await fetch(`${BACKEND_URL}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${sessao.token}` }
        });
      }
    } catch (err) {
      console.error('Erro ao fazer logout no backend:', err);
    }
    setSessao(null);
    setLojaVisualizada(null);
    setAllDeliveries([]);
    setAllDrivers([]);
    setSelectedForManifest([]);
    setActiveManifest(null);
    localStorage.removeItem('distre_sessao');
    localStorage.removeItem('distre_token');
    localStorage.removeItem('distre_driver_mobile');
    localStorage.removeItem('distre_driver_location');
  };

  const carregarEmpresas = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas`);
      if (res.ok) {
        const data = await res.json();
        setEmpresas(data);
      }
    } catch (err) {
      console.error('Erro ao carregar empresas:', err);
    }
  };

  const carregarLojas = async (empresaId: string) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas`);
      if (res.ok) {
        const data = await res.json();
        setLojasDaEmpresa(prev => ({ ...prev, [empresaId]: data }));
      }
    } catch (err) {
      console.error(`Erro ao carregar lojas da empresa ${empresaId}:`, err);
    }
  };

  // --- FUNÇÕES E EFEITOS DO MÓDULO FINANCEIRO ---

  const carregarFinanceiroDashboard = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/dashboard`);
      if (res.ok) {
        const data = await res.json();
        setFinDashboard(data);
      }
    } catch (err) {
      console.error('Erro ao carregar dashboard financeiro:', err);
    }
  };

  const carregarFinanceiroFaturas = async () => {
    try {
      const queryParams = new URLSearchParams({
        status: finFaturasFiltros.status,
        empresaId: finFaturasFiltros.empresaId,
        dataInicio: finFaturasFiltros.dataInicio,
        dataFim: finFaturasFiltros.dataFim,
        page: finPaginaAtual.toString(),
        limit: finFaturasFiltros.limit.toString()
      });
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/faturas?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setFinFaturas(data.faturas || []);
        setFinTotalPaginas(data.paginacao?.paginas || 1);
      }
    } catch (err) {
      console.error('Erro ao carregar faturas:', err);
    }
  };

  const carregarFinanceiroRelatorios = async () => {
    try {
      const [resFat, resInad, resChurn, resPrev] = await Promise.all([
        apiFetch(`${BACKEND_URL}/api/admin/financeiro/relatorios/faturamento`),
        apiFetch(`${BACKEND_URL}/api/admin/financeiro/relatorios/inadimplencia`),
        apiFetch(`${BACKEND_URL}/api/admin/financeiro/relatorios/churn`),
        apiFetch(`${BACKEND_URL}/api/admin/financeiro/relatorios/previsibilidade`)
      ]);
      if (resFat.ok) setFinRelFaturamento(await resFat.json());
      if (resInad.ok) setFinRelInadimplencia(await resInad.json());
      if (resChurn.ok) setFinRelChurn(await resChurn.json());
      if (resPrev.ok) setFinRelPrevisibilidade(await resPrev.json());
    } catch (err) {
      console.error('Erro ao carregar relatórios financeiros:', err);
    }
  };

  const carregarFinanceiroConfig = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/configuracoes`);
      if (res.ok) {
        const data = await res.json();
        setFinConfiguracoes(data);
      }
    } catch (err) {
      console.error('Erro ao carregar configurações de cobrança:', err);
    }
  };

  const carregarFinanceiroAssinaturas = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/assinaturas`);
      if (res.ok) {
        const data = await res.json();
        setFinAssinaturas(data);
      }
    } catch (err) {
      console.error('Erro ao carregar assinaturas:', err);
    }
  };

  const carregarFinanceiroPlanos = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/planos`);
      if (res.ok) {
        const data = await res.json();
        setFinPlanos(data);
      }
    } catch (err) {
      console.error('Erro ao carregar planos:', err);
    }
  };

  const carregarTodosDadosFinanceiros = () => {
    carregarFinanceiroDashboard();
    carregarFinanceiroFaturas();
    carregarFinanceiroRelatorios();
    carregarFinanceiroConfig();
    carregarFinanceiroAssinaturas();
    carregarFinanceiroPlanos();
  };

  const handleCobrarManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setManualCobrarError(null);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/cobrar-manual`, {
        method: 'POST',
        body: JSON.stringify({
          empresaId: manualCobrarEmpresaId,
          valor: parseFloat(manualCobrarValor),
          descricao: manualCobrarDescricao,
          vencimento: manualCobrarVencimento
        })
      });
      if (res.ok) {
        setShowCobrarManualForm(false);
        setManualCobrarEmpresaId('');
        setManualCobrarValor('');
        setManualCobrarDescricao('');
        setManualCobrarVencimento('');
        carregarTodosDadosFinanceiros();
      } else {
        const data = await res.json();
        setManualCobrarError(data.error || 'Erro ao gerar cobrança manual');
      }
    } catch (err: any) {
      setManualCobrarError(err.message);
    }
  };

  const handleBaixaManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showBaixaManualForm) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/faturas/${showBaixaManualForm}/baixa-manual`, {
        method: 'PUT',
        body: JSON.stringify({
          dataPagamento: new Date().toISOString(),
          comprovanteReferencia: baixaManualComprovante,
          observacoes: baixaManualObservacoes
        })
      });
      if (res.ok) {
        setShowBaixaManualForm(null);
        setBaixaManualComprovante('');
        setBaixaManualObservacoes('');
        carregarTodosDadosFinanceiros();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao registrar baixa');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleContestarFatura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showContestarForm) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/faturas/${showContestarForm}/contestar`, {
        method: 'PUT',
        body: JSON.stringify({ motivo: contestarMotivo })
      });
      if (res.ok) {
        setShowContestarForm(null);
        setContestarMotivo('');
        carregarTodosDadosFinanceiros();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao contestar fatura');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCancelarFatura = async (faturaId: string) => {
    if (!confirm('Deseja realmente cancelar esta fatura?')) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/faturas/${faturaId}/cancelar`, {
        method: 'PUT'
      });
      if (res.ok) {
        carregarTodosDadosFinanceiros();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao cancelar fatura');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSalvarConfigCobranca = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!finConfiguracoes) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/admin/financeiro/configuracoes`, {
        method: 'PUT',
        body: JSON.stringify(finConfiguracoes)
      });
      if (res.ok) {
        alert('Configurações salvas com sucesso!');
        carregarFinanceiroConfig();
        carregarFinanceiroDashboard();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao salvar configurações');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSalvarPlano = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlanoError(null);
    const isEdit = !!showPlanoForm?.id;
    const url = isEdit
      ? `${BACKEND_URL}/api/admin/financeiro/planos/${showPlanoForm.id}`
      : `${BACKEND_URL}/api/admin/financeiro/planos`;
    const method = isEdit ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify({
          nome: planoNome,
          descricao: planoDescricao,
          valorMensal: parseFloat(planoValorMensal),
          limiteEntregasMes: planoLimiteEntregas ? parseInt(planoLimiteEntregas) : null,
          limiteLojas: planoLimiteLojas ? parseInt(planoLimiteLojas) : null,
          limiteMotoristas: planoLimiteMotoristas ? parseInt(planoLimiteMotoristas) : null,
          ativo: showPlanoForm?.ativo !== false
        })
      });
      if (res.ok) {
        setShowPlanoForm(null);
        setPlanoNome('');
        setPlanoDescricao('');
        setPlanoValorMensal('');
        setPlanoLimiteEntregas('');
        setPlanoLimiteLojas('');
        setPlanoLimiteMotoristas('');
        carregarTodosDadosFinanceiros();
      } else {
        const data = await res.json();
        setPlanoError(data.error || 'Erro ao salvar plano');
      }
    } catch (err: any) {
      setPlanoError(err.message);
    }
  };

  const startEditPlano = (plano: any) => {
    setShowPlanoForm(plano);
    setPlanoNome(plano.nome);
    setPlanoDescricao(plano.descricao);
    setPlanoValorMensal(plano.valorMensal.toString());
    setPlanoLimiteEntregas(plano.limiteEntregasMes?.toString() || '');
    setPlanoLimiteLojas(plano.limiteLojas?.toString() || '');
    setPlanoLimiteMotoristas(plano.limiteMotoristas?.toString() || '');
  };

  const startNovoPlano = () => {
    setShowPlanoForm({ id: '' });
    setPlanoNome('');
    setPlanoDescricao('');
    setPlanoValorMensal('');
    setPlanoLimiteEntregas('');
    setPlanoLimiteLojas('');
    setPlanoLimiteMotoristas('');
  };

  useEffect(() => {
    if (sessao?.tipo === 'admin' && !lojaVisualizada && adminSubView === 'financeiro') {
      carregarTodosDadosFinanceiros();
    }
  }, [sessao, lojaVisualizada, adminSubView]);

  useEffect(() => {
    if (sessao?.tipo === 'admin' && !lojaVisualizada && adminSubView === 'financeiro') {
      carregarFinanceiroFaturas();
    }
  }, [finPaginaAtual, finFaturasFiltros]);

  const toggleEmpresaExpandida = (empresaId: string) => {
    if (expandedEmpresas.includes(empresaId)) {
      setExpandedEmpresas(prev => prev.filter(id => id !== empresaId));
    } else {
      setExpandedEmpresas(prev => [...prev, empresaId]);
      carregarLojas(empresaId);
    }
  };

  const handleCadastrarEmpresa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!novaEmpresaNome.trim() || !novaEmpresaCnpj.trim()) {
      alert('Nome e CNPJ são obrigatórios');
      return;
    }
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas`, {
        method: 'POST',
        body: JSON.stringify({
          nome: novaEmpresaNome,
          cnpj: novaEmpresaCnpj,
          telefone: novaEmpresaTelefone,
          email: novaEmpresaEmail
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Erro ao cadastrar empresa');
      }
      setNovaEmpresaNome('');
      setNovaEmpresaCnpj('');
      setNovaEmpresaTelefone('');
      setNovaEmpresaEmail('');
      setShowNovaEmpresaForm(false);
      carregarEmpresas();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCadastrarLoja = async (e: React.FormEvent, empresaId: string) => {
    e.preventDefault();
    if (!novaLojaNome.trim() || !novaLojaUsuario.trim() || !novaLojaSenha.trim() || !novaLojaCnpj.trim()) {
      alert('Nome, CNPJ, usuário e senha são obrigatórios');
      return;
    }
    if (!novaLojaPlanoId) {
      alert('Selecione o plano de assinatura da loja');
      return;
    }
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas`, {
        method: 'POST',
        body: JSON.stringify({
          nome: novaLojaNome,
          cnpj: novaLojaCnpj,
          usuario: novaLojaUsuario,
          senha: novaLojaSenha,
          endereco: novaLojaEndereco,
          numero: novaLojaNumero,
          bairro: novaLojaBairro,
          cidade: novaLojaCidade,
          uf: novaLojaUf,
          cep: novaLojaCep,
          recebePedidos: novaLojaRecebePedidos,
          planoId: novaLojaPlanoId
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Erro ao cadastrar loja');
      }
      setNovaLojaNome('');
      setNovaLojaCnpj('');
      setNovaLojaUsuario('');
      setNovaLojaSenha('');
      setNovaLojaEndereco('');
      setNovaLojaNumero('');
      setNovaLojaBairro('');
      setNovaLojaCidade('');
      setNovaLojaUf('');
      setNovaLojaCep('');
      setNovaLojaRecebePedidos(false);
      setNovaLojaPlanoId('');
      setShowNovaLojaForm(null);
      carregarLojas(empresaId);
      carregarEmpresas();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleEmpresa = async (empresaId: string) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/toggle`, {
        method: 'PATCH'
      });
      if (res.ok) {
        carregarEmpresas();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao alternar status da empresa');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleLoja = async (empresaId: string, lojaId: string) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas/${lojaId}/toggle`, {
        method: 'PATCH'
      });
      if (res.ok) {
        carregarLojas(empresaId);
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao alternar status da loja');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleRecebePedidos = async (empresaId: string, loja: Loja) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas/${loja.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          recebePedidos: !loja.recebePedidos
        })
      });
      if (res.ok) {
        carregarLojas(empresaId);
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao alternar recebimento de pedidos');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const startEditLoja = (loja: Loja) => {
    setEditingLoja(loja);
    setEditLojaNome(loja.nome);
    setEditLojaCnpj(loja.cnpj || '');
    setEditLojaUsuario(loja.usuario);
    setEditLojaSenha('');
    setEditLojaEndereco(loja.endereco || '');
    setEditLojaNumero(loja.numero || '');
    setEditLojaBairro(loja.bairro || '');
    setEditLojaCidade(loja.cidade || '');
    setEditLojaUf(loja.uf || '');
    setEditLojaCep(loja.cep || '');
    setEditLojaRecebePedidos(loja.recebePedidos || false);
  };

  const handleUpdateLoja = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLoja) return;
    if (!editLojaNome.trim() || !editLojaUsuario.trim() || !editLojaCnpj.trim()) {
      alert('Nome, CNPJ e usuário são obrigatórios');
      return;
    }

    try {
      const body: any = {
        nome: editLojaNome,
        cnpj: editLojaCnpj,
        usuario: editLojaUsuario,
        endereco: editLojaEndereco || undefined,
        numero: editLojaNumero || undefined,
        bairro: editLojaBairro || undefined,
        cidade: editLojaCidade || undefined,
        uf: editLojaUf || undefined,
        cep: editLojaCep || undefined,
        recebePedidos: editLojaRecebePedidos
      };
      if (editLojaSenha.trim()) {
        body.senha = editLojaSenha;
      }

      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${editingLoja.empresaId}/lojas/${editingLoja.id}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Erro ao editar loja');
      }

      setEditingLoja(null);
      carregarLojas(editingLoja.empresaId);
      carregarEmpresas();
      alert('Loja atualizada com sucesso!');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRegenerarChaveLoja = async (empresaId: string, lojaId: string) => {
    if (!window.confirm('Tem certeza que deseja regenerar a chave de acesso? A chave antiga deixará de funcionar imediatamente.')) {
      return;
    }
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas/${lojaId}/regenerar-chave`, {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        alert(`Nova chave gerada com sucesso: ${data.chaveAcesso}`);
        carregarLojas(empresaId);
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao regenerar chave da loja');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteEmpresa = async (empresaId: string) => {
    if (!window.confirm('Tem certeza que deseja excluir esta empresa?')) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        carregarEmpresas();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao excluir empresa. Verifique se existem lojas cadastradas.');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteLoja = async (empresaId: string, lojaId: string) => {
    if (!window.confirm('Tem certeza que deseja excluir esta loja?')) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/empresas/${empresaId}/lojas/${lojaId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        carregarLojas(empresaId);
        carregarEmpresas();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao excluir loja');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  useEffect(() => {
    if (sessao?.tipo === 'admin') {
      carregarEmpresas();
    }
  }, [sessao]);

  const [isConnected, setIsConnected] = useState(false);
  const [allDeliveries, setAllDeliveries] = useState<Entrega[]>([]);
  const [allDrivers, setAllDrivers] = useState<Motorista[]>([]);
  // Feed de eventos do broker para o Centro de Operações (buffer rolante, filtrado/deduplicado).
  const [liveEvents, setLiveEvents] = useState<BrokerEvento[]>([]);
  // Coordenadas geográficas da loja recebidas em tempo real via system_status (independem da sessão em cache)
  const [lojaCoordsLive, setLojaCoordsLive] = useState<{ lat: number; lng: number } | null>(null);

  // Filtro de segurança (Multi-tenant) no frontend
  const tenantLojaId = sessao?.tipo === 'loja' 
    ? sessao.lojaId 
    : (sessao?.tipo === 'admin' && lojaVisualizada ? lojaVisualizada.id : undefined);

  const deliveries = tenantLojaId
    ? allDeliveries.filter(d => d.lojaId === tenantLojaId)
    : allDeliveries;

  const drivers = tenantLojaId
    ? allDrivers.filter(d => d.lojaId === tenantLojaId)
    : allDrivers;

  const currentLoja = tenantLojaId
    ? Object.values(lojasDaEmpresa).flat().find(l => l.id === tenantLojaId)
    : null;
  const isRecebePedidosEnabled = sessao?.tipo === 'loja'
    ? (sessao.recebePedidos || currentLoja?.recebePedidos || false)
    : (sessao?.tipo === 'admin' && lojaVisualizada ? (currentLoja?.recebePedidos || false) : false);

  // Estados de logs e webhooks removidos
  // Controle de interface do painel
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  
  // Controle de formulários
  const [clientName, setClientName] = useState('');
  const [clienteDocumento, setClienteDocumento] = useState('');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [bairro, setBairro] = useState('');
  const [cidade, setCidade] = useState('');
  const [referencia, setReferencia] = useState('');
  const [items, setItems] = useState('');
  const [priority, setPriority] = useState<'baixa' | 'media' | 'alta' | 'critica'>('media');
  const [cargoType, setCargoType] = useState<'normal' | 'expressa' | 'agendado'>('normal');
  const [formaPagamento, setFormaPagamento] = useState<'maquininha' | 'pix' | 'dinheiro'>('maquininha');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [valor, setValor] = useState('');
  const [driverId, setDriverId] = useState('');
  const [externalApiUrl, setExternalApiUrl] = useState(`${BACKEND_URL}/api/simulator/external-orders-api`);
  const [isSyncing, setIsSyncing] = useState(false);
  const [mapRoutesTrigger, setMapRoutesTrigger] = useState(0);
  const [isGeocoding, setIsGeocoding] = useState(false);

  // Estados para o FAB e Modal de Relatório
  const [fabOpen, setFabOpen] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [whatsappMessages, setWhatsappMessages] = useState<Array<{ sender: 'customer' | 'bot'; text: string; timestamp: string }>>([]);
  const [whatsappIsTyping, setWhatsappIsTyping] = useState(false);
  const [whatsappPhone, setWhatsappPhone] = useState('+55 (81) 99999-8888');
  const whatsappPhoneRef = useRef(whatsappPhone);

  useEffect(() => {
    whatsappPhoneRef.current = whatsappPhone;
  }, [whatsappPhone]);
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportPhase, setReportPhase] = useState<'filters' | 'view'>('filters');
  const [isGenerating, setIsGenerating] = useState(false);

  // Estados para Cadastro de Motoboy e Veículos
  const [vehicleTypes, setVehicleTypes] = useState<TipoVeiculo[]>([
    { id: 'drone', name: 'Drone' },
    { id: 'motorcycle', name: 'Motocicleta' },
    { id: 'van', name: 'Van' },
    { id: 'refrigerated_truck', name: 'Caminhão Refrigerado' }
  ]);
  const [showDriverModal, setShowDriverModal] = useState(false);
  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [newDriverName, setNewDriverName] = useState('');
  const [newDriverVehicleType, setNewDriverVehicleType] = useState('motorcycle');
  const [newVehicleName, setNewVehicleName] = useState('');
  
  // Parâmetros de filtro do relatório
  const [startDate, setStartDate] = useState(() => {
    // Padrão: 7 dias atrás
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [selectedDriverId, setSelectedDriverId] = useState('Todos');
  const [activeReportTab, setActiveReportTab] = useState<'fleet' | 'regions' | 'finance' | 'travel_time' | 'incidents'>('fleet');

  // Lógica de cálculo do relatório (mesclando histórico e entregas reais finalizadas)
  const mappedLivePerformance: DadoPerformanceHistorico[] = deliveries
    .filter(d => d.motorista && (d.status === 'ENTREGUE' || d.status === 'RECUSADO_INSUCESSO' || d.status === 'AGUARDANDO_RETORNO_CD' || d.status === 'PRODUTO_RETORNADO_ESTOQUE'))
    .map(d => {
      const isSuccess = d.status === 'ENTREGUE';
      let tempo = 15;
      if (d.criadoEm && d.atualizadoEm) {
        const diffMs = new Date(d.atualizadoEm).getTime() - new Date(d.criadoEm).getTime();
        tempo = Math.max(1, Math.round(diffMs / 60000));
      }
      return {
        id: d.id,
        data: d.criadoEm ? d.criadoEm.slice(0, 10) : new Date().toISOString().slice(0, 10),
        motoristaId: d.motorista!.id,
        motoristaName: d.motorista!.name,
        veiculo: d.motorista!.vehicleType as any,
        status: isSuccess ? 'sucesso' as const : 'cancelado' as const,
        tempoEntregaMin: tempo,
        valor: d.valor || 0,
        avaliacao: isSuccess ? 5 : 0,
        bairro: d.bairro || 'Sem Bairro',
        formaPagamento: d.formaPagamento,
        prioridade: d.prioridade,
        incidentesCount: d.incidentes ? d.incidentes.length : 0,
        incidentesTipos: d.incidentes ? d.incidentes.map(i => i.tipo) : [],
        romaneioId: d.romaneioId,
        despachadoEm: d.despachadoEm
      };
    });

  const allPerformanceData = [...HISTORICO_PERFORMANCE, ...mappedLivePerformance];

  const reportData = allPerformanceData.filter(item => {
    const matchDate = item.data >= startDate && item.data <= endDate;
    const matchDriver = selectedDriverId === 'Todos' || item.motoristaId === selectedDriverId;
    return matchDate && matchDriver;
  });

  const totalConcluidas = reportData.filter(d => d.status === 'sucesso').length;
  const totalCanceladas = reportData.filter(d => d.status === 'cancelado').length;
  const totalGeral = totalConcluidas + totalCanceladas;

  const tempoMedioSla = totalConcluidas > 0
    ? Math.round(reportData.filter(d => d.status === 'sucesso').reduce((acc, curr) => acc + curr.tempoEntregaMin, 0) / totalConcluidas)
    : 0;

  const taxaSucesso = totalGeral > 0
    ? Math.round((totalConcluidas / totalGeral) * 100)
    : 0;

  // Constrói a lista de motoristas do relatório:
  // 1. Motoristas ativos da frota (aparecem mesmo com 0 entregas no período)
  // 2. + Motoristas que aparecem nos dados mas não estão mais na frota (histórico ou excluídos)
  const driverReportMap = new Map<string, { id: string; name: string; veiculo: string }>();
  
  // Adiciona motoristas ativos
  drivers.forEach(drv => {
    driverReportMap.set(drv.id, { id: drv.id, name: drv.name, veiculo: drv.vehicleType });
  });
  
  // Adiciona motoristas que aparecem no reportData mas não estão na frota ativa
  reportData.forEach(d => {
    if (!driverReportMap.has(d.motoristaId)) {
      driverReportMap.set(d.motoristaId, { id: d.motoristaId, name: d.motoristaName, veiculo: d.veiculo });
    }
  });

  const motoristasPerformance = Array.from(driverReportMap.values()).map(drv => {
    const drvData = reportData.filter(d => d.motoristaId === drv.id);
    const concluidas = drvData.filter(d => d.status === 'sucesso').length;
    const canceladas = drvData.filter(d => d.status === 'cancelado').length;
    const faturamento = drvData.filter(d => d.status === 'sucesso').reduce((acc, curr) => acc + curr.valor, 0);
    const somaAvaliacoes = drvData.filter(d => d.status === 'sucesso').reduce((acc, curr) => acc + curr.avaliacao, 0);
    const avaliacaoMedia = concluidas > 0 ? (somaAvaliacoes / concluidas).toFixed(1) : '0.0';

    return {
      id: drv.id,
      name: drv.name,
      veiculo: drv.veiculo,
      concluidas,
      canceladas,
      faturamento,
      avaliacaoMedia
    };
  });

  const maxVolume = Math.max(...motoristasPerformance.map(m => Math.max(m.concluidas, m.canceladas)), 1);
  const chartWidth = Math.max(500, 100 + motoristasPerformance.length * 100);

  // 1. Regiões (Bairros)
  const bairrosMap = new Map<string, { total: number; sucesso: number; cancelado: number; faturamento: number }>();
  reportData.forEach(d => {
    const b = d.bairro || 'Sem Bairro';
    const current = bairrosMap.get(b) || { total: 0, sucesso: 0, cancelado: 0, faturamento: 0 };
    current.total += 1;
    if (d.status === 'sucesso') {
      current.sucesso += 1;
      current.faturamento += d.valor;
    } else {
      current.cancelado += 1;
    }
    bairrosMap.set(b, current);
  });
  const regioesPerformance = Array.from(bairrosMap.entries()).map(([bairro, metrics]) => ({
    bairro,
    ...metrics
  })).sort((a, b) => b.total - a.total);
  const maxRegionVolume = Math.max(...regioesPerformance.map(r => r.total), 1);

  // 2. Financeiro & SLAs
  const pagamentosMap = {
    pix: 0,
    maquininha: 0,
    dinheiro: 0
  };
  reportData.forEach(d => {
    if (d.status === 'sucesso' && d.formaPagamento) {
      const f = d.formaPagamento.toLowerCase();
      if (f === 'pix' || f === 'maquininha' || f === 'dinheiro') {
        pagamentosMap[f as keyof typeof pagamentosMap] += d.valor;
      }
    }
  });

  const prioridadesMap = new Map<string, { totalSucesso: number; totalTempo: number }>();
  ['baixa', 'media', 'alta', 'critica'].forEach(p => prioridadesMap.set(p, { totalSucesso: 0, totalTempo: 0 }));
  reportData.forEach(d => {
    if (d.status === 'sucesso' && d.prioridade) {
      const current = prioridadesMap.get(d.prioridade) || { totalSucesso: 0, totalTempo: 0 };
      current.totalSucesso += 1;
      current.totalTempo += d.tempoEntregaMin;
      prioridadesMap.set(d.prioridade, current);
    }
  });
  const prioridadesSla = Array.from(prioridadesMap.entries()).map(([prioridade, metrics]) => ({
    prioridade,
    slaMedio: metrics.totalSucesso > 0 ? Math.round(metrics.totalTempo / metrics.totalSucesso) : 0,
    totalSucesso: metrics.totalSucesso
  }));

  // 3. Tempo de Trajeto por Motoboy (Romaneios)
  const romaneiosMap = new Map<string, typeof reportData>();
  reportData.forEach(d => {
    if (d.romaneioId) {
      const list = romaneiosMap.get(d.romaneioId) || [];
      list.push(d);
      romaneiosMap.set(d.romaneioId, list);
    }
  });

  const romaneiosAnalise = Array.from(romaneiosMap.entries()).map(([romId, dels]) => {
    const firstDel = dels[0];
    const driverId = firstDel.motoristaId;
    const driverName = firstDel.motoristaName;
    const veiculo = firstDel.veiculo;
    const totalValue = dels.reduce((acc, curr) => acc + (curr.status === 'sucesso' ? curr.valor : 0), 0);
    const totalDels = dels.length;
    const concluidas = dels.filter(d => d.status === 'sucesso').length;
    
    // Encontra início e fim do trajeto
    const liveDeliveriesOfRom = deliveries.filter(ld => ld.romaneioId === romId);
    let startMs = 0;
    let endMs = 0;
    
    if (liveDeliveriesOfRom.length > 0) {
      const startTimes = liveDeliveriesOfRom.map(ld => ld.despachadoEm ? new Date(ld.despachadoEm).getTime() : new Date(ld.criadoEm).getTime());
      const endTimes = liveDeliveriesOfRom.map(ld => ld.dataHoraConclusao ? new Date(ld.dataHoraConclusao).getTime() : new Date(ld.atualizadoEm).getTime());
      startMs = Math.min(...startTimes);
      endMs = Math.max(...endTimes);
    } else {
      const dates = dels.map(d => new Date(d.data).getTime());
      startMs = Math.min(...dates);
      endMs = Math.max(...dates) + (15 * 60000); // 15 mins default
    }
    
    const tempoTrajetoMin = startMs > 0 && endMs >= startMs ? Math.max(1, Math.round((endMs - startMs) / 60000)) : 15;
    const allFinal = dels.every(d => d.status === 'sucesso' || d.status === 'cancelado');
    const romStatus = allFinal ? 'Concluído' : 'Em Trajeto';

    return {
      romId,
      driverId,
      driverName,
      veiculo,
      totalValue,
      totalDels,
      concluidas,
      tempoTrajetoMin,
      romStatus,
      horaInicio: startMs > 0 ? new Date(startMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
      horaFim: endMs > 0 && allFinal ? new Date(endMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--'
    };
  });

  const motoboyTrajetoMap = new Map<string, { totalRomaneios: number; totalTempo: number }>();
  romaneiosAnalise.forEach(r => {
    const current = motoboyTrajetoMap.get(r.driverId) || { totalRomaneios: 0, totalTempo: 0 };
    current.totalRomaneios += 1;
    current.totalTempo += r.tempoTrajetoMin;
    motoboyTrajetoMap.set(r.driverId, current);
  });

  const motoboysTrajeto = Array.from(motoboyTrajetoMap.entries()).map(([driverId, metrics]) => {
    const name = romaneiosAnalise.find(r => r.driverId === driverId)?.driverName || '';
    const veiculo = romaneiosAnalise.find(r => r.driverId === driverId)?.veiculo || '';
    return {
      driverId,
      name,
      veiculo,
      totalRomaneios: metrics.totalRomaneios,
      tempoMedioTrajeto: Math.round(metrics.totalTempo / metrics.totalRomaneios)
    };
  });

  // 4. Incidentes
  const incidentesTiposCount = {
    traffic_jam: 0,
    flat_tire: 0,
    temperature_spike: 0,
    route_deviation: 0,
    webhook_timeout: 0
  };
  reportData.forEach(d => {
    if (d.incidentesTipos) {
      d.incidentesTipos.forEach(t => {
        if (t in incidentesTiposCount) {
          incidentesTiposCount[t as keyof typeof incidentesTiposCount] += 1;
        }
      });
    }
  });
  const totalIncidentes = Object.values(incidentesTiposCount).reduce((a, b) => a + b, 0);

  const handleTriggerGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    setTimeout(() => {
      setIsGenerating(false);
      setReportPhase('view');
    }, 1200);
  };

  const handleShortcutFilter = (type: 'hoje' | '7dias' | 'esteMes') => {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (type === 'hoje') {
      setStartDate(todayStr);
      setEndDate(todayStr);
    } else if (type === '7dias') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      setStartDate(d.toISOString().slice(0, 10));
      setEndDate(todayStr);
    } else if (type === 'esteMes') {
      setStartDate('2026-05-01');
      setEndDate(todayStr);
    }
  };

  const formatarDataBR = (dateStr: string) => {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
  };

  const handleExportCSV = () => {
    let csvContent = `Relatório de Desempenho da Frota\r\n`;
    csvContent += `Período;${formatarDataBR(startDate)} até ${formatarDataBR(endDate)}\r\n`;
    csvContent += `Filtro Entregador;${selectedDriverId === 'Todos' ? 'Todos' : (motoristasPerformance.find(d => d.id === selectedDriverId)?.name || drivers.find(d => d.id === selectedDriverId)?.name || selectedDriverId)}\r\n`;
    csvContent += `Gerado em;${new Date().toLocaleString('pt-BR')}\r\n\r\n`;

    csvContent += `RESUMO DE PERFORMANCE DOS ENTREGADORES\r\n`;
    csvContent += `Entregador;Veículo;Concluídas;Canceladas;Faturamento (R$);Nota Média\r\n`;
    
    const filteredDrivers = motoristasPerformance.filter(m => selectedDriverId === 'Todos' || m.id === selectedDriverId);
    filteredDrivers.forEach(m => {
      const veiculoNome = m.veiculo === 'refrigerated_truck' ? 'Caminhão Refrigerado' : m.veiculo === 'motorcycle' ? 'Motocicleta' : m.veiculo === 'van' ? 'Van' : 'Drone';
      csvContent += `"${m.name}";"${veiculoNome}";${m.concluidas};${m.canceladas};"${m.faturamento.toFixed(2).replace('.', ',')}";"${m.avaliacaoMedia.replace('.', ',')}"\r\n`;
    });

    if (sessao?.tipo === 'loja') {
      csvContent += `\r\n`;
      csvContent += `ENTREGAS POR REGIÃO / BAIRRO\r\n`;
      csvContent += `Bairro;Total Comandas;Entregas Concluídas;Canceladas;Faturamento (R$)\r\n`;
      regioesPerformance.forEach(r => {
        csvContent += `"${r.bairro}";${r.total};${r.sucesso};${r.cancelado};"${r.faturamento.toFixed(2).replace('.', ',')}"\r\n`;
      });

      csvContent += `\r\n`;
      csvContent += `FATURAMENTO POR FORMA DE PAGAMENTO\r\n`;
      csvContent += `Forma de Pagamento;Faturamento (R$)\r\n`;
      csvContent += `Pix;"${pagamentosMap.pix.toFixed(2).replace('.', ',')}"\r\n`;
      csvContent += `Cartão (Maquininha);"${pagamentosMap.maquininha.toFixed(2).replace('.', ',')}"\r\n`;
      csvContent += `Dinheiro;"${pagamentosMap.dinheiro.toFixed(2).replace('.', ',')}"\r\n`;

      csvContent += `\r\n`;
      csvContent += `TEMPO MÉDIO DE SLA POR PRIORIDADE\r\n`;
      csvContent += `Prioridade;Tempo Médio (min);Quantidade Entregas\r\n`;
      prioridadesSla.forEach(p => {
        csvContent += `"${p.prioridade}";${p.slaMedio};${p.totalSucesso}\r\n`;
      });

      csvContent += `\r\n`;
      csvContent += `HISTÓRICO DE ROMANEIOS E TEMPO DE TRAJETO\r\n`;
      csvContent += `Código do Romaneio;Entregador;Qtd Comandas;Concluídas;Horário Início;Horário Fim;Tempo Trajeto (min);Faturamento (R$);Status\r\n`;
      romaneiosAnalise.forEach(r => {
        csvContent += `"${r.romId}";"${r.driverName}";${r.totalDels};${r.concluidas};"${r.horaInicio}";"${r.horaFim}";${r.tempoTrajetoMin};"${r.totalValue.toFixed(2).replace('.', ',')}";"${r.romStatus}"\r\n`;
      });

      csvContent += `\r\n`;
      csvContent += `EXCEÇÕES E INCIDENTES DE ROTA\r\n`;
      csvContent += `Tipo de Incidente;Ocorrências\r\n`;
      csvContent += `Trânsito Intenso;${incidentesTiposCount.traffic_jam}\r\n`;
      csvContent += `Problemas no Veículo;${incidentesTiposCount.flat_tire}\r\n`;
      csvContent += `Alerta de Temperatura;${incidentesTiposCount.temperature_spike}\r\n`;
      csvContent += `Desvios de Rota;${incidentesTiposCount.route_deviation}\r\n`;
    }

    csvContent += `\r\n`;
    csvContent += `DETALHAMENTO DAS ENTREGAS NO PERÍODO\r\n`;
    csvContent += `ID da Comanda;Data;Entregador;Veículo;Status;Tempo de Entrega (min);Valor (R$);Avaliação;Bairro;Forma Pagamento\r\n`;

    reportData.forEach(d => {
      const veiculoNome = d.veiculo === 'refrigerated_truck' ? 'Caminhão Refrigerado' : d.veiculo === 'motorcycle' ? 'Motocicleta' : d.veiculo === 'van' ? 'Van' : 'Drone';
      const statusFormatado = d.status === 'sucesso' ? 'Concluída' : 'Cancelada';
      csvContent += `"${d.id}";"${formatarDataBR(d.data)}";"${d.motoristaName}";"${veiculoNome}";"${statusFormatado}";${d.tempoEntregaMin};"${d.valor.toFixed(2).replace('.', ',')}";${d.avaliacao};"${d.bairro || ''}";"${d.formaPagamento || ''}"\r\n`;
    });

    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const fileName = `relatorio_desempenho_${startDate}_a_${endDate}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleVincularDriverMobile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driverPinInput.trim()) {
      alert('Por favor, digite o PIN de pareamento.');
      return;
    }

    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (sessao?.token) {
        headers['Authorization'] = `Bearer ${sessao.token}`;
      }

      const res = await fetch(`${BACKEND_URL}/api/drivers/vincular`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ codigoVinculo: driverPinInput.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Código de pareamento inválido ou motoboy não cadastrado');
      }

      if (data.success && data.driver) {
        const motorista = data.driver;
        setDriverMobileVinculado(motorista);
        localStorage.setItem('distre_driver_mobile', JSON.stringify(motorista));
        setDriverPinInput('');

        // Se o motorista já possuir uma coordenada salva no backend ou se for a inicial (10, 10)
        const initialLoc = motorista.localizacaoAtual || { x: 10, y: 10 };
        setDriverLocation(initialLoc);

        alert(`Aparelho vinculado ao entregador ${motorista.name}!`);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDesvincularDriverMobile = () => {
    if (!window.confirm('Tem certeza que deseja desvincular este dispositivo do entregador?')) {
      return;
    }
    
    // Para limpar o registro no backend, a gente força uma desconexão e reconexão do socketRef
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }

    setDriverMobileVinculado(null);
    setDriverLocation(null);
    localStorage.removeItem('distre_driver_mobile');
    localStorage.removeItem('distre_driver_location');
  };

  const handleMoverGpsSimulado = (direction: 'N' | 'S' | 'L' | 'O') => {
    if (!driverMobileVinculado || !driverLocation) return;

    let { x, y } = driverLocation;
    const step = 5;

    switch (direction) {
      case 'N':
        y = Math.max(0, y - step);
        break;
      case 'S':
        y = Math.min(100, y + step);
        break;
      case 'L':
        x = Math.min(100, x + step);
        break;
      case 'O':
        x = Math.max(0, x - step);
        break;
    }

    setDriverLocation({ x, y });
  };

  const handleSubmitDriver = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDriverName.trim()) return;

    apiFetch(`${BACKEND_URL}/api/drivers`, {
      method: 'POST',
      body: JSON.stringify({
        name: newDriverName,
        vehicleType: newDriverVehicleType
      })
    })
      .then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // 403 PLAN_LIMIT_REACHED: surface a mensagem de limite+upgrade do backend.
          throw new Error(data.error || 'Erro ao cadastrar motoboy');
        }
        return res.json();
      })
      .then(() => {
        setNewDriverName('');
        setShowDriverModal(false);
      })
      .catch(err => alert(err.message));
  };

  const handleDeleteDriver = (id: string) => {
    apiFetch(`${BACKEND_URL}/api/drivers/${id}`, {
      method: 'DELETE'
    })
      .then(res => {
        if (!res.ok) {
          return res.json().then(data => {
            throw new Error(data.error || 'Erro ao remover motoboy');
          });
        }
        return res.json();
      })
      .catch(err => alert(err.message));
  };

  const handleSubmitVehicle = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVehicleName.trim()) return;

    apiFetch(`${BACKEND_URL}/api/vehicle-types`, {
      method: 'POST',
      body: JSON.stringify({ name: newVehicleName })
    })
      .then(res => {
        if (!res.ok) throw new Error('Tipo de veículo já cadastrado ou inválido');
        return res.json();
      })
      .then(newType => {
        setVehicleTypes(prev => [...prev, newType]);
        setNewDriverVehicleType(newType.id);
        setNewVehicleName('');
        setShowVehicleModal(false);
      })
      .catch(err => alert(err.message));
  };

  // Controle de incidentes
  const [incidentType, setIncidentType] = useState<string>('traffic_jam');
  const [incidentDesc, setIncidentDesc] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<'aviso' | 'critico'>('aviso');

  // Controle do Simulador Mobile (Edge Offline Sync)
  const [offlineMode, setOfflineMode] = useState(false);
  const [actionQueue, setActionQueue] = useState<AcaoFilaSincronia[]>([]);
  
  // Dados obrigatórios do formulário POD no celular
  const [recebedorNome, setRecebedorNome] = useState('');
  const [failReason, setFailReason] = useState('01 - Cliente Ausente (3 tentativas de contato)');
  
  // Geofencing override
  const [requestJustification, setRequestJustification] = useState(false);
  const [justificationText, setJustificationText] = useState('');

  const socketRef = useRef<Socket | null>(null);

  // Leaflet Map & Layer Refs
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const hubMarkerRef = useRef<any>(null);
  const destinationMarkersRef = useRef<Map<string, any>>(new Map());
  const vehicleMarkersRef = useRef<Map<string, any>>(new Map());
  const routeLinesRef = useRef<Map<string, any>>(new Map());

  // Romaneio e Impressão Térmica
  const [selectedForManifest, setSelectedForManifest] = useState<string[]>([]);
  const [activeManifest, setActiveManifest] = useState<{ id: string; deliveryIds: string[]; driverName: string; driverId: string; totalValue: number } | null>(null);
  const [showThermalReceipt, setShowThermalReceipt] = useState(false);

  const getDeliveryValue = (d: Entrega) => {
    if (d.valor !== undefined && d.valor !== null) return d.valor;
    return ((d.id.charCodeAt(d.id.length - 1) || 0) * 3 % 100) + 25.50;
  };

  // ===== Impressão automática de comanda (80mm térmica) =====
  // Modo configurável por loja (persistido em localStorage):
  //  - 'impressora': abre a comanda 80mm e dispara window.print() (vai p/ impressora
  //    padrão; sai silencioso se o Chrome estiver com --kiosk-printing + 80mm como padrão)
  //  - 'pdf': abre o documento 80mm numa aba para salvar/visualizar como PDF
  //  - 'off': não imprime automaticamente
  type ModoImpressaoComanda = 'impressora' | 'pdf' | 'off';
  const [comandaPrintMode, setComandaPrintMode] = useState<ModoImpressaoComanda>(() => {
    try { return (localStorage.getItem('distre_comanda_print_mode') as ModoImpressaoComanda) || 'impressora'; }
    catch { return 'impressora'; }
  });
  const alterarModoImpressao = (m: ModoImpressaoComanda) => {
    setComandaPrintMode(m);
    try { localStorage.setItem('distre_comanda_print_mode', m); } catch { /* ignore */ }
  };

  const imprimirComandaTicket = (e: Entrega, modo: ModoImpressaoComanda) => {
    if (modo === 'off') return;
    const lojaNome = sessao?.nomeLoja || lojaVisualizada?.nome || 'DISTRE';
    const valor = getDeliveryValue(e);
    const itens = (e.itens && e.itens.length) ? e.itens : [];
    const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
    const win = window.open('', `COMANDA_${e.id}`, 'width=400,height=700');
    if (!win) { alert('Permita pop-ups para imprimir/abrir a comanda.'); return; }
    const linhasItens = itens.length
      ? itens.map(i => `<div class="row"><span class="it">${esc(i)}</span></div>`).join('')
      : '<div class="muted">Sem itens detalhados</div>';
    win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comanda ${esc(e.id)}</title>
      <style>
        @page { size: 80mm auto; margin: 0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { width: 80mm; padding: 4mm 3mm; font-family: 'Courier New', monospace; color: #000; background: #fff; font-size: 12px; line-height: 1.35; }
        .center { text-align: center; } .b { font-weight: 700; } .xl { font-size: 18px; }
        .row { display: flex; justify-content: space-between; gap: 6px; }
        .it { flex: 1; } .muted { color: #444; font-style: italic; }
        .sep { border-top: 1px dashed #000; margin: 6px 0; }
        .sep-solid { border-top: 2px solid #000; margin: 6px 0; }
        .total { font-size: 15px; font-weight: 700; }
        .noprint { margin-top: 14px; text-align: center; }
        .noprint button { font: inherit; padding: 8px 14px; cursor: pointer; }
        @media print { .noprint { display: none; } }
      </style></head><body>
        <div class="center b xl">${esc(lojaNome)}</div>
        <div class="center">COMANDA DE PEDIDO</div>
        <div class="sep-solid"></div>
        <div class="row"><span>COMANDA:</span><span class="b">${esc(e.id)}</span></div>
        <div class="row"><span>DATA/HORA:</span><span>${new Date().toLocaleString('pt-BR')}</span></div>
        ${e.formaPagamento ? `<div class="row"><span>PAGAMENTO:</span><span>${esc(String(e.formaPagamento).toUpperCase())}</span></div>` : ''}
        <div class="sep"></div>
        <div class="b">CLIENTE</div>
        <div>${esc(e.nomeCliente)}</div>
        ${e.clienteDocumento ? `<div>CPF/CNPJ: ${esc(e.clienteDocumento)}</div>` : ''}
        <div class="sep"></div>
        <div class="b">ENTREGA</div>
        <div>${esc(e.endereco)}</div>
        ${e.bairro ? `<div>Bairro: ${esc(e.bairro)}</div>` : ''}
        ${e.cidade ? `<div>Cidade: ${esc(e.cidade)}</div>` : ''}
        ${e.referencia ? `<div>Ref: ${esc(e.referencia)}</div>` : ''}
        <div class="sep"></div>
        <div class="b">ITENS</div>
        ${linhasItens}
        <div class="sep-solid"></div>
        <div class="row total"><span>TOTAL:</span><span>R$ ${valor.toFixed(2)}</span></div>
        <div class="sep"></div>
        <div class="center">Distre - Gestao de Entregas</div>
        <div class="noprint"><button onclick="window.print()">Imprimir / Salvar PDF</button></div>
      </body></html>`);
    win.document.close();
    if (modo === 'impressora') {
      win.focus();
      setTimeout(() => { try { win.print(); } catch { /* ignore */ } }, 400);
    }
  };

  // Detecta novos pedidos na fila e imprime a comanda automaticamente.
  const comandasImpressasRef = useRef<Set<string>>(new Set());
  const printInitRef = useRef(false);
  useEffect(() => {
    const pedidosRecebidos = deliveries.filter(d => d.tipoComanda === 'pedido' && d.status === 'RECEBIDO');
    // Na 1ª carga, marca o backlog como "já visto" para não imprimir pedidos antigos de uma vez.
    if (!printInitRef.current) {
      pedidosRecebidos.forEach(d => comandasImpressasRef.current.add(d.id));
      printInitRef.current = true;
      return;
    }
    // Só auto-imprime no contexto operacional da própria loja (não no admin observando).
    if (comandaPrintMode === 'off' || sessao?.tipo !== 'loja') return;
    pedidosRecebidos
      .filter(d => !comandasImpressasRef.current.has(d.id))
      .forEach(d => {
        comandasImpressasRef.current.add(d.id);
        imprimirComandaTicket(d, comandaPrintMode);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveries, comandaPrintMode]);

  // Buffer de telemetria GPS quando estiver offline
  useEffect(() => {
    if (!offlineMode) return;
    const interval = setInterval(() => {
      setAllDeliveries(prev => {
        prev.forEach(d => {
          if (d.status === 'EM_TRANSITO' && d.telemetria) {
            const key = `offline_gps_${d.id}`;
            const existing = localStorage.getItem(key);
            const coords = existing ? JSON.parse(existing) : [];
            coords.push({
              x: d.telemetria.localizacaoAtual.x,
              y: d.telemetria.localizacaoAtual.y,
              velocidade: d.telemetria.velocidadeKmh,
              bateria: d.telemetria.combustivelBateriaPct,
              timestamp: new Date().toISOString()
            });
            localStorage.setItem(key, JSON.stringify(coords));
          }
        });
        return prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [offlineMode]);

  const offlineModeRef = useRef(offlineMode);
  const actionQueueRef = useRef(actionQueue);

  // Carrega configurações de despacho
  useEffect(() => {
    offlineModeRef.current = offlineMode;
  }, [offlineMode]);

  // Salva a localização do motorista em tempo real no localStorage
  useEffect(() => {
    if (driverLocation) {
      localStorage.setItem('distre_driver_location', JSON.stringify(driverLocation));
    } else {
      localStorage.removeItem('distre_driver_location');
    }
  }, [driverLocation]);

  // Sincroniza a conexão e registro do motorista pelo socket
  useEffect(() => {
    if (socketRef.current && socketRef.current.connected && driverMobileVinculado) {
      // Registra o aparelho
      socketRef.current.emit('driver_register', { driverId: driverMobileVinculado.id });
      
      // Envia a coordenada GPS atual do aparelho se não estiver em modo offline
      if (driverLocation && !offlineMode) {
        socketRef.current.emit('driver_gps_update', {
          driverId: driverMobileVinculado.id,
          x: driverLocation.x,
          y: driverLocation.y
        });
      }
    }
  }, [driverMobileVinculado, driverLocation, offlineMode, isConnected]);

  useEffect(() => {
    actionQueueRef.current = actionQueue;
  }, [actionQueue]);

  useEffect(() => {
    // Carrega fila de sincronização salva localmente se houver
    const savedQueue = localStorage.getItem('actionQueue');
    if (savedQueue) {
      setActionQueue(JSON.parse(savedQueue));
    }

    if (!sessao) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setIsConnected(false);
      setAllDeliveries([]);
      setAllDrivers([]);
      setLiveEvents([]);
      return;
    }

    // Carregar tipos de veículos do backend usando apiFetch
    apiFetch(`${BACKEND_URL}/api/vehicle-types`)
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Erro ao buscar tipos de veículos');
      })
      .then(data => {
        if (Array.isArray(data)) setVehicleTypes(data);
      })
      .catch(err => console.error('[API] Falha ao obter tipos de veículos:', err));

    // Conecta ao backend Socket.io passando o token (BACKEND_URL vazio = mesma origem)
    const socket = io(BACKEND_URL || undefined, {
      auth: {
        token: sessao.token
      }
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('session_expired', () => {
      console.warn('[Socket] Sessão expirou ou o servidor reiniciou. Forçando logout...');
      handleLogout();
    });

    socket.on('initial_state', (data: any) => {
      setAllDeliveries(data.deliveries);
      setAllDrivers(data.drivers);
      // Logs de eventos e webhooks não são mais salvos no estado
    });

    socket.on('system_status', (data: any) => {
      const syncedDeliveries = data.deliveries as Entrega[];
      const nextDeliveries = syncedDeliveries.map(d => {
        const offlineAction = actionQueueRef.current.find(a => a.entregaId === d.id);
        if (offlineAction && offlineModeRef.current) {
          let statusOpt = d.status;
          if (offlineAction.acao === 'concluir') {
            statusOpt = 'ENTREGUE';
          } else if (offlineAction.acao === 'falhar') {
            statusOpt = 'AGUARDANDO_RETORNO_CD';
          } else if (offlineAction.acao === 'chegar') {
            statusOpt = 'NO_LOCAL';
          }
          return {
            ...d,
            status: statusOpt,
            recebedorNome: offlineAction.recebedorNome,
            recebedorCPF: offlineAction.recebedorCPF,
            justificativaDesvioCoordenada: offlineAction.justificativaDesvioCoordenada
          };
        }
        return d;
      });
      setAllDeliveries(nextDeliveries);
      setAllDrivers(data.drivers);
      if (typeof data.lojaLat === 'number' && typeof data.lojaLng === 'number') {
        setLojaCoordsLive(prev => {
          if (prev && prev.lat === data.lojaLat && prev.lng === data.lojaLng) return prev;
          return { lat: data.lojaLat, lng: data.lojaLng };
        });
      }
      // Webhooks recebidos não são mais salvos no estado
    });

    // Eventos do broker → feed do "Centro de Operações" (buffer rolante, filtra ruído).
    socket.on('broker_event', (data: any) => {
      const ev = data?.event as BrokerEvento | undefined;
      if (!ev || !ev.topic) return;
      if (ev.topic === 'GPS_HEARTBEAT') return; // telemetria de alta frequência: descarta
      if (ev.topic === 'entrega.monitorada') {
        const s = ev.payload?.status;
        const relevante = s === 'ENTREGUE' || s === 'NO_LOCAL' || s === 'RECUSADO_INSUCESSO' || s === 'AGUARDANDO_RETORNO_CD' || s === 'PRODUTO_RETORNADO_ESTOQUE';
        if (!relevante) return; // ignora updates contínuos de EM_TRANSITO/telemetria
      }
      setLiveEvents(prev => {
        const last = prev[0];
        const sig = `${ev.topic}|${ev.deliveryId}|${ev.payload?.status ?? ''}`;
        const lastSig = last ? `${last.topic}|${last.deliveryId}|${last.payload?.status ?? ''}` : '';
        if (sig === lastSig) return prev; // dedupe de publicações consecutivas idênticas
        return [ev, ...prev].slice(0, 40);
      });
    });

    // ---- Listeners do Simulador de WhatsApp ----
    socket.on('whatsapp_msg_received', (data: { phone: string; sender: 'customer' | 'bot'; text: string; timestamp: string }) => {
      if (data.sender === 'bot') {
        // A mensagem do bot já foi adicionada otimisticamente (customer side) — só adicionamos a resposta do bot
        setWhatsappMessages(prev => [...prev, { sender: 'bot', text: data.text, timestamp: data.timestamp }]);
      }
    });

    socket.on('whatsapp_typing', (data: { phone: string; isTyping: boolean }) => {
      setWhatsappIsTyping(data.isTyping);
    });

    return () => {
      socket.disconnect();
    };
  }, [sessao]);

  // Persiste a fila local
  useEffect(() => {
    localStorage.setItem('actionQueue', JSON.stringify(actionQueue));
  }, [actionQueue]);

  // Executa sincronização quando voltar a ficar online
  useEffect(() => {
    if (!offlineMode && actionQueue.length > 0) {
      syncOfflineQueue();
    }
  }, [offlineMode]);

  // ---- Função helper para enviar mensagens ao bot WhatsApp via socket ----
  const [whatsappInput, setWhatsappInput] = useState('');
  const whatsappMessagesEndRef = useRef<HTMLDivElement>(null);

  const sendWhatsappMessage = (text: string) => {
    const msg = text.trim() || whatsappInput.trim();
    if (!msg || !socketRef.current) return;

    const lojaId = sessao?.lojaId || sessao?.tipo === 'admin' ? 'admin' : '';
    const phone = whatsappPhoneRef.current;
    const timestamp = new Date().toISOString();

    // Adiciona a mensagem do usuário otimisticamente na UI
    setWhatsappMessages(prev => [...prev, { sender: 'customer', text: msg, timestamp }]);
    setWhatsappInput('');

    // Envia para o backend via socket
    socketRef.current.emit('whatsapp_send_msg', { phone, text: msg, lojaId });
  };

  const clearWhatsappHistory = () => {
    setWhatsappMessages([]);
    setWhatsappIsTyping(false);
  };

  // Auto-scroll para o final do chat quando novas mensagens chegam
  useEffect(() => {
    if (whatsappOpen && whatsappMessagesEndRef.current) {
      whatsappMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [whatsappMessages, whatsappIsTyping, whatsappOpen]);



  const syncOfflineQueue = async () => {
    console.log('[Offline Sync] Iniciando outbox flush de ações acumuladas...', actionQueue);
    const queueToProcess = [...actionQueue];
    
    for (const action of queueToProcess) {
      try {
        // 1. Sincroniza primeiro o buffer de coordenadas GPS offline em lote (bulk) se houver
        const gpsKey = `offline_gps_${action.entregaId}`;
        const cachedGps = localStorage.getItem(gpsKey);
        if (cachedGps) {
          const coordenadas = JSON.parse(cachedGps);
          await apiFetch(`${BACKEND_URL}/api/deliveries/${action.entregaId}/telemetria-bulk`, {
            method: 'POST',
            body: JSON.stringify({ coordenadas })
          });
          localStorage.removeItem(gpsKey);
        }

         // 2. Sincroniza a ação (POD/Insucesso/Chegada)
        let endpoint = '';
        let payload = {};
        
        if (action.acao === 'concluir') {
          endpoint = 'complete';
          payload = {
            recebedorNome: action.recebedorNome,
            recebedorCPF: action.recebedorCPF,
            comprovanteFotoUrl: action.comprovanteFotoUrl,
            assinaturaBase64: action.assinaturaBase64,
            justificativaDesvioCoordenada: action.justificativaDesvioCoordenada
          };
        } else if (action.acao === 'falhar') {
          endpoint = 'fail';
          payload = {
            motivoInsucesso: action.motivoInsucesso
          };
        } else if (action.acao === 'chegar') {
          endpoint = 'arrive';
          payload = {};
        }

        const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${action.entregaId}/${endpoint}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        
        if (response.ok) {
          setActionQueue(prev => prev.filter(item => item.id !== action.id));
        }
      } catch (err) {
        console.error(`[Offline Sync] Falha ao esvaziar outbox da ação ${action.id}:`, err);
        break;
      }
    }
  };

  // Coordenadas reais da loja atual (resolvidas via Nominatim no backend a partir do endereço).
  // Ordem de prioridade:
  //   1. lojaCoordsLive — vem em tempo real pelo system_status (cobre backfill e edição de endereço sem precisar relogar)
  //   2. currentLoja (admin observando uma loja) ou sessao (usuário-loja logado)
  //   3. Fallback: ponto fixo da grade (10,10) dentro do bounding box padrão da cidade
  const lojaLat =
    lojaCoordsLive?.lat ??
    (sessao?.tipo === 'loja' ? sessao.latitude : currentLoja?.latitude);
  const lojaLng =
    lojaCoordsLive?.lng ??
    (sessao?.tipo === 'loja' ? sessao.longitude : currentLoja?.longitude);
  const hubLatLng: [number, number] =
    typeof lojaLat === 'number' && typeof lojaLng === 'number'
      ? [lojaLat, lojaLng]
      : gridToLatLng(10, 10);

  // Recentraliza o mapa quando as coordenadas reais da loja chegarem (ou mudarem após edição).
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    if (typeof lojaLat !== 'number' || typeof lojaLng !== 'number') return;
    map.setView([lojaLat, lojaLng], map.getZoom());
  }, [lojaLat, lojaLng]);

  // 1. Inicialização do Mapa Leaflet
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (leafletMapRef.current) return; // já inicializado

    
    // Inicializa o mapa com zoom ajustado
    const map = L.map(mapContainerRef.current, {
      center: hubLatLng,
      zoom: 14,
      zoomControl: false,
      attributionControl: false
    });

    // Botões de zoom no canto superior direito para não poluir
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Tile Layer claro estilo Waze (CartoDB Voyager) — vias e POIs em tema claro.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20
    }).addTo(map);

    leafletMapRef.current = map;

    // Marcador do Hub (Loja) com divIcon customizado
    const hubIcon = L.divIcon({
      className: 'hub-icon-wrapper',
      html: hubIconHtml(hubName),
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });

    hubMarkerRef.current = L.marker(hubLatLng, { icon: hubIcon }).addTo(map);

    return () => {
      // Limpa tudo ao desmontar
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
        hubMarkerRef.current = null;
        destinationMarkersRef.current.clear();
        vehicleMarkersRef.current.clear();
        routeLinesRef.current.clear();
      }
    };
  }, [!!mapContainerRef.current]);

  // 2. Sincronização dos Marcadores, Polylines e Veículos no Leaflet
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;

    // A. Atualizar marcador do Hub com o nome da loja dinâmico
    if (hubMarkerRef.current) {
      const hubIcon = L.divIcon({
        className: 'hub-icon-wrapper',
        html: hubIconHtml(hubName),
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });
      hubMarkerRef.current.setLatLng(hubLatLng);
      hubMarkerRef.current.setIcon(hubIcon);
    }

    // Filtra comandas ativas
    const activeDels = deliveries.filter(
      d => d.status === 'EM_TRANSITO' || d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA' || d.status === 'NO_LOCAL'
    );

    // B. Sincronizar Destinos
    const currentDestKeys = new Set<string>();
    activeDels.forEach(d => {
      if (!d.rota?.path) return;
      const endNode = d.rota.path[d.rota.path.length - 1];
      // Prefere as coordenadas reais geocodificadas do endereço do cliente.
      // Se não houver (entrega legada ou geocoder falhou), cai no ponto sintético da grade.
      const endLatLng: [number, number] =
        typeof d.destinoLatitude === 'number' && typeof d.destinoLongitude === 'number'
          ? [d.destinoLatitude, d.destinoLongitude]
          : gridToLatLng(endNode.x, endNode.y);
      const isSkipped = d.incidentes?.some(i => i.tipo === 'route_deviation' && i.descricao.includes('AlertaDesvioSequencia'));
      const hasArrived = d.status === 'NO_LOCAL';

      const key = d.id;
      currentDestKeys.add(key);

      const isSelectedDest = d.id === selectedDeliveryId;
      const destIcon = L.divIcon({
        className: 'dest-icon-wrapper',
        html: `<div class="map-destination ${hasArrived ? 'arrived' : ''} ${isSkipped ? 'skipped' : ''} ${isSelectedDest ? 'selected' : ''}" style="position: absolute; transform: translate(-50%, -50%); left: 0; top: 0;" title="Destino da Entrega ${d.id}"><div class="dest-label">${d.id}</div></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });

      if (destinationMarkersRef.current.has(key)) {
        const marker = destinationMarkersRef.current.get(key);
        marker.setLatLng(endLatLng);
        marker.setIcon(destIcon);
      } else {
        const marker = L.marker(endLatLng, { icon: destIcon }).addTo(map);
        marker.on('click', () => setSelectedDeliveryId(d.id));
        destinationMarkersRef.current.set(key, marker);
      }
    });

    // Remover destinos inativos do mapa
    destinationMarkersRef.current.forEach((marker, key) => {
      if (!currentDestKeys.has(key)) {
        map.removeLayer(marker);
        destinationMarkersRef.current.delete(key);
      }
    });

    // C. Sincronizar Polylines (Rotas OSRM com cache)
    const currentRouteKeys = new Set<string>();
    activeDels.forEach(d => {
      if (!d.rota?.path) return;
      const key = d.id;
      currentRouteKeys.add(key);

      const startLatLng = hubLatLng;
      const endNode = d.rota.path[d.rota.path.length - 1];
      const endLatLng: [number, number] =
        typeof d.destinoLatitude === 'number' && typeof d.destinoLongitude === 'number'
          ? [d.destinoLatitude, d.destinoLongitude]
          : gridToLatLng(endNode.x, endNode.y);

      const cacheKey = `${d.id}-${hubLatLng[0].toFixed(5)}-${hubLatLng[1].toFixed(5)}-${endLatLng[0].toFixed(5)}-${endLatLng[1].toFixed(5)}`;
      const isSelected = d.id === selectedDeliveryId;
      const hasIncident = d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA';

      // Estilo Waze em tiles claros: rota selecionada em azul vivo, grossa e sólida;
      // as demais finas, mais claras e tracejadas. Incidente em vermelho.
      const color = isSelected
        ? '#1a73e8'
        : hasIncident
        ? '#f43f5e'
        : '#5b8def';
      const opacity = isSelected ? 0.95 : 0.5;
      const weight = isSelected ? 6 : 3;
      const dashArray = isSelected ? null : '6, 8';

      const drawPolyline = (latlngs: [number, number][]) => {
        if (routeLinesRef.current.has(key)) {
          const polyline = routeLinesRef.current.get(key);
          polyline.setLatLngs(latlngs);
          polyline.setStyle({ color, opacity, weight, dashArray });
        } else {
          const polyline = L.polyline(latlngs, {
            color,
            opacity,
            weight,
            dashArray,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(map);
          routeLinesRef.current.set(key, polyline);
        }
      };

      if (osrmRoutesCache.has(cacheKey)) {
        drawPolyline(osrmRoutesCache.get(cacheKey)!);
      } else {
        // Fallback linear provisório enquanto carrega
        osrmRoutesCache.set(cacheKey, [startLatLng, endLatLng]);
        drawPolyline([startLatLng, endLatLng]);

        // Carrega rota real no OSRM de forma assíncrona
        fetch(`https://router.project-osrm.org/route/v1/driving/${startLatLng[1]},${startLatLng[0]};${endLatLng[1]},${endLatLng[0]}?overview=full&geometries=geojson`)
          .then(res => res.json())
          .then(data => {
            if (data.code === 'Ok' && data.routes && data.routes[0]) {
              const coordinates = data.routes[0].geometry.coordinates; // [[lng, lat], ...]
              const latlngs = coordinates.map((coord: any) => [coord[1], coord[0]] as [number, number]);
              osrmRoutesCache.set(cacheKey, latlngs);
              setMapRoutesTrigger(prev => prev + 1);
            }
          })
          .catch(err => console.error('Erro ao buscar rota no OSRM:', err));
      }
    });

    // Remover polylines inativas
    routeLinesRef.current.forEach((polyline, key) => {
      if (!currentRouteKeys.has(key)) {
        map.removeLayer(polyline);
        routeLinesRef.current.delete(key);
      }
    });

    // D. Sincronizar Veículos
    const currentVehKeys = new Set<string>();

    // D1. Veículos simulados locais (sem celular pareado)
    const simulatedDels = activeDels.filter(d => {
      if (!d.telemetria) return false;
      const motoristaConectado = drivers.some(
        drv => drv.id === d.motorista?.id && drv.dispositivoConectado && drv.localizacaoAtual
      );
      return !motoristaConectado;
    });

    simulatedDels.forEach(d => {
      if (!d.telemetria) return;
      const key = `sim-${d.id}`;
      currentVehKeys.add(key);

      const loc = d.telemetria.localizacaoAtual;
      const latlng = gridToLatLng(loc.x, loc.y);
      const isSelected = selectedDeliveryId === d.id;
      const hasIncident = d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA';
      const hasArrived = d.status === 'NO_LOCAL';
      const isStale = d.incidentes?.some(
        i => i.tipo === 'route_deviation' && i.descricao.includes('AlertaParadaProlongada')
      );

      let vehClass = 'map-vehicle';
      if (isSelected) vehClass += ' selected';
      if (hasIncident) vehClass += ' incident_alert';
      if (hasArrived) vehClass += ' arrived';
      if (isStale) vehClass += ' stale-driver';

      const iconHtml = `
        <div class="${vehClass}" style="position: absolute; transform: translate(-50%, -50%); left: 0; top: 0; cursor: pointer;">
          <span style="display: flex; align-items: center; justify-content: center;">
            ${getVehicleIconHtmlString(d.motorista?.vehicleType)}
          </span>
          <div class="vehicle-label">${d.id}</div>
        </div>
      `;

      const vehIcon = L.divIcon({
        className: 'veh-icon-wrapper',
        html: iconHtml,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });

      if (vehicleMarkersRef.current.has(key)) {
        const marker = vehicleMarkersRef.current.get(key);
        marker.setLatLng(latlng);
        marker.setIcon(vehIcon);
      } else {
        const marker = L.marker(latlng, { icon: vehIcon }).addTo(map);
        marker.on('click', () => setSelectedDeliveryId(d.id));
        vehicleMarkersRef.current.set(key, marker);
      }
    });

    // D2. Veículos online reais (dispositivo móvel pareado)
    const connectedDrivers = drivers.filter(d => d.dispositivoConectado && d.localizacaoAtual);
    connectedDrivers.forEach(d => {
      const key = `conn-${d.id}`;
      currentVehKeys.add(key);

      const loc = d.localizacaoAtual!;
      const latlng = gridToLatLng(loc.x, loc.y);
      const isSelected = driverMobileVinculado?.id === d.id;
      const entregaAtiva = deliveries.find(
        del => del.motorista?.id === d.id && 
        (del.status === 'EM_TRANSITO' || del.status === 'ALERTA_INCIDENTE' || del.status === 'SLA_ALERTA' || del.status === 'NO_LOCAL')
      );

      let vehClass = 'map-vehicle';
      if (isSelected) vehClass += ' selected';

      const labelText = `${d.name.split(' ')[0]} ${entregaAtiva ? `(${entregaAtiva.id})` : ''}`;

      const iconHtml = `
        <div class="${vehClass}" style="position: absolute; transform: translate(-50%, -50%); left: 0; top: 0; border-color: var(--color-emerald); box-shadow: 0 0 12px var(--color-emerald); z-index: 25; cursor: pointer;">
          <span style="color: var(--color-emerald); display: flex; align-items: center; justify-content: center;">
            ${getVehicleIconHtmlString(d.vehicleType)}
          </span>
          <div class="vehicle-label" style="background-color: #064e3b; color: #34d399; border: 1px solid #059669; padding: 0.05rem 0.2rem; border-radius: 4px; white-space: nowrap;">
            ${labelText}
          </div>
        </div>
      `;

      const vehIcon = L.divIcon({
        className: 'veh-icon-wrapper',
        html: iconHtml,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });

      if (vehicleMarkersRef.current.has(key)) {
        const marker = vehicleMarkersRef.current.get(key);
        marker.setLatLng(latlng);
        marker.setIcon(vehIcon);
      } else {
        const marker = L.marker(latlng, { icon: vehIcon }).addTo(map);
        marker.on('click', () => {
          if (entregaAtiva) {
            setSelectedDeliveryId(entregaAtiva.id);
          }
        });
        vehicleMarkersRef.current.set(key, marker);
      }
    });

    // Remover marcadores de veículos antigos
    vehicleMarkersRef.current.forEach((marker, key) => {
      if (!currentVehKeys.has(key)) {
        map.removeLayer(marker);
        vehicleMarkersRef.current.delete(key);
      }
    });

  }, [deliveries, drivers, selectedDeliveryId, driverMobileVinculado, hubName, mapRoutesTrigger]);

  // Foco automático: ao clicar/selecionar uma comanda, enquadra o mapa na entrega
  // daquele motoboy (loja → posição do motoboy → destino), revelando o trajeto e o
  // destino. Reage só à MUDANÇA de seleção (não a cada tick), para o mapa não "pular".
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map || !selectedDeliveryId) return;
    const d = deliveries.find(x => x.id === selectedDeliveryId);
    if (!d) return;

    const pts: [number, number][] = [hubLatLng];
    if (typeof d.destinoLatitude === 'number' && typeof d.destinoLongitude === 'number') {
      pts.push([d.destinoLatitude, d.destinoLongitude]);
    } else if (d.rota?.path?.length) {
      const n = d.rota.path[d.rota.path.length - 1];
      pts.push(gridToLatLng(n.x, n.y));
    }
    const drv = drivers.find(v => v.id === d.motorista?.id && v.localizacaoAtual);
    if (drv?.localizacaoAtual) {
      pts.push(gridToLatLng(drv.localizacaoAtual.x, drv.localizacaoAtual.y));
    } else if (d.telemetria?.localizacaoAtual) {
      pts.push(gridToLatLng(d.telemetria.localizacaoAtual.x, d.telemetria.localizacaoAtual.y));
    }

    if (pts.length >= 2) {
      map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 16, animate: true });
    } else {
      map.setView(pts[0], 15, { animate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeliveryId]);

  const handleCreateDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName || !address) return;

    setIsGeocoding(true);
    let x: number | undefined;
    let y: number | undefined;

    // Concatena endereço com o número se informado
    const fullAddress = addressNumber.trim() ? `${address.trim()}, ${addressNumber.trim()}` : address.trim();

    try {
      // Faz fetch na API de geocodificação pública do Nominatim
      // Adicionamos ", Abreu e Lima, Pernambuco, Brasil" para filtrar na cidade foco se não houver cidade especificada
      const query = cidade.trim() ? `${fullAddress}, ${cidade.trim()}, Brasil` : `${fullAddress}, Abreu e Lima, Pernambuco, Brasil`;
      const resGeocode = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
      );
      if (resGeocode.ok) {
        const data = await resGeocode.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          const gridCoords = latLngToGrid(lat, lon);
          x = gridCoords.x;
          y = gridCoords.y;
        }
      }
    } catch (err) {
      console.warn('[Nominatim] Falha ao geocodificar endereço, usando fallback de simulação clássica:', err);
    } finally {
      setIsGeocoding(false);
    }

    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries`, {
        method: 'POST',
        body: JSON.stringify({
          clientName,
          clienteDocumento: clienteDocumento || undefined,
          address: fullAddress,
          items: items ? items.split(',').map(i => i.trim()) : [],
          priority,
          cargoType,
          formaPagamento,
          bairro: bairro || undefined,
          cidade: cidade || undefined,
          referencia: referencia || undefined,
          webhookUrl: webhookUrl || undefined,
          valor: valor ? parseFloat(valor) : undefined,
          driverId: driverId || undefined,
          x,
          y
        })
      });

      if (response.ok) {
        const newDelivery = await response.json();
        setClientName('');
        setClienteDocumento('');
        setAddress('');
        setAddressNumber('');
        setBairro('');
        setCidade('');
        setReferencia('');
        setItems('');
        setPriority('media');
        setCargoType('normal');
        setFormaPagamento('maquininha');
        setWebhookUrl('');
        setValor('');
        setDriverId('');
        setSelectedDeliveryId(newDelivery.id);
      } else {
        // 403 PLAN_LIMIT_REACHED (ou outro erro): mostra a mensagem do backend
        // (ex.: limite mensal de entregas atingido + nudge de upgrade).
        const data = await response.json().catch(() => ({}));
        alert(data.error || 'Erro ao registrar entrega.');
      }
    } catch (err) {
      console.error('Erro ao registrar entrega:', err);
    }
  };

  const handlePrepararPedido = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${id}/prepare`, {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao preparar comanda');
      }
      alert(data.message || 'Pedido aceito e em preparação!');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCancelarPedido = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const motivo = window.prompt('Motivo do cancelamento (opcional):', '');
    if (motivo === null) return; // usuário fechou o prompt
    if (!window.confirm(`Confirma o cancelamento da comanda ${id}? Esta ação não pode ser desfeita.`)) return;
    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ motivo: motivo.trim() || undefined })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao cancelar comanda');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleFinalizarPedido = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${id}/finalize-order`, {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao finalizar comanda');
      }
      alert(data.message || 'Pedido finalizado e enviado para entrega!');
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Gera o romaneio (manifesto) das comandas selecionadas + entregador escolhido.
  // Extraído do antigo botão "Gerar Romaneios" do header; acionado pelo Kanban (Coluna "Prontos").
  const gerarRomaneioParaSelecionados = (driverId?: string) => {
    if (selectedForManifest.length === 0) return;
    const driver =
      drivers.find(drv => drv.id === driverId) ||
      drivers.find(drv => drv.id === selectedDriverForDispatch) ||
      drivers.find(drv => drv.status === 'ocioso') ||
      drivers[0];
    const driverName = driver ? driver.name : 'Motoboy Terceirizado';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const romId = `ROM-${dateStr}-${Math.floor(100 + Math.random() * 900)}`;
    const totalValue = selectedForManifest.reduce((acc, deliveryId) => {
      const found = deliveries.find(del => del.id === deliveryId);
      return acc + (found ? getDeliveryValue(found) : 0);
    }, 0);
    setActiveManifest({
      id: romId,
      deliveryIds: [...selectedForManifest],
      driverName,
      driverId: driver ? driver.id : '',
      totalValue,
    });
    setSelectedForManifest([]);
  };

  const handleManualDispatch = async () => {
    if (!selectedDriverForDispatch) {
      alert('Por favor, selecione um entregador.');
      return;
    }

    const recebidas = deliveries
      .filter(d => selectedForManifest.includes(d.id) && d.status === 'RECEBIDO')
      .map(d => d.id);

    if (recebidas.length === 0) {
      alert('Selecione pelo menos uma comanda no status Recebido.');
      return;
    }

    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries/dispatch-batch`, {
        method: 'POST',
        body: JSON.stringify({
          deliveryIds: recebidas,
          driverId: selectedDriverForDispatch
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao despachar entregas');
      }
      alert(data.message || 'Comandas liberadas com sucesso!');
      setSelectedForManifest([]);
      setSelectedDriverForDispatch('');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSyncExternalOrders = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!externalApiUrl) return;

    setIsSyncing(true);
    try {
      const response = await apiFetch(`${BACKEND_URL}/api/simulator/import-external`, {
        method: 'POST',
        body: JSON.stringify({ url: externalApiUrl })
      });
      
      if (response.ok) {
        const resData = await response.json();
        if (resData.importedCount > 0) {
          alert(`Sucesso! ${resData.importedCount} comandas foram importadas da API externa.`);
          if (resData.deliveries && resData.deliveries.length > 0) {
            setSelectedDeliveryId(resData.deliveries[0]);
          }
        } else {
          alert('Sincronizado! Nenhum pedido novo encontrado (pedidos já foram importados).');
        }
      } else {
        const errData = await response.json();
        alert(`Erro: ${errData.error || 'Não foi possível sincronizar o canal'}`);
      }
    } catch (err: any) {
      console.error('Erro de conexão ao sincronizar canal externo:', err);
      alert(`Erro de conexão: ${err.message || 'Verifique se o backend está rodando'}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleInjectIncident = async () => {
    if (!selectedDeliveryId) return;
    
    let desc = incidentDesc;
    if (!desc) {
      if (incidentType === 'traffic_jam') desc = 'Engarrafamento severo detectado na via expressa.';
      if (incidentType === 'flat_tire') desc = 'Pane mecânica do veículo. Parada forçada.';
      if (incidentType === 'temperature_spike') desc = 'Alerta Térmico: Temperatura subindo rápido!';
      if (incidentType === 'route_deviation') desc = 'Veículo fora do GPS planejado!';
    }

    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${selectedDeliveryId}/incident`, {
        method: 'POST',
        body: JSON.stringify({
          type: incidentType,
          description: desc,
          severity: incidentSeverity
        })
      });

      if (response.ok) {
        setIncidentDesc('');
      }
    } catch (err) {
      console.error('Erro ao injetar incidente:', err);
    }
  };

  const handleResolveIncidents = async (deliveryId: string) => {
    try {
      await apiFetch(`${BACKEND_URL}/api/deliveries/${deliveryId}/resolve`, {
        method: 'POST'
      });
    } catch (err) {
      console.error('Erro ao resolver incidentes:', err);
    }
  };

  const handleClearSimulation = async () => {
    try {
      await apiFetch(`${BACKEND_URL}/api/simulator/clear`, { method: 'POST' });
      setAllDeliveries([]);
      setSelectedDeliveryId(null);
      setActionQueue([]);
      localStorage.removeItem('actionQueue');
      // Limpa os caches de gps offline
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('offline_gps_')) {
          localStorage.removeItem(key);
        }
      });
    } catch (err) {
      console.error('Erro ao limpar simulação:', err);
    }
  };

  const triggerQuickDelivery = async () => {
    const clients = ['Lojas Americanas', 'Supermercado Extra', 'Farmácia Pague Menos', 'Hospital Albert Einstein', 'Lojas Renner'];
    const products = [['Teclado Mecânico', 'Mouse Sem Fio'], ['Sorvete Kibon', 'Polpas Congeladas'], ['Medicamentos Controlados', 'Vacinas'], ['Materiais Cirúrgicos'], ['Jaqueta de Couro', 'Calça Jeans']];
    const types: Array<'normal' | 'expressa' | 'agendado'> = ['normal', 'expressa', 'agendado', 'normal', 'expressa'];
    const priorities: Array<'baixa' | 'media' | 'alta' | 'critica'> = ['media', 'alta', 'critica', 'baixa', 'media'];
    
    const randomIdx = Math.floor(Math.random() * clients.length);

    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries`, {
        method: 'POST',
        body: JSON.stringify({
          clientName: clients[randomIdx],
          address: `Av. Paulista, nº ${100 + Math.floor(Math.random() * 2000)}, São Paulo`,
          items: products[randomIdx],
          priority: priorities[randomIdx],
          cargoType: types[randomIdx],
          tipoComanda: 'entrega'
        })
      });
      
      if (response.ok) {
        const newD = await response.json();
        setSelectedDeliveryId(newD.id);
      }
    } catch (err) {
      console.error('Erro ao criar entrega rápida:', err);
    }
  };

  const triggerQuickOrder = async () => {
    const clients = ['Lojas Americanas', 'Supermercado Extra', 'Farmácia Pague Menos', 'Hospital Albert Einstein', 'Lojas Renner'];
    const products = [['Teclado Mecânico', 'Mouse Sem Fio'], ['Sorvete Kibon', 'Polpas Congeladas'], ['Medicamentos Controlados', 'Vacinas'], ['Materiais Cirúrgicos'], ['Jaqueta de Couro', 'Calça Jeans']];
    const types: Array<'normal' | 'expressa' | 'agendado'> = ['normal', 'expressa', 'agendado', 'normal', 'expressa'];
    const priorities: Array<'baixa' | 'media' | 'alta' | 'critica'> = ['media', 'alta', 'critica', 'baixa', 'media'];
    
    const randomIdx = Math.floor(Math.random() * clients.length);

    try {
      const response = await apiFetch(`${BACKEND_URL}/api/deliveries`, {
        method: 'POST',
        body: JSON.stringify({
          clientName: clients[randomIdx],
          address: `Av. Paulista, nº ${100 + Math.floor(Math.random() * 2000)}, São Paulo`,
          items: products[randomIdx],
          priority: priorities[randomIdx],
          cargoType: types[randomIdx],
          tipoComanda: 'pedido'
        })
      });
      
      if (response.ok) {
        const newD = await response.json();
        setSelectedDeliveryId(newD.id);
      }
    } catch (err) {
      console.error('Erro ao criar comanda de pedido rápido:', err);
    }
  };

  // Lógica do Simulador Mobile (Conclusão de POD e Outbox)
  const handleDriverComplete = async (deliveryId: string) => {
    if (!recebedorNome) {
      alert('O nome do recebedor é obrigatório para comprovação física (POD)!');
      return;
    }

    if (!isWithinGeofenceMobile && !requestJustification) {
      alert('Validação de Cerca Virtual falhou! Você está fora do raio de entrega. Marque a caixa de liberação por justificativa para prosseguir.');
      return;
    }

    if (!isWithinGeofenceMobile && requestJustification && !justificationText) {
      alert('Escreva uma justificativa explicativa para a entrega fora de rota!');
      return;
    }

    const payload: Partial<AcaoFilaSincronia> = {
      recebedorNome,
      recebedorCPF: '000.000.000-00',
      comprovanteFotoUrl: 'foto_canhoto_assinado.png',
      assinaturaBase64: 'Assinatura Simplificada',
      justificativaDesvioCoordenada: !isWithinGeofenceMobile ? justificationText : undefined
    };

    if (offlineMode) {
      // Adiciona ação na fila do outbox local
      const newAction: AcaoFilaSincronia = {
        id: `act-${Math.random().toString(36).substring(2, 6)}`,
        acao: 'concluir',
        entregaId: deliveryId,
        timestamp: new Date().toISOString(),
        ...payload
      };
      setActionQueue(prev => [...prev, newAction]);
      
      // Atualiza de forma otimista local
      setAllDeliveries(prev => 
        prev.map(d => d.id === deliveryId ? { 
          ...d, 
          status: 'ENTREGUE',
          recebedorNome,
          recebedorCPF: payload.recebedorCPF,
          justificativaDesvioCoordenada: payload.justificativaDesvioCoordenada
        } : d)
      );
      
      // Limpa formulário
      setRecebedorNome('');
      setJustificationText('');
      setRequestJustification(false);
    } else {
      try {
        const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${deliveryId}/complete`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          setRecebedorNome('');
          setJustificationText('');
          setRequestJustification(false);
        }
      } catch (err) {
        console.error('Erro ao concluir entrega:', err);
      }
    }
  };

  const handleDriverFail = async (deliveryId: string) => {
    if (offlineMode) {
      const newAction: AcaoFilaSincronia = {
        id: `act-${Math.random().toString(36).substring(2, 6)}`,
        acao: 'falhar',
        entregaId: deliveryId,
        motivoInsucesso: failReason,
        timestamp: new Date().toISOString()
      };
      setActionQueue(prev => [...prev, newAction]);
      
      setAllDeliveries(prev => 
        prev.map(d => d.id === deliveryId ? { ...d, status: 'AGUARDANDO_RETORNO_CD' } : d)
      );
    } else {
      try {
        await apiFetch(`${BACKEND_URL}/api/deliveries/${deliveryId}/fail`, {
          method: 'POST',
          body: JSON.stringify({ motivoInsucesso: failReason })
        });
      } catch (err) {
        console.error('Erro ao registrar insucesso:', err);
      }
    }
  };

  const handleDriverArrive = async (deliveryId: string) => {
    if (offlineMode) {
      const newAction: AcaoFilaSincronia = {
        id: `act-${Math.random().toString(36).substring(2, 6)}`,
        acao: 'chegar',
        entregaId: deliveryId,
        timestamp: new Date().toISOString()
      };
      setActionQueue(prev => [...prev, newAction]);
      
      // Atualiza de forma otimista local
      setAllDeliveries(prev => 
        prev.map(d => d.id === deliveryId ? { ...d, status: 'NO_LOCAL' } : d)
      );
    } else {
      try {
        const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${deliveryId}/arrive`, {
          method: 'POST'
        });
        if (!response.ok) {
          const err = await response.json();
          alert(err.error || 'Erro ao registrar chegada');
        }
      } catch (err) {
        console.error('Erro ao registrar chegada:', err);
      }
    }
  };

  const handleUndo = async (deliveryId: string) => {
    if (offlineMode) {
      // Remove a última ação correspondente à entrega da fila local
      setActionQueue(prev => prev.filter(item => item.entregaId !== deliveryId));
      setAllDeliveries(prev => 
        prev.map(d => d.id === deliveryId ? { ...d, status: 'NO_LOCAL' } : d)
      );
    } else {
      try {
        const response = await apiFetch(`${BACKEND_URL}/api/deliveries/${deliveryId}/rollback`, {
          method: 'POST'
        });
        if (!response.ok) {
          const err = await response.json();
          alert(err.error || 'Erro ao desfazer ação');
        }
      } catch (err) {
        console.error('Erro ao estornar ação:', err);
      }
    }
  };

  const getVehicleIcon = (type?: string) => {
    switch (type) {
      case 'drone':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
            <path d="M12 2v20M20 12H4" />
            <circle cx="12" cy="12" r="3" />
            <circle cx="12" cy="2" r="1.5" />
            <circle cx="12" cy="22" r="1.5" />
            <circle cx="20" cy="12" r="1.5" />
            <circle cx="4" cy="12" r="1.5" />
          </svg>
        );
      case 'motorcycle':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
            <circle cx="5" cy="18" r="3" />
            <circle cx="19" cy="18" r="3" />
            <path d="M12 18V8H9m6 10l-3-6h-3m4-4h4l2 3" />
          </svg>
        );
      case 'van':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
            <path d="M14 18H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" />
            <circle cx="7.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="18" r="2.5" />
            <path d="M13 6v8m5-8l2 3v3" />
          </svg>
        );
      case 'refrigerated_truck':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
            <path d="M14 18H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h11v13z" />
            <path d="M14 8h5l3 3v6h-8V8z" />
            <circle cx="5.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="18" r="2.5" />
            <path d="M20 18h2" />
          </svg>
        );
      default:
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
            <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
            <circle cx="7" cy="17" r="2" />
            <circle cx="17" cy="17" r="2" />
          </svg>
        );
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'RECEBIDO': return 'A Despachar';
      case 'DESPACHADO': return 'Despachado';
      case 'EM_TRANSITO': return 'Em Trânsito';
      case 'NO_LOCAL': return 'No Local';
      case 'ENTREGUE': return 'Entregue (Sucesso)';
      case 'RECUSADO_INSUCESSO': return 'Recusado / Insucesso';
      case 'ALERTA_INCIDENTE': return 'Alerta de Incidente';
      case 'AGUARDANDO_RETORNO_CD': return 'Aguardando Retorno a Loja';
      case 'PRODUTO_RETORNADO_ESTOQUE': return 'Cancelado / Devolvido';
      case 'SLA_ALERTA': return 'Alerta de SLA';
      case 'CANCELADO': return 'Cancelado';
      default: return status;
    }
  };

  const getPriorityText = (priority: string) => {
    switch (priority) {
      case 'baixa': return 'Baixa';
      case 'media': return 'Média';
      case 'alta': return 'Alta';
      case 'critica': return 'Crítica';
      default: return priority;
    }
  };

  const getCargoTypeText = (type: string) => {
    switch (type) {
      case 'normal': return 'Entrega Normal';
      case 'expressa': return 'Entrega Expressa';
      case 'agendado': return 'Entrega Agendada';
      default: return type;
    }
  };

  const selectedDelivery = deliveries.find(d => d.id === selectedDeliveryId);
  const activeDeliveries = deliveries.filter(d => d.status !== 'ENTREGUE' && d.status !== 'RECUSADO_INSUCESSO' && d.status !== 'PRODUTO_RETORNADO_ESTOQUE');
  const alertDeliveries = deliveries.filter(d => d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA');
  const selectedRecebidas = deliveries.filter(d => selectedForManifest.includes(d.id) && d.status === 'RECEBIDO');

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

  // Encontra a entrega ativa associada ao motoboy pareado no celular simulador
  const entregaAtivaMobile = (() => {
    if (!driverMobileVinculado) return undefined;
    const driverDels = deliveries.filter(d => 
      d.motorista?.id === driverMobileVinculado.id && 
      d.status !== 'ENTREGUE' && 
      d.status !== 'RECUSADO_INSUCESSO' && 
      d.status !== 'PRODUTO_RETORNADO_ESTOQUE'
    );
    if (driverDels.length === 0) return undefined;

    driverDels.sort((a, b) => {
      const weightA = getStatusWeight(a.status);
      const weightB = getStatusWeight(b.status);
      if (weightA !== weightB) {
        return weightB - weightA;
      }
      const seqA = a.sequenciaEsperada ?? Infinity;
      const seqB = b.sequenciaEsperada ?? Infinity;
      return seqA - seqB;
    });

    return driverDels[0];
  })();



  // Cálculo de geofencing do simulador mobile pareado
  const endNodeMobile = entregaAtivaMobile?.rota?.path[entregaAtivaMobile.rota.path.length - 1];
  const currentLocMobile = driverLocation;
  const distanceMobile = endNodeMobile && currentLocMobile
    ? Math.sqrt(Math.pow(endNodeMobile.x - currentLocMobile.x, 2) + Math.pow(endNodeMobile.y - currentLocMobile.y, 2))
    : 100;
  const isWithinGeofenceMobile = distanceMobile < 3;

  if (!sessao) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-brand">
              <svg className="login-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="30" height="30" rx="8" fill="#070d1c" stroke="#1e293b" />
                <path d="M7 22 L16 6 L25 22" stroke="#2563EB" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                <path d="M11 22 L16 13 L21 22" stroke="#60A5FA" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <span className="login-word">DISTRE</span>
            </div>
            <p>Orquestração e Gestão de Entregas</p>
          </div>
          
          <div className="login-tabs">
            <button 
              type="button" 
              className={`login-tab ${loginTab === 'loja' ? 'active' : ''}`}
              onClick={() => { setLoginTab('loja'); setLoginError(null); }}
            >
              Portal da Loja
            </button>
            <button 
              type="button" 
              className={`login-tab ${loginTab === 'admin' ? 'active' : ''}`}
              onClick={() => { setLoginTab('admin'); setLoginError(null); }}
            >
              Administrador Master
            </button>
          </div>

          <form className="login-form" onSubmit={handleLogin}>
            <div className="form-group">
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Usuário</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder={loginTab === 'admin' ? 'admin' : 'usuario_da_loja'}
                value={loginUsuario}
                onChange={e => setLoginUsuario(e.target.value)}
                required
              />
            </div>
            
            <div className="form-group">
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Senha</label>
              <input 
                type="password" 
                className="form-input" 
                placeholder="••••••••"
                value={loginSenha}
                onChange={e => setLoginSenha(e.target.value)}
                required
              />
            </div>

            {loginError && <div className="login-error">{loginError}</div>}

            <button type="submit" className="login-btn">
              Entrar no Sistema
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (sessao.tipo === 'admin' && !lojaVisualizada) {
    const totalLojas = empresas.reduce((acc, curr) => acc + (curr.totalLojas || 0), 0);
    const lojasAtivas = empresas.reduce((acc, curr) => acc + (curr.lojasAtivas || 0), 0);

    return (
      <div className="app-container">
        {/* Header Admin */}
        <header className="app-header">
          <div className="logo-section">
            <div className="logo-icon" style={{ background: 'linear-gradient(135deg, var(--color-purple), var(--color-pink))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>M</div>
            <div>
              <h1>Distre - Painel Master</h1>
            </div>
            <span className="version-badge" style={{ background: 'var(--color-purple)', color: '#fff' }}>Master</span>
          </div>
          <div className="status-badges">
            <div className="status-badge">
              <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}></span>
              <span>{isConnected ? 'Servidor Conectado' : 'Desconectado'}</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="btn" style={{ background: '#1f293d', color: 'var(--color-rose)', border: '1px solid rgba(244, 63, 94, 0.2)' }} onClick={handleLogout}>Sair</button>
          </div>
        </header>

        {/* Navigation Tabs — segmented control */}
        <div style={{ display: 'flex', gap: 'var(--space-1)', background: 'var(--bg-secondary)', padding: 'var(--space-1)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-thin)', marginBottom: 'var(--space-6)' }}>
          {([
            { id: 'operacional', label: 'Gestão de Empresas & Lojas' },
            { id: 'financeiro', label: 'Controle Financeiro & Cobrança (ERP)' },
          ] as const).map(tab => {
            const ativo = adminSubView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setAdminSubView(tab.id)}
                style={{
                  flex: 1,
                  background: ativo ? 'var(--bg-card)' : 'transparent',
                  color: ativo ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: 'var(--text-sm)',
                  padding: '0.6rem 1rem',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: ativo ? 'var(--shadow-sm)' : 'none',
                  cursor: 'pointer',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {adminSubView === 'financeiro' ? (
          <div className="financeiro-panel-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* KPI Cards Grid */}
            <div className="report-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <div className="report-kpi-card" style={{ borderLeft: '4px solid var(--color-cyan)' }}>
                <span className="kpi-label">MRR Atual (Assinaturas Ativas)</span>
                <span className="kpi-value" style={{ color: 'var(--color-cyan)' }}>
                  R$ {finDashboard?.mrrAtual.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0,00'}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Projetado próximo mês: R$ {finDashboard?.mrrProjetado.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) || '0,00'}
                </span>
              </div>
              <div className="report-kpi-card" style={{ borderLeft: '4px solid var(--color-amber)' }}>
                <span className="kpi-label">Cobranças em Aberto</span>
                <span className="kpi-value" style={{ color: 'var(--color-amber)' }}>
                  {finDashboard?.totalFaturasEmAberto || 0} faturas
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Total: R$ {finDashboard?.valorEmAberto.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) || '0,00'}
                </span>
              </div>
              <div className="report-kpi-card" style={{ borderLeft: '4px solid var(--color-rose)' }}>
                <span className="kpi-label">Inadimplência</span>
                <span className="kpi-value" style={{ color: 'var(--color-rose)' }}>
                  {finDashboard?.taxaInadimplencia || 0}%
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  {finDashboard?.lojasInadimplentes || 0} de {finDashboard?.totalLojas || 0} lojas atrasadas
                </span>
              </div>
              <div className="report-kpi-card" style={{ borderLeft: '4px solid var(--color-emerald)' }}>
                <span className="kpi-label">Faturamento Líquido (Mês Atual)</span>
                <span className="kpi-value" style={{ color: 'var(--color-emerald)' }}>
                  R$ {finDashboard?.faturamentoLiquidoMes.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) || '0,00'}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Faturamento bruto: R$ {finDashboard?.faturamentoBrutoMes.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) || '0,00'}
                </span>
              </div>
            </div>

            {/* Sub-tabs for Financeiro */}
            <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border-thin)', paddingBottom: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-small"
                style={{
                  background: finSubTab === 'faturas' ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
                  color: finSubTab === 'faturas' ? 'var(--color-cyan)' : 'var(--text-secondary)',
                  border: finSubTab === 'faturas' ? '1px solid var(--color-cyan)' : '1px solid transparent',
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                  fontWeight: 600
                }}
                onClick={() => setFinSubTab('faturas')}
              >
                Faturas e Cobranças
              </button>
              <button
                type="button"
                className="btn btn-small"
                style={{
                  background: finSubTab === 'relatorios' ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
                  color: finSubTab === 'relatorios' ? 'var(--color-cyan)' : 'var(--text-secondary)',
                  border: finSubTab === 'relatorios' ? '1px solid var(--color-cyan)' : '1px solid transparent',
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                  fontWeight: 600
                }}
                onClick={() => setFinSubTab('relatorios')}
              >
                Relatórios Analíticos
              </button>
              <button
                type="button"
                className="btn btn-small"
                style={{
                  background: finSubTab === 'planos_config' ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
                  color: finSubTab === 'planos_config' ? 'var(--color-cyan)' : 'var(--text-secondary)',
                  border: finSubTab === 'planos_config' ? '1px solid var(--color-cyan)' : '1px solid transparent',
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                  fontWeight: 600
                }}
                onClick={() => setFinSubTab('planos_config')}
              >
                Planos, Assinaturas e Configurações
              </button>
            </div>

            {/* TAB: FATURAS */}
            {finSubTab === 'faturas' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Filtros e Nova Cobrança */}
                <div className="card" style={{ padding: '1rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)', display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'end', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Empresa</label>
                      <select
                        className="form-input"
                        style={{ height: '34px', padding: '0 0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-thin)', color: 'var(--text-primary)', borderRadius: '4px' }}
                        value={finFaturasFiltros.empresaId}
                        onChange={e => setFinFaturasFiltros(prev => ({ ...prev, empresaId: e.target.value }))}
                      >
                        <option value="">Todas as Empresas</option>
                        {empresas.map(emp => (
                          <option key={emp.id} value={emp.id}>{emp.nome}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Status</label>
                      <select
                        className="form-input"
                        style={{ height: '34px', padding: '0 0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-thin)', color: 'var(--text-primary)', borderRadius: '4px' }}
                        value={finFaturasFiltros.status}
                        onChange={e => setFinFaturasFiltros(prev => ({ ...prev, status: e.target.value }))}
                      >
                        <option value="">Todos os Status</option>
                        <option value="PAGA">Paga</option>
                        <option value="PENDENTE">Pendente</option>
                        <option value="ATRASADA">Atrasada</option>
                        <option value="CONTESTADA">Contestada</option>
                        <option value="CANCELADA">Cancelada</option>
                      </select>
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Vencimento Inicial</label>
                      <input
                        type="date"
                        className="form-input"
                        style={{ height: '34px', padding: '0 0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-thin)', color: 'var(--text-primary)', borderRadius: '4px' }}
                        value={finFaturasFiltros.dataInicio}
                        onChange={e => setFinFaturasFiltros(prev => ({ ...prev, dataInicio: e.target.value }))}
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Vencimento Final</label>
                      <input
                        type="date"
                        className="form-input"
                        style={{ height: '34px', padding: '0 0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-thin)', color: 'var(--text-primary)', borderRadius: '4px' }}
                        value={finFaturasFiltros.dataFim}
                        onChange={e => setFinFaturasFiltros(prev => ({ ...prev, dataFim: e.target.value }))}
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ height: '34px', background: 'linear-gradient(135deg, var(--color-cyan), var(--color-blue))', color: '#000', border: 'none', fontWeight: 600 }}
                    onClick={() => setShowCobrarManualForm(true)}
                  >
                    + Cobrança Manual
                  </button>
                </div>

                {/* Tabela de Faturas */}
                <div className="card" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', overflow: 'hidden' }}>
                  <div className="lojas-table-container">
                    <table className="lojas-table">
                      <thead>
                        <tr>
                          <th>ID / Ref</th>
                          <th>Empresa</th>
                          <th>CNPJ</th>
                          <th>Mes/Ano</th>
                          <th>Bruto</th>
                          <th>Desconto</th>
                          <th>Líquido</th>
                          <th>Vencimento</th>
                          <th>Pagamento</th>
                          <th>Status</th>
                          <th style={{ textAlign: 'right' }}>Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finFaturas.length === 0 ? (
                          <tr>
                            <td colSpan={11} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                              Nenhuma fatura encontrada com os filtros selecionados.
                            </td>
                          </tr>
                        ) : (
                          finFaturas.map(fat => {
                            let badgeColor = 'gray';
                            let statusText = fat.status;
                            if (fat.status === 'PAGA') { badgeColor = 'var(--color-emerald)'; statusText = 'Paga'; }
                            else if (fat.status === 'PENDENTE') { badgeColor = 'var(--color-amber)'; statusText = 'Pendente'; }
                            else if (fat.status === 'ATRASADA') { badgeColor = 'var(--color-rose)'; statusText = 'Atrasada'; }
                            else if (fat.status === 'CONTESTADA') { badgeColor = 'var(--color-purple)'; statusText = 'Contestada'; }
                            else if (fat.status === 'CANCELADA') { badgeColor = '#4b5563'; statusText = 'Cancelada'; }

                            return (
                              <tr key={fat.id}>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{fat.id}</td>
                                <td><strong>{fat.empresaNome}</strong></td>
                                <td style={{ color: 'var(--text-secondary)' }}>{fat.cnpj}</td>
                                <td>{fat.referenciaMesAno}</td>
                                <td style={{ fontFamily: 'var(--font-mono)' }}>R$ {fat.valorBruto.toFixed(2)}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-rose)' }}>-R$ {fat.valorDesconto.toFixed(2)}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>R$ {fat.valorLiquido.toFixed(2)}</td>
                                <td>{new Date(fat.dataVencimento).toLocaleDateString('pt-BR')}</td>
                                <td>{fat.dataPagamento ? new Date(fat.dataPagamento).toLocaleDateString('pt-BR') : '-'}</td>
                                <td>
                                  <span style={{
                                    display: 'inline-block',
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: '12px',
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    background: `rgba(${badgeColor === 'var(--color-emerald)' ? '16,185,129' : badgeColor === 'var(--color-amber)' ? '245,158,11' : badgeColor === 'var(--color-rose)' ? '244,63,94' : badgeColor === 'var(--color-purple)' ? '139,92,246' : '75,85,99'}, 0.15)`,
                                    color: badgeColor,
                                    border: `1px solid ${badgeColor}`
                                  }}>
                                    {statusText}
                                  </span>
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                                    {fat.status !== 'PAGA' && fat.status !== 'CANCELADA' && (
                                      <>
                                        <button
                                          type="button"
                                          className="btn btn-small btn-success"
                                          style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', background: 'var(--color-emerald)', color: '#000' }}
                                          onClick={() => setShowBaixaManualForm(fat.id)}
                                        >
                                          Baixar
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-small"
                                          style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', background: 'rgba(139, 92, 246, 0.2)', color: 'var(--color-purple)', border: '1px solid rgba(139, 92, 246, 0.3)' }}
                                          onClick={() => {
                                            setShowContestarForm(fat.id);
                                            setContestarMotivo('');
                                          }}
                                        >
                                          Contestar
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-small"
                                          style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', background: 'rgba(244, 63, 94, 0.2)', color: 'var(--color-rose)', border: '1px solid rgba(244, 63, 94, 0.3)' }}
                                          onClick={() => handleCancelarFatura(fat.id)}
                                        >
                                          Cancelar
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Paginação */}
                  {finTotalPaginas > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', borderTop: '1px solid var(--border-thin)' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Página <strong>{finPaginaAtual}</strong> de <strong>{finTotalPaginas}</strong>
                      </span>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={finPaginaAtual === 1}
                          onClick={() => setFinPaginaAtual(prev => Math.max(prev - 1, 1))}
                        >
                          Anterior
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={finPaginaAtual === finTotalPaginas}
                          onClick={() => setFinPaginaAtual(prev => Math.min(prev + 1, finTotalPaginas))}
                        >
                          Próximo
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: RELATORIOS */}
            {finSubTab === 'relatorios' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
                  {/* Gráfico 1: Faturamento Bruto vs Líquido */}
                  <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
                    <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Faturamento Bruto vs. Líquido Mensal (Pagas)</h3>
                    {finRelFaturamento.length === 0 ? (
                      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Sem dados históricos suficientes.</div>
                    ) : (
                      <div>
                        {/* Renderizar Gráfico SVG */}
                        <svg width="100%" height="220" viewBox="0 0 500 220" style={{ overflow: 'visible' }}>
                          <line x1="50" y1="20" x2="480" y2="20" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="70" x2="480" y2="70" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="120" x2="480" y2="120" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="170" x2="480" y2="170" stroke="var(--border-thin)" strokeWidth="1" />
                          
                          {/* Desenha as barras */}
                          {(() => {
                            const maxVal = Math.max(...finRelFaturamento.map(d => Math.max(d.bruto, d.liquido)), 100);
                            const scale = 150 / maxVal;
                            
                            return finRelFaturamento.slice(-5).map((d, idx) => {
                              const x = 80 + idx * 80;
                              const hBruto = d.bruto * scale;
                              const hLiquido = d.liquido * scale;
                              
                              return (
                                <g key={d.referencia}>
                                  {/* Barra Bruto (Blue) */}
                                  <rect x={x} y={170 - hBruto} width="18" height={hBruto} fill="url(#gradBruto)" rx="2" stroke="var(--color-blue)" strokeWidth="0.5" />
                                  {/* Barra Liquido (Emerald) */}
                                  <rect x={x + 22} y={170 - hLiquido} width="18" height={hLiquido} fill="url(#gradLiquido)" rx="2" stroke="var(--color-emerald)" strokeWidth="0.5" />
                                  
                                  {/* Labels */}
                                  <text x={x + 20} y="185" fill="var(--text-secondary)" fontSize="9" textAnchor="middle">{d.referencia}</text>
                                  {d.bruto > 0 && <text x={x + 9} y={165 - hBruto} fill="var(--color-blue)" fontSize="8" textAnchor="middle">R$ {d.bruto.toFixed(0)}</text>}
                                  {d.liquido > 0 && <text x={x + 31} y={165 - hLiquido} fill="var(--color-emerald)" fontSize="8" textAnchor="middle">R$ {d.liquido.toFixed(0)}</text>}
                                </g>
                              );
                            });
                          })()}
                          <defs>
                            <linearGradient id="gradBruto" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--color-blue)" stopOpacity="1" />
                              <stop offset="100%" stopColor="rgba(59, 130, 246, 0.2)" stopOpacity="0.2" />
                            </linearGradient>
                            <linearGradient id="gradLiquido" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--color-emerald)" stopOpacity="1" />
                              <stop offset="100%" stopColor="rgba(16, 185, 129, 0.2)" stopOpacity="0.2" />
                            </linearGradient>
                          </defs>
                        </svg>
                        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            <span style={{ width: '12px', height: '12px', background: 'var(--color-blue)', borderRadius: '2px', border: '1px solid var(--color-blue)' }}></span>
                            Faturamento Bruto
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            <span style={{ width: '12px', height: '12px', background: 'var(--color-emerald)', borderRadius: '2px', border: '1px solid var(--color-emerald)' }}></span>
                            Faturamento Líquido
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Gráfico 2: Taxa de Inadimplência */}
                  <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
                    <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Taxa de Inadimplência Mensal (%)</h3>
                    {finRelInadimplencia.length === 0 ? (
                      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Sem dados suficientes.</div>
                    ) : (
                      <div>
                        <svg width="100%" height="220" viewBox="0 0 500 220" style={{ overflow: 'visible' }}>
                          <line x1="50" y1="20" x2="480" y2="20" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="70" x2="480" y2="70" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="120" x2="480" y2="120" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="170" x2="480" y2="170" stroke="var(--border-thin)" strokeWidth="1" />
                          
                          {/* Desenhar linha/pontos */}
                          {(() => {
                            const points: string[] = [];
                            finRelInadimplencia.slice(-5).forEach((d, idx) => {
                              const x = 80 + idx * 80;
                              const y = 170 - (d.taxaInadimplencia * 1.5);
                              points.push(`${x},${y}`);
                            });
                            
                            return (
                              <g>
                                {points.length > 1 && (
                                  <polyline
                                    fill="none"
                                    stroke="var(--color-rose)"
                                    strokeWidth="2.5"
                                    points={points.join(' ')}
                                  />
                                )}
                                {finRelInadimplencia.slice(-5).map((d, idx) => {
                                  const x = 80 + idx * 80;
                                  const y = 170 - (d.taxaInadimplencia * 1.5);
                                  return (
                                    <g key={d.referencia}>
                                      <circle cx={x} cy={y} r="5" fill="var(--bg-card)" stroke="var(--color-rose)" strokeWidth="2.5" />
                                      <text x={x} y="185" fill="var(--text-secondary)" fontSize="9" textAnchor="middle">{d.referencia}</text>
                                      <text x={x} y={y - 10} fill="var(--color-rose)" fontSize="9" textAnchor="middle" fontWeight="bold">{d.taxaInadimplencia}%</text>
                                    </g>
                                  );
                                })}
                              </g>
                            );
                          })()}
                        </svg>
                        <div style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          Taxa % de MRR retido por faturas atrasadas sobre o total faturado no mês.
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
                  {/* Churn Rate Financeiro */}
                  <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
                    <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Churn Rate Financeiro (MRR Perdido por Cancelamento)</h3>
                    <div className="lojas-table-container">
                      <table className="lojas-table" style={{ fontSize: '0.8rem' }}>
                        <thead>
                          <tr>
                            <th>Referência</th>
                            <th>Faturas Emitidas</th>
                            <th>Faturas Canceladas</th>
                            <th>Receita Total</th>
                            <th>Receita Perdida</th>
                            <th>Churn Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finRelChurn.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)' }}>Sem dados de cancelamento.</td>
                            </tr>
                          ) : (
                            finRelChurn.map(d => (
                              <tr key={d.referencia}>
                                <td style={{ fontWeight: 600 }}>{d.referencia}</td>
                                <td>{d.faturasTotal}</td>
                                <td style={{ color: 'var(--color-rose)' }}>{d.faturasCanceladas}</td>
                                <td>R$ {d.receitaTotal.toFixed(2)}</td>
                                <td style={{ color: 'var(--color-rose)' }}>R$ {d.receitaPerdida.toFixed(2)}</td>
                                <td>
                                  <strong style={{ color: d.churnRate > 0 ? 'var(--color-rose)' : 'var(--color-emerald)' }}>
                                    {d.churnRate}%
                                  </strong>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Relatório de Previsibilidade */}
                  <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
                    <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Contas a Receber nos Próximos Meses (Previsibilidade)</h3>
                    <div className="lojas-table-container">
                      <table className="lojas-table" style={{ fontSize: '0.8rem' }}>
                        <thead>
                          <tr>
                            <th>Dia Vencimento</th>
                            <th>Total de Assinaturas</th>
                            <th>Faturamento Projetado (MRR)</th>
                            <th>Projeção Trimestral (3 Meses)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finRelPrevisibilidade.length === 0 ? (
                            <tr>
                              <td colSpan={4} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)' }}>Nenhuma assinatura ativa para previsão.</td>
                            </tr>
                          ) : (
                            finRelPrevisibilidade.map(d => (
                              <tr key={d.diaVencimento}>
                                <td style={{ fontWeight: 600 }}>Dia {d.diaVencimento}</td>
                                <td>{d.totalAssinaturas} assinatura(s)</td>
                                <td style={{ color: 'var(--color-cyan)', fontWeight: 600 }}>R$ {d.mrrProjetado.toFixed(2)}</td>
                                <td style={{ color: 'var(--color-emerald)', fontWeight: 600 }}>R$ {(d.mrrProjetado * 3).toFixed(2)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: PLANOS E CONFIGURAÇÕES */}
            {finSubTab === 'planos_config' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
                
                {/* CONFIGURAÇÃO DE COBRANÇA */}
                <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
                  <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Configurações de Cobrança e Inadimplência</h3>
                  {finConfiguracoes && (
                    <form onSubmit={handleSalvarConfigCobranca} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <div className="form-group">
                        <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Carência para Bloqueio de Acesso (Dias)</label>
                        <input
                          type="number"
                          className="form-input"
                          value={finConfiguracoes.diasCarenciaBloqueio}
                          onChange={e => setFinConfiguracoes((prev: any) => ({ ...prev, diasCarenciaBloqueio: parseInt(e.target.value) || 0 }))}
                          required
                        />
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Tempo limite com faturas vencidas antes de suspender acessos das lojas.</span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="form-group">
                          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Multa por Atraso (%)</label>
                          <input
                            type="number"
                            step="0.01"
                            className="form-input"
                            value={finConfiguracoes.multaPercentual}
                            onChange={e => setFinConfiguracoes((prev: any) => ({ ...prev, multaPercentual: parseFloat(e.target.value) || 0 }))}
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Juros ao Mês (%)</label>
                          <input
                            type="number"
                            step="0.01"
                            className="form-input"
                            value={finConfiguracoes.jurosMesPercentual}
                            onChange={e => setFinConfiguracoes((prev: any) => ({ ...prev, jurosMesPercentual: parseFloat(e.target.value) || 0 }))}
                            required
                          />
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="form-group">
                          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Notificar E-mail (Dias Antes)</label>
                          <input
                            type="number"
                            className="form-input"
                            value={finConfiguracoes.emailNotificacaoDiasAntes}
                            onChange={e => setFinConfiguracoes((prev: any) => ({ ...prev, emailNotificacaoDiasAntes: parseInt(e.target.value) || 0 }))}
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Notificar WhatsApp (Dias Atraso)</label>
                          <input
                            type="number"
                            className="form-input"
                            value={finConfiguracoes.whatsappNotificacaoDiasAtraso}
                            onChange={e => setFinConfiguracoes((prev: any) => ({ ...prev, whatsappNotificacaoDiasAtraso: parseInt(e.target.value) || 0 }))}
                            required
                          />
                        </div>
                      </div>

                      <button type="submit" className="btn btn-success" style={{ marginTop: '0.5rem', background: 'linear-gradient(135deg, var(--color-cyan), var(--color-blue))', color: '#000', border: 'none', fontWeight: 600 }}>
                        Salvar Configurações
                      </button>
                    </form>
                  )}
                </div>

                {/* PLANOS */}
                <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 600 }}>Planos de Assinatura</h3>
                    <button type="button" className="btn btn-success btn-small" onClick={startNovoPlano}>
                      + Novo Plano
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {finPlanos.map(plan => (
                      <div key={plan.id} style={{ padding: '0.75rem', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-thin)', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <strong style={{ color: 'var(--color-cyan)' }}>{plan.nome}</strong>
                          <span style={{ fontSize: '0.85rem', marginLeft: '0.5rem', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                            R$ {plan.valorMensal.toFixed(2)}/mês
                          </span>
                          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                            {plan.descricao}
                          </p>
                        </div>
                        <button type="button" className="btn btn-small" onClick={() => startEditPlano(plan)} style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}>
                          Editar
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ASSINATURAS DAS EMPRESAS */}
                <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)', gridColumn: 'span 2' }}>
                  <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '1rem', fontWeight: 600 }}>Assinaturas Ativas de Empresas</h3>
                  <div className="lojas-table-container">
                    <table className="lojas-table" style={{ fontSize: '0.8rem' }}>
                      <thead>
                        <tr>
                          <th>Empresa</th>
                          <th>CNPJ</th>
                          <th>Plano</th>
                          <th>Valor Cobrado</th>
                          <th>Dia Vencimento</th>
                          <th>Status</th>
                          <th>Próxima Cobrança</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finAssinaturas.length === 0 ? (
                          <tr>
                            <td colSpan={7} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)' }}>Sem assinaturas registradas.</td>
                          </tr>
                        ) : (
                          finAssinaturas.map(sub => (
                            <tr key={sub.id}>
                              <td><strong>{sub.empresaNome}</strong></td>
                              <td style={{ color: 'var(--text-secondary)' }}>{sub.cnpj}</td>
                              <td><span className="badge-tenant ativo" style={{ background: 'var(--color-purple)' }}>{sub.planoNome}</span></td>
                              <td style={{ fontFamily: 'var(--font-mono)' }}>R$ {sub.valorEfetivo.toFixed(2)}</td>
                              <td>Todo dia {sub.diaVencimento}</td>
                              <td>
                                {(() => {
                                  const estilos: Record<string, { bg: string; cor: string; label: string }> = {
                                    ATIVA:     { bg: 'rgba(16,185,129,0.1)', cor: 'var(--color-emerald)', label: 'Ativa' },
                                    TRIAL:     { bg: 'rgba(59,130,246,0.1)', cor: 'var(--color-blue, #3b82f6)', label: 'Trial' },
                                    ATRASADA:  { bg: 'rgba(245,158,11,0.1)', cor: 'var(--color-amber)', label: 'Atrasada' },
                                    SUSPENSA:  { bg: 'rgba(244,63,94,0.1)', cor: 'var(--color-rose)', label: 'Suspensa' },
                                    CANCELADA: { bg: 'rgba(75,85,99,0.15)', cor: '#9ca3af', label: 'Cancelada' },
                                  };
                                  const e = estilos[sub.status] ?? estilos.CANCELADA;
                                  return (
                                    <span style={{
                                      display: 'inline-block',
                                      padding: '0.1rem 0.4rem',
                                      borderRadius: '4px',
                                      fontSize: '0.75rem',
                                      background: e.bg,
                                      color: e.cor
                                    }}>
                                      {e.label}
                                    </span>
                                  );
                                })()}
                              </td>
                              <td>{sub.proximoFaturamento ? new Date(sub.proximoFaturamento).toLocaleDateString('pt-BR') : '-'}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            )}
          </div>
        ) : (
          <>
            {/* Stats Grid */}
            <div className="admin-stats-grid">
          <div className="admin-stat-card">
            <span className="admin-stat-label">Total de Empresas</span>
            <span className="admin-stat-value">{empresas.length}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Lojas Cadastradas</span>
            <span className="admin-stat-value">{totalLojas}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Lojas Ativas</span>
            <span className="admin-stat-value" style={{ color: 'var(--color-emerald)' }}>{lojasAtivas}</span>
          </div>
        </div>

        {/* Botão de Nova Empresa */}
        <div className="admin-header">
          <h2>Empresas e Redes Credenciadas</h2>
          <button 
            className="btn btn-success" 
            onClick={() => setShowNovaEmpresaForm(!showNovaEmpresaForm)}
          >
            {showNovaEmpresaForm ? 'Cancelar' : '+ Nova Empresa'}
          </button>
        </div>

        {/* Formulário de Nova Empresa */}
        {showNovaEmpresaForm && (
          <div className="card" style={{ marginBottom: '1.5rem', padding: '1.5rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '1rem', color: 'var(--color-cyan)' }}>Cadastrar Nova Empresa</h3>
            <form onSubmit={handleCadastrarEmpresa} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', alignItems: 'end' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Razão Social / Nome</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={novaEmpresaNome} 
                  onChange={e => setNovaEmpresaNome(e.target.value)} 
                  placeholder="Ex: Pizzaria Bella Italia Ltda"
                  required 
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CNPJ</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={novaEmpresaCnpj} 
                  onChange={e => setNovaEmpresaCnpj(e.target.value)} 
                  placeholder="Ex: 12.345.678/0001-99"
                  required 
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Telefone (opcional)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={novaEmpresaTelefone} 
                  onChange={e => setNovaEmpresaTelefone(e.target.value)} 
                  placeholder="(11) 99999-9999" 
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Email (opcional)</label>
                <input 
                  type="email" 
                  className="form-input" 
                  value={novaEmpresaEmail} 
                  onChange={e => setNovaEmpresaEmail(e.target.value)} 
                  placeholder="email@empresa.com" 
                />
              </div>
              <button type="submit" className="btn btn-success" style={{ height: '38px' }}>Salvar Empresa</button>
            </form>
          </div>
        )}

        {/* Listagem de Empresas */}
        <div className="empresas-container">
          {empresas.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)', background: 'var(--bg-card)', border: '1px dashed var(--border-thin)', borderRadius: '12px' }}>
              Nenhuma empresa cadastrada no sistema. Clique em "+ Nova Empresa" para começar.
            </div>
          ) : (
            empresas.map(empresa => {
              const isExpanded = expandedEmpresas.includes(empresa.id);
              const lojas = lojasDaEmpresa[empresa.id] || [];
              const isNovaLojaAberta = showNovaLojaForm === empresa.id;

              return (
                <div key={empresa.id} className="empresa-card">
                  {/* Cabeçalho da Empresa */}
                  <div className="empresa-card-header" onClick={() => toggleEmpresaExpandida(empresa.id)}>
                    <div className="empresa-header-info">
                      <svg 
                        width="16" 
                        height="16" 
                        viewBox="0 0 24 24" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2" 
                        style={{ 
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', 
                          transition: 'transform 0.2s ease',
                          color: empresa.ativo ? 'var(--color-cyan)' : 'var(--text-secondary)'
                        }}
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      <span className="empresa-name" style={{ textDecoration: empresa.ativo ? 'none' : 'line-through', opacity: empresa.ativo ? 1 : 0.6 }}>{empresa.nome}</span>
                      <span className="empresa-cnpj">{empresa.cnpj}</span>
                      <span className={`badge-tenant ${empresa.ativo ? 'ativo' : 'inativo'}`}>
                        {empresa.ativo ? 'Ativa' : 'Inativa'}
                      </span>
                    </div>

                    <div className="empresa-actions" onClick={e => e.stopPropagation()}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginRight: '1rem' }}>
                        {empresa.totalLojas || 0} loja(s)
                      </span>
                      <button 
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.7rem', 
                          padding: '0.2rem 0.5rem',
                          background: empresa.ativo ? 'rgba(244, 63, 94, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                          color: empresa.ativo ? 'var(--color-rose)' : 'var(--color-emerald)',
                          border: empresa.ativo ? '1px solid rgba(244, 63, 94, 0.2)' : '1px solid rgba(16, 185, 129, 0.2)'
                        }}
                        onClick={() => handleToggleEmpresa(empresa.id)}
                      >
                        {empresa.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                      <button 
                        className="icon-btn danger" 
                        title="Excluir Empresa"
                        onClick={() => handleDeleteEmpresa(empresa.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Lojas da Empresa (Conteúdo Expandido) */}
                  {isExpanded && (
                    <div className="empresa-card-content">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lojas / Redes</h4>
                        <button 
                          className="btn btn-success btn-small"
                          onClick={() => {
                            const abrindo = !isNovaLojaAberta;
                            setShowNovaLojaForm(abrindo ? empresa.id : null);
                            if (abrindo && finPlanos.length === 0) carregarFinanceiroPlanos();
                          }}
                        >
                          {isNovaLojaAberta ? 'Cancelar' : '+ Nova Loja'}
                        </button>
                      </div>

                      {/* Form Nova Loja */}
                      {isNovaLojaAberta && (
                        <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid var(--border-thin)', borderRadius: '8px' }}>
                          <h5 style={{ fontSize: '0.8rem', color: 'var(--color-cyan)', marginBottom: '0.75rem' }}>Cadastrar Nova Loja na Rede {empresa.nome}</h5>
                          <form onSubmit={e => handleCadastrarLoja(e, empresa.id)} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Nome Fantasia</label>
                              <input 
                                type="text" 
                                className="form-input" 
                                value={novaLojaNome} 
                                onChange={e => setNovaLojaNome(e.target.value)} 
                                placeholder="Loja Centro" 
                                required 
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>CNPJ da Loja</label>
                              <input 
                                type="text" 
                                className="form-input" 
                                value={novaLojaCnpj} 
                                onChange={e => setNovaLojaCnpj(e.target.value)} 
                                placeholder="00.000.000/0000-00" 
                                required 
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Usuário de Acesso</label>
                              <input 
                                type="text" 
                                className="form-input" 
                                value={novaLojaUsuario} 
                                onChange={e => setNovaLojaUsuario(e.target.value)} 
                                placeholder="ex: lojacentro" 
                                required 
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Senha Inicial</label>
                              <input 
                                type="password" 
                                className="form-input" 
                                value={novaLojaSenha}
                                onChange={e => setNovaLojaSenha(e.target.value)}
                                placeholder="Senha da loja"
                                required
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Plano de Assinatura</label>
                              <select
                                className="form-input"
                                value={novaLojaPlanoId}
                                onChange={e => setNovaLojaPlanoId(e.target.value)}
                                required
                              >
                                <option value="">Selecione o plano...</option>
                                {finPlanos.filter(p => p.ativo !== false).map(p => (
                                  <option key={p.id} value={p.id}>
                                    {p.nome} — R$ {Number(p.valorMensal).toFixed(2)}/mês
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>CEP</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaCep}
                                onChange={e => setNovaLojaCep(e.target.value)}
                                placeholder="00000-000"
                                maxLength={9}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Endereço (Logradouro)</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaEndereco}
                                onChange={e => setNovaLojaEndereco(e.target.value)}
                                placeholder="Rua das Flores"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Número</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaNumero}
                                onChange={e => setNovaLojaNumero(e.target.value)}
                                placeholder="123"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Bairro</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaBairro}
                                onChange={e => setNovaLojaBairro(e.target.value)}
                                placeholder="Bairro"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Cidade</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaCidade}
                                onChange={e => setNovaLojaCidade(e.target.value)}
                                placeholder="São Paulo"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>UF</label>
                              <input
                                type="text"
                                className="form-input"
                                value={novaLojaUf}
                                onChange={e => setNovaLojaUf(e.target.value.toUpperCase())}
                                placeholder="SP"
                                maxLength={2}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', height: '34px' }}>
                              <input 
                                type="checkbox" 
                                id="novaLojaRecebePedidos"
                                checked={novaLojaRecebePedidos} 
                                onChange={e => setNovaLojaRecebePedidos(e.target.checked)} 
                                style={{ accentColor: 'var(--color-cyan)', cursor: 'pointer', width: '15px', height: '15px' }}
                              />
                              <label htmlFor="novaLojaRecebePedidos" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 0 }}>
                                Ativar Fila de Pedidos (WhatsApp)
                              </label>
                            </div>
                            <button type="submit" className="btn btn-success" style={{ height: '34px' }}>Salvar Loja</button>
                          </form>
                        </div>
                      )}

                      {/* Tabela de Lojas */}
                      <div className="lojas-table-container">
                        {lojas.length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                            Nenhuma loja cadastrada nesta empresa.
                          </div>
                        ) : (
                          <table className="lojas-table">
                            <thead>
                              <tr>
                                <th>Nome</th>
                                <th>CNPJ</th>
                                <th>Usuário</th>
                                <th>Endereço</th>
                                <th>Chave de Acesso</th>
                                <th>Fila de Pedidos</th>
                                <th>Status</th>
                                <th style={{ textAlign: 'right' }}>Ações</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lojas.map(loja => (
                                <tr key={loja.id}>
                                  <td style={{ fontWeight: 600 }}>{loja.nome}</td>
                                  <td className="font-mono" style={{ fontSize: '0.78rem' }}>
                                    {loja.cnpj || <em style={{ color: 'var(--text-muted)' }}>Não informado</em>}
                                  </td>
                                  <td className="font-mono">{loja.usuario}</td>
                                  <td style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                    {loja.endereco ? (
                                      <>
                                        {loja.endereco}
                                        {loja.bairro && `, ${loja.bairro}`}
                                        {loja.cidade && ` - ${loja.cidade}`}
                                      </>
                                    ) : (
                                      <em style={{ color: 'var(--text-muted)' }}>Não informado</em>
                                    )}
                                  </td>
                                  <td>
                                    <div className="chave-acesso-box">
                                      <span className="chave-acesso-text">{loja.chaveAcesso}</span>
                                      <button 
                                        type="button"
                                        className="icon-btn" 
                                        title="Copiar Chave de Acesso"
                                        onClick={() => {
                                          navigator.clipboard.writeText(loja.chaveAcesso);
                                          alert('Chave copiada para a área de transferência!');
                                        }}
                                      >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                      </button>
                                      <button 
                                        type="button"
                                        className="icon-btn" 
                                        title="Regenerar Chave"
                                        onClick={() => handleRegenerarChaveLoja(empresa.id, loja.id)}
                                      >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>
                                  <td>
                                    <span 
                                      className={`badge-tenant ${loja.recebePedidos ? 'ativo' : 'inativo'}`}
                                      style={{ cursor: 'pointer', border: loja.recebePedidos ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(156, 163, 175, 0.3)', background: loja.recebePedidos ? 'rgba(245, 158, 11, 0.08)' : 'rgba(156, 163, 175, 0.08)', color: loja.recebePedidos ? 'var(--color-amber)' : '#9ca3af' }}
                                      onClick={() => handleToggleRecebePedidos(empresa.id, loja)}
                                      title="Clique para alternar Fila de Pedidos"
                                    >
                                      {loja.recebePedidos ? 'Habilitada' : 'Desabilitada'}
                                    </span>
                                  </td>
                                  <td>
                                    <span className={`badge-tenant ${loja.ativo ? 'ativo' : 'inativo'}`}>
                                      {loja.ativo ? 'Ativa' : 'Inativa'}
                                    </span>
                                  </td>
                                  <td>
                                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                                      <button 
                                        className="btn btn-small btn-success" 
                                        style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', background: 'var(--color-cyan)', color: '#000' }}
                                        onClick={() => setLojaVisualizada({ id: loja.id, nome: loja.nome, nomeEmpresa: empresa.nome })}
                                        disabled={!loja.ativo || !empresa.ativo}
                                        title={(!loja.ativo || !empresa.ativo) ? 'Não é possível visualizar painel de loja ou empresa inativa' : 'Visualizar Dashboard'}
                                      >
                                        Painel
                                      </button>
                                      <button 
                                        className="btn btn-small" 
                                        style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', background: '#1f293d', color: '#fff', border: '1px solid rgba(255,255,255,0.08)' }}
                                        onClick={() => startEditLoja(loja)}
                                        title="Editar Informações da Loja"
                                      >
                                        Editar
                                      </button>
                                      <button 
                                        className="btn btn-small"
                                        style={{ 
                                          fontSize: '0.7rem', 
                                          padding: '0.15rem 0.4rem',
                                          background: loja.ativo ? 'rgba(244, 63, 94, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                                          color: loja.ativo ? 'var(--color-rose)' : 'var(--color-emerald)',
                                          border: loja.ativo ? '1px solid rgba(244, 63, 94, 0.2)' : '1px solid rgba(16, 185, 129, 0.2)'
                                        }}
                                        onClick={() => handleToggleLoja(empresa.id, loja.id)}
                                      >
                                        {loja.ativo ? 'Bloquear' : 'Liberar'}
                                      </button>
                                      <button 
                                        className="icon-btn danger" 
                                        title="Excluir Loja"
                                        onClick={() => handleDeleteLoja(empresa.id, loja.id)}
                                      >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <polyline points="3 6 5 6 21 6" />
                                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </>
    )}

        {/* --- MODAIS DO MÓDULO FINANCEIRO --- */}
        {showCobrarManualForm && createPortal(
          <div className="report-modal-overlay" onClick={() => setShowCobrarManualForm(false)}>
            <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="report-modal-header">
                <h2>Gerar Cobrança Manual (Fatura Avulsa)</h2>
                <button type="button" className="report-modal-close-btn" onClick={() => setShowCobrarManualForm(false)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="report-modal-body">
                <form onSubmit={handleCobrarManual} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Empresa</label>
                    <select
                      className="form-input"
                      value={manualCobrarEmpresaId}
                      onChange={e => setManualCobrarEmpresaId(e.target.value)}
                      required
                    >
                      <option value="">Selecione uma empresa...</option>
                      {empresas.map(emp => (
                        <option key={emp.id} value={emp.id}>{emp.nome}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Valor Cobrado (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={manualCobrarValor}
                      onChange={e => setManualCobrarValor(e.target.value)}
                      placeholder="Ex: 299.00"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Referência / Descrição</label>
                    <input
                      type="text"
                      className="form-input"
                      value={manualCobrarDescricao}
                      onChange={e => setManualCobrarDescricao(e.target.value)}
                      placeholder="Ex: Mensalidade extra"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Data de Vencimento</label>
                    <input
                      type="date"
                      className="form-input"
                      value={manualCobrarVencimento}
                      onChange={e => setManualCobrarVencimento(e.target.value)}
                      required
                    />
                  </div>
                  {manualCobrarError && (
                    <div style={{ color: 'var(--color-rose)', fontSize: '0.75rem' }}>{manualCobrarError}</div>
                  )}
                  <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem', background: 'linear-gradient(135deg, var(--color-cyan), var(--color-blue))', color: '#000', border: 'none', fontWeight: 600 }}>Gerar Cobrança</button>
                </form>
              </div>
            </div>
          </div>
        , document.body)}

        {showBaixaManualForm && createPortal(
          <div className="report-modal-overlay" onClick={() => setShowBaixaManualForm(null)}>
            <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="report-modal-header">
                <h2>Dar Baixa Manual na Fatura</h2>
                <button type="button" className="report-modal-close-btn" onClick={() => setShowBaixaManualForm(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="report-modal-body">
                <form onSubmit={handleBaixaManual} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Fatura ID</label>
                    <input type="text" className="form-input" value={showBaixaManualForm} readOnly disabled />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Comprovante de Referência / Transação</label>
                    <input
                      type="text"
                      className="form-input"
                      value={baixaManualComprovante}
                      onChange={e => setBaixaManualComprovante(e.target.value)}
                      placeholder="Ex: Autenticação Pix E123456"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Observações</label>
                    <textarea
                      className="form-input"
                      value={baixaManualObservacoes}
                      onChange={e => setBaixaManualObservacoes(e.target.value)}
                      placeholder="Ex: Recebido via transferência bancária direta."
                      rows={3}
                      style={{ resize: 'vertical', minHeight: '60px' }}
                    />
                  </div>
                  <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem' }}>Confirmar Pagamento</button>
                </form>
              </div>
            </div>
          </div>
        , document.body)}

        {showContestarForm && createPortal(
          <div className="report-modal-overlay" onClick={() => setShowContestarForm(null)}>
            <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="report-modal-header">
                <h2>Marcar Fatura como Contestada</h2>
                <button type="button" className="report-modal-close-btn" onClick={() => setShowContestarForm(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="report-modal-body">
                <form onSubmit={handleContestarFatura} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Fatura ID</label>
                    <input type="text" className="form-input" value={showContestarForm} readOnly disabled />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Motivo da Contestação</label>
                    <textarea
                      className="form-input"
                      value={contestarMotivo}
                      onChange={e => setContestarMotivo(e.target.value)}
                      placeholder="Descreva o motivo relatado pela empresa para a contestação da cobrança..."
                      rows={4}
                      required
                      style={{ resize: 'vertical', minHeight: '80px' }}
                    />
                  </div>
                  <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem', background: 'var(--color-purple)', border: '1px solid var(--color-purple)', color: '#fff' }}>Registrar Contestação</button>
                </form>
              </div>
            </div>
          </div>
        , document.body)}

        {showPlanoForm && createPortal(
          <div className="report-modal-overlay" onClick={() => setShowPlanoForm(null)}>
            <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="report-modal-header">
                <h2>{showPlanoForm.id ? 'Editar Plano de Assinatura' : 'Criar Novo Plano de Assinatura'}</h2>
                <button type="button" className="report-modal-close-btn" onClick={() => setShowPlanoForm(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="report-modal-body">
                <form onSubmit={handleSalvarPlano} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Nome do Plano</label>
                    <input
                      type="text"
                      className="form-input"
                      value={planoNome}
                      onChange={e => setPlanoNome(e.target.value)}
                      placeholder="Ex: Silver Plus"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Descrição do Plano</label>
                    <input
                      type="text"
                      className="form-input"
                      value={planoDescricao}
                      onChange={e => setPlanoDescricao(e.target.value)}
                      placeholder="Ex: Recomendado para redes médias"
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Valor Mensal (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={planoValorMensal}
                      onChange={e => setPlanoValorMensal(e.target.value)}
                      placeholder="Ex: 349.00"
                      required
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Limite Entregas/Mês</label>
                      <input
                        type="number"
                        className="form-input"
                        value={planoLimiteEntregas}
                        onChange={e => setPlanoLimiteEntregas(e.target.value)}
                        placeholder="Deixe em branco para ilimitado"
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Limite Lojas</label>
                      <input
                        type="number"
                        className="form-input"
                        value={planoLimiteLojas}
                        onChange={e => setPlanoLimiteLojas(e.target.value)}
                        placeholder="Deixe em branco para ilimitado"
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Limite Motoristas</label>
                    <input
                      type="number"
                      className="form-input"
                      value={planoLimiteMotoristas}
                      onChange={e => setPlanoLimiteMotoristas(e.target.value)}
                      placeholder="Deixe em branco para ilimitado"
                    />
                  </div>
                  {planoError && (
                    <div style={{ color: 'var(--color-rose)', fontSize: '0.75rem' }}>{planoError}</div>
                  )}
                  <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem' }}>Salvar Plano</button>
                </form>
              </div>
            </div>
          </div>
        , document.body)}

        {editingLoja && createPortal(
          <div className="report-modal-overlay" onClick={() => setEditingLoja(null)}>
            <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
              <div className="report-modal-header">
                <h2>Editar Informações da Loja</h2>
                <button className="report-modal-close-btn" onClick={() => setEditingLoja(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="report-modal-body">
                <form onSubmit={handleUpdateLoja} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Nome Fantasia</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editLojaNome} 
                      onChange={e => setEditLojaNome(e.target.value)} 
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CNPJ da Loja</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editLojaCnpj} 
                      onChange={e => setEditLojaCnpj(e.target.value)} 
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Usuário de Acesso</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editLojaUsuario} 
                      onChange={e => setEditLojaUsuario(e.target.value)} 
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Alterar Senha (deixe em branco para manter a atual)</label>
                    <input 
                      type="password" 
                      className="form-input" 
                      value={editLojaSenha} 
                      onChange={e => setEditLojaSenha(e.target.value)} 
                      placeholder="Nova senha da loja"
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CEP</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaCep}
                        onChange={e => setEditLojaCep(e.target.value)}
                        placeholder="00000-000"
                        maxLength={9}
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>UF</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaUf}
                        onChange={e => setEditLojaUf(e.target.value.toUpperCase())}
                        placeholder="SP"
                        maxLength={2}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.6rem' }}>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Endereço (Logradouro)</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaEndereco}
                        onChange={e => setEditLojaEndereco(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Número</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaNumero}
                        onChange={e => setEditLojaNumero(e.target.value)}
                        placeholder="123"
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Bairro</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaBairro}
                        onChange={e => setEditLojaBairro(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Cidade</label>
                      <input
                        type="text"
                        className="form-input"
                        value={editLojaCidade}
                        onChange={e => setEditLojaCidade(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input
                      type="checkbox"
                      id="editLojaRecebePedidosMaster"
                      checked={editLojaRecebePedidos} 
                      onChange={e => setEditLojaRecebePedidos(e.target.checked)} 
                      style={{ accentColor: 'var(--color-cyan)', cursor: 'pointer', width: '15px', height: '15px' }}
                    />
                    <label htmlFor="editLojaRecebePedidosMaster" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 0 }}>
                      Ativar Fila de Pedidos (WhatsApp)
                    </label>
                  </div>
                  <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem' }}>Salvar Alterações</button>
                </form>
              </div>
            </div>
          </div>
        , document.body)}
      </div>
    );
  }

  // Dashboard da Loja
  return (
    <div className="app-container">
      {lojaVisualizada && (
        <div className="viewing-tenant-banner">
          <span className="viewing-tenant-text">
            <strong>Modo Visualização:</strong> Você está visualizando o dashboard de <strong>{lojaVisualizada.nome}</strong> ({lojaVisualizada.nomeEmpresa}).
          </span>
          <button 
            className="btn btn-small" 
            style={{ background: 'var(--color-purple)', color: '#fff' }}
            onClick={() => setLojaVisualizada(null)}
          >
            Voltar ao Painel Master
          </button>
        </div>
      )}

      {/* 1. App Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon" style={{ background: 'transparent', boxShadow: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {/* Logo oficial Distre — mesmo mark da landing (site/index.html) e da tela de login */}
            <svg width="40" height="40" viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ display: 'block' }}>
              <rect x="1" y="1" width="30" height="30" rx="8" fill="#070d1c" stroke="#1e293b" />
              <path d="M7 22 L16 6 L25 22" stroke="#2563EB" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              <path d="M11 22 L16 13 L21 22" stroke="#60A5FA" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h1>Distre - Gestão de Entregas</h1>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
              {lojaVisualizada ? (
                <span>Visualizando: <strong>{lojaVisualizada.nome}</strong> / {lojaVisualizada.nomeEmpresa}</span>
              ) : sessao?.tipo === 'loja' ? (
                <span>Loja: <strong>{sessao.nomeLoja}</strong> / {sessao.nomeEmpresa}</span>
              ) : (
                <span>Modo Administrativo</span>
              )}
            </p>
          </div>
          <span className="version-badge">v2.1-br</span>
        </div>
        <div className="status-badges">
          <div className="status-badge">
            <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}></span>
            <span>{isConnected ? 'Servidor Conectado' : 'Desconectado'}</span>
          </div>
          <div className="status-badge" style={{ color: 'var(--color-cyan)' }}>
            <strong>{activeDeliveries.length}</strong> Entregas Ativas
          </div>
          {alertDeliveries.length > 0 && (
            <div className="status-badge" style={{ color: 'var(--color-rose)' }}>
              <strong>{alertDeliveries.length}</strong> Alertas Ativos
            </div>
          )}
        </div>
        <div className="header-actions">
          {/* Hierarquia: 1 primária (Gerar Pedido), 1 secundária (Entrega Rápida),
              destrutivo e logout rebaixados a ghost p/ não competir nem causar clique acidental. */}
          <button className="btn btn-primary" onClick={triggerQuickOrder}>+ Gerar Pedido</button>
          <button className="btn btn-secondary" onClick={triggerQuickDelivery}>Entrega Rápida</button>
          <button
            className="btn"
            style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-thin)' }}
            onClick={handleClearSimulation}
            title="Apagar todos os dados da simulação"
          >
            Limpar Dados
          </button>
          {!lojaVisualizada && (
            <button
              className="btn"
              style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-thin)' }}
              onClick={handleLogout}
            >
              Sair
            </button>
          )}
        </div>
      </header>

      {/* 2. Incidents Alerts Banner */}
      {alertDeliveries.length > 0 && (
        <div className="incidents-container">
          {alertDeliveries.map(d => (
            <div key={d.id} className="incident-alert-banner">
              <div className="incident-alert-text">
                <span className="incident-alert-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '4px' }}>
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                </span>
                <span>
                  <strong>Entrega {d.id} ({d.nomeCliente})</strong>: {d.incidentes.find(i => !i.resolvido)?.descricao || 'Problema na rota'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-primary btn-small" onClick={() => setSelectedDeliveryId(d.id)}>Visualizar</button>
                <button className="btn btn-success btn-small" onClick={() => handleResolveIncidents(d.id)}>Resolver Todos</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Centro de Operações — painel operacional ao vivo (KPIs + SLA + eventos) */}
      <CentroOperacoes
        deliveries={deliveries}
        drivers={drivers}
        liveEvents={liveEvents}
        zona={sessao?.nomeLoja || currentLoja?.nome || undefined}
      />

      {/* 3. Seção de Entregas Cadastradas (Comandas) */}
      <section className="glass-panel deliveries-top-panel glow-cyan">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Controle de Comandas
            {tenantLojaId && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" />
                </svg>
                Impressão de comanda:
                <select
                  className="form-select"
                  value={comandaPrintMode}
                  onChange={ev => alterarModoImpressao(ev.target.value as ModoImpressaoComanda)}
                  style={{ width: 'auto', minHeight: '30px', padding: '0 var(--space-2)', fontSize: '0.75rem' }}
                  title="Como a comanda é gerada quando um pedido novo entra na fila"
                >
                  <option value="impressora">Impressora 80mm (auto)</option>
                  <option value="pdf">Abrir PDF</option>
                  <option value="off">Desligada</option>
                </select>
              </label>
            )}
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {selectedRecebidas.length > 0 && tenantLojaId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderRight: '1px solid rgba(255,255,255,0.08)', paddingRight: '0.5rem', marginRight: '0.1rem' }}>
                <select
                  className="form-select"
                  style={{ fontSize: '0.68rem', padding: '0.2rem 0.4rem', background: '#141b27', border: '1px solid #1f293d', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
                  value={selectedDriverForDispatch}
                  onChange={e => setSelectedDriverForDispatch(e.target.value)}
                >
                  <option value="">Selecione o Entregador</option>
                  {drivers.map(d => (
                    <option key={d.id} value={d.id} disabled={!d.dispositivoConectado}>
                      {d.name} ({!d.dispositivoConectado ? 'Offline' : d.status === 'ocioso' ? 'Disponível' : 'Em Rota'})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {/* Despacho em lote movido para o Kanban (Coluna "Prontos p/ Despacho") */}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Total: {deliveries.length} comandas
            </span>
          </div>
        </div>

        {/* Romaneio Ativo */}
        {activeManifest && (
          <div style={{ 
            background: '#0d131f', 
            border: '1px solid #1f293d', 
            borderRadius: '8px', 
            padding: '0.75rem', 
            marginBottom: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="font-mono" style={{ color: 'var(--color-cyan)', fontWeight: 'bold', fontSize: '0.85rem' }}>{activeManifest.id}</span>
              <button 
                style={{ background: 'transparent', border: 'none', color: 'var(--color-rose)', cursor: 'pointer', fontSize: '0.75rem' }}
                onClick={() => {
                  setSelectedForManifest(activeManifest.deliveryIds);
                  setSelectedDriverForDispatch(activeManifest.driverId);
                  setActiveManifest(null);
                }}
              >
                Desfazer
              </button>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              <div><strong>Motoboy:</strong> {activeManifest.driverName}</div>
              <div style={{ marginTop: '0.2rem' }}>
                <strong>Comandas:</strong>{' '}
                {activeManifest.deliveryIds.map(id => (
                  <span key={id} className="font-mono" style={{ marginRight: '0.4rem', background: '#141b27', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>
                    {id}
                  </span>
                ))}
              </div>
              <div style={{ 
                marginTop: '0.4rem', 
                padding: '0.4rem', 
                background: 'rgba(6, 182, 212, 0.04)', 
                border: '1px solid rgba(6, 182, 212, 0.1)', 
                borderRadius: '4px',
                color: 'var(--color-cyan)',
                fontWeight: 600
              }}>
                Valor Total a Cobrar em Maquininha: R$ {activeManifest.totalValue.toFixed(2)}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-small"
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '0.4rem',
                  background: '#141b27',
                  border: '1px solid #1f293d',
                  color: 'var(--text-primary)',
                  fontSize: '0.72rem',
                  padding: '0.35rem',
                  width: 'fit-content'
                }}
                onClick={() => setShowThermalReceipt(true)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 9V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5" />
                  <rect width="12" height="8" x="6" y="14" rx="1" />
                </svg>
                Imprimir Guia do Motoboy (80mm)
              </button>

              <button
                type="button"
                className="btn btn-primary btn-small"
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '0.4rem',
                  fontSize: '0.72rem',
                  padding: '0.35rem',
                  width: 'fit-content'
                }}
                onClick={async () => {
                  try {
                    const response = await apiFetch(`${BACKEND_URL}/api/deliveries/dispatch-batch`, {
                      method: 'POST',
                      body: JSON.stringify({
                        deliveryIds: activeManifest.deliveryIds,
                        driverId: activeManifest.driverId,
                        romaneioId: activeManifest.id
                      })
                    });
                    const data = await response.json();
                    if (!response.ok) {
                      throw new Error(data.error || 'Erro ao despachar entregas');
                    }
                    alert(data.message || 'Comandas liberadas com sucesso!');
                    setActiveManifest(null);
                  } catch (err: any) {
                    alert(err.message);
                  }
                }}
              >
                Liberar Entrega
              </button>
            </div>
          </div>
        )}

        {/* Kanban de Controle de Comandas — substitui as 2 filas verticais antigas */}
        <KanbanComandas
          deliveries={deliveries}
          drivers={drivers}
          selectedForManifest={selectedForManifest}
          onToggleManifest={(id, checked) => setSelectedForManifest(prev => (checked ? [...prev, id] : prev.filter(x => x !== id)))}
          onPreparar={handlePrepararPedido}
          onFinalizar={handleFinalizarPedido}
          onCancelar={handleCancelarPedido}
          onAbrirComanda={setSelectedDeliveryId}
          onDespachar={gerarRomaneioParaSelecionados}
          onImprimir={(c) => imprimirComandaTicket(c as any, 'impressora')}
          getValor={getDeliveryValue as any}
          getStatusText={getStatusText}
        />
        {/* (as 2 filas verticais antigas foram substituídas pelo Kanban acima) */}
      </section>

      {/* 4. Dashboard Main Body Grid */}
      <div className="dashboard-grid">
        
        {/* Left Side: Create Delivery Form & Ingestion Control */}
        <section className="glass-panel">
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px', color: 'var(--color-cyan)' }}>
                <rect width="20" height="8" x="2" y="3" rx="2" />
                <rect width="20" height="8" x="2" y="13" rx="2" />
                <path d="M6 7h.01M6 17h.01" />
              </svg>
              Registrar Nova Entrega
            </h2>
          </div>

          <form onSubmit={handleCreateDelivery} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
            <div className="form-group">
              <label>ID da Comanda</label>
              <input 
                type="text" 
                className="form-input font-mono" 
                value="ID: [Gerado Automaticamente]" 
                disabled 
                style={{ opacity: 0.6, cursor: 'not-allowed' }}
              />
            </div>

            <div className="form-group">
              <label>Nome do Cliente</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Ex: Lojas Americanas"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>CPF/CNPJ <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Ex: 000.000.000-00 ou 00.000.000/0000-00"
                value={clienteDocumento}
                onChange={(e) => setClienteDocumento(e.target.value)}
              />
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '2.5fr 1fr', gap: '0.6rem' }}>
              <div className="form-group">
                <label>Endereço de Entrega (Rua/Av.)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Ex: Av. Paulista"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Número</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Ex: 1000"
                  value={addressNumber}
                  onChange={(e) => setAddressNumber(e.target.value)}
                  required
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              <div className="form-group">
                <label>Bairro <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Ex: Piedade"
                  value={bairro}
                  onChange={(e) => setBairro(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Cidade <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="Ex: Abreu e Lima"
                  value={cidade}
                  onChange={(e) => setCidade(e.target.value)}
                />
              </div>
            </div>
            
            <div className="form-group">
              <label>Referência <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Ex: Ao lado do banco"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
              />
            </div>
            
            <div className="form-group">
              <label>Itens da Carga (separados por vírgula) <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Ex: Dipirona 500mg, Soro (opcional)"
                value={items}
                onChange={(e) => setItems(e.target.value)}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              <div className="form-group">
                <label>Prioridade SLA</label>
                <select className="form-select" value={priority} onChange={(e: any) => setPriority(e.target.value)}>
                  <option value="baixa">Baixa</option>
                  <option value="media">Média</option>
                  <option value="alta">Alta</option>
                  <option value="critica">Crítica</option>
                </select>
              </div>

              <div className="form-group">
                <label>Tipo de Entrega</label>
                <select className="form-select" value={cargoType} onChange={(e: any) => setCargoType(e.target.value)}>
                  <option value="expressa">Expressa</option>
                  <option value="normal">Normal</option>
                  <option value="agendado">Agendado</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              <div className="form-group">
                <label>Valor da Entrega (R$) <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
                <input 
                  type="number" 
                  step="0.01"
                  min="0"
                  className="form-input" 
                  placeholder="Ex: 45.90"
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Motoboy para Atribuição <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(opcional)</span></label>
                <select className="form-select" value={driverId} onChange={(e: any) => setDriverId(e.target.value)}>
                  <option value="">Atribuição Automática</option>
                  {drivers.filter(d => d.status === 'ocioso').map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Forma de Pagamento</label>
              <select className="form-select" value={formaPagamento} onChange={(e: any) => setFormaPagamento(e.target.value)}>
                <option value="maquininha">Maquininha (Cartao)</option>
                <option value="pix">Pix</option>
                <option value="dinheiro">Dinheiro</option>
              </select>
            </div>


            <button 
              type="submit" 
              className="btn btn-primary" 
              style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isGeocoding ? 0.7 : 1, cursor: isGeocoding ? 'not-allowed' : 'pointer' }}
              disabled={isGeocoding}
            >
              {isGeocoding ? (
                <>Geocodificando endereço...</>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                    <path d="M5 12h14M12 5v14" />
                  </svg>
                  Incluir Nova Comanda
                </>
              )}
            </button>
          </form>

          <hr style={{ margin: '1.2rem 0', borderColor: 'var(--border-thin)', opacity: 0.15 }} />

          <div className="external-channel-sync" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            <h3 style={{ fontSize: '0.85rem', color: 'var(--color-cyan)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              Sincronizar Canal de Vendas (Cenário Externo)
            </h3>
            
            <form onSubmit={handleSyncExternalOrders} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <div className="form-group">
                <label style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>URL da API de Pedidos Externos</label>
                <input 
                  type="text" 
                  className="form-input font-mono" 
                  style={{ fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}
                  value={externalApiUrl}
                  onChange={(e) => setExternalApiUrl(e.target.value)}
                  required
                />
              </div>
              
              <button 
                type="submit" 
                className="btn btn-secondary btn-small" 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  fontSize: '0.72rem', 
                  padding: '0.35rem',
                  width: '100%',
                  opacity: isSyncing ? 0.6 : 1,
                  cursor: isSyncing ? 'not-allowed' : 'pointer'
                }}
                disabled={isSyncing}
              >
                {isSyncing ? 'Sincronizando...' : 'Sincronizar Pedidos'}
              </button>
            </form>
          </div>

          {/* A listagem de comandas foi movida para o topo */}

          {/* A Frota de Motoristas foi movida para a coluna da direita */}
        </section>

        {/* Center: Live GPS Map & Mobile Simulator / Telemetry split */}
        <section className="glass-panel" style={{ minWidth: '0' }}>
          <div className="panel-header">
            <h2 style={{ fontFamily: "'Nunito', 'Baloo 2', sans-serif", fontWeight: 800, letterSpacing: '0.2px' }}>Telemetria e Monitoramento de Rotas (GPS)</h2>
            <span style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Grade de Coordenadas 100x100</span>
          </div>

          <div className="map-container map-waze" style={{ position: 'relative', overflow: 'hidden' }}>
            {/* Mapa interativo (Leaflet, tiles claros estilo Waze): loja, rota do motoboy
                (OSRM) e destinos. Ao clicar na comanda, o mapa dá foco na entrega. */}
            <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

            {/* Overlay de geolocalização da loja (canto inferior esquerdo) */}
            {sessao?.tipo === 'loja' && (
              <div className="map-loc-overlay">
                {typeof lojaLat === 'number' && typeof lojaLng === 'number' ? (
                  <span className="map-loc-coords">
                    <span className="map-loc-dot" />
                    {lojaLat.toFixed(5)}, {lojaLng.toFixed(5)}
                  </span>
                ) : (
                  <span className="map-loc-warn">⚠️ Localização não resolvida — sem CEP/endereço.</span>
                )}
                <button
                  type="button"
                  className="map-loc-btn"
                  title="Usa o GPS deste dispositivo para fixar a loja na localização atual"
                  onClick={() => {
                    if (!navigator.geolocation) {
                      alert('Este navegador não suporta geolocalização.');
                      return;
                    }
                    navigator.geolocation.getCurrentPosition(
                      async (pos) => {
                        const { latitude, longitude } = pos.coords;
                        try {
                          const resp = await apiFetch(`${BACKEND_URL}/api/loja-atual/coordenadas`, {
                            method: 'POST',
                            body: JSON.stringify({ latitude, longitude })
                          });
                          const contentType = resp.headers.get('content-type') || '';
                          if (!contentType.includes('application/json')) {
                            alert(
                              `Backend respondeu HTTP ${resp.status} sem JSON. ` +
                              `Reinicie o backend (npm run dev) — rota nova ainda não existe.`
                            );
                            return;
                          }
                          const data = await resp.json();
                          if (!resp.ok) {
                            alert(data.error || 'Erro ao salvar localização.');
                            return;
                          }
                          setLojaCoordsLive({ lat: latitude, lng: longitude });
                        } catch (err: any) {
                          alert('Erro ao salvar localização: ' + err.message);
                        }
                      },
                      (err) => {
                        const msg = err.code === err.PERMISSION_DENIED
                          ? 'Permissão de localização negada. Libere no navegador (cadeado da URL → Localização → Permitir) e tente de novo.'
                          : err.code === err.POSITION_UNAVAILABLE
                            ? 'Localização indisponível no momento.'
                            : err.code === err.TIMEOUT
                              ? 'Tempo esgotado ao obter localização.'
                              : 'Erro de geolocalização: ' + err.message;
                        alert(msg);
                      },
                      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
                    );
                  }}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                    <circle cx="12" cy="8.2" r="4" fill="currentColor" />
                    <path d="M4.5 20 a7.5 7.5 0 0 1 15 0 Z" fill="currentColor" />
                  </svg>
                  Usar minha localização
                </button>
              </div>
            )}
          </div>

          <div className="split-telemetry-container">
            
            {/* Painel do Operador */}
            {selectedDelivery ? (
              <div className="operator-control-panel">
                <h3 style={{ fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--color-cyan)', fontWeight: 600 }}>
                  Painel do Operador / Telemetria: <span className="font-mono">{selectedDelivery.id}</span>
                </h3>
                <div style={{ fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: '0.2rem', color: 'var(--text-secondary)' }}>
                  <div><strong>Cliente:</strong> {selectedDelivery.nomeCliente}</div>
                  <div><strong>Status:</strong> <span className={`card-badge ${selectedDelivery.status}`} style={{ display: 'inline', fontSize: '0.62rem' }}>{getStatusText(selectedDelivery.status)}</span></div>
                  
                  {selectedDelivery.motorista && (
                    <div><strong>Entregador:</strong> {selectedDelivery.motorista.name} ({getVehicleIcon(selectedDelivery.motorista.vehicleType)})</div>
                  )}
                </div>

                {selectedDelivery.recebedorNome && (
                  <div style={{ 
                    marginTop: '0.4rem', 
                    background: 'rgba(255, 255, 255, 0.02)', 
                    border: '1px solid #1f293d', 
                    padding: '0.4rem', 
                    borderRadius: '6px', 
                    fontSize: '0.68rem',
                    color: 'var(--text-secondary)'
                  }}>
                    Recebedor: {selectedDelivery.recebedorNome}
                  </div>
                )}
                {selectedDelivery.justificativaDesvioCoordenada && (
                  <div style={{ color: 'var(--color-amber)', marginTop: '0.2rem', fontSize: '0.68rem' }}>
                    ⚠️ <strong>Justificativa GPS:</strong> {selectedDelivery.justificativaDesvioCoordenada}
                  </div>
                )}

                {selectedDelivery.status === 'AGUARDANDO_RETORNO_CD' && (
                  <div style={{ marginTop: '0.4rem', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)', padding: '0.4rem', borderRadius: '6px', fontSize: '0.68rem' }}>
                    <div style={{ color: 'var(--color-amber)', fontWeight: 'bold' }}>⚠️ EM CUSTÓDIA REVERSA (MOTORISTA):</div>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                      O pedido falhou. Aguardando retorno a Loja para bipar conferência física.
                    </div>
                    <button
                      className="btn btn-success btn-small"
                      style={{ width: '100%', fontSize: '0.68rem', padding: '0.2rem' }}
                      onClick={async () => {
                        try {
                          await apiFetch(`${BACKEND_URL}/api/deliveries/${selectedDelivery.id}/return-stock`, {
                            method: 'POST'
                          });
                        } catch (err) {
                          console.error('Erro ao bipar retorno ao estoque:', err);
                        }
                      }}
                    >
                      Bipar Código de Barras (Retorno ao Estoque)
                    </button>
                  </div>
                )}

                {selectedDelivery.status === 'PRODUTO_RETORNADO_ESTOQUE' && (
                  <div style={{ marginTop: '0.4rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', padding: '0.4rem', borderRadius: '6px', fontSize: '0.68rem' }}>
                    <div style={{ color: 'var(--color-cyan)', fontWeight: 'bold' }}>PEDIDO CANCELADO / DEVOLVIDO:</div>
                    <div style={{ color: 'var(--text-secondary)' }}>
                      Conferência física finalizada e saldo de produtos retornado ao estoque.
                    </div>
                  </div>
                )}

                {selectedDelivery.incidentes.filter(i => !i.resolvido).length > 0 && (
                  <div style={{ marginTop: '0.4rem', background: 'rgba(244, 63, 94, 0.1)', border: '1px solid rgba(244, 63, 94, 0.3)', padding: '0.4rem', borderRadius: '6px' }}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--color-rose)', fontWeight: 'bold' }}>INCIDENTES ATIVOS:</div>
                    {selectedDelivery.incidentes.filter(i => !i.resolvido).map(i => (
                      <div key={i.id} style={{ fontSize: '0.65rem', marginTop: '0.1rem' }}>
                        {i.descricao}
                      </div>
                    ))}
                    <button 
                      className="btn btn-success btn-small" 
                      style={{ marginTop: '0.3rem', width: '100%', fontSize: '0.65rem', padding: '0.2rem' }}
                      onClick={() => handleResolveIncidents(selectedDelivery.id)}
                    >
                      Resolver Alertas
                    </button>
                  </div>
                )}

                {/* Injetor de Incidentes */}
                {(selectedDelivery.status === 'EM_TRANSITO' || selectedDelivery.status === 'ALERTA_INCIDENTE') && (
                  <div style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.4rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-rose)', marginBottom: '0.2rem' }}>Simular Pane/Atraso</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      <select 
                        className="form-select" 
                        style={{ padding: '0.2rem', fontSize: '0.7rem' }}
                        value={incidentType}
                        onChange={(e) => setIncidentType(e.target.value)}
                      >
                        <option value="traffic_jam">Trânsito Intenso</option>
                        <option value="flat_tire">Pneu Furado / Pane</option>
                        <option value="temperature_spike">Quebra de Cadeia Fria</option>
                        <option value="route_deviation">Desvio de GPS</option>
                      </select>
                      <div style={{ display: 'flex', gap: '0.2rem' }}>
                        <button 
                          className="btn btn-danger btn-small" 
                          style={{ flex: 1, fontSize: '0.65rem', padding: '0.2rem' }}
                          onClick={() => {
                            setIncidentSeverity('aviso');
                            setTimeout(handleInjectIncident, 50);
                          }}
                        >
                          Aviso
                        </button>
                        <button 
                          className="btn btn-danger btn-small" 
                          style={{ flex: 1, fontSize: '0.65rem', padding: '0.2rem', backgroundColor: 'rgba(244, 63, 94, 0.4)' }}
                          onClick={() => {
                            setIncidentSeverity('critico');
                            setTimeout(handleInjectIncident, 50);
                          }}
                        >
                          Crítico
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="operator-control-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', minHeight: '380px' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '1rem', opacity: 0.3 }}>Telemetria</div>
                Selecione uma comanda active na listagem acima ou uma entrega no mapa para carregar a telemetria em tempo real do operador.
              </div>
            )}

            {/* Simulador de App Mobile do Entregador */}
            <div className="mobile-phone-simulator">
              <div className="phone-bezel">
                <div className="phone-screen">
                  <div className="phone-header-bar">
                    <span className="phone-time">13:40</span>
                    <div className="phone-notch"></div>
                    <div className="phone-signals">
                      <span className={`signal-indicator ${offlineMode ? 'offline' : 'online'}`}>
                        {offlineMode ? 'Sem sinal' : '5G'}
                      </span>
                    </div>
                  </div>
                  
                  <div className="phone-body-content">
                    {!driverMobileVinculado ? (
                      /* Tela de Pareamento por PIN */
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="phone-app-header">
                          <h4>Entregador Mobile</h4>
                        </div>
                        <form onSubmit={handleVincularDriverMobile} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', padding: '1rem 0.5rem', flex: 1, justifyContent: 'center' }}>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: '1.1rem' }}>
                            Para vincular o simulador móvel ao seu cadastro no painel, digite o PIN de 6 dígitos do motoboy.
                          </div>
                          <div className="phone-form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <input 
                              type="text" 
                              className="phone-input"
                              style={{ 
                                background: '#141b27', 
                                border: '1px solid #1f293d', 
                                borderRadius: '6px', 
                                padding: '0.5rem', 
                                color: '#fff', 
                                fontSize: '1rem', 
                                letterSpacing: '2px',
                                textAlign: 'center',
                                fontWeight: 'bold',
                                outline: 'none'
                              }}
                              placeholder="000-000" 
                              maxLength={7}
                              value={driverPinInput}
                              onChange={(e) => {
                                let val = e.target.value.replace(/\D/g, '');
                                if (val.length > 3) {
                                  val = val.substring(0, 3) + '-' + val.substring(3, 6);
                                }
                                setDriverPinInput(val);
                              }}
                            />
                          </div>
                          <button 
                            type="submit"
                            className="phone-btn"
                            style={{ 
                              background: 'var(--color-cyan)', 
                              color: '#000', 
                              width: '100%', 
                              padding: '0.5rem', 
                              borderRadius: '6px', 
                              fontWeight: 600, 
                              fontSize: '0.78rem',
                              cursor: 'pointer',
                              border: 'none',
                              boxShadow: '0 0 10px var(--color-cyan)',
                              marginTop: '0.5rem'
                            }}
                          >
                            Vincular Aparelho
                          </button>
                        </form>
                      </div>
                    ) : (
                      /* Tela do Celular Pareado */
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="phone-app-header" style={{ paddingBottom: '0.4rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--color-emerald)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              🏍️ {driverMobileVinculado.name}
                            </span>
                            <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                              {driverMobileVinculado.id} ({driverMobileVinculado.vehicleType === 'refrigerated_truck' ? 'Caminhão' : driverMobileVinculado.vehicleType === 'motorcycle' ? 'Motocicleta' : driverMobileVinculado.vehicleType === 'van' ? 'Van' : 'Drone'})
                            </span>
                          </div>
                          <button 
                            type="button" 
                            onClick={handleDesvincularDriverMobile}
                            style={{ 
                              background: 'rgba(244, 63, 94, 0.15)', 
                              border: '1px solid rgba(244, 63, 94, 0.3)', 
                              borderRadius: '4px', 
                              color: 'var(--color-rose)', 
                              fontSize: '0.62rem', 
                              padding: '0.15rem 0.35rem',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                          >
                            Sair
                          </button>
                        </div>

                        <div className="connection-switch-row" style={{ marginTop: '0.4rem', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: offlineMode ? 'var(--color-rose)' : 'var(--color-emerald)', display: 'inline-block', boxShadow: offlineMode ? '0 0 6px var(--color-rose)' : '0 0 6px var(--color-emerald)' }} />
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                              {offlineMode ? 'Modo Offline' : 'Online'}
                            </span>
                          </div>
                          <label className="switch-label" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.65rem', cursor: 'pointer' }}>
                            <input 
                              type="checkbox" 
                              checked={offlineMode} 
                              onChange={(e) => setOfflineMode(e.target.checked)} 
                              style={{ accentColor: 'var(--color-rose)' }}
                            />
                            Simular Offline
                          </label>
                        </div>

                        {actionQueue.length > 0 && (
                          <div className="offline-badge-alert" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)', color: 'var(--color-amber)', padding: '0.2rem', borderRadius: '4px', fontSize: '0.65rem', textAlign: 'center', marginTop: '0.3rem' }}>
                            Fila Outbox: <strong>{actionQueue.length}</strong> pendente(s)
                          </div>
                        )}

                        <div style={{ flex: 1, overflowY: 'auto', paddingRight: '2px', marginTop: '0.4rem' }}>
                          {entregaAtivaMobile ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', textAlign: 'left' }}>
                              <div className="phone-delivery-details" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #1f293d', padding: '0.4rem 0.5rem', borderRadius: '6px' }}>
                                <div className="phone-del-id" style={{ fontSize: '0.72rem', fontWeight: 'bold' }}>ID: {entregaAtivaMobile.id}</div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>Destino: {entregaAtivaMobile.endereco}</div>
                                <div className="phone-status-badge-container" style={{ marginTop: '0.2rem', fontSize: '0.65rem' }}>
                                  Status: <span className={`phone-status-badge ${entregaAtivaMobile.status}`} style={{ fontSize: '0.6rem' }}>{getStatusText(entregaAtivaMobile.status)}</span>
                                </div>
                              </div>

                              {entregaAtivaMobile.status === 'RECEBIDO' || entregaAtivaMobile.status === 'DESPACHADO' ? (
                                <div className="phone-status-msg" style={{ fontSize: '0.7rem', textAlign: 'center', padding: '0.8rem 0.5rem', background: '#0f172a', borderRadius: '6px', color: 'var(--text-muted)' }}>
                                  ⏳ Aguardando liberação e despacho no Hub Central.
                                </div>
                              ) : entregaAtivaMobile.status === 'EM_TRANSITO' || entregaAtivaMobile.status === 'ALERTA_INCIDENTE' || entregaAtivaMobile.status === 'SLA_ALERTA' ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                  <div className="phone-status-msg animate-pulse" style={{ fontSize: '0.7rem', color: 'var(--color-cyan)', textAlign: 'center', padding: '0.4rem', background: 'rgba(0, 242, 254, 0.05)', borderRadius: '6px' }}>
                                    🏍️ Rota em andamento para o cliente...
                                    {driverLocation && (
                                      <div style={{ fontSize: '0.62rem', marginTop: '0.2rem', color: 'var(--text-secondary)' }}>
                                        Coordenadas GPS: <strong>x: {driverLocation.x}, y: {driverLocation.y}</strong>
                                      </div>
                                    )}
                                  </div>
                                  
                                  {/* Controles de Movimentação do GPS */}
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem', margin: '0.2rem 0' }}>
                                    <button 
                                      type="button"
                                      className="btn btn-secondary btn-small"
                                      style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                      onClick={() => handleMoverGpsSimulado('N')}
                                    >
                                      ▲ N
                                    </button>
                                    <div style={{ display: 'flex', gap: '1.2rem' }}>
                                      <button 
                                        type="button"
                                        className="btn btn-secondary btn-small"
                                        style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                        onClick={() => handleMoverGpsSimulado('O')}
                                      >
                                        ◀ O
                                      </button>
                                      <button 
                                        type="button"
                                        className="btn btn-secondary btn-small"
                                        style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                        onClick={() => handleMoverGpsSimulado('L')}
                                      >
                                        L ▶
                                      </button>
                                    </div>
                                    <button 
                                      type="button"
                                      className="btn btn-secondary btn-small"
                                      style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                      onClick={() => handleMoverGpsSimulado('S')}
                                    >
                                      ▼ S
                                    </button>
                                  </div>

                                  {/* Botão de Confirmar Chegada ao Local */}
                                  <button 
                                    className="phone-btn"
                                    style={{ 
                                      background: 'var(--color-purple)', 
                                      color: '#fff', 
                                      width: '100%', 
                                      padding: '0.45rem', 
                                      borderRadius: '6px', 
                                      fontWeight: 600, 
                                      fontSize: '0.72rem', 
                                      cursor: 'pointer',
                                      border: 'none',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '0.3rem',
                                      marginTop: '0.2rem',
                                      boxShadow: '0 0 10px rgba(168, 85, 247, 0.2)'
                                    }}
                                    onClick={() => handleDriverArrive(entregaAtivaMobile.id)}
                                  >
                                    Confirmar Chegada ao Local
                                  </button>
                                </div>
                              ) : entregaAtivaMobile.status === 'NO_LOCAL' ? (
                                <div className="phone-actions-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                  
                                  {/* Geofencing Indicator */}
                                  {!isWithinGeofenceMobile ? (
                                    <div style={{ padding: '0.4rem', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.15)', borderRadius: '6px', fontSize: '0.68rem', color: 'var(--color-amber)' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontWeight: 600 }}>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--color-amber)' }}>
                                          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                                          <line x1="12" y1="9" x2="12" y2="13"/>
                                          <line x1="12" y1="17" x2="12.01" y2="17"/>
                                        </svg>
                                        Divergência de GPS Detectada
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.25rem' }}>
                                        <input 
                                          type="checkbox" 
                                          id="divergencia-gps-mobile"
                                          checked={requestJustification} 
                                          onChange={(e) => setRequestJustification(e.target.checked)} 
                                          style={{ accentColor: 'var(--color-amber)' }}
                                        />
                                        <label htmlFor="divergencia-gps-mobile" style={{ fontSize: '0.62rem', cursor: 'pointer' }}>Justificar divergência</label>
                                      </div>
                                      {requestJustification && (
                                        <input 
                                          type="text" 
                                          className="phone-input"
                                          style={{ marginTop: '0.3rem', fontSize: '0.68rem', padding: '0.25rem 0.4rem', background: '#141b27', border: '1px solid #1f293d', borderRadius: '4px', width: '100%', color: '#fff' }}
                                          placeholder="Ex: GPS sem sinal / Prédio alto" 
                                          value={justificationText}
                                          onChange={(e) => setJustificationText(e.target.value)}
                                        />
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: '0.68rem', color: '#34d399', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.15)', borderRadius: '6px', padding: '0.4rem', display: 'flex', alignItems: 'center' }}>
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '4px', color: '#10b981' }}>
                                        <path d="M20 6L9 17l-5-5"/>
                                      </svg>
                                      GPS validado dentro da cerca virtual
                                    </div>
                                  )}

                                  {/* Form Comprovação (POD) */}
                                  <div className="phone-form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                    <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Nome do Recebedor</label>
                                    <input 
                                      type="text" 
                                      className="phone-input"
                                      style={{ background: '#141b27', border: '1px solid #1f293d', borderRadius: '6px', padding: '0.35rem 0.5rem', color: '#fff', fontSize: '0.72rem', outline: 'none' }}
                                      placeholder="Nome por extenso" 
                                      value={recebedorNome}
                                      onChange={(e) => setRecebedorNome(e.target.value)}
                                    />
                                  </div>

                                  <button 
                                    className="phone-btn"
                                    style={{ 
                                      background: '#10b981', 
                                      color: '#fff', 
                                      width: '100%', 
                                      padding: '0.45rem', 
                                      borderRadius: '6px', 
                                      fontWeight: 600, 
                                      fontSize: '0.72rem', 
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '0.3rem',
                                      opacity: (!isWithinGeofenceMobile && !requestJustification) ? 0.5 : 1,
                                      border: 'none'
                                    }}
                                    onClick={() => handleDriverComplete(entregaAtivaMobile.id)}
                                    disabled={!isWithinGeofenceMobile && !requestJustification}
                                  >
                                    Confirmar Entrega (POD)
                                  </button>

                                  <div className="phone-divider" style={{ margin: '0.2rem 0', fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center' }}>Ou Registrar Falha</div>

                                  <div className="phone-form-group">
                                    <select 
                                      className="phone-select" 
                                      style={{ fontSize: '0.65rem', padding: '0.3rem' }}
                                      value={failReason} 
                                      onChange={(e) => setFailReason(e.target.value)}
                                    >
                                      <option value="01 - Cliente Ausente (3 tentativas de contato)">01 - Cliente Ausente (3 contato)</option>
                                      <option value="02 - Endereço Não Localizado / Incompleto">02 - Endereço Não Localizado</option>
                                      <option value="03 - Estabelecimento Fechado (Comercial)">03 - Estabelecimento Fechado</option>
                                      <option value="04 - Recusa por Avaria ou Item Incorreto">04 - Recusa por Avaria</option>
                                      <option value="05 - Falta de Segurança no Local (Área de Risco)">05 - Falta de Segurança</option>
                                    </select>
                                  </div>

                                  <button 
                                    className="phone-btn phone-btn-danger"
                                    style={{ padding: '0.4rem', fontSize: '0.7rem' }}
                                    onClick={() => handleDriverFail(entregaAtivaMobile.id)}
                                  >
                                    Reportar Insucesso / Devolução
                                  </button>
                                </div>
                              ) : (
                                <div className="phone-status-msg" style={{ fontSize: '0.7rem', textAlign: 'center', padding: '0.5rem', background: '#0f172a', borderRadius: '6px' }}>
                                  Ciclo finalizado!<br />
                                  Resultado: <strong>{getStatusText(entregaAtivaMobile.status)}</strong>
                                  {((entregaAtivaMobile.status === 'ENTREGUE' || entregaAtivaMobile.status === 'AGUARDANDO_RETORNO_CD') && isWithinGeofenceMobile) && (
                                    <button
                                      className="phone-btn phone-btn-warning"
                                      style={{ marginTop: '0.6rem', fontSize: '0.65rem', backgroundColor: 'var(--color-amber)', color: '#000', width: '100%', border: 'none', borderRadius: '4px', padding: '0.3rem', cursor: 'pointer', fontWeight: 'bold' }}
                                      onClick={() => handleUndo(entregaAtivaMobile.id)}
                                    >
                                      Desfazer Última Ação (60s)
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            /* Caso não tenha entrega associada ao motoboy pareado */
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.4rem', textAlign: 'left' }}>
                              <div style={{ fontSize: '0.72rem', textAlign: 'center', padding: '1.2rem 0.5rem', background: '#0f172a', borderRadius: '8px', color: 'var(--color-emerald)', border: '1px dashed rgba(16, 185, 129, 0.2)' }}>
                                <div style={{ fontSize: '1.2rem', marginBottom: '0.2rem' }}></div>
                                <strong>Online & Disponível</strong>
                                <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                                  Aguardando nova comanda ser atribuída pela Loja...
                                </p>
                              </div>
                              
                              {/* Controles de GPS em modo livre */}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.2rem' }}>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textAlign: 'center', fontWeight: '500' }}>
                                  Simular Movimentação Livre (GPS):
                                </div>
                                {driverLocation && (
                                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                                    x: {driverLocation.x}%, y: {driverLocation.y}%
                                  </div>
                                )}
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem', margin: '0.2rem 0' }}>
                                  <button 
                                    type="button"
                                    className="btn btn-secondary btn-small"
                                    style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                    onClick={() => handleMoverGpsSimulado('N')}
                                  >
                                    ▲ N
                                  </button>
                                  <div style={{ display: 'flex', gap: '1.2rem' }}>
                                    <button 
                                      type="button"
                                      className="btn btn-secondary btn-small"
                                      style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                      onClick={() => handleMoverGpsSimulado('O')}
                                    >
                                      ◀ O
                                    </button>
                                    <button 
                                      type="button"
                                      className="btn btn-secondary btn-small"
                                      style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                      onClick={() => handleMoverGpsSimulado('L')}
                                    >
                                      L ▶
                                    </button>
                                  </div>
                                  <button 
                                    type="button"
                                    className="btn btn-secondary btn-small"
                                    style={{ width: '32px', height: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}
                                    onClick={() => handleMoverGpsSimulado('S')}
                                  >
                                    ▼ S
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
            </div>
          </div>
        </div>
      </section>

        {/* Right Side: Frota de Motoristas */}
        <section className="glass-panel">
          <div className="panel-header">
            <h2>Frota de Motoristas</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '550px', overflowY: 'auto' }}>
            {drivers.map(d => {
              const pinFormatado = d.codigoVinculo
                ? `${d.codigoVinculo.substring(0, 3)}-${d.codigoVinculo.substring(3)}`
                : '---';
              return (
                <div key={d.id} className="driver-card">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <span style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span 
                        style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          background: d.dispositivoConectado ? 'var(--color-emerald)' : '#4b5563', 
                          boxShadow: d.dispositivoConectado ? '0 0 8px var(--color-emerald)' : 'none',
                          display: 'inline-block' 
                        }}
                        title={d.dispositivoConectado ? 'Celular conectado' : 'Dispositivo offline'}
                      />
                      {getVehicleIcon(d.vehicleType)} 
                      {d.name}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '1.25rem', fontFamily: 'monospace' }}>
                      PIN: <strong style={{ color: 'var(--color-cyan)' }}>{pinFormatado}</strong>
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className={`card-badge ${!d.dispositivoConectado ? 'offline' : d.status === 'ocioso' ? 'completed' : 'failed'}`} style={{ textTransform: 'capitalize', fontSize: '0.7rem' }}>
                      {!d.dispositivoConectado ? 'Offline' : d.status === 'ocioso' ? 'Disponível' : 'Em Rota'}
                    </span>
                    <button 
                      className="icon-btn danger" 
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-rose)', display: 'flex', padding: '0.2rem' }}
                      title="Excluir Motoboy"
                      onClick={() => handleDeleteDriver(d.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

      </div>
      {showThermalReceipt && activeManifest && createPortal(
        <div className="thermal-overlay">
          <div className="thermal-modal-content">

            {/* Barra de Ações — oculta na impressão via @media print */}
            <div className="thermal-actions-bar no-print">
              <span style={{ fontSize: '0.75rem', color: '#6b7280', fontFamily: 'sans-serif' }}>
                Visualização dos Cupons — {activeManifest.id}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="thermal-btn-print"
                  onClick={() => window.print()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    <path d="M6 9V3h12v6" />
                    <rect width="12" height="8" x="6" y="14" rx="1" />
                  </svg>
                  Imprimir Guias
                </button>
                <button
                  className="thermal-btn-close"
                  onClick={() => setShowThermalReceipt(false)}
                >
                  Fechar
                </button>
              </div>
            </div>

            {/* Área impressa — única visível no @media print */}
            <div className="thermal-print-area">

            {/* ======================================================== */}
            {/* CUPOM 1: RESUMO DO ROMANEIO (Cupom de Saida)              */}
            {/* ======================================================== */}
            <div className="thermal-cupom">
              <div className="thermal-center thermal-title">ROMANEIO DE ENTREGA</div>
              <div className="thermal-divider-solid" />
              <div className="thermal-row"><span>ROMANEIO:</span> <span className="thermal-mono">{activeManifest.id}</span></div>
              <div className="thermal-row"><span>DATA/HORA:</span> <span>{new Date().toLocaleString('pt-BR')}</span></div>
              <div className="thermal-row"><span>MOTORISTA:</span> <span>{activeManifest.driverName}</span></div>
              <div className="thermal-divider-dashed" />
              <div className="thermal-row"><span>QTD COMANDAS:</span> <span className="thermal-mono">{activeManifest.deliveryIds.length}</span></div>
              <div className="thermal-divider-solid" />
              <div style={{ fontWeight: 'bold', marginBottom: '0.3rem' }}>RESUMO DE VALORES A COBRAR NA RUA:</div>
              <div className="thermal-divider-dashed" />
              {activeManifest.deliveryIds.map(id => {
                const d = deliveries.find(del => del.id === id);
                if (!d) return null;
                const fp = d.formaPagamento || 'maquininha';
                const fpLabel = fp === 'maquininha' ? 'CARTAO (MAQUININHA)' : fp === 'pix' ? 'PIX' : 'DINHEIRO';
                return (
                  <div key={id} className="thermal-row" style={{ fontSize: '0.76rem' }}>
                    <span className="thermal-mono">{d.id}:</span>
                    <span>R$ {getDeliveryValue(d).toFixed(2)} — {fpLabel}</span>
                  </div>
                );
              })}
              <div className="thermal-divider-dashed" />
              <div className="thermal-row thermal-total">
                <span>TOTAL A RECEBER NA RUA:</span>
                <span>R$ {activeManifest.totalValue.toFixed(2)}</span>
              </div>
              <div className="thermal-divider-solid" />
              <div className="thermal-center thermal-footer">* AGUARDANDO SAIDA DO MOTORISTA *</div>
            </div>

            {/* ======================================================== */}
            {/* CUPOM 2: FICHAS INDIVIDUAIS (uma por comanda)             */}
            {/* ======================================================== */}
            {activeManifest.deliveryIds.map((id, idx) => {
              const d = deliveries.find(del => del.id === id);
              if (!d) return null;
              const fp = d.formaPagamento || 'maquininha';
              const fpLabel = fp === 'maquininha' ? 'MAQUININHA (A COBRAR)' : fp === 'pix' ? 'PIX (A RECEBER)' : 'DINHEIRO (A RECEBER)';
              return (
                <div key={id} className="thermal-cupom">
                  <div className="thermal-center" style={{ fontSize: '0.7rem', marginBottom: '0.1rem' }}>FICHA {idx + 1} DE {activeManifest.deliveryIds.length}</div>
                  <div className="thermal-center thermal-title" style={{ fontSize: '0.95rem' }}>
                    {(d.nomeEmpresa || sessao?.nomeEmpresa || d.nomeLoja || sessao?.nomeLoja || 'FARMACIA & RESTAURANTE').toUpperCase()}
                  </div>
                  <div className="thermal-divider-solid" />
                  <div className="thermal-row"><span>COMANDA:</span> <span className="thermal-mono">{d.id}</span></div>
                  <div className="thermal-row"><span>ROMANEIO:</span> <span className="thermal-mono">{activeManifest.id}</span></div>
                  <div className="thermal-divider-dashed" />
                  <div className="thermal-row"><span>CLIENTE:</span> <span>{d.nomeCliente.toUpperCase()}</span></div>
                  {d.clienteDocumento && <div className="thermal-row"><span>CPF/CNPJ:</span> <span>{d.clienteDocumento}</span></div>}
                  <div className="thermal-row"><span>ENDERECO:</span> <span>{d.endereco}</span></div>
                  {d.bairro && <div className="thermal-row"><span>BAIRRO:</span> <span>{d.bairro.toUpperCase()}</span></div>}
                  {d.referencia && <div className="thermal-row"><span>REF:</span> <span>{d.referencia}</span></div>}
                  <div className="thermal-divider-dashed" />
                  <div style={{ fontWeight: 'bold', marginBottom: '0.3rem' }}>ITENS DO PEDIDO:</div>
                  {d.itens.map((item, i) => (
                    <div key={i} style={{ fontSize: '0.76rem', paddingLeft: '0.5rem' }}>
                      {i + 1}x {item}
                    </div>
                  ))}
                  <div className="thermal-divider-dashed" />
                  <div className="thermal-row" style={{ fontWeight: 'bold' }}>
                    <span>FORMA DE PAGAMENTO:</span>
                  </div>
                  <div style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '0.85rem', margin: '0.2rem 0' }}>{fpLabel}</div>
                  <div className="thermal-row thermal-total">
                    <span>VALOR TOTAL DO PEDIDO:</span>
                    <span>R$ {getDeliveryValue(d).toFixed(2)}</span>
                  </div>
                  <div className="thermal-divider-solid" />
                  <div className="thermal-center thermal-footer">* CONFIRMAR COM CLIENTE NA ENTREGA *</div>
                </div>
              );
            })}

          </div>
          </div>
        </div>
      , document.body)}

      {/* Botão Flutuante de Ação (FAB) */}
      <div className="fab-container">
        {fabOpen && (
          <div className="fab-menu">
            <button 
              className="fab-menu-item" 
              onClick={() => {
                setFabOpen(false);
                setReportPhase('filters');
                setReportModalOpen(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
              Gerar Relatório de Desempenho
            </button>
            <button 
              className="fab-menu-item" 
              onClick={() => {
                setFabOpen(false);
                setShowDriverModal(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <line x1="20" y1="8" x2="20" y2="14" />
                <line x1="23" y1="11" x2="17" y2="11" />
              </svg>
              Cadastrar Motoboy
            </button>
            <button 
              className="fab-menu-item" 
              onClick={() => {
                setFabOpen(false);
                setShowVehicleModal(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="3" width="15" height="13" />
                <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
                <circle cx="5.5" cy="18.5" r="2.5" />
                <circle cx="18.5" cy="18.5" r="2.5" />
              </svg>
              Cadastrar Tipo de Veículo
            </button>
          </div>
        )}
        <button 
          className={`fab-button ${fabOpen ? 'active' : ''}`}
          onClick={() => setFabOpen(prev => !prev)}
          title="Menu de Ações"
        >
          {fabOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
      </div>

      {/* Modal do Relatório Analítico */}
      {reportModalOpen && createPortal(
        <div className="report-modal-overlay" onClick={() => setReportModalOpen(false)}>
          <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="report-modal-header">
              <h2>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-cyan)' }}>
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
                Análise de Desempenho da Frota
              </h2>
              <button className="report-modal-close-btn" onClick={() => setReportModalOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="report-modal-body">
              {reportPhase === 'filters' ? (
                /* FASE 1: Filtros do Relatório */
                <form onSubmit={handleTriggerGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div className="form-group">
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Data Inicial</label>
                      <input 
                        type="date" 
                        className="date-input-dark" 
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Data Final</label>
                      <input 
                        type="date" 
                        className="date-input-dark" 
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Filtros Rápidos de Período</label>
                    <div className="shortcut-buttons">
                      <button type="button" className="shortcut-btn" onClick={() => handleShortcutFilter('hoje')}>Hoje</button>
                      <button type="button" className="shortcut-btn" onClick={() => handleShortcutFilter('7dias')}>Últimos 7 dias</button>
                      <button type="button" className="shortcut-btn" onClick={() => handleShortcutFilter('esteMes')}>Este Mês</button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Seleção de Entregador</label>
                    <select 
                      className="form-select" 
                      value={selectedDriverId} 
                      onChange={(e) => setSelectedDriverId(e.target.value)}
                    >
                      <option value="Todos">Todos os Entregadores</option>
                      {drivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>

                  <button 
                    type="submit" 
                    className="btn btn-primary" 
                    style={{ 
                      marginTop: '0.5rem', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      gap: '0.5rem',
                      opacity: isGenerating ? 0.75 : 1,
                      cursor: isGenerating ? 'not-allowed' : 'pointer'
                    }}
                    disabled={isGenerating}
                  >
                    {isGenerating ? (
                      <>
                        <svg className="spinner-rotate" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                          <line x1="12" y1="2" x2="12" y2="6" />
                          <line x1="12" y1="18" x2="12" y2="22" />
                          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                          <line x1="2" y1="12" x2="6" y2="12" />
                          <line x1="18" y1="12" x2="22" y2="12" />
                          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
                        </svg>
                        Buscando no Banco de Dados...
                      </>
                    ) : (
                      'Gerar Relatório'
                    )}
                  </button>
                </form>
              ) : (
                /* FASE 2: Exibição do Relatório / Dashboard */
                <div>
                  <div className="report-sub-header">
                    <div>
                      <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {sessao?.tipo === 'loja' ? 'Painel de Indicadores & Analytics' : 'Análise de Desempenho da Frota'}
                      </h3>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Período: {formatarDataBR(startDate)} até {formatarDataBR(endDate)}
                        {selectedDriverId !== 'Todos' && ` | Filtro: ${drivers.find(d => d.id === selectedDriverId)?.name}`}
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button 
                        type="button"
                        className="btn btn-secondary btn-small"
                        style={{ fontSize: '0.72rem', padding: '0.35rem 0.6rem' }}
                        onClick={() => setReportPhase('filters')}
                      >
                        Voltar aos Filtros
                      </button>
                      <button 
                        type="button"
                        className="btn btn-success btn-small"
                        style={{ fontSize: '0.72rem', padding: '0.35rem 0.6rem' }}
                        onClick={handleExportCSV}
                      >
                        Exportar Excel
                      </button>
                    </div>
                  </div>

                  {/* KPIs */}
                  <div className="report-kpi-grid">
                    <div className="report-kpi-card">
                      <span className="kpi-label">Entregas Realizadas</span>
                      <span className="kpi-value">{totalConcluidas}</span>
                    </div>
                    <div className="report-kpi-card">
                      <span className="kpi-label">Tempo Médio (SLA)</span>
                      <span className="kpi-value">{tempoMedioSla} min</span>
                    </div>
                    <div className="report-kpi-card">
                      <span className="kpi-label">Taxa de Sucesso</span>
                      <span className="kpi-value" style={{ color: taxaSucesso > 80 ? 'var(--color-emerald)' : 'var(--color-amber)' }}>{taxaSucesso}%</span>
                    </div>
                  </div>

                  {/* Abas analíticas (Exclusivo da visão de loja) */}
                  {sessao?.tipo === 'loja' && (
                    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-thin)', paddingBottom: '0.6rem', flexWrap: 'wrap' }}>
                      <button 
                        type="button"
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.75rem', 
                          padding: '0.3rem 0.6rem', 
                          background: activeReportTab === 'fleet' ? '#0891b2' : 'var(--bg-card)', 
                          color: activeReportTab === 'fleet' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid ' + (activeReportTab === 'fleet' ? '#0891b2' : 'var(--border-thin)'),
                          borderRadius: '4px'
                        }}
                        onClick={() => setActiveReportTab('fleet')}
                      >
                        Frota e Desempenho
                      </button>
                      <button 
                        type="button"
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.75rem', 
                          padding: '0.3rem 0.6rem', 
                          background: activeReportTab === 'regions' ? '#0891b2' : 'var(--bg-card)', 
                          color: activeReportTab === 'regions' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid ' + (activeReportTab === 'regions' ? '#0891b2' : 'var(--border-thin)'),
                          borderRadius: '4px'
                        }}
                        onClick={() => setActiveReportTab('regions')}
                      >
                        Vendas por Região
                      </button>
                      <button 
                        type="button"
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.75rem', 
                          padding: '0.3rem 0.6rem', 
                          background: activeReportTab === 'finance' ? '#0891b2' : 'var(--bg-card)', 
                          color: activeReportTab === 'finance' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid ' + (activeReportTab === 'finance' ? '#0891b2' : 'var(--border-thin)'),
                          borderRadius: '4px'
                        }}
                        onClick={() => setActiveReportTab('finance')}
                      >
                        Financeiro e SLA
                      </button>
                      <button 
                        type="button"
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.75rem', 
                          padding: '0.3rem 0.6rem', 
                          background: activeReportTab === 'travel_time' ? '#0891b2' : 'var(--bg-card)', 
                          color: activeReportTab === 'travel_time' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid ' + (activeReportTab === 'travel_time' ? '#0891b2' : 'var(--border-thin)'),
                          borderRadius: '4px'
                        }}
                        onClick={() => setActiveReportTab('travel_time')}
                      >
                        Tempo de Trajeto
                      </button>
                      <button 
                        type="button"
                        className="btn btn-small" 
                        style={{ 
                          fontSize: '0.75rem', 
                          padding: '0.3rem 0.6rem', 
                          background: activeReportTab === 'incidents' ? '#0891b2' : 'var(--bg-card)', 
                          color: activeReportTab === 'incidents' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid ' + (activeReportTab === 'incidents' ? '#0891b2' : 'var(--border-thin)'),
                          borderRadius: '4px'
                        }}
                        onClick={() => setActiveReportTab('incidents')}
                      >
                        Incidentes e Alertas
                      </button>
                    </div>
                  )}

                  {/* Renderização condicional de Abas */}
                  {(!sessao || sessao.tipo !== 'loja' || activeReportTab === 'fleet') && (
                    <>
                      {/* Gráfico Principal */}
                      <div className="chart-svg-container" style={{ marginBottom: '1.25rem' }}>
                        <h4 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', fontWeight: 600 }}>Entregas por Entregador no Período</h4>
                        <svg width="100%" height="200" viewBox={`0 0 ${chartWidth} 200`} style={{ overflow: 'visible' }}>
                          <defs>
                            <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--color-emerald)" stopOpacity="1" />
                              <stop offset="100%" stopColor="rgba(16, 185, 129, 0.2)" stopOpacity="0.2" />
                            </linearGradient>
                            <linearGradient id="gradFail" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--color-rose)" stopOpacity="1" />
                              <stop offset="100%" stopColor="rgba(244, 63, 94, 0.2)" stopOpacity="0.2" />
                            </linearGradient>
                          </defs>

                          {/* Grade de fundo */}
                          <line x1="50" y1="30" x2={chartWidth - 20} y2="30" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="75" x2={chartWidth - 20} y2="75" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="120" x2={chartWidth - 20} y2="120" stroke="rgba(255,255,255,0.03)" strokeDasharray="3,3" />
                          <line x1="50" y1="160" x2={chartWidth - 20} y2="160" stroke="var(--border-thin)" strokeWidth="1" />

                          {/* Eixo Y */}
                          <text x="38" y="34" fill="var(--text-secondary)" fontSize="9" textAnchor="end">{maxVolume}</text>
                          <text x="38" y="98" fill="var(--text-secondary)" fontSize="9" textAnchor="end">{Math.round(maxVolume / 2)}</text>
                          <text x="38" y="163" fill="var(--text-secondary)" fontSize="9" textAnchor="end">0</text>

                          {/* Barras por motorista */}
                          {motoristasPerformance.map((drv, idx) => {
                            const xOffset = 80 + idx * 100;
                            const scale = 120 / maxVolume;
                            const heightSuccess = drv.concluidas * scale;
                            const heightCancel = drv.canceladas * scale;

                            return (
                              <g key={drv.id}>
                                {/* Barra Sucesso */}
                                <rect 
                                  x={xOffset} 
                                  y={160 - heightSuccess} 
                                  width="24" 
                                  height={heightSuccess} 
                                  fill="url(#gradSuccess)" 
                                  rx="3"
                                  stroke="var(--color-emerald)"
                                  strokeWidth="0.5"
                                />
                                {drv.concluidas > 0 && (
                                  <text x={xOffset + 12} y={155 - heightSuccess} fill="var(--color-emerald)" fontSize="9" textAnchor="middle" fontWeight="bold">
                                    {drv.concluidas}
                                  </text>
                                )}

                                {/* Barra Cancelamento */}
                                <rect 
                                  x={xOffset + 28} 
                                  y={160 - heightCancel} 
                                  width="24" 
                                  height={heightCancel} 
                                  fill="url(#gradFail)" 
                                  rx="3"
                                  stroke="var(--color-rose)"
                                  strokeWidth="0.5"
                                />
                                {drv.canceladas > 0 && (
                                  <text x={xOffset + 40} y={155 - heightCancel} fill="var(--color-rose)" fontSize="9" textAnchor="middle" fontWeight="bold">
                                    {drv.canceladas}
                                  </text>
                                )}

                                {/* Rótulo Eixo X */}
                                <text x={xOffset + 26} y="178" fill="var(--text-primary)" fontSize="9" textAnchor="middle">
                                  {drv.name.split(' ')[0]}
                                </text>
                              </g>
                            );
                          })}
                        </svg>
                        
                        <div className="chart-legends">
                          <div className="legend-item">
                            <span className="legend-color" style={{ backgroundColor: 'var(--color-emerald)', border: '1px solid var(--color-emerald)' }}></span>
                            <span style={{ color: 'var(--text-secondary)' }}>Concluídas com Sucesso</span>
                          </div>
                          <div className="legend-item">
                            <span className="legend-color" style={{ backgroundColor: 'var(--color-rose)', border: '1px solid var(--color-rose)' }}></span>
                            <span style={{ color: 'var(--text-secondary)' }}>Canceladas / Devolvidas</span>
                          </div>
                        </div>
                      </div>

                      {/* Tabela de Desempenho */}
                      <div style={{ overflowX: 'auto', border: '1px solid var(--border-thin)', borderRadius: '8px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-thin)', color: 'var(--text-secondary)' }}>
                              <th style={{ padding: '0.6rem 0.8rem' }}>Entregador</th>
                              <th style={{ padding: '0.6rem 0.8rem' }}>Veículo</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'center' }}>Concluídas</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'center' }}>Canceladas</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'right' }}>Faturamento</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'center' }}>Nota Média</th>
                            </tr>
                          </thead>
                          <tbody>
                            {motoristasPerformance
                              .filter(m => selectedDriverId === 'Todos' || m.id === selectedDriverId)
                              .map(m => (
                                <tr key={m.id} style={{ borderBottom: '1px solid var(--border-thin)' }}>
                                  <td style={{ padding: '0.6rem 0.8rem', fontWeight: 500, color: 'var(--text-primary)' }}>{m.name}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textTransform: 'capitalize', color: 'var(--text-secondary)' }}>{m.veiculo === 'refrigerated_truck' ? 'Caminhão Refrigerado' : m.veiculo === 'motorcycle' ? 'Motocicleta' : m.veiculo}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'center', fontWeight: 'bold', color: 'var(--color-emerald)' }}>{m.concluidas}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'center', fontWeight: 'bold', color: 'var(--color-rose)' }}>{m.canceladas}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--color-cyan)' }}>R$ {m.faturamento.toFixed(2)}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'center' }}>
                                    <span className="card-badge completed" style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.08)', color: 'var(--color-emerald)', border: '1px solid rgba(16, 185, 129, 0.15)' }}>
                                      ★ {m.avaliacaoMedia}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {sessao?.tipo === 'loja' && activeReportTab === 'regions' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>Entregas por Região / Bairro</h4>
                      {regioesPerformance.length === 0 ? (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem', border: '1px dashed var(--border-thin)', borderRadius: '8px' }}>
                          Nenhuma entrega com informação de bairro no período.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '1rem' }}>
                          {regioesPerformance.map(r => {
                            const scale = (r.total / maxRegionVolume) * 100;
                            return (
                              <div key={r.bairro} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.bairro}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    <strong>{r.total}</strong> comandas ({r.sucesso} OK / {r.cancelado} Falhas) | <strong style={{ color: 'var(--color-cyan)' }}>R$ {r.faturamento.toFixed(2)}</strong>
                                  </span>
                                </div>
                                <div style={{ width: '100%', height: '8px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '4px', overflow: 'hidden' }}>
                                  <div style={{ width: `${scale}%`, height: '100%', background: 'linear-gradient(90deg, var(--color-cyan), var(--color-blue))', borderRadius: '4px' }}></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {sessao?.tipo === 'loja' && activeReportTab === 'finance' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                      <div>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>Faturamento por Forma de Pagamento</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Faturamento via Pix</span>
                            <strong style={{ fontSize: '1.1rem', color: 'var(--color-emerald)', fontFamily: 'var(--font-mono)' }}>R$ {pagamentosMap.pix.toFixed(2)}</strong>
                          </div>
                          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Faturamento via Cartão (Maquininha)</span>
                            <strong style={{ fontSize: '1.1rem', color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>R$ {pagamentosMap.maquininha.toFixed(2)}</strong>
                          </div>
                          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Faturamento via Dinheiro</span>
                            <strong style={{ fontSize: '1.1rem', color: 'var(--color-amber)', fontFamily: 'var(--font-mono)' }}>R$ {pagamentosMap.dinheiro.toFixed(2)}</strong>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>Tempo Médio de SLA por Prioridade de Pedido</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
                          {prioridadesSla.map(p => {
                            const badgeColor = p.prioridade === 'critica' ? 'var(--color-rose)' : p.prioridade === 'alta' ? 'var(--color-amber)' : p.prioridade === 'media' ? 'var(--color-blue)' : 'var(--text-secondary)';
                            return (
                              <div key={p.prioridade} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                <span style={{ fontSize: '0.72rem', color: badgeColor, textTransform: 'capitalize', fontWeight: 'bold' }}>• {p.prioridade}</span>
                                <strong style={{ fontSize: '1.1rem', color: '#fff', fontFamily: 'var(--font-mono)' }}>{p.slaMedio} min</strong>
                                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>Com base em {p.totalSucesso} entregas</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {sessao?.tipo === 'loja' && activeReportTab === 'travel_time' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                      <div>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>Tempo Médio de Trajeto por Motoboy</h4>
                        {motoboysTrajeto.length === 0 ? (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem', border: '1px dashed var(--border-thin)', borderRadius: '8px' }}>
                            Sem dados de romaneios concluídos no período.
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                            {motoboysTrajeto.map(m => (
                              <div key={m.driverId} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{m.name}</span>
                                <strong style={{ fontSize: '1.15rem', color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>{m.tempoMedioTrajeto} min</strong>
                                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>Média sobre {m.totalRomaneios} romaneios</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>Histórico de Romaneios & Trajetos</h4>
                        {romaneiosAnalise.length === 0 ? (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem', border: '1px dashed var(--border-thin)', borderRadius: '8px' }}>
                            Nenhum romaneio gerado no período.
                          </div>
                        ) : (
                          <div style={{ overflowX: 'auto', border: '1px solid var(--border-thin)', borderRadius: '8px' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', textAlign: 'left' }}>
                              <thead>
                                <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-thin)', color: 'var(--text-secondary)' }}>
                                  <th style={{ padding: '0.5rem 0.6rem' }}>Cód. Romaneio</th>
                                  <th style={{ padding: '0.5rem 0.6rem' }}>Entregador</th>
                                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>Qtd Comandas</th>
                                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>Horário</th>
                                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>Tempo Trajeto</th>
                                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Faturamento</th>
                                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {romaneiosAnalise.map(r => (
                                  <tr key={r.romId} style={{ borderBottom: '1px solid var(--border-thin)' }}>
                                    <td style={{ padding: '0.5rem 0.6rem', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{r.romId}</td>
                                    <td style={{ padding: '0.5rem 0.6rem', color: 'var(--text-secondary)' }}>{r.driverName}</td>
                                    <td style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>{r.totalDels} ({r.concluidas} OK)</td>
                                    <td style={{ padding: '0.5rem 0.6rem', textAlign: 'center', color: 'var(--text-muted)' }}>{r.horaInicio} até {r.horaFim}</td>
                                    <td style={{ padding: '0.5rem 0.6rem', textAlign: 'center', fontWeight: '500', color: 'var(--color-cyan)' }}>{r.tempoTrajetoMin} min</td>
                                    <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>R$ {r.totalValue.toFixed(2)}</td>
                                    <td style={{ padding: '0.5rem 0.6rem', textAlign: 'center' }}>
                                      <span className={`card-badge ${r.romStatus === 'Concluído' ? 'completed' : 'in_transit'}`} style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem' }}>
                                        {r.romStatus}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {sessao?.tipo === 'loja' && activeReportTab === 'incidents' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>Detalhamento de Exceções & Incidentes de Rota</h4>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Trânsito Intenso</span>
                            <strong style={{ fontSize: '1.2rem', color: 'var(--color-rose)' }}>{incidentesTiposCount.traffic_jam} ocorrências</strong>
                          </div>
                        </div>
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Problemas no Veículo</span>
                            <strong style={{ fontSize: '1.2rem', color: 'var(--color-rose)' }}>{incidentesTiposCount.flat_tire} ocorrências</strong>
                          </div>
                        </div>
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Alerta de Temperatura</span>
                            <strong style={{ fontSize: '1.2rem', color: 'var(--color-rose)' }}>{incidentesTiposCount.temperature_spike} ocorrências</strong>
                          </div>
                        </div>
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-thin)', borderRadius: '8px', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Desvios de Rota</span>
                            <strong style={{ fontSize: '1.2rem', color: 'var(--color-rose)' }}>{incidentesTiposCount.route_deviation} ocorrências</strong>
                          </div>
                        </div>
                      </div>

                      <div style={{ background: 'rgba(16, 185, 129, 0.04)', border: '1px solid rgba(16, 185, 129, 0.15)', borderRadius: '8px', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                          {totalIncidentes === 0 ? 'Excelente! Zero incidentes de rota registrados no período selecionado.' : `Registrados ${totalIncidentes} incidentes/exceções no período.`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      , document.body)}

      {/* Modal de Cadastro de Motoboy */}
      {showDriverModal && createPortal(
        <div className="report-modal-overlay" onClick={() => setShowDriverModal(false)}>
          <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="report-modal-header">
              <h2>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-cyan)', marginRight: '0.5rem' }}>
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                </svg>
                Motoboys da Frota
              </h2>
              <button className="report-modal-close-btn" onClick={() => setShowDriverModal(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="report-modal-body">
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
                Motoboys Cadastrados
              </label>
              
              {/* Lista vertical de motoboys */}
              <div style={{ 
                maxHeight: '180px', 
                overflowY: 'auto', 
                marginBottom: '1.25rem', 
                border: '1px solid var(--border-thin)', 
                borderRadius: '8px', 
                display: 'flex', 
                flexDirection: 'column', 
                background: 'rgba(0,0,0,0.1)'
              }}>
                {drivers.map((d, index) => (
                  <div 
                    key={d.id} 
                    style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center', 
                      padding: '0.6rem 0.8rem',
                      borderBottom: index === drivers.length - 1 ? 'none' : '1px solid var(--border-thin)'
                    }}
                  >
                    <span style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-primary)' }}>
                      {getVehicleIcon(d.vehicleType)}
                      <span style={{ fontWeight: 500 }}>{d.name}</span>
                      <span style={{ 
                        fontSize: '0.65rem', 
                        padding: '0.1rem 0.3rem', 
                        borderRadius: '4px',
                        marginLeft: '0.25rem',
                        background: !d.dispositivoConectado ? 'rgba(156, 163, 175, 0.08)' : d.status === 'ocioso' ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)',
                        color: !d.dispositivoConectado ? '#9ca3af' : d.status === 'ocioso' ? 'var(--color-emerald)' : 'var(--color-rose)',
                        textTransform: 'capitalize'
                      }}>
                        {!d.dispositivoConectado ? 'offline' : d.status === 'ocioso' ? 'disponível' : 'em rota'}
                      </span>
                    </span>
                    <button 
                      type="button" 
                      style={{ 
                        background: 'transparent', 
                        border: 'none', 
                        color: 'var(--color-rose)', 
                        cursor: d.status === 'ocupado' ? 'not-allowed' : 'pointer', 
                        padding: '0.2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: d.status === 'ocupado' ? 0.35 : 0.8
                      }}
                      disabled={d.status === 'ocupado'}
                      onClick={() => handleDeleteDriver(d.id)}
                      title={d.status === 'ocupado' ? 'Motoboy em rota não pode ser removido' : 'Remover Motoboy'}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              <form onSubmit={handleSubmitDriver} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Cadastrar Novo Motoboy</label>
                <div className="form-group" style={{ marginBottom: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={newDriverName} 
                    onChange={(e) => setNewDriverName(e.target.value)} 
                    placeholder="Nome (ex: Pedro Henrique Moto-05)"
                    required 
                  />
                </div>
                <div className="form-group" style={{ marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select 
                      className="form-select" 
                      value={newDriverVehicleType} 
                      onChange={(e) => setNewDriverVehicleType(e.target.value)}
                      style={{ flex: 1 }}
                    >
                      {vehicleTypes.map(vt => (
                        <option key={vt.id} value={vt.id}>{vt.name}</option>
                      ))}
                    </select>
                    <button 
                      type="button" 
                      className="btn btn-secondary btn-small"
                      style={{ padding: '0.6rem 0.8rem', whiteSpace: 'nowrap' }}
                      onClick={() => {
                        setShowDriverModal(false);
                        setShowVehicleModal(true);
                      }}
                    >
                      + Novo Tipo
                    </button>
                  </div>
                </div>
                <button type="submit" className="btn btn-primary" style={{ marginTop: '0.25rem' }}>
                  Salvar Motoboy
                </button>
              </form>
            </div>
          </div>
        </div>
      , document.body)}

      {showVehicleModal && createPortal(
        <div className="report-modal-overlay" onClick={() => setShowVehicleModal(false)}>
          <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="report-modal-header">
              <h2>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-emerald)', marginRight: '0.5rem' }}>
                  <rect x="1" y="3" width="15" height="13" />
                  <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
                </svg>
                Tipos de Veículo
              </h2>
              <button className="report-modal-close-btn" onClick={() => setShowVehicleModal(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="report-modal-body">
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
                Tipos de Veículos Cadastrados
              </label>
              
              <div style={{ 
                maxHeight: '150px', 
                overflowY: 'auto', 
                marginBottom: '1.25rem', 
                border: '1px solid var(--border-thin)', 
                borderRadius: '8px', 
                padding: '0.6rem', 
                display: 'flex', 
                flexWrap: 'wrap', 
                gap: '0.5rem',
                background: 'rgba(0,0,0,0.1)'
              }}>
                {vehicleTypes.map(vt => (
                  <span 
                    key={vt.id} 
                    style={{ 
                      display: 'inline-flex', 
                      alignItems: 'center', 
                      gap: '0.35rem', 
                      fontSize: '0.72rem', 
                      padding: '0.3rem 0.5rem', 
                      borderRadius: '6px',
                      background: 'rgba(16, 185, 129, 0.08)', 
                      color: 'var(--color-emerald)', 
                      border: '1px solid rgba(16, 185, 129, 0.15)',
                      fontWeight: 500
                    }}
                  >
                    {getVehicleIcon(vt.id)}
                    {vt.name}
                  </span>
                ))}
              </div>

              <form onSubmit={handleSubmitVehicle} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Incluir Novo Veículo</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={newVehicleName} 
                    onChange={(e) => setNewVehicleName(e.target.value)} 
                    placeholder="Ex: Carro, Patinete Elétrico"
                    required 
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-success" style={{ padding: '0 1rem', whiteSpace: 'nowrap' }}>
                    + Incluir
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      , document.body)}

      {editingLoja && createPortal(
        <div className="report-modal-overlay" onClick={() => setEditingLoja(null)}>
          <div className="report-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="report-modal-header">
              <h2>Editar Informações da Loja</h2>
              <button className="report-modal-close-btn" onClick={() => setEditingLoja(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="report-modal-body">
              <form onSubmit={handleUpdateLoja} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                <div className="form-group">
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Nome Fantasia</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={editLojaNome} 
                    onChange={e => setEditLojaNome(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CNPJ da Loja</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={editLojaCnpj} 
                    onChange={e => setEditLojaCnpj(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Usuário de Acesso</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={editLojaUsuario} 
                    onChange={e => setEditLojaUsuario(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Alterar Senha (deixe em branco para manter a atual)</label>
                  <input 
                    type="password" 
                    className="form-input" 
                    value={editLojaSenha} 
                    onChange={e => setEditLojaSenha(e.target.value)} 
                    placeholder="Nova senha da loja"
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CEP</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaCep}
                      onChange={e => setEditLojaCep(e.target.value)}
                      placeholder="00000-000"
                      maxLength={9}
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>UF</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaUf}
                      onChange={e => setEditLojaUf(e.target.value.toUpperCase())}
                      placeholder="SP"
                      maxLength={2}
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.6rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Endereço (Logradouro)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaEndereco}
                      onChange={e => setEditLojaEndereco(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Número</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaNumero}
                      onChange={e => setEditLojaNumero(e.target.value)}
                      placeholder="123"
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Bairro</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaBairro}
                      onChange={e => setEditLojaBairro(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Cidade</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editLojaCidade}
                      onChange={e => setEditLojaCidade(e.target.value)}
                    />
                  </div>
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <input
                    type="checkbox"
                    id="editLojaRecebePedidos"
                    checked={editLojaRecebePedidos} 
                    onChange={e => setEditLojaRecebePedidos(e.target.checked)} 
                    style={{ accentColor: 'var(--color-cyan)', cursor: 'pointer', width: '15px', height: '15px' }}
                  />
                  <label htmlFor="editLojaRecebePedidos" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 0 }}>
                    Ativar Fila de Pedidos (WhatsApp)
                  </label>
                </div>
                <button type="submit" className="btn btn-success" style={{ width: '100%', marginTop: '0.5rem' }}>Salvar Alterações</button>
              </form>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}

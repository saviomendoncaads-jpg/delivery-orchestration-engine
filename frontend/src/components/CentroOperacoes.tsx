import { useMemo } from 'react';
import { BentoItem } from './ui/cybernetic-bento-grid';

/**
 * Centro de Operações — painel operacional AO VIVO.
 *
 * Não inventa dado: todos os números derivam do mesmo estado que já chega pelo
 * socket `system_status` (entregas/motoristas) e do feed `broker_event` (eventos).
 *
 * SLA no prazo (v1): regra "derivar de SLA_ALERTA" — % da operação de hoje
 * (ativas + concluídas) que NÃO está nem esteve em alerta de SLA. É um indicador
 * vivo, sem precisar de um campo de prazo/deadline por entrega no backend.
 */

// Tipos estruturais mínimos (só os campos usados) — evita acoplar ao App.tsx.
interface EntregaLite {
  id: string;
  status: string;
  valor?: number;
  despachadoEm?: string;
  dataHoraConclusao?: string;
  atualizadoEm?: string;
  criadoEm?: string;
}

interface MotoristaLite {
  id: string;
  name: string;
  status?: string;
  dispositivoConectado?: boolean;
}

export interface BrokerEvento {
  id: string;
  topic: string;
  deliveryId: string;
  payload?: any;
  timestamp: string;
}

interface Props {
  deliveries: EntregaLite[];
  drivers: MotoristaLite[];
  liveEvents: BrokerEvento[];
  zona?: string;
}

const STATUS_ATIVOS = ['DESPACHADO', 'EM_TRANSITO', 'NO_LOCAL', 'ALERTA_INCIDENTE', 'SLA_ALERTA'];
// Comandas "encerradas" do dia — não contam mais como operação em aberto.
const STATUS_FINALIZADOS = ['ENTREGUE', 'RECUSADO_INSUCESSO', 'CANCELADO', 'PRODUTO_RETORNADO_ESTOQUE'];
// Comandas que ainda não saíram para entrega (fila de despacho).
const STATUS_AGUARDANDO = ['RECEBIDO', 'EM_PREPARO'];
// Logística reversa: entregas que voltaram (insucesso/recusa ou retorno ao CD/estoque).
const STATUS_DEVOLVIDAS = ['RECUSADO_INSUCESSO', 'AGUARDANDO_RETORNO_CD', 'PRODUTO_RETORNADO_ESTOQUE'];
const META_SLA = 95; // meta de SLA no prazo (%)

function isHoje(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function CentroOperacoes({ deliveries, drivers, liveEvents, zona }: Props) {
  const m = useMemo(() => {
    // Isolamento multi-tenant: o backend transmite broker_event globalmente (io.emit),
    // então só consideramos eventos de entregas que pertencem a ESTE painel.
    const idsLocais = new Set(deliveries.map(d => d.id));
    const eventosTenant = liveEvents.filter(e => idsLocais.has(e.deliveryId));

    const ativas = deliveries.filter(d => STATUS_ATIVOS.includes(d.status));
    const despachando = ativas.filter(d => d.status === 'DESPACHADO').length;
    const concluidasHoje = deliveries.filter(d => d.status === 'ENTREGUE' && isHoje(d.dataHoraConclusao || d.atualizadoEm));

    // Tempo médio por entrega (min): conclusão − despacho, só onde há os dois carimbos.
    const duracoes = concluidasHoje
      .map(d => {
        const fim = new Date(d.dataHoraConclusao || d.atualizadoEm || '').getTime();
        const ini = new Date(d.despachadoEm || d.criadoEm || '').getTime();
        return fim && ini && fim > ini ? (fim - ini) / 60000 : NaN;
      })
      .filter(v => !Number.isNaN(v));
    const tempoMedio = duracoes.length ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length) : 0;

    // SLA no prazo: IDs que dispararam SLA_ALERTA no feed (ou estão nele agora).
    const breachIds = new Set<string>(
      eventosTenant.filter(e => e.topic === 'ALERTA_GERADO' && e.payload?.status === 'SLA_ALERTA').map(e => e.deliveryId)
    );
    const universo = [...concluidasHoje, ...ativas];
    const emRisco = new Set<string>(
      universo.filter(d => d.status === 'SLA_ALERTA' || breachIds.has(d.id)).map(d => d.id)
    );
    const slaPct = universo.length ? Math.round((1 - emRisco.size / universo.length) * 100) : 100;

    const frotaAtiva = drivers.filter(d => d.dispositivoConectado).length;

    // Resumo financeiro do dia: valor das comandas em operação (abertas) + as
    // concluídas hoje. Não inventa dado — soma o `valor` que já vem em cada comanda.
    const abertas = deliveries.filter(d => !STATUS_FINALIZADOS.includes(d.status));
    const comandasDoDia = [...abertas, ...concluidasHoje];
    const faturamento = comandasDoDia.reduce((acc, d) => acc + (d.valor || 0), 0);
    const ticketMedio = comandasDoDia.length ? faturamento / comandasDoDia.length : 0;
    const aguardando = deliveries.filter(d => STATUS_AGUARDANDO.includes(d.status)).length;

    // Devolvidas hoje: entregas que voltaram (insucesso/recusa ou retorno ao CD/estoque).
    const devolvidas = deliveries.filter(d => STATUS_DEVOLVIDAS.includes(d.status) && isHoje(d.dataHoraConclusao || d.atualizadoEm || d.criadoEm)).length;
    // Volume do dia: comandas que entraram hoje (independente do status atual).
    const recebidosHoje = deliveries.filter(d => isHoje(d.criadoEm)).length;

    return {
      emRota: ativas.length,
      despachando,
      entregues: concluidasHoje.length,
      tempoMedio,
      slaPct,
      frotaAtiva,
      frotaTotal: drivers.length,
      faturamento,
      ticketMedio,
      aguardando,
      devolvidas,
      recebidosHoje,
    };
  }, [deliveries, drivers, liveEvents]);

  // Anel SVG do gauge de SLA.
  const R = 26;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - m.slaPct / 100);
  const slaCor = m.slaPct >= META_SLA ? 'var(--color-emerald)' : m.slaPct >= META_SLA - 5 ? 'var(--color-amber)' : 'var(--color-rose)';

  return (
    <section className="glass-panel centro-ops-panel">
      <div className="centro-ops-head">
        <div className="centro-ops-title">
          <span className="centro-ops-live-dot" />
          Centro de Operações
          <span className="centro-ops-zone">{zona || 'Operação em tempo real'}</span>
        </div>
        <span className="centro-ops-live">
          {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · Ao vivo
        </span>
      </div>

      <div className="centro-ops">
        {/* Coluna esquerda: KPIs */}
        <div className="centro-ops-kpis">
          <BentoItem className="centro-ops-kpi">
            <div className="label">Em rota</div>
            <div className="value">{m.emRota}</div>
            <div className="sub">{m.despachando} despachando</div>
          </BentoItem>
          <BentoItem className="centro-ops-kpi">
            <div className="label">SLA prazo</div>
            <div className="value" style={{ color: slaCor }}>{m.slaPct}%</div>
            <div className="sub">{m.slaPct >= META_SLA ? 'acima da meta' : 'abaixo da meta'}</div>
          </BentoItem>
          <BentoItem className="centro-ops-kpi">
            <div className="label">Entregues</div>
            <div className="value">{m.entregues}</div>
            <div className="sub">hoje</div>
          </BentoItem>
          <BentoItem className="centro-ops-kpi">
            <div className="label">T. médio</div>
            <div className="value">{m.tempoMedio}<span style={{ fontSize: '0.9rem', fontWeight: 600 }}>m</span></div>
            <div className="sub">por entrega</div>
          </BentoItem>
          <BentoItem className="centro-ops-kpi">
            <div className="label">Devolvidas</div>
            <div className="value" style={{ color: m.devolvidas > 0 ? 'var(--color-amber)' : 'var(--color-emerald)' }}>{m.devolvidas}</div>
            <div className="sub">{m.devolvidas > 0 ? 'insucesso · retorno' : 'nenhuma hoje'}</div>
          </BentoItem>
          <BentoItem className="centro-ops-kpi">
            <div className="label">Recebidos</div>
            <div className="value">{m.recebidosHoje}</div>
            <div className="sub">pedidos hoje</div>
          </BentoItem>
        </div>

        {/* Coluna direita: gauge de SLA + resumo financeiro do dia */}
        <div>
          <BentoItem className="centro-ops-gauge">
            <svg width="64" height="64" viewBox="0 0 64 64" style={{ flex: 'none' }}>
              <circle cx="32" cy="32" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
              <circle
                cx="32" cy="32" r={R} fill="none" stroke={slaCor} strokeWidth="6"
                strokeDasharray={CIRC} strokeDashoffset={offset} strokeLinecap="round"
                transform="rotate(-90 32 32)" style={{ transition: 'stroke-dashoffset 0.6s ease' }}
              />
            </svg>
            <div>
              <div style={{ fontSize: '0.62rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>SLA no prazo</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1 }}>{m.slaPct}%</div>
              <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                meta {META_SLA}% · {m.slaPct >= META_SLA ? 'acima' : 'abaixo'} · {m.frotaAtiva} veíc. ativos
              </div>
            </div>
          </BentoItem>

          <BentoItem className="centro-ops-resumo">
            <div className="centro-ops-feed-title">Resumo de hoje</div>
            <div className="centro-ops-resumo-row">
              <span className="centro-ops-resumo-label">Faturamento</span>
              <span className="centro-ops-resumo-value" style={{ color: 'var(--color-emerald)' }}>{fmtBRL(m.faturamento)}</span>
            </div>
            <div className="centro-ops-resumo-row">
              <span className="centro-ops-resumo-label">Ticket médio</span>
              <span className="centro-ops-resumo-value">{fmtBRL(m.ticketMedio)}</span>
            </div>
            <div className="centro-ops-resumo-row">
              <span className="centro-ops-resumo-label">Aguardando despacho</span>
              <span className="centro-ops-resumo-value">{m.aguardando}<small> comandas</small></span>
            </div>
            <div className="centro-ops-resumo-row">
              <span className="centro-ops-resumo-label">Frota ativa</span>
              <span className="centro-ops-resumo-value">{m.frotaAtiva}<small> / {m.frotaTotal} online</small></span>
            </div>
          </BentoItem>
        </div>
      </div>
    </section>
  );
}

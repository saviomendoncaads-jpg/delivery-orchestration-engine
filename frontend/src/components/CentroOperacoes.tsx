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
const META_SLA = 95; // meta de SLA no prazo (%)

function isHoje(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function shortId(id: string): string {
  if (!id) return '';
  return id.length > 8 ? '…' + id.slice(-6) : id;
}

function tempoRelativo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.round(m / 60);
  return `há ${h}h`;
}

function formatarEvento(ev: BrokerEvento, drivers: MotoristaLite[]) {
  const id = shortId(ev.deliveryId);
  const status = ev.payload?.status as string | undefined;
  switch (ev.topic) {
    case 'entrega.recebida':
      return { cor: 'var(--color-cyan)', titulo: 'Pedido recebido', detalhe: `#${id} · fila de despacho` };
    case 'entrega.despachada': {
      const drv = drivers.find(d => d.id === ev.payload?.driverId);
      return { cor: '#3b82f6', titulo: `#${id} despachado`, detalhe: `${drv ? drv.name : 'motorista'} · auto-dispatch` };
    }
    case 'ALERTA_GERADO':
      if (status === 'SLA_ALERTA') return { cor: 'var(--color-amber)', titulo: `#${id} risco de SLA`, detalhe: 'rota recalculada' };
      return { cor: 'var(--color-rose)', titulo: `#${id} incidente`, detalhe: ev.payload?.gravidade === 'critico' ? 'crítico · rota' : 'aviso' };
    case 'entrega.monitorada':
      if (status === 'ENTREGUE') return { cor: 'var(--color-emerald)', titulo: `POD registrado · #${id}`, detalhe: 'foto + assinatura' };
      if (status === 'NO_LOCAL') return { cor: 'var(--color-emerald)', titulo: `#${id} chegou ao local`, detalhe: 'aguardando POD' };
      if (status === 'RECUSADO_INSUCESSO') return { cor: 'var(--color-rose)', titulo: `#${id} insucesso`, detalhe: 'retorno ao CD' };
      return { cor: 'var(--text-muted)', titulo: `#${id} atualizado`, detalhe: status || '' };
    default:
      return { cor: 'var(--text-muted)', titulo: ev.topic, detalhe: `#${id}` };
  }
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

    return {
      emRota: ativas.length,
      despachando,
      entregues: concluidasHoje.length,
      tempoMedio,
      slaPct,
      frotaAtiva,
      eventos: eventosTenant.slice(0, 6),
    };
  }, [deliveries, drivers, liveEvents]);

  // Anel SVG do gauge de SLA.
  const R = 26;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - m.slaPct / 100);
  const slaCor = m.slaPct >= META_SLA ? 'var(--color-emerald)' : m.slaPct >= META_SLA - 5 ? 'var(--color-amber)' : 'var(--color-rose)';

  const eventos = m.eventos;

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
        </div>

        {/* Coluna direita: gauge de SLA + eventos ao vivo */}
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

          <BentoItem className="centro-ops-feed">
            <div className="centro-ops-feed-title">Eventos ao vivo</div>
            {eventos.length === 0 ? (
              <div className="centro-ops-feed-empty">Aguardando eventos da operação…</div>
            ) : (
              eventos.map(ev => {
                const f = formatarEvento(ev, drivers);
                return (
                  <div key={ev.id} className="centro-ops-feed-item">
                    <span className="centro-ops-dot" style={{ background: f.cor }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="centro-ops-feed-titulo">{f.titulo}</div>
                      <div className="centro-ops-feed-detalhe">{tempoRelativo(ev.timestamp)} · {f.detalhe}</div>
                    </div>
                  </div>
                );
              })
            )}
          </BentoItem>
        </div>
      </div>
    </section>
  );
}

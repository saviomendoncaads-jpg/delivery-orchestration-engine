import React, { useMemo, useState } from 'react';
import { BentoItem } from './ui/cybernetic-bento-grid';

/**
 * Kanban de Controle de Comandas — 5 colunas por etapa do funil operacional.
 *
 * Só camada visual: filtra `deliveries` por status e dispara os MESMOS handlers
 * que o painel já usava (preparar/finalizar/cancelar, despacho em lote por romaneio,
 * abrir POD). Sem lógica de dados nova, sem backend novo.
 */

interface ComandaLite {
  id: string;
  status: string;
  tipoComanda?: 'pedido' | 'entrega';
  nomeCliente: string;
  endereco: string;
  itens?: string[];
  criadoEm?: string;
  atualizadoEm?: string;
  dataHoraConclusao?: string;
  motorista?: { id: string; name: string };
  incidentes?: { resolvido: boolean }[];
}

interface DriverLite {
  id: string;
  name: string;
  status?: string;
  dispositivoConectado?: boolean;
}

interface Props {
  deliveries: ComandaLite[];
  drivers: DriverLite[];
  selectedForManifest: string[];
  onToggleManifest: (id: string, checked: boolean) => void;
  onPreparar: (id: string, e: React.MouseEvent) => void;
  onFinalizar: (id: string, e: React.MouseEvent) => void;
  onCancelar: (id: string, e: React.MouseEvent) => void;
  onAbrirComanda: (id: string) => void;
  onDespachar: (driverId: string) => void;
  onImprimir: (c: ComandaLite) => void;
  getValor: (c: ComandaLite) => number;
  getStatusText: (status: string) => string;
}

const STATUS_ROTA = ['DESPACHADO', 'EM_TRANSITO', 'NO_LOCAL', 'ALERTA_INCIDENTE', 'SLA_ALERTA', 'AGUARDANDO_RETORNO_CD'];
const STATUS_FINAL = ['ENTREGUE', 'RECUSADO_INSUCESSO', 'PRODUTO_RETORNADO_ESTOQUE', 'CANCELADO'];

function isHoje(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// Tempo decorrido desde a última mudança de status (não há campo de prazo no modelo,
// então o nível de alerta é heurístico por tempo — verde < 15min, âmbar < 30min, vermelho >= 30min).
function tempoDecorrido(iso?: string): { label: string; nivel: 'ok' | 'warn' | 'crit' } {
  if (!iso) return { label: '—', nivel: 'ok' };
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  const label = min < 1 ? 'agora' : min < 60 ? `${min}min` : `${Math.floor(min / 60)}h${(min % 60).toString().padStart(2, '0')}`;
  const nivel: 'ok' | 'warn' | 'crit' = min >= 30 ? 'crit' : min >= 15 ? 'warn' : 'ok';
  return { label, nivel };
}

const corTimer: Record<'ok' | 'warn' | 'crit', string> = {
  ok: 'var(--color-emerald)',
  warn: 'var(--color-amber)',
  crit: 'var(--color-rose)',
};

type ColKey = 'novos' | 'separacao' | 'prontos' | 'rota' | 'finalizadas';

interface ColDef {
  key: ColKey;
  titulo: string;
  cor: string;
  match: (d: ComandaLite) => boolean;
}

const COLUNAS: ColDef[] = [
  { key: 'novos', titulo: 'Novos Pedidos', cor: 'var(--color-amber)', match: d => d.tipoComanda === 'pedido' && d.status === 'RECEBIDO' },
  { key: 'separacao', titulo: 'Em Separação', cor: 'var(--color-blue)', match: d => d.tipoComanda === 'pedido' && d.status === 'EM_PREPARO' },
  { key: 'prontos', titulo: 'Prontos p/ Despacho', cor: 'var(--color-cyan)', match: d => d.tipoComanda !== 'pedido' && d.status === 'RECEBIDO' },
  { key: 'rota', titulo: 'Em Rota', cor: 'var(--color-emerald)', match: d => d.tipoComanda !== 'pedido' && STATUS_ROTA.includes(d.status) },
  { key: 'finalizadas', titulo: 'Finalizadas', cor: 'var(--text-muted)', match: d => STATUS_FINAL.includes(d.status) && isHoje(d.dataHoraConclusao || d.atualizadoEm) },
];

export default function KanbanComandas({
  deliveries, drivers, selectedForManifest, onToggleManifest,
  onPreparar, onFinalizar, onCancelar, onAbrirComanda, onDespachar, onImprimir,
  getValor, getStatusText,
}: Props) {
  const [colAtiva, setColAtiva] = useState<ColKey>('novos');
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [driverEscolhido, setDriverEscolhido] = useState('');

  // Distribui cada comanda na coluna certa (uma passada só).
  const porColuna = useMemo(() => {
    const acc: Record<ColKey, ComandaLite[]> = { novos: [], separacao: [], prontos: [], rota: [], finalizadas: [] };
    for (const d of deliveries) {
      const col = COLUNAS.find(c => c.match(d));
      if (col) acc[col.key].push(d);
    }
    // mais recentes primeiro (por última atualização)
    const ord = (a: ComandaLite, b: ComandaLite) =>
      new Date(b.atualizadoEm || b.criadoEm || 0).getTime() - new Date(a.atualizadoEm || a.criadoEm || 0).getTime();
    (Object.keys(acc) as ColKey[]).forEach(k => acc[k].sort(ord));
    return acc;
  }, [deliveries]);

  // Seleção do despacho restrita às comandas que estão de fato na coluna "Prontos".
  const idsProntos = porColuna.prontos.map(d => d.id);
  const selecionadosProntos = selectedForManifest.filter(id => idsProntos.includes(id));

  const confirmarDespacho = () => {
    onDespachar(driverEscolhido);
    setDispatchOpen(false);
    setDriverEscolhido('');
  };

  const renderCard = (d: ComandaLite, col: ColKey) => {
    const timer = tempoDecorrido(d.atualizadoEm || d.criadoEm);
    const temAlerta = d.status === 'ALERTA_INCIDENTE' || d.status === 'SLA_ALERTA';
    return (
      <BentoItem key={d.id} className="kanban-card" title="Abrir detalhes da comanda">
        <div className="kanban-card-inner" onClick={() => onAbrirComanda(d.id)}>
          <div className="kanban-card-top">
            <div className="kanban-card-id">
              {col === 'prontos' && (
                <input
                  type="checkbox"
                  className="kanban-check"
                  checked={selectedForManifest.includes(d.id)}
                  onClick={e => e.stopPropagation()}
                  onChange={e => { e.stopPropagation(); onToggleManifest(d.id, e.target.checked); }}
                  title="Selecionar para despacho em lote"
                />
              )}
              <span className="card-id font-mono">{d.id}</span>
            </div>
            <span
              className="kanban-card-timer"
              style={{ color: col === 'finalizadas' ? 'var(--text-muted)' : corTimer[timer.nivel] }}
              title="Tempo desde a última mudança de status"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 2.5" />
              </svg>
              {timer.label}
            </span>
          </div>

          <div className="kanban-card-body">
            <div className="kanban-card-cliente">{d.nomeCliente}</div>
            {col === 'novos' || col === 'separacao' ? (
              <div className="kanban-card-itens">{d.itens && d.itens.length ? d.itens.join(', ') : 'Sem itens'}</div>
            ) : (
              <div className="kanban-card-itens">{d.endereco}</div>
            )}
            <div className="kanban-card-meta">
              <span className="kanban-card-valor">R$ {getValor(d).toFixed(2)}</span>
              {col === 'finalizadas' && <span className={`card-badge ${d.status}`}>{getStatusText(d.status)}</span>}
              {d.motorista && (col === 'rota' || col === 'finalizadas') && (
                <span className="kanban-card-motoboy">· {d.motorista.name}</span>
              )}
              {temAlerta && <span className="kanban-card-alerta">⚠ alerta</span>}
            </div>
          </div>
        </div>

        {/* Ações por etapa */}
        {col === 'novos' && (
          <div className="kanban-card-actions">
            <button className="kanban-btn kanban-btn-amber" onClick={e => onPreparar(d.id, e)}>Aceitar e Preparar</button>
            <button className="kanban-btn kanban-btn-ghost-rose" onClick={e => onCancelar(d.id, e)} title="Cancelar comanda">✕</button>
          </div>
        )}
        {col === 'separacao' && (
          <div className="kanban-card-actions">
            <button className="kanban-btn kanban-btn-emerald" onClick={e => onFinalizar(d.id, e)}>Concluir Separação</button>
          </div>
        )}
        {col === 'rota' && (
          <div className="kanban-card-actions">
            <button className="kanban-btn kanban-btn-emerald-soft" onClick={e => { e.stopPropagation(); onAbrirComanda(d.id); }}>Confirmar Entrega</button>
            <button className="kanban-btn kanban-btn-amber-soft" onClick={e => { e.stopPropagation(); onAbrirComanda(d.id); }}>Reportar Problema</button>
          </div>
        )}
      </BentoItem>
    );
  };

  const renderColuna = (col: ColDef) => {
    const itens = porColuna[col.key];
    return (
      <div className="kanban-column" key={col.key} data-active={colAtiva === col.key}>
        <div className="kanban-col-header">
          <span className="kanban-col-dot" style={{ background: col.cor }} />
          <span className="kanban-col-title">{col.titulo}</span>
          <span className="kanban-col-count">{itens.length}</span>
        </div>

        {col.key === 'prontos' && (
          <button
            className="kanban-dispatch-btn"
            disabled={selecionadosProntos.length === 0}
            onClick={() => setDispatchOpen(true)}
          >
            Despachar Selecionados ({selecionadosProntos.length})
          </button>
        )}

        <div className="kanban-col-body">
          {itens.length === 0 ? (
            <div className="kanban-empty">Nenhuma comanda</div>
          ) : (
            itens.map(d => renderCard(d, col.key))
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Abas (só aparecem no mobile via CSS) */}
      <div className="kanban-tabs">
        {COLUNAS.map(col => (
          <button
            key={col.key}
            className={`kanban-tab ${colAtiva === col.key ? 'active' : ''}`}
            onClick={() => setColAtiva(col.key)}
          >
            <span className="kanban-col-dot" style={{ background: col.cor }} />
            {col.titulo} <span className="kanban-col-count">{porColuna[col.key].length}</span>
          </button>
        ))}
      </div>

      <div className="kanban-board">
        {COLUNAS.map(renderColuna)}
      </div>

      {/* Modal enxuto de despacho — escolhe o entregador e gera o romaneio */}
      {dispatchOpen && (
        <div className="kanban-modal-overlay" onClick={() => setDispatchOpen(false)}>
          <div className="kanban-modal" onClick={e => e.stopPropagation()}>
            <h3 className="kanban-modal-title">Despachar {selecionadosProntos.length} comanda(s)</h3>
            <p className="kanban-modal-sub">Escolha o entregador. Um romaneio será gerado para impressão.</p>
            <label className="kanban-modal-label">Entregador</label>
            <select className="form-select" value={driverEscolhido} onChange={e => setDriverEscolhido(e.target.value)}>
              <option value="">Auto (primeiro disponível)</option>
              {drivers.map(d => (
                <option key={d.id} value={d.id} disabled={!d.dispositivoConectado}>
                  {d.name} ({!d.dispositivoConectado ? 'Offline' : d.status === 'ocioso' ? 'Disponível' : 'Em Rota'})
                </option>
              ))}
            </select>
            <div className="kanban-modal-actions">
              <button className="kanban-btn kanban-btn-ghost" onClick={() => setDispatchOpen(false)}>Cancelar</button>
              <button className="kanban-btn kanban-btn-cyan" onClick={confirmarDespacho}>Gerar Romaneio e Despachar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * WazeRouteMonitor
 * ------------------------------------------------------------------
 * Painel de monitoramento de rotas usando o **Waze Live Map oficial**
 * (iframe embed) — ruas, tráfego em tempo real (verde/amarelo/vermelho),
 * alertas e POIs reais do Waze, centralizado nas coordenadas da loja.
 *
 * Doc oficial: https://developers.google.com/waze/iframe
 * Parâmetros: zoom, lat, lon, pin (1 = fixa um pin no centro).
 *
 * Componente autocontido (iframe + CSS escopado), pronto p/ React/Next.
 */

export interface WazeRouteMonitorProps {
  /** Rótulo da loja exibido no chip de identidade. */
  storeLabel?: string;
  /** Latitude resolvida da loja (centro do mapa + pin). */
  lojaLat?: number;
  /** Longitude resolvida da loja (centro do mapa + pin). */
  lojaLng?: number;
  /** Quando true, mostra o botão "Usar minha localização". */
  isStoreSession?: boolean;
  /** Handler do botão turquesa "Usar minha localização". */
  onUseMyLocation?: () => void;
  /** Nível de zoom do Waze Live Map (1–17). Padrão 15 (bairro). */
  zoom?: number;
}

// Centro padrão: Loja 10 — Abreu e Lima / Região Metropolitana do Recife (PE).
const DEFAULT_LAT = -7.9018;
const DEFAULT_LON = -34.9043;

export default function WazeRouteMonitor({
  storeLabel = 'BRASIL FARMA - LOJA 10',
  lojaLat,
  lojaLng,
  isStoreSession = false,
  onUseMyLocation,
  zoom = 15,
}: WazeRouteMonitorProps) {
  const hasCoords = typeof lojaLat === 'number' && typeof lojaLng === 'number';
  const lat = hasCoords ? (lojaLat as number) : DEFAULT_LAT;
  const lon = hasCoords ? (lojaLng as number) : DEFAULT_LON;

  // URL oficial do Waze Live Map. Trocar lat/lon recentraliza o mapa
  // (ex.: após "Usar minha localização" atualizar as coordenadas da loja).
  const embedSrc = `https://embed.waze.com/iframe?zoom=${zoom}&lat=${lat}&lon=${lon}&pin=1`;

  return (
    <div className="waze-embed">
      <style>{WAZE_CSS}</style>

      <iframe
        title="Waze Live Map — Monitoramento de Rotas"
        src={embedSrc}
        className="waze-embed-iframe"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allow="geolocation"
      />

      {/* Camada de overlays — pointer-events:none p/ não bloquear o mapa;
          cada elemento reativa pointer-events:auto individualmente. */}
      <div className="waze-embed-overlays">
        {/* Chip de identidade da loja (abaixo do header do Waze) */}
        <div className="waze-store-pill">
          <span className="waze-rx" aria-hidden>
            <svg viewBox="0 0 24 24" width="13" height="13">
              <rect x="9.5" y="4" width="5" height="16" rx="1.6" fill="#fff" />
              <rect x="4" y="9.5" width="16" height="5" rx="1.6" fill="#fff" />
            </svg>
          </span>
          <span className="waze-store-text">
            <b>{storeLabel}</b>
            {hasCoords ? (
              <span className="waze-coords">{lat.toFixed(5)}, {lon.toFixed(5)}</span>
            ) : (
              <span className="waze-warn">Localização não resolvida — sem CEP/endereço.</span>
            )}
          </span>
        </div>

        {/* FAB turquesa "Usar minha localização" com avatar (carinha Waze) */}
        {isStoreSession && onUseMyLocation && (
          <button type="button" className="waze-fab" onClick={onUseMyLocation}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <circle cx="12" cy="8.2" r="4" fill="#063b45" />
              <path d="M4.5 20 a7.5 7.5 0 0 1 15 0 Z" fill="#063b45" />
            </svg>
            Usar minha localização
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- estilos (escopo .waze-embed) ------------------ */
const WAZE_CSS = `
.waze-embed {
  position: absolute; inset: 0; overflow: hidden; background: #dfe7ee;
  font-family: 'Nunito', 'Baloo 2', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.waze-embed-iframe { width: 100%; height: 100%; border: 0; display: block; }

.waze-embed-overlays { position: absolute; inset: 0; pointer-events: none; z-index: 5; }

.waze-store-pill {
  position: absolute; top: 52px; left: 14px; pointer-events: auto;
  display: flex; align-items: center; gap: 9px; max-width: 290px;
  background: rgba(15,21,34,.92); backdrop-filter: blur(10px) saturate(140%);
  border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
  padding: 8px 12px; box-shadow: 0 12px 28px -10px rgba(0,0,0,.6);
}
.waze-rx {
  width: 22px; height: 22px; flex: 0 0 auto; border-radius: 7px;
  background: linear-gradient(180deg, #1ec979, #16a865);
  display: flex; align-items: center; justify-content: center;
}
.waze-store-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.waze-store-text b { color: #fff; font-weight: 900; font-size: 13px; letter-spacing: .2px; white-space: nowrap; }
.waze-coords { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; font-weight: 600; color: #7fd9ea; }
.waze-warn { font-size: 11px; font-weight: 700; color: #ffb74d; }

.waze-fab {
  position: absolute; bottom: 18px; right: 18px; pointer-events: auto;
  display: inline-flex; align-items: center; gap: 8px;
  border: none; cursor: pointer; border-radius: 999px; padding: 11px 16px;
  font-family: inherit; font-size: 13.5px; font-weight: 900; color: #042b33;
  background: linear-gradient(180deg, #25d8ec, #14b8d4);
  box-shadow: 0 10px 22px -6px rgba(20,184,212,.6), inset 0 1px 0 rgba(255,255,255,.4);
  transition: transform .08s ease, box-shadow .15s ease;
}
.waze-fab:hover { box-shadow: 0 12px 26px -6px rgba(20,184,212,.82), inset 0 1px 0 rgba(255,255,255,.5); }
.waze-fab:active { transform: translateY(1px) scale(.99); }
.waze-fab svg { filter: drop-shadow(0 1px 0 rgba(255,255,255,.25)); }
`;

import React, { useCallback, useRef } from 'react';

/**
 * Cybernetic Bento — primitives reutilizáveis.
 *
 * Adaptado do componente "cybernetic-bento-grid": mantém a interação que dá o
 * charme (um glow que segue o cursor, via --mouse-x/--mouse-y), mas:
 *  - tipado (TS) e usando handler do React (sem addEventListener manual);
 *  - SEM o conteúdo de marketing do original (Global CDN, Serverless...);
 *  - na identidade da marca Distre (glow esmeralda/ciano) — o CSS de .bento-item
 *    e .bento-grid vive no App.css.
 *
 * Uso: envolva qualquer card com <BentoItem> para ganhar o realce interativo.
 */

interface BentoItemProps {
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
}

export function BentoItem({ className = '', children, style, title }: BentoItemProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
  }, []);

  return (
    <div ref={ref} title={title} onMouseMove={handleMouseMove} className={`bento-item ${className}`} style={style}>
      {children}
    </div>
  );
}

interface BentoGridProps {
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function BentoGrid({ className = '', children, style }: BentoGridProps) {
  return (
    <div className={`bento-grid ${className}`} style={style}>
      {children}
    </div>
  );
}

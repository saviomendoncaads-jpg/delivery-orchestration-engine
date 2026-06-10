import type { CSSProperties } from 'react';
import { IconeCategoria } from './SidebarCategorias';
import type { CategoriaVitrine, FiltroCategoria } from './SidebarCategorias';

// ============================================================================
// CATEGORIAS ILUSTRADAS — grade horizontal de tiles vibrantes (MODELO 2).
// Mesma fonte de dados da sidebar (categoriasDe), só que como atalho visual de
// alto impacto. Sem ilustração por categoria no backend: cada tile combina o
// ícone da categoria com um gradiente vibrante de uma paleta ciclada por índice.
// Clicar num tile dispara o MESMO onFiltrar da sidebar (estado compartilhado).
// ============================================================================

// Paleta de gradientes (a / b / sombra) — coerente com o tema cobalto+menta,
// mas variada o bastante para os tiles "saltarem" como na referência.
const PALETA: Array<[string, string, string]> = [
  ['#60a5fa', '#2563eb', 'rgba(37, 99, 235, 0.45)'], // azul
  ['#34d399', '#10b981', 'rgba(16, 185, 129, 0.45)'], // menta
  ['#f0abfc', '#a855f7', 'rgba(168, 85, 247, 0.45)'], // roxo
  ['#fdba74', '#f97316', 'rgba(249, 115, 22, 0.45)'], // laranja
  ['#fca5a5', '#ef4444', 'rgba(239, 68, 68, 0.42)'], // vermelho
  ['#5eead4', '#0891b2', 'rgba(8, 145, 178, 0.45)'], // ciano
];

interface Props {
  categorias: CategoriaVitrine[];
  filtro: FiltroCategoria;
  onFiltrar: (filtro: FiltroCategoria) => void;
}

export default function CategoriasIlustradas({ categorias, filtro, onFiltrar }: Props) {
  if (categorias.length === 0) return null;

  return (
    <section className="v-cat-secao" aria-label="Categorias">
      <div className="v-secao-titulo">
        <h2>Categorias</h2>
        {filtro.categoria && (
          <button type="button" className="v-secao-link" onClick={() => onFiltrar({})}>
            Ver tudo
          </button>
        )}
      </div>
      <div className="v-cat-grid">
        {categorias.map((cat, i) => {
          const ativa = filtro.categoria === cat.nome;
          const [a, b, sombra] = PALETA[i % PALETA.length];
          const estilo = {
            '--v-tile-a': a,
            '--v-tile-b': b,
            '--v-tile-sombra': sombra,
          } as CSSProperties;
          return (
            <button
              key={cat.nome}
              type="button"
              className={`v-cat-tile${ativa ? ' v-cat-tile--ativo' : ''}`}
              aria-pressed={ativa}
              // Clicar na categoria ativa volta ao cardápio completo.
              onClick={() => onFiltrar(ativa ? {} : { categoria: cat.nome })}
            >
              <span className="v-cat-tile-icone" style={estilo} aria-hidden="true">
                <IconeCategoria nome={cat.nome} />
              </span>
              <span className="v-cat-tile-nome">{cat.nome}</span>
              <span className="v-cat-tile-qtd">
                {cat.quantidade} {cat.quantidade === 1 ? 'item' : 'itens'}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ProdutoVitrine } from '../types';

// ============================================================================
// SIDEBAR DE CATEGORIAS — navegação do cardápio público.
// As categorias NÃO são fixas: a árvore é derivada dos campos categoria/
// subcategoria que a loja define produto a produto no painel (GestaoVitrine).
// Produtos sem categoria caem no grupo "Outros" quando a loja usa categorias.
// ============================================================================

export const CATEGORIA_OUTROS = 'Outros';
const MAX_VISIVEIS = 4; // acima disso, o excedente fica atrás de "Mais categorias"

export interface CategoriaVitrine {
  nome: string;
  subcategorias: string[];
  quantidade: number;
}

export interface FiltroCategoria {
  categoria?: string;
  subcategoria?: string;
}

// Monta a árvore a partir dos produtos: categorias ordenadas por quantidade
// de itens (as mais relevantes primeiro), "Outros" sempre por último.
export function categoriasDe(produtos: ProdutoVitrine[]): CategoriaVitrine[] {
  const mapa = new Map<string, { subs: Set<string>; qtd: number }>();
  let semCategoria = 0;
  for (const p of produtos) {
    if (!p.categoria) {
      semCategoria++;
      continue;
    }
    const atual = mapa.get(p.categoria) || { subs: new Set<string>(), qtd: 0 };
    atual.qtd++;
    if (p.subcategoria) atual.subs.add(p.subcategoria);
    mapa.set(p.categoria, atual);
  }
  if (mapa.size === 0) return []; // loja não usa categorias → sem sidebar
  const lista = [...mapa.entries()]
    .map(([nome, info]) => ({ nome, subcategorias: [...info.subs].sort(), quantidade: info.qtd }))
    .sort((a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome));
  if (semCategoria > 0) {
    lista.push({ nome: CATEGORIA_OUTROS, subcategorias: [], quantidade: semCategoria });
  }
  return lista;
}

export function filtrarPorCategoria(produtos: ProdutoVitrine[], filtro: FiltroCategoria): ProdutoVitrine[] {
  if (!filtro.categoria) return produtos;
  const base =
    filtro.categoria === CATEGORIA_OUTROS
      ? produtos.filter(p => !p.categoria)
      : produtos.filter(p => p.categoria === filtro.categoria);
  return filtro.subcategoria ? base.filter(p => p.subcategoria === filtro.subcategoria) : base;
}

// Ícone por palavra-chave do nome (acentos ignorados): a loja nomeia livremente
// e ainda ganha um ícone coerente; o fallback é uma etiqueta genérica.
function IconeCategoria({ nome }: { nome: string }) {
  const chave = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let desenho: ReactNode;
  if (/medicament|remedio|farmac|generic|prescri/.test(chave)) {
    // pílula/cápsula
    desenho = (
      <>
        <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
        <path d="m8.5 8.5 7 7" />
      </>
    );
  } else if (/higiene|cuidado|pessoal|beleza|dermo|cabelo|pele/.test(chave)) {
    // autocuidado (brilhos)
    desenho = (
      <>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
        <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
      </>
    );
  } else if (/conveni|mercad|cesta|bebida|aliment|snack/.test(chave)) {
    // cesta de compras
    desenho = (
      <>
        <path d="m5 11 4-7M19 11l-4-7" />
        <path d="M2 11h20l-1.6 7.4a2 2 0 0 1-2 1.6H5.6a2 2 0 0 1-2-1.6L2 11Z" />
        <path d="M9 15v3M15 15v3" />
      </>
    );
  } else if (/suplement|vitamin|nutri|protein|whey/.test(chave)) {
    // pote de suplemento
    desenho = (
      <>
        <path d="M8 3h8v3H8z" />
        <path d="M7 6h10a1 1 0 0 1 1 1v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1Z" />
        <path d="M9 12h6" />
      </>
    );
  } else {
    // etiqueta (fallback)
    desenho = (
      <>
        <path d="M12.6 3.6 21 12l-8.4 8.4a2 2 0 0 1-2.8 0L3 13.6V5a2 2 0 0 1 2-2h8.6l-1-.4Z" />
        <circle cx="7.5" cy="7.5" r="1" />
      </>
    );
  }
  return (
    <svg
      className="v-sidebar-icone"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {desenho}
    </svg>
  );
}

interface Props {
  categorias: CategoriaVitrine[];
  filtro: FiltroCategoria;
  onFiltrar: (filtro: FiltroCategoria) => void;
}

export default function SidebarCategorias({ categorias, filtro, onFiltrar }: Props) {
  const [expandido, setExpandido] = useState(false);

  let visiveis = expandido ? categorias : categorias.slice(0, MAX_VISIVEIS);
  // A categoria ativa nunca fica escondida atrás do "Mais categorias".
  if (filtro.categoria && !visiveis.some(c => c.nome === filtro.categoria)) {
    const ativa = categorias.find(c => c.nome === filtro.categoria);
    if (ativa) visiveis = [...visiveis, ativa];
  }

  function aoClicarCategoria(nome: string) {
    // Clicar na categoria já ativa limpa o filtro (volta ao cardápio completo).
    onFiltrar(filtro.categoria === nome ? {} : { categoria: nome });
  }

  function aoClicarSub(categoria: string, sub: string) {
    onFiltrar(filtro.subcategoria === sub ? { categoria } : { categoria, subcategoria: sub });
  }

  return (
    <aside className="v-sidebar">
      <nav aria-label="Categorias do cardápio">
        <ul className="v-sidebar-lista">
          {visiveis.map(cat => {
            const ativa = filtro.categoria === cat.nome;
            return (
              <li key={cat.nome}>
                <button
                  type="button"
                  className={`v-sidebar-item${ativa ? ' v-sidebar-item--ativo' : ''}`}
                  aria-current={ativa ? 'true' : undefined}
                  onClick={() => aoClicarCategoria(cat.nome)}
                >
                  <IconeCategoria nome={cat.nome} />
                  <span>{cat.nome}</span>
                </button>
                {ativa && cat.subcategorias.length > 0 && (
                  <ul className="v-sidebar-sublista">
                    {cat.subcategorias.map(sub => (
                      <li key={sub}>
                        <button
                          type="button"
                          className={`v-sidebar-sub${filtro.subcategoria === sub ? ' v-sidebar-sub--ativo' : ''}`}
                          onClick={() => aoClicarSub(cat.nome, sub)}
                        >
                          {sub}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {categorias.length > MAX_VISIVEIS && (
            <li>
              <button
                type="button"
                className="v-sidebar-item v-sidebar-item--mais"
                onClick={() => setExpandido(e => !e)}
                aria-expanded={expandido}
              >
                <svg className="v-sidebar-icone" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
                <span>{expandido ? 'Menos categorias' : 'Mais categorias'}</span>
              </button>
            </li>
          )}
        </ul>
      </nav>
    </aside>
  );
}

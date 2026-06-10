import type { CSSProperties } from 'react';
import type { CategoriaVitrine, FiltroCategoria } from './SidebarCategorias';

// ============================================================================
// CATEGORIAS ILUSTRADAS — faixa horizontal de tiles de cor cheia (MODELO 2).
// Visual da referência Medline: cada tile é um cartão de cor sólida vibrante,
// com a ilustração grande no topo e o rótulo branco embaixo.
//
// IMPORTANTE — como a categoria "sabe" a ilustração/cor: NÃO há imagem real por
// categoria no backend. A escolha é um palpite por PALAVRA-CHAVE no nome (acento
// ignorado), o mesmo critério do ícone da sidebar. Categoria que não casa com
// nenhuma regra cai no visual neutro (etiqueta + cinza). Para ilustrações 3D
// idênticas ao mockup seria preciso a loja subir um PNG por categoria.
// ============================================================================

interface Aparencia {
  emoji: string;
  cor: string; // cor de fundo do tile
}

// Mapa palavra-chave → emoji + cor, casado na ordem (PRIMEIRO match vence — por
// isso "cuidado/higiene pessoal" (beleza) vem antes de "limpeza", senão "cuidado"
// cairia no balde de limpeza).
const REGRAS: Array<{ teste: RegExp; ap: Aparencia }> = [
  { teste: /remedio|medicament|farmac|generic|prescri|saude/, ap: { emoji: '💊', cor: '#36b37e' } }, // verde
  { teste: /beleza|dermo|cabelo|pele|cosmet|perfum|higiene|cuidado|pessoal/, ap: { emoji: '🧖', cor: '#a855f7' } }, // roxo
  { teste: /limpeza|sanit|desinfet|domestic|faxina|lava/, ap: { emoji: '🧴', cor: '#ef5350' } }, // vermelho/coral
  { teste: /conveni|mercad|cesta|bebida|aliment|snack|bebê|bebe/, ap: { emoji: '🛒', cor: '#4285f4' } }, // azul
  { teste: /suplement|vitamin|nutri|protein|whey|fitness/, ap: { emoji: '🥤', cor: '#f5a623' } }, // amarelo/âmbar
];

const NEUTRO: Aparencia = { emoji: '🏷️', cor: '#64748b' }; // fallback (slate)

function aparenciaDe(nome: string): Aparencia {
  const chave = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return REGRAS.find(r => r.teste.test(chave))?.ap ?? NEUTRO;
}

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
        {categorias.map(cat => {
          const ativa = filtro.categoria === cat.nome;
          const { emoji, cor } = aparenciaDe(cat.nome);
          const estilo = { '--v-tile-cor': cor } as CSSProperties;
          return (
            <button
              key={cat.nome}
              type="button"
              className={`v-cat-tile${ativa ? ' v-cat-tile--ativo' : ''}`}
              style={estilo}
              aria-pressed={ativa}
              // Clicar na categoria ativa volta ao cardápio completo.
              onClick={() => onFiltrar(ativa ? {} : { categoria: cat.nome })}
            >
              <span className="v-cat-tile-emoji" aria-hidden="true">{emoji}</span>
              <span className="v-cat-tile-nome">{cat.nome}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

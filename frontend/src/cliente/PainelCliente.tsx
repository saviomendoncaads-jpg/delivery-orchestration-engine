import { useEffect, useMemo, useState } from 'react';
import { CarrinhoProvider, useCarrinho } from './context/CarrinhoContext';
import CatalogoProdutos from './components/CatalogoProdutos';
import SidebarCategorias, { categoriasDe, filtrarPorCategoria } from './components/SidebarCategorias';
import type { FiltroCategoria } from './components/SidebarCategorias';
import CategoriasIlustradas from './components/CategoriasIlustradas';
import CarrinhoDrawer from './components/CarrinhoDrawer';
import CheckoutForm from './components/CheckoutForm';
import PedidoConfirmado from './components/PedidoConfirmado';
import { buscarCardapio } from './services/pedidoService';
import { urlImagem } from './services/api';
import { formatarPreco } from './types';
import type { CardapioResposta, LojaVitrine, PedidoConfirmacao } from './types';
import './cliente.css';

// ============================================================================
// PAINEL DO CLIENTE — vitrine pública servida em /loja/<lojaId>.
// Catálogo → sacola (drawer) → checkout → confirmação. Os pedidos entram no
// Distre pela rota pública /api/vitrine e caem como comanda no painel da loja.
// ============================================================================

type Tela = 'catalogo' | 'checkout' | 'confirmado';

function extrairLojaId(): string {
  const m = window.location.pathname.match(/^\/loja\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Logomarca da loja no cabeçalho: usa a imagem configurada no painel;
// sem logo (ou com URL quebrada), cai na inicial do nome em âmbar.
function LogoLoja({ loja }: { loja: LojaVitrine }) {
  const [falhou, setFalhou] = useState(false);
  const src = urlImagem(loja.logoUrl);
  if (!src || falhou) {
    return (
      <div className="v-header-avatar" aria-hidden="true">
        {loja.nome.charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="v-header-avatar v-header-avatar--logo">
      <img src={src} alt={`Logo de ${loja.nome}`} onError={() => setFalhou(true)} />
    </div>
  );
}

// Comparação sem acentos/caixa para a busca (\p{M} = marcas diacríticas).
function normalizarTexto(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Campo de busca por nome/descrição, acima da grade de produtos.
function BuscaProdutos({ valor, onMudar }: { valor: string; onMudar: (v: string) => void }) {
  return (
    <div className="v-busca" role="search">
      <svg className="v-busca-icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="search"
        className="v-busca-input"
        placeholder="Buscar medicamento ou produto…"
        value={valor}
        onChange={e => onMudar(e.target.value)}
        aria-label="Buscar produto por nome"
      />
      {valor && (
        <button type="button" className="v-busca-limpar" onClick={() => onMudar('')} aria-label="Limpar busca">
          ×
        </button>
      )}
    </div>
  );
}

// Barra flutuante "Ver sacola" — só aparece no catálogo com itens na sacola.
function BarraSacola({ onAbrir }: { onAbrir: () => void }) {
  const { totalItens, subtotal } = useCarrinho();
  if (totalItens === 0) return null;
  return (
    <button type="button" className="v-barra-sacola" onClick={onAbrir}>
      <span className="v-barra-sacola-badge">{totalItens}</span>
      <span>Ver sacola</span>
      <span className="v-barra-sacola-total">{formatarPreco(subtotal)}</span>
    </button>
  );
}

function ConteudoPainel({ cardapio }: { cardapio: CardapioResposta }) {
  const [tela, setTela] = useState<Tela>('catalogo');
  const [sacolaAberta, setSacolaAberta] = useState(false);
  const [confirmacao, setConfirmacao] = useState<PedidoConfirmacao | null>(null);
  const { loja, produtos } = cardapio;

  // Sidebar de categorias: a árvore vem dos produtos (configurada no painel da
  // loja). O padrão é "Todos os Produtos" — o cliente vê o cardápio completo
  // e refina por categoria se quiser.
  const categorias = useMemo(() => categoriasDe(produtos), [produtos]);
  const [filtro, setFiltro] = useState<FiltroCategoria>({});
  // Busca por texto: pesquisa nome+descrição do cardápio INTEIRO (acentos
  // ignorados). Busca e categoria são mutuamente exclusivas: digitar limpa o
  // filtro de categoria; clicar numa categoria limpa a busca.
  const [busca, setBusca] = useState('');
  const termoBusca = normalizarTexto(busca.trim());

  const produtosVisiveis = useMemo(() => {
    if (termoBusca) {
      return produtos.filter(
        p =>
          normalizarTexto(p.nome).includes(termoBusca) ||
          (p.descricao && normalizarTexto(p.descricao).includes(termoBusca))
      );
    }
    return filtrarPorCategoria(produtos, filtro);
  }, [produtos, filtro, termoBusca]);

  function aoBuscar(valor: string) {
    setBusca(valor);
    if (valor.trim() && filtro.categoria) setFiltro({});
  }

  function aoFiltrarCategoria(novo: FiltroCategoria) {
    setBusca('');
    setFiltro(novo);
  }

  useEffect(() => {
    document.title = `${loja.nome} • Cardápio online`;
  }, [loja.nome]);

  const localizacao = [loja.bairro, loja.cidade, loja.uf].filter(Boolean).join(', ');

  return (
    <div className="v-pagina">
      <header className="v-header">
        <div className="v-header-loja">
          <LogoLoja loja={loja} />
          <div>
            <h1>{loja.nome}</h1>
            {localizacao && <p className="v-header-local">{localizacao}</p>}
          </div>
        </div>
        {loja.aceitandoPedidos ? (
          <span className="v-chip-aberto">
            <span className="v-chip-pulso" aria-hidden="true" /> Recebendo pedidos
          </span>
        ) : (
          <span className="v-chip-fechado">Pedidos pausados</span>
        )}
      </header>

      <main className="v-conteudo">
        {!loja.aceitandoPedidos && tela !== 'confirmado' && (
          <div className="v-aviso" role="status">
            Esta loja não está aceitando pedidos online no momento.
          </div>
        )}

        {tela === 'catalogo' && (
          <div className={categorias.length > 0 ? 'v-vitrine-layout' : undefined}>
            {categorias.length > 0 && (
              <SidebarCategorias categorias={categorias} filtro={filtro} onFiltrar={aoFiltrarCategoria} />
            )}
            <div className="v-vitrine-conteudo">
              {produtos.length > 0 && <BuscaProdutos valor={busca} onMudar={aoBuscar} />}
              {/* Tiles ilustrados de categoria: atalho visual de alto impacto.
                  Some durante a busca por texto para o foco ficar nos resultados. */}
              {!termoBusca && categorias.length > 0 && (
                <CategoriasIlustradas categorias={categorias} filtro={filtro} onFiltrar={aoFiltrarCategoria} />
              )}
              {termoBusca && produtosVisiveis.length === 0 ? (
                <div className="v-estado-vazio">
                  <span className="v-estado-vazio-icone" aria-hidden="true">🔍</span>
                  <h2>Nada encontrado</h2>
                  <p>
                    Nenhum produto corresponde a <strong>“{busca.trim()}”</strong>. Confira a grafia ou
                    navegue pelas categorias.
                  </p>
                  <button type="button" className="v-btn-secundario" onClick={() => setBusca('')}>
                    Limpar busca
                  </button>
                </div>
              ) : (
                <CatalogoProdutos produtos={produtosVisiveis} />
              )}
            </div>
          </div>
        )}

        {tela === 'checkout' && (
          <CheckoutForm
            lojaId={loja.id}
            onVoltar={() => setTela('catalogo')}
            onConfirmado={c => {
              setConfirmacao(c);
              setTela('confirmado');
              window.scrollTo({ top: 0 });
            }}
          />
        )}

        {tela === 'confirmado' && confirmacao && (
          <PedidoConfirmado
            confirmacao={confirmacao}
            nomeLoja={loja.nome}
            onNovoPedido={() => {
              setConfirmacao(null);
              setTela('catalogo');
            }}
          />
        )}
      </main>

      {tela === 'catalogo' && loja.aceitandoPedidos && (
        <BarraSacola onAbrir={() => setSacolaAberta(true)} />
      )}

      <CarrinhoDrawer
        aberto={sacolaAberta}
        onFechar={() => setSacolaAberta(false)}
        onIrParaCheckout={() => {
          setSacolaAberta(false);
          setTela('checkout');
          window.scrollTo({ top: 0 });
        }}
      />

      <footer className="v-footer">
        Pedidos e entregas orquestrados por <strong className="v-footer-marca">Distre</strong>
      </footer>
    </div>
  );
}

export default function PainelCliente() {
  const lojaId = useMemo(extrairLojaId, []);
  const [cardapio, setCardapio] = useState<CardapioResposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!lojaId) return;
    let ativo = true;
    buscarCardapio(lojaId)
      .then(dados => {
        if (ativo) setCardapio(dados);
      })
      .catch(err => {
        if (ativo) setErro(err?.message || 'Não foi possível carregar o cardápio.');
      });
    return () => {
      ativo = false;
    };
  }, [lojaId]);

  if (!lojaId) {
    return (
      <div className="v-pagina v-pagina--centro">
        <div className="v-estado-vazio">
          <span className="v-estado-vazio-icone" aria-hidden="true">🔗</span>
          <h2>Link incompleto</h2>
          <p>
            Este cardápio é acessado por um link no formato <code>/loja/&lt;id-da-loja&gt;</code>.
            Peça o link correto à loja.
          </p>
        </div>
      </div>
    );
  }

  if (erro) {
    return (
      <div className="v-pagina v-pagina--centro">
        <div className="v-estado-vazio">
          <span className="v-estado-vazio-icone" aria-hidden="true">😕</span>
          <h2>Não foi possível abrir o cardápio</h2>
          <p>{erro}</p>
          <button type="button" className="v-btn-secundario" onClick={() => window.location.reload()}>
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (!cardapio) {
    return (
      <div className="v-pagina v-pagina--centro">
        <div className="v-carregando" role="status" aria-label="Carregando cardápio">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  return (
    <CarrinhoProvider lojaId={lojaId}>
      <ConteudoPainel cardapio={cardapio} />
    </CarrinhoProvider>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { CarrinhoProvider, useCarrinho } from './context/CarrinhoContext';
import CatalogoProdutos from './components/CatalogoProdutos';
import CarrinhoDrawer from './components/CarrinhoDrawer';
import CheckoutForm from './components/CheckoutForm';
import PedidoConfirmado from './components/PedidoConfirmado';
import { buscarCardapio } from './services/pedidoService';
import { formatarPreco } from './types';
import type { CardapioResposta, PedidoConfirmacao } from './types';
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

  useEffect(() => {
    document.title = `${loja.nome} • Cardápio online`;
  }, [loja.nome]);

  const localizacao = [loja.bairro, loja.cidade, loja.uf].filter(Boolean).join(', ');

  return (
    <div className="v-pagina">
      <header className="v-header">
        <div className="v-header-loja">
          <div className="v-header-avatar" aria-hidden="true">
            {loja.nome.charAt(0).toUpperCase()}
          </div>
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

        {tela === 'catalogo' && <CatalogoProdutos produtos={produtos} />}

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

import { useEffect } from 'react';
import { useCarrinho } from '../context/CarrinhoContext';
import { formatarPreco } from '../types';

interface Props {
  aberto: boolean;
  onFechar: () => void;
  onIrParaCheckout: () => void;
}

export default function CarrinhoDrawer({ aberto, onFechar, onIrParaCheckout }: Props) {
  const { itens, subtotal, incrementar, decrementar, remover, definirObservacao } = useCarrinho();

  // Esc fecha a sacola; trava o scroll da página enquanto o drawer está aberto.
  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar();
    };
    document.addEventListener('keydown', aoTeclar);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      document.body.style.overflow = '';
    };
  }, [aberto, onFechar]);

  if (!aberto) return null;

  return (
    <div className="v-drawer-overlay" onClick={onFechar}>
      <aside
        className="v-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Sua sacola"
        onClick={e => e.stopPropagation()}
      >
        <header className="v-drawer-cabecalho">
          <h2>Sua sacola</h2>
          <button type="button" className="v-btn-fechar" onClick={onFechar} aria-label="Fechar sacola">
            ✕
          </button>
        </header>

        {itens.length === 0 ? (
          <div className="v-drawer-vazio">
            <span aria-hidden="true">🛒</span>
            <p>Sua sacola está vazia.</p>
            <button type="button" className="v-btn-secundario" onClick={onFechar}>
              Ver cardápio
            </button>
          </div>
        ) : (
          <>
            <ul className="v-drawer-lista">
              {itens.map(item => (
                <li key={item.produto.id} className="v-drawer-item">
                  <div className="v-drawer-item-info">
                    <div className="v-drawer-item-topo">
                      <span className="v-drawer-item-nome">{item.produto.nome}</span>
                      <button
                        type="button"
                        className="v-btn-remover"
                        onClick={() => remover(item.produto.id)}
                        aria-label={`Remover ${item.produto.nome} da sacola`}
                      >
                        Remover
                      </button>
                    </div>
                    <span className="v-drawer-item-preco">
                      {item.quantidade} × {formatarPreco(item.produto.preco)} ={' '}
                      <strong>{formatarPreco(item.produto.preco * item.quantidade)}</strong>
                    </span>
                    <input
                      type="text"
                      className="v-input v-input--observacao"
                      placeholder="Alguma observação? Ex.: sem cebola"
                      maxLength={120}
                      value={item.observacao ?? ''}
                      onChange={e => definirObservacao(item.produto.id, e.target.value)}
                    />
                  </div>
                  <div className="v-stepper v-stepper--drawer" role="group" aria-label={`Quantidade de ${item.produto.nome}`}>
                    <button type="button" onClick={() => decrementar(item.produto.id)} aria-label="Diminuir quantidade">
                      −
                    </button>
                    <span>{item.quantidade}</span>
                    <button type="button" onClick={() => incrementar(item.produto.id)} aria-label="Aumentar quantidade">
                      +
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <footer className="v-drawer-rodape">
              <div className="v-linha-valor">
                <span>Subtotal</span>
                <span>{formatarPreco(subtotal)}</span>
              </div>
              <div className="v-linha-valor v-linha-valor--suave">
                <span>Taxa de entrega</span>
                <span>combinada com a loja</span>
              </div>
              <div className="v-linha-valor v-linha-valor--total">
                <span>Total</span>
                <span>{formatarPreco(subtotal)}</span>
              </div>
              <button type="button" className="v-btn-primario" onClick={onIrParaCheckout}>
                Continuar para entrega
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

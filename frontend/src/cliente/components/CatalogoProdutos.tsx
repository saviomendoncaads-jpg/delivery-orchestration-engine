import { useState } from 'react';
import { useCarrinho } from '../context/CarrinhoContext';
import { urlImagem } from '../services/api';
import { formatarPreco } from '../types';
import type { ProdutoVitrine } from '../types';

// Foto do produto com fallback elegante: se a URL quebrar (ou não existir),
// mostra um bloco com a inicial do produto em vez de imagem rasgada.
function FotoProduto({ produto }: { produto: ProdutoVitrine }) {
  const [falhou, setFalhou] = useState(false);
  const src = urlImagem(produto.imagemUrl);
  if (!src || falhou) {
    return (
      <div className="v-card-foto v-card-foto--placeholder" aria-hidden="true">
        <span>{produto.nome.charAt(0).toUpperCase()}</span>
      </div>
    );
  }
  return (
    <div className="v-card-foto">
      <img
        src={src}
        alt={produto.nome}
        loading="lazy"
        onError={() => setFalhou(true)}
      />
    </div>
  );
}

function CardProduto({ produto, indice }: { produto: ProdutoVitrine; indice: number }) {
  const { adicionar, incrementar, decrementar, quantidadeDe } = useCarrinho();
  const quantidade = quantidadeDe(produto.id);

  return (
    <article className="v-card" style={{ animationDelay: `${Math.min(indice, 11) * 45}ms` }}>
      <FotoProduto produto={produto} />
      <div className="v-card-corpo">
        <h3 className="v-card-nome">{produto.nome}</h3>
        {produto.descricao && <p className="v-card-descricao">{produto.descricao}</p>}
        <div className="v-card-rodape">
          <span className="v-card-preco">{formatarPreco(produto.preco)}</span>
          {quantidade === 0 ? (
            <button type="button" className="v-btn-adicionar" onClick={() => adicionar(produto)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="9" cy="20" r="1" />
                <circle cx="18" cy="20" r="1" />
                <path d="M2 3h2l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.2L21 7H5" />
              </svg>
              Adicionar
            </button>
          ) : (
            <div className="v-stepper" role="group" aria-label={`Quantidade de ${produto.nome}`}>
              <button
                type="button"
                onClick={() => decrementar(produto.id)}
                aria-label={`Remover uma unidade de ${produto.nome}`}
              >
                −
              </button>
              <span aria-live="polite">{quantidade}</span>
              <button
                type="button"
                onClick={() => incrementar(produto.id)}
                aria-label={`Adicionar uma unidade de ${produto.nome}`}
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function CatalogoProdutos({ produtos }: { produtos: ProdutoVitrine[] }) {
  if (produtos.length === 0) {
    return (
      <div className="v-estado-vazio">
        <span className="v-estado-vazio-icone" aria-hidden="true">🍽️</span>
        <h2>Cardápio em preparação</h2>
        <p>Esta loja ainda não publicou produtos. Volte em breve!</p>
      </div>
    );
  }

  return (
    <section className="v-grid" aria-label="Cardápio de produtos">
      {produtos.map((p, i) => (
        <CardProduto key={p.id} produto={p} indice={i} />
      ))}
    </section>
  );
}

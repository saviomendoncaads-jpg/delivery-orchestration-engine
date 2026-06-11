import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ItemCarrinho, ProdutoVitrine } from '../types';

// ============================================================================
// Estado global do carrinho (Context API + useReducer).
// Persistido em localStorage POR LOJA: o cliente pode fechar a aba no meio do
// pedido e voltar com a sacola intacta, sem misturar sacolas de lojas diferentes.
// ============================================================================

const QTD_MAXIMA = 99; // espelha MAX_QTD_POR_ITEM do backend (vitrine.ts)

interface EstadoCarrinho {
  itens: ItemCarrinho[];
}

type AcaoCarrinho =
  | { tipo: 'adicionar'; produto: ProdutoVitrine }
  | { tipo: 'incrementar'; produtoId: string }
  | { tipo: 'decrementar'; produtoId: string }
  | { tipo: 'remover'; produtoId: string }
  | { tipo: 'observacao'; produtoId: string; observacao: string }
  | { tipo: 'limpar' };

function reducerCarrinho(estado: EstadoCarrinho, acao: AcaoCarrinho): EstadoCarrinho {
  switch (acao.tipo) {
    case 'adicionar': {
      const existente = estado.itens.find(i => i.produto.id === acao.produto.id);
      if (existente) {
        return reducerCarrinho(estado, { tipo: 'incrementar', produtoId: acao.produto.id });
      }
      return { itens: [...estado.itens, { produto: acao.produto, quantidade: 1 }] };
    }
    case 'incrementar':
      return {
        itens: estado.itens.map(i =>
          i.produto.id === acao.produtoId
            ? { ...i, quantidade: Math.min(QTD_MAXIMA, i.quantidade + 1) }
            : i
        )
      };
    case 'decrementar':
      // Chegou a zero = item sai da sacola.
      return {
        itens: estado.itens
          .map(i => (i.produto.id === acao.produtoId ? { ...i, quantidade: i.quantidade - 1 } : i))
          .filter(i => i.quantidade > 0)
      };
    case 'remover':
      return { itens: estado.itens.filter(i => i.produto.id !== acao.produtoId) };
    case 'observacao':
      return {
        itens: estado.itens.map(i =>
          i.produto.id === acao.produtoId ? { ...i, observacao: acao.observacao } : i
        )
      };
    case 'limpar':
      return { itens: [] };
    default:
      return estado;
  }
}

function chaveStorage(lojaId: string): string {
  return `distre.vitrine.carrinho.${lojaId}`;
}

function carregarEstadoInicial(lojaId: string): EstadoCarrinho {
  try {
    const bruto = localStorage.getItem(chaveStorage(lojaId));
    if (!bruto) return { itens: [] };
    const itens = JSON.parse(bruto);
    if (!Array.isArray(itens)) return { itens: [] };
    return {
      itens: itens.filter(
        (i: ItemCarrinho) => i?.produto?.id && Number.isInteger(i.quantidade) && i.quantidade > 0
      )
    };
  } catch {
    return { itens: [] };
  }
}

interface ContextoCarrinho {
  itens: ItemCarrinho[];
  totalItens: number;
  subtotal: number;
  adicionar: (produto: ProdutoVitrine) => void;
  incrementar: (produtoId: string) => void;
  decrementar: (produtoId: string) => void;
  remover: (produtoId: string) => void;
  definirObservacao: (produtoId: string, observacao: string) => void;
  limpar: () => void;
  quantidadeDe: (produtoId: string) => number;
}

const CarrinhoContext = createContext<ContextoCarrinho | null>(null);

export function CarrinhoProvider({ lojaId, children }: { lojaId: string; children: React.ReactNode }) {
  const [estado, dispatch] = useReducer(reducerCarrinho, lojaId, carregarEstadoInicial);

  useEffect(() => {
    try {
      localStorage.setItem(chaveStorage(lojaId), JSON.stringify(estado.itens));
    } catch {
      /* storage cheio/indisponível (modo privado) — sacola segue só em memória */
    }
  }, [estado.itens, lojaId]);

  const valor = useMemo<ContextoCarrinho>(() => {
    const subtotal = estado.itens.reduce((acc, i) => acc + i.produto.preco * i.quantidade, 0);
    const totalItens = estado.itens.reduce((acc, i) => acc + i.quantidade, 0);
    return {
      itens: estado.itens,
      totalItens,
      subtotal,
      adicionar: produto => dispatch({ tipo: 'adicionar', produto }),
      incrementar: produtoId => dispatch({ tipo: 'incrementar', produtoId }),
      decrementar: produtoId => dispatch({ tipo: 'decrementar', produtoId }),
      remover: produtoId => dispatch({ tipo: 'remover', produtoId }),
      definirObservacao: (produtoId, observacao) => dispatch({ tipo: 'observacao', produtoId, observacao }),
      limpar: () => dispatch({ tipo: 'limpar' }),
      quantidadeDe: produtoId => estado.itens.find(i => i.produto.id === produtoId)?.quantidade ?? 0
    };
  }, [estado.itens]);

  return <CarrinhoContext.Provider value={valor}>{children}</CarrinhoContext.Provider>;
}

export function useCarrinho(): ContextoCarrinho {
  const ctx = useContext(CarrinhoContext);
  if (!ctx) throw new Error('useCarrinho deve ser usado dentro de <CarrinhoProvider>.');
  return ctx;
}

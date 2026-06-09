// Tipos do Painel do Cliente (vitrine pública).
// Espelham os contratos do backend em backend/src/vitrine.ts.

export interface ProdutoVitrine {
  id: string;
  nome: string;
  descricao?: string;
  preco: number;
  imagemUrl?: string;
}

export interface LojaVitrine {
  id: string;
  nome: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  aceitandoPedidos: boolean;
}

export interface CardapioResposta {
  loja: LojaVitrine;
  produtos: ProdutoVitrine[];
}

export interface ItemCarrinho {
  produto: ProdutoVitrine;
  quantidade: number;
  observacao?: string;
}

export type FormaPagamentoVitrine = 'pix' | 'cartao' | 'dinheiro';

export interface EnderecoEntrega {
  cep: string;
  logradouro: string;
  numero: string;
  bairro: string;
  cidade: string;
  uf: string;
  complemento: string;
  referencia: string;
}

// Payload aceito por POST /api/vitrine/:lojaId/pedidos — os preços NÃO viajam
// no payload: o backend recalcula tudo a partir dos produtoId.
export interface PedidoPayload {
  cliente: {
    nome: string;
    telefone?: string;
  };
  itens: {
    produtoId: string;
    quantidade: number;
    observacao?: string;
  }[];
  endereco: {
    cep?: string;
    logradouro: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    complemento?: string;
    referencia?: string;
  };
  pagamento: {
    forma: FormaPagamentoVitrine;
    troco?: number;
  };
  observacao?: string;
}

export interface PedidoConfirmacao {
  success: boolean;
  pedidoId: string;
  status: string;
  total: number;
  subtotal: number;
  taxaEntrega: number;
  itens: {
    produtoId: string;
    nome: string;
    quantidade: number;
    precoUnitario: number;
  }[];
}

export function formatarPreco(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

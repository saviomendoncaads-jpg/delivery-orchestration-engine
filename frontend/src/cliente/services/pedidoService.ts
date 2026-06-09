import { apiGet, apiPost } from './api';
import type {
  CardapioResposta,
  EnderecoEntrega,
  FormaPagamentoVitrine,
  ItemCarrinho,
  PedidoConfirmacao,
  PedidoPayload
} from '../types';

// Carrega os dados públicos da loja + produtos ativos do cardápio.
export function buscarCardapio(lojaId: string): Promise<CardapioResposta> {
  return apiGet<CardapioResposta>(`/api/vitrine/${encodeURIComponent(lojaId)}`);
}

interface DadosCheckout {
  nome: string;
  telefone: string;
  endereco: EnderecoEntrega;
  formaPagamento: FormaPagamentoVitrine;
  troco?: number;
  observacao?: string;
}

// Converte o estado do carrinho + formulário no payload que a rota pública do
// Distre espera. Repare que NÃO enviamos preços: o backend recalcula o total
// pelo catálogo real da loja (anti-fraude de preço no cliente).
export function montarPayload(itens: ItemCarrinho[], dados: DadosCheckout): PedidoPayload {
  return {
    cliente: {
      nome: dados.nome.trim(),
      telefone: dados.telefone.trim() || undefined
    },
    itens: itens.map(item => ({
      produtoId: item.produto.id,
      quantidade: item.quantidade,
      observacao: item.observacao?.trim() || undefined
    })),
    endereco: {
      cep: dados.endereco.cep.trim() || undefined,
      logradouro: dados.endereco.logradouro.trim(),
      numero: dados.endereco.numero.trim() || undefined,
      bairro: dados.endereco.bairro.trim() || undefined,
      cidade: dados.endereco.cidade.trim() || undefined,
      uf: dados.endereco.uf.trim() || undefined,
      complemento: dados.endereco.complemento.trim() || undefined,
      referencia: dados.endereco.referencia.trim() || undefined
    },
    pagamento: {
      forma: dados.formaPagamento,
      troco: dados.formaPagamento === 'dinheiro' ? dados.troco : undefined
    },
    observacao: dados.observacao?.trim() || undefined
  };
}

// Dispara o pedido para o módulo Distre (cai como comanda RECEBIDO no painel da loja).
export function criarPedido(lojaId: string, payload: PedidoPayload): Promise<PedidoConfirmacao> {
  return apiPost<PedidoConfirmacao>(`/api/vitrine/${encodeURIComponent(lojaId)}/pedidos`, payload);
}

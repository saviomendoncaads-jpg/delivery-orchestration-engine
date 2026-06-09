import { formatarPreco } from '../types';
import type { PedidoConfirmacao } from '../types';

interface Props {
  confirmacao: PedidoConfirmacao;
  nomeLoja: string;
  onNovoPedido: () => void;
}

export default function PedidoConfirmado({ confirmacao, nomeLoja, onNovoPedido }: Props) {
  return (
    <div className="v-confirmacao">
      <div className="v-confirmacao-selo" aria-hidden="true">
        <svg viewBox="0 0 52 52">
          <circle className="v-selo-circulo" cx="26" cy="26" r="24" fill="none" />
          <path className="v-selo-check" fill="none" d="M14 27 l8 8 l16 -17" />
        </svg>
      </div>
      <h1>Pedido enviado!</h1>
      <p className="v-confirmacao-sub">
        <strong>{nomeLoja}</strong> recebeu seu pedido e já está cuidando dele.
      </p>

      <div className="v-confirmacao-card">
        <div className="v-confirmacao-linha">
          <span>Número do pedido</span>
          <code>{confirmacao.pedidoId}</code>
        </div>
        <div className="v-confirmacao-linha">
          <span>Status</span>
          <span className="v-chip-status">{confirmacao.status === 'RECEBIDO' ? 'Recebido pela loja' : confirmacao.status}</span>
        </div>
        <ul className="v-resumo-lista">
          {confirmacao.itens.map(item => (
            <li key={item.produtoId}>
              <span className="v-resumo-qtd">{item.quantidade}×</span>
              <span className="v-resumo-nome">{item.nome}</span>
              <span className="v-resumo-valor">{formatarPreco(item.precoUnitario * item.quantidade)}</span>
            </li>
          ))}
        </ul>
        <div className="v-linha-valor v-linha-valor--total">
          <span>Total</span>
          <span>{formatarPreco(confirmacao.total)}</span>
        </div>
      </div>

      <p className="v-confirmacao-nota">
        Guarde o número do pedido. Qualquer dúvida, fale com a loja informando esse código.
      </p>

      <button type="button" className="v-btn-secundario" onClick={onNovoPedido}>
        Fazer novo pedido
      </button>
    </div>
  );
}

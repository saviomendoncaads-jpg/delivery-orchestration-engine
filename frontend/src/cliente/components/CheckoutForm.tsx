import React, { useState } from 'react';
import { useCarrinho } from '../context/CarrinhoContext';
import { buscarEnderecoPorCep, mascararCep } from '../services/cep';
import { criarPedido, montarPayload } from '../services/pedidoService';
import { formatarPreco } from '../types';
import type { EnderecoEntrega, FormaPagamentoVitrine, PedidoConfirmacao } from '../types';

interface Props {
  lojaId: string;
  onVoltar: () => void;
  onConfirmado: (confirmacao: PedidoConfirmacao) => void;
}

const ENDERECO_VAZIO: EnderecoEntrega = {
  cep: '',
  logradouro: '',
  numero: '',
  bairro: '',
  cidade: '',
  uf: '',
  complemento: '',
  referencia: ''
};

function mascararTelefone(valor: string): string {
  const d = valor.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const FORMAS: { valor: FormaPagamentoVitrine; titulo: string; detalhe: string; icone: string }[] = [
  { valor: 'pix', titulo: 'PIX', detalhe: 'Chave enviada pela loja', icone: '◈' },
  { valor: 'cartao', titulo: 'Cartão', detalhe: 'Maquininha na entrega', icone: '💳' },
  { valor: 'dinheiro', titulo: 'Dinheiro', detalhe: 'Pague ao receber', icone: '💵' }
];

export default function CheckoutForm({ lojaId, onVoltar, onConfirmado }: Props) {
  const { itens, subtotal, limpar } = useCarrinho();

  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [endereco, setEndereco] = useState<EnderecoEntrega>(ENDERECO_VAZIO);
  const [formaPagamento, setFormaPagamento] = useState<FormaPagamentoVitrine>('pix');
  const [trocoStr, setTrocoStr] = useState('');
  const [observacao, setObservacao] = useState('');
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const total = subtotal; // v1: taxa de entrega combinada com a loja (não somada aqui)

  function atualizarEndereco(campo: keyof EnderecoEntrega, valor: string) {
    setEndereco(atual => ({ ...atual, [campo]: valor }));
  }

  // Ao completar o CEP, consulta o ViaCEP e preenche rua/bairro/cidade/UF.
  async function aoSairDoCep() {
    if (endereco.cep.replace(/\D/g, '').length !== 8) return;
    setBuscandoCep(true);
    const resultado = await buscarEnderecoPorCep(endereco.cep);
    setBuscandoCep(false);
    if (resultado) {
      setEndereco(atual => ({
        ...atual,
        logradouro: resultado.logradouro || atual.logradouro,
        bairro: resultado.bairro || atual.bairro,
        cidade: resultado.cidade || atual.cidade,
        uf: resultado.uf || atual.uf
      }));
    }
  }

  function validar(): string | null {
    if (itens.length === 0) return 'Sua sacola está vazia.';
    if (!nome.trim()) return 'Informe seu nome.';
    if (telefone.replace(/\D/g, '').length < 10) return 'Informe um telefone válido com DDD.';
    if (!endereco.logradouro.trim()) return 'Informe a rua do endereço de entrega.';
    if (!endereco.numero.trim()) return 'Informe o número do endereço.';
    if (!endereco.bairro.trim()) return 'Informe o bairro.';
    if (!endereco.cidade.trim()) return 'Informe a cidade.';
    if (formaPagamento === 'dinheiro' && trocoStr.trim()) {
      const troco = Number(trocoStr.replace(',', '.'));
      if (!Number.isFinite(troco)) return 'Valor de troco inválido.';
      if (troco < total) return `O troco deve ser maior ou igual ao total (${formatarPreco(total)}).`;
    }
    return null;
  }

  async function aoEnviar(e: React.FormEvent) {
    e.preventDefault();
    const problema = validar();
    if (problema) {
      setErro(problema);
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const troco = trocoStr.trim() ? Number(trocoStr.replace(',', '.')) : undefined;
      const payload = montarPayload(itens, {
        nome,
        telefone,
        endereco,
        formaPagamento,
        troco,
        observacao
      });
      const confirmacao = await criarPedido(lojaId, payload);
      limpar();
      onConfirmado(confirmacao);
    } catch (err: any) {
      setErro(err?.message || 'Não foi possível enviar o pedido. Tente novamente.');
    } finally {
      setEnviando(false);
    }
  }

  if (itens.length === 0) {
    return (
      <div className="v-estado-vazio">
        <span className="v-estado-vazio-icone" aria-hidden="true">🛒</span>
        <h2>Sua sacola está vazia</h2>
        <p>Adicione itens do cardápio para finalizar um pedido.</p>
        <button type="button" className="v-btn-secundario" onClick={onVoltar}>
          Voltar ao cardápio
        </button>
      </div>
    );
  }

  return (
    <div className="v-checkout">
      <button type="button" className="v-btn-voltar" onClick={onVoltar}>
        ← Voltar ao cardápio
      </button>

      <div className="v-checkout-colunas">
        <form className="v-form" onSubmit={aoEnviar} noValidate>
          <section className="v-form-bloco">
            <h2 className="v-form-titulo">Seus dados</h2>
            <div className="v-campo">
              <label htmlFor="v-nome">Nome *</label>
              <input
                id="v-nome"
                className="v-input"
                type="text"
                maxLength={120}
                autoComplete="name"
                value={nome}
                onChange={e => setNome(e.target.value)}
                placeholder="Como podemos te chamar?"
              />
            </div>
            <div className="v-campo">
              <label htmlFor="v-telefone">Telefone / WhatsApp *</label>
              <input
                id="v-telefone"
                className="v-input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={telefone}
                onChange={e => setTelefone(mascararTelefone(e.target.value))}
                placeholder="(00) 00000-0000"
              />
            </div>
          </section>

          <section className="v-form-bloco">
            <h2 className="v-form-titulo">Endereço de entrega</h2>
            <div className="v-campo v-campo--cep">
              <label htmlFor="v-cep">CEP {buscandoCep && <em className="v-cep-status">buscando…</em>}</label>
              <input
                id="v-cep"
                className="v-input"
                type="text"
                inputMode="numeric"
                autoComplete="postal-code"
                value={endereco.cep}
                onChange={e => atualizarEndereco('cep', mascararCep(e.target.value))}
                onBlur={aoSairDoCep}
                placeholder="00000-000"
              />
            </div>
            <div className="v-campo-linha">
              <div className="v-campo v-campo--crescer">
                <label htmlFor="v-rua">Rua *</label>
                <input
                  id="v-rua"
                  className="v-input"
                  type="text"
                  maxLength={120}
                  autoComplete="address-line1"
                  value={endereco.logradouro}
                  onChange={e => atualizarEndereco('logradouro', e.target.value)}
                  placeholder="Av. Brasil"
                />
              </div>
              <div className="v-campo v-campo--numero">
                <label htmlFor="v-numero">Número *</label>
                <input
                  id="v-numero"
                  className="v-input"
                  type="text"
                  maxLength={20}
                  value={endereco.numero}
                  onChange={e => atualizarEndereco('numero', e.target.value)}
                  placeholder="123"
                />
              </div>
            </div>
            <div className="v-campo-linha">
              <div className="v-campo v-campo--crescer">
                <label htmlFor="v-bairro">Bairro *</label>
                <input
                  id="v-bairro"
                  className="v-input"
                  type="text"
                  maxLength={120}
                  value={endereco.bairro}
                  onChange={e => atualizarEndereco('bairro', e.target.value)}
                  placeholder="Centro"
                />
              </div>
              <div className="v-campo v-campo--crescer">
                <label htmlFor="v-cidade">Cidade *</label>
                <input
                  id="v-cidade"
                  className="v-input"
                  type="text"
                  maxLength={120}
                  autoComplete="address-level2"
                  value={endereco.cidade}
                  onChange={e => atualizarEndereco('cidade', e.target.value)}
                  placeholder="Abreu e Lima"
                />
              </div>
              <div className="v-campo v-campo--uf">
                <label htmlFor="v-uf">UF</label>
                <input
                  id="v-uf"
                  className="v-input"
                  type="text"
                  maxLength={2}
                  value={endereco.uf}
                  onChange={e => atualizarEndereco('uf', e.target.value.toUpperCase())}
                  placeholder="PE"
                />
              </div>
            </div>
            <div className="v-campo">
              <label htmlFor="v-complemento">Complemento</label>
              <input
                id="v-complemento"
                className="v-input"
                type="text"
                maxLength={120}
                value={endereco.complemento}
                onChange={e => atualizarEndereco('complemento', e.target.value)}
                placeholder="Apto, bloco, casa…"
              />
            </div>
            <div className="v-campo">
              <label htmlFor="v-referencia">Ponto de referência</label>
              <input
                id="v-referencia"
                className="v-input"
                type="text"
                maxLength={200}
                value={endereco.referencia}
                onChange={e => atualizarEndereco('referencia', e.target.value)}
                placeholder="Próximo à praça, portão azul…"
              />
            </div>
          </section>

          <section className="v-form-bloco">
            <h2 className="v-form-titulo">Pagamento na entrega</h2>
            <div className="v-pagamentos" role="radiogroup" aria-label="Forma de pagamento">
              {FORMAS.map(f => (
                <label
                  key={f.valor}
                  className={`v-pagamento${formaPagamento === f.valor ? ' v-pagamento--ativo' : ''}`}
                >
                  <input
                    type="radio"
                    name="formaPagamento"
                    value={f.valor}
                    checked={formaPagamento === f.valor}
                    onChange={() => setFormaPagamento(f.valor)}
                  />
                  <span className="v-pagamento-icone" aria-hidden="true">{f.icone}</span>
                  <span className="v-pagamento-textos">
                    <strong>{f.titulo}</strong>
                    <small>{f.detalhe}</small>
                  </span>
                </label>
              ))}
            </div>
            {formaPagamento === 'dinheiro' && (
              <div className="v-campo v-campo--troco">
                <label htmlFor="v-troco">Troco para quanto? (opcional)</label>
                <input
                  id="v-troco"
                  className="v-input"
                  type="text"
                  inputMode="decimal"
                  value={trocoStr}
                  onChange={e => setTrocoStr(e.target.value.replace(/[^\d.,]/g, ''))}
                  placeholder={`Ex.: ${Math.ceil(total / 50) * 50},00`}
                />
              </div>
            )}
          </section>

          <section className="v-form-bloco">
            <div className="v-campo">
              <label htmlFor="v-observacao">Observações do pedido</label>
              <textarea
                id="v-observacao"
                className="v-input v-input--textarea"
                maxLength={500}
                rows={3}
                value={observacao}
                onChange={e => setObservacao(e.target.value)}
                placeholder="Alguma instrução para a loja ou para o entregador?"
              />
            </div>
          </section>

          {erro && (
            <p className="v-erro" role="alert">
              {erro}
            </p>
          )}

          <button type="submit" className="v-btn-primario v-btn-finalizar" disabled={enviando}>
            {enviando ? 'Enviando pedido…' : `Finalizar pedido • ${formatarPreco(total)}`}
          </button>
        </form>

        <aside className="v-resumo" aria-label="Resumo do pedido">
          <h2 className="v-form-titulo">Resumo</h2>
          <ul className="v-resumo-lista">
            {itens.map(item => (
              <li key={item.produto.id}>
                <span className="v-resumo-qtd">{item.quantidade}×</span>
                <span className="v-resumo-nome">
                  {item.produto.nome}
                  {item.observacao ? <small> — {item.observacao}</small> : null}
                </span>
                <span className="v-resumo-valor">{formatarPreco(item.produto.preco * item.quantidade)}</span>
              </li>
            ))}
          </ul>
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
            <span>{formatarPreco(total)}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

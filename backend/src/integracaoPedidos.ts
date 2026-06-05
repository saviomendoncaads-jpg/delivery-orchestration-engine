import { Router, Request, Response } from 'express';
import { broker } from './broker';
import { salvarEntrega } from './database';
import { Entrega, FormaPagamento, Prioridade, TipoCarga } from './types';
import { lojas } from './tenants';
import { deliveries, gerarIdComanda } from './gateway';
import { geocodificarEndereco } from './geocoding';
import { verificarLimiteEntregasMes, erroLimite } from './billing/planLimitsService';

const router = Router();

type FormaPgtoEntrada =
  | 'pix'
  | 'dinheiro'
  | 'maquininha'
  | 'credito'
  | 'debito'
  | 'cartao'
  | 'cartao_credito'
  | 'cartao_debito';

interface PedidoEntradaProduto {
  nome: string;
  quantidade: number;
  precoUnitario?: number;
  observacao?: string;
}

interface PedidoEntrada {
  lojaId?: string;
  cliente: {
    nome: string;
    telefone?: string;
    documento?: string;
  };
  produtos: PedidoEntradaProduto[];
  valores?: {
    subtotal?: number;
    taxaEntrega?: number;
    desconto?: number;
    total?: number;
  };
  endereco: {
    logradouro: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    cep?: string;
    referencia?: string;
  };
  pagamento?: {
    forma?: FormaPgtoEntrada;
    troco?: number;
  };
  prioridade?: Prioridade;
  tipoCarga?: TipoCarga;
  observacao?: string;
  idPedidoExterno?: string;
}

function normalizarFormaPagamento(forma?: FormaPgtoEntrada): FormaPagamento {
  switch (forma) {
    case 'pix':
      return 'pix';
    case 'dinheiro':
      return 'dinheiro';
    case 'maquininha':
    case 'credito':
    case 'debito':
    case 'cartao':
    case 'cartao_credito':
    case 'cartao_debito':
      return 'maquininha';
    default:
      return 'maquininha';
  }
}

function montarEndereco(end: PedidoEntrada['endereco']): string {
  const partes: string[] = [];
  if (end.logradouro) partes.push(end.logradouro);
  if (end.numero) partes.push(end.numero);
  if (end.complemento) partes.push(end.complemento);
  if (end.cidade) partes.push(end.cidade);
  if (end.uf) partes.push(end.uf);
  if (end.cep) partes.push(`CEP ${end.cep}`);
  return partes.join(', ');
}

// POST /api/integracao/pedidos — Ingestão pública de pedidos externos
router.post('/pedidos', async (req: Request, res: Response) => {
  try {
    const lojaId = (req.header('x-loja-id') || (req.body?.lojaId as string | undefined) || '').trim();
    if (!lojaId) {
      res.status(400).json({ error: 'Header X-Loja-Id (ou campo lojaId) é obrigatório.' });
      return;
    }

    const loja = lojas.find(l => l.id === lojaId);
    if (!loja) {
      res.status(404).json({ error: 'Loja não encontrada.' });
      return;
    }

    // Enforcement de plano: respeita o teto mensal de entregas do tier da loja.
    const limite = await verificarLimiteEntregasMes(lojaId);
    if (!limite.permitido) {
      res.status(403).json(erroLimite(limite));
      return;
    }

    const payload = req.body as PedidoEntrada;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Payload inválido.' });
      return;
    }

    const { cliente, produtos, endereco, valores, pagamento, observacao, idPedidoExterno } = payload;

    if (!cliente?.nome) {
      res.status(400).json({ error: 'cliente.nome é obrigatório.' });
      return;
    }
    if (!Array.isArray(produtos) || produtos.length === 0) {
      res.status(400).json({ error: 'produtos[] é obrigatório e não pode estar vazio.' });
      return;
    }
    if (!endereco?.logradouro) {
      res.status(400).json({ error: 'endereco.logradouro é obrigatório.' });
      return;
    }

    for (const [i, p] of produtos.entries()) {
      if (!p?.nome || !Number.isFinite(p.quantidade) || p.quantidade <= 0) {
        res.status(400).json({ error: `produtos[${i}] inválido: nome e quantidade (>0) são obrigatórios.` });
        return;
      }
    }

    const subtotalCalc = produtos.reduce(
      (acc, p) => acc + (Number(p.precoUnitario) || 0) * Number(p.quantidade),
      0
    );
    const subtotal = valores?.subtotal ?? subtotalCalc;
    const taxaEntrega = valores?.taxaEntrega ?? 0;
    const desconto = valores?.desconto ?? 0;
    const total = valores?.total ?? subtotal + taxaEntrega - desconto;

    const itensTexto = produtos.map(p => `${p.quantidade}x ${p.nome}`);
    const enderecoTexto = montarEndereco(endereco);
    const recebePedidos = loja.recebePedidos || false;

    // Geocodifica o endereço do destino para que o pino caia no lugar real no mapa.
    // Falha silenciosamente: se não resolver, o frontend cai no grid sintético antigo.
    const destinoCoord = await geocodificarEndereco({
      endereco: endereco.logradouro,
      numero: endereco.numero,
      bairro: endereco.bairro,
      cidade: endereco.cidade,
      uf: endereco.uf,
      cep: endereco.cep
    });

    const id = gerarIdComanda();
    const nowIso = new Date().toISOString();

    const novaComanda: Entrega = {
      id,
      nomeCliente: cliente.nome,
      clienteDocumento: cliente.documento || undefined,
      endereco: enderecoTexto,
      itens: itensTexto,
      prioridade: (payload.prioridade || 'media') as Prioridade,
      tipoCarga: (payload.tipoCarga || 'normal') as TipoCarga,
      status: 'RECEBIDO',
      valor: total,
      incidentes: [],
      urlWebhook: 'http://localhost:5000/api/simulator/webhook',
      logsWebhook: [],
      criadoEm: nowIso,
      atualizadoEm: nowIso,
      formaPagamento: normalizarFormaPagamento(pagamento?.forma),
      bairro: endereco.bairro || undefined,
      cidade: endereco.cidade || undefined,
      referencia: [
        endereco.referencia,
        observacao,
        pagamento?.troco ? `Troco para R$ ${pagamento.troco.toFixed(2)}` : undefined,
        idPedidoExterno ? `Pedido externo: ${idPedidoExterno}` : undefined
      ].filter(Boolean).join(' | ') || undefined,
      lojaId,
      nomeLoja: loja.nome,
      nomeEmpresa: undefined,
      tipoComanda: recebePedidos ? 'pedido' : 'entrega',
      destinoLatitude: destinoCoord?.latitude,
      destinoLongitude: destinoCoord?.longitude
    };

    deliveries.set(id, novaComanda);
    await salvarEntrega(novaComanda);

    if (!recebePedidos) {
      broker.publish('entrega.recebida', id, {
        deliveryId: id,
        cargoType: novaComanda.tipoCarga,
        priority: novaComanda.prioridade,
        clientName: novaComanda.nomeCliente,
        address: novaComanda.endereco
      });
    }

    res.status(201).json({
      success: true,
      pedidoId: id,
      status: novaComanda.status,
      tipoComanda: novaComanda.tipoComanda,
      total,
      subtotal,
      taxaEntrega,
      desconto
    });
  } catch (err: any) {
    console.error('[IntegracaoPedidos] Erro ao receber pedido:', err);
    res.status(500).json({ error: err.message || 'Erro interno ao processar pedido.' });
  }
});

export default router;

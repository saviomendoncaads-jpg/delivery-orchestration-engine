import { Router, Request, Response } from 'express';
import { broker } from './broker';
import { salvarEntrega, obterProdutos } from './database';
import { Entrega, FormaPagamento, Produto } from './types';
import { lojas } from './tenants';
import { deliveries, gerarIdComanda } from './gateway';
import { geocodificarEndereco } from './geocoding';
import { verificarLimiteEntregasMes, erroLimite } from './billing/planLimitsService';

// ============================================================================
// VITRINE PÚBLICA — Painel do Cliente (cardápio + checkout)
//
// Diferente de /api/integracao (server-to-server, autenticado por X-Api-Key),
// estas rotas são consumidas DIRETO pelo navegador do cliente final, então:
//   - não exigem credencial (a chaveAcesso da loja jamais vai ao browser);
//   - NUNCA confiam em preço vindo do cliente: o pedido referencia produtos
//     por ID e o valor é recalculado aqui com o preço do banco;
//   - expõem apenas dados públicos da loja (nada de usuario/senha/chave);
//   - são montadas no index.ts atrás de rate limit próprio.
// ============================================================================

const router = Router();

type FormaPgtoVitrine = 'pix' | 'cartao' | 'dinheiro';

interface ItemCarrinhoEntrada {
  produtoId: string;
  quantidade: number;
  observacao?: string;
}

interface PedidoVitrineEntrada {
  cliente: {
    nome: string;
    telefone?: string;
  };
  itens: ItemCarrinhoEntrada[];
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
    forma: FormaPgtoVitrine;
    troco?: number;
  };
  observacao?: string;
}

// Limites anti-abuso (rota pública): tamanhos máximos de campos e do carrinho.
const MAX_ITENS_DISTINTOS = 50;
const MAX_QTD_POR_ITEM = 99;
const MAX_TEXTO_CURTO = 120;
const MAX_TEXTO_LONGO = 500;

function textoLimpo(valor: unknown, max: number): string {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, max);
}

function normalizarFormaPagamento(forma: FormaPgtoVitrine): FormaPagamento {
  if (forma === 'pix') return 'pix';
  if (forma === 'dinheiro') return 'dinheiro';
  return 'maquininha'; // cartão é cobrado na entrega via maquininha
}

function buscarLojaAtiva(lojaId: string) {
  const loja = lojas.find(l => l.id === lojaId);
  if (!loja || !loja.ativo) return undefined;
  return loja;
}

// GET /api/vitrine/:lojaId — Dados públicos da loja + cardápio (produtos ativos)
router.get('/:lojaId', async (req: Request<{ lojaId: string }>, res: Response) => {
  try {
    const loja = buscarLojaAtiva(req.params.lojaId);
    if (!loja) {
      res.status(404).json({ error: 'Loja não encontrada.' });
      return;
    }

    const suspensa = loja.statusFinanceiro === 'SUSPENSO' || loja.statusFinanceiro === 'CANCELADO';
    const produtos = suspensa ? [] : await obterProdutos(loja.id);

    res.json({
      loja: {
        id: loja.id,
        nome: loja.nome,
        bairro: loja.bairro || undefined,
        cidade: loja.cidade || undefined,
        uf: loja.uf || undefined,
        logoUrl: loja.logoUrl || undefined,
        aceitandoPedidos: !suspensa
      },
      produtos: produtos.map(p => ({
        id: p.id,
        nome: p.nome,
        descricao: p.descricao || undefined,
        preco: p.preco,
        imagemUrl: p.imagemUrl || undefined
      }))
    });
  } catch (err: any) {
    console.error('[Vitrine] Erro ao montar cardápio:', err);
    res.status(500).json({ error: 'Erro interno ao carregar o cardápio.' });
  }
});

// POST /api/vitrine/:lojaId/pedidos — Checkout público do Painel do Cliente
router.post('/:lojaId/pedidos', async (req: Request<{ lojaId: string }>, res: Response) => {
  try {
    const loja = buscarLojaAtiva(req.params.lojaId);
    if (!loja) {
      res.status(404).json({ error: 'Loja não encontrada.' });
      return;
    }
    if (loja.statusFinanceiro === 'SUSPENSO' || loja.statusFinanceiro === 'CANCELADO') {
      res.status(503).json({ error: 'Esta loja não está aceitando pedidos no momento.' });
      return;
    }

    // Enforcement de plano: respeita o teto mensal de entregas do tier da loja.
    const limite = await verificarLimiteEntregasMes(loja.id);
    if (!limite.permitido) {
      res.status(503).json({ ...erroLimite(limite), error: 'Esta loja não está aceitando pedidos no momento.' });
      return;
    }

    const payload = req.body as PedidoVitrineEntrada;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Payload inválido.' });
      return;
    }

    const nomeCliente = textoLimpo(payload.cliente?.nome, MAX_TEXTO_CURTO);
    if (!nomeCliente) {
      res.status(400).json({ error: 'cliente.nome é obrigatório.' });
      return;
    }

    const logradouro = textoLimpo(payload.endereco?.logradouro, MAX_TEXTO_CURTO);
    if (!logradouro) {
      res.status(400).json({ error: 'endereco.logradouro é obrigatório.' });
      return;
    }

    const itens = payload.itens;
    if (!Array.isArray(itens) || itens.length === 0) {
      res.status(400).json({ error: 'itens[] é obrigatório e não pode estar vazio.' });
      return;
    }
    if (itens.length > MAX_ITENS_DISTINTOS) {
      res.status(400).json({ error: `Máximo de ${MAX_ITENS_DISTINTOS} itens distintos por pedido.` });
      return;
    }

    const forma = payload.pagamento?.forma;
    if (forma !== 'pix' && forma !== 'cartao' && forma !== 'dinheiro') {
      res.status(400).json({ error: "pagamento.forma deve ser 'pix', 'cartao' ou 'dinheiro'." });
      return;
    }

    // Resolve cada item contra o catálogo REAL da loja: produto inexistente ou
    // inativo derruba o pedido; o preço usado é sempre o do banco de dados.
    const catalogo = await obterProdutos(loja.id);
    const porId = new Map<string, Produto>(catalogo.map(p => [p.id, p]));

    const itensValidados: { produto: Produto; quantidade: number; observacao?: string }[] = [];
    for (const [i, item] of itens.entries()) {
      const produto = item?.produtoId ? porId.get(String(item.produtoId)) : undefined;
      if (!produto) {
        res.status(400).json({ error: `itens[${i}]: produto não encontrado no cardápio desta loja.` });
        return;
      }
      const quantidade = Number(item.quantidade);
      if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > MAX_QTD_POR_ITEM) {
        res.status(400).json({ error: `itens[${i}]: quantidade deve ser um inteiro entre 1 e ${MAX_QTD_POR_ITEM}.` });
        return;
      }
      const observacao = textoLimpo(item.observacao, MAX_TEXTO_CURTO) || undefined;
      itensValidados.push({ produto, quantidade, observacao });
    }

    const subtotal = itensValidados.reduce((acc, it) => acc + it.produto.preco * it.quantidade, 0);
    const taxaEntrega = 0; // v1: frete definido pela loja na comanda; campo reservado
    const total = Number((subtotal + taxaEntrega).toFixed(2));

    const troco = forma === 'dinheiro' && Number.isFinite(Number(payload.pagamento?.troco))
      ? Number(payload.pagamento!.troco)
      : undefined;
    if (troco !== undefined && troco < total) {
      res.status(400).json({ error: 'pagamento.troco deve ser maior ou igual ao total do pedido.' });
      return;
    }

    const endereco = payload.endereco;
    const partesEndereco = [
      logradouro,
      textoLimpo(endereco.numero, 20),
      textoLimpo(endereco.complemento, MAX_TEXTO_CURTO),
      textoLimpo(endereco.cidade, MAX_TEXTO_CURTO),
      textoLimpo(endereco.uf, 2).toUpperCase(),
      endereco.cep ? `CEP ${textoLimpo(endereco.cep, 10)}` : ''
    ].filter(Boolean);

    const itensTexto = itensValidados.map(it =>
      `${it.quantidade}x ${it.produto.nome}${it.observacao ? ` (${it.observacao})` : ''}`
    );

    // Geocodifica o destino para o pino cair no lugar real no mapa do despacho.
    // Falha silenciosamente: sem coordenada, o frontend usa o grid sintético.
    const destinoCoord = await geocodificarEndereco({
      endereco: logradouro,
      numero: endereco.numero,
      bairro: endereco.bairro,
      cidade: endereco.cidade,
      uf: endereco.uf,
      cep: endereco.cep
    });

    const recebePedidos = loja.recebePedidos || false;
    const id = gerarIdComanda();
    const nowIso = new Date().toISOString();
    const telefone = textoLimpo(payload.cliente?.telefone, 30);

    const novaComanda: Entrega = {
      id,
      nomeCliente,
      endereco: partesEndereco.join(', '),
      itens: itensTexto,
      prioridade: 'media',
      tipoCarga: 'normal',
      status: 'RECEBIDO',
      valor: total,
      incidentes: [],
      urlWebhook: 'http://localhost:5000/api/simulator/webhook',
      logsWebhook: [],
      criadoEm: nowIso,
      atualizadoEm: nowIso,
      formaPagamento: normalizarFormaPagamento(forma),
      bairro: textoLimpo(endereco.bairro, MAX_TEXTO_CURTO) || undefined,
      cidade: textoLimpo(endereco.cidade, MAX_TEXTO_CURTO) || undefined,
      referencia: [
        textoLimpo(endereco.referencia, MAX_TEXTO_LONGO),
        textoLimpo(payload.observacao, MAX_TEXTO_LONGO),
        telefone ? `Tel: ${telefone}` : undefined,
        troco !== undefined ? `Troco para R$ ${troco.toFixed(2)}` : undefined,
        'Pedido via Cardápio Online'
      ].filter(Boolean).join(' | ') || undefined,
      lojaId: loja.id,
      nomeLoja: loja.nome,
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
      total,
      subtotal: Number(subtotal.toFixed(2)),
      taxaEntrega,
      itens: itensValidados.map(it => ({
        produtoId: it.produto.id,
        nome: it.produto.nome,
        quantidade: it.quantidade,
        precoUnitario: it.produto.preco
      }))
    });
  } catch (err: any) {
    console.error('[Vitrine] Erro ao receber pedido:', err);
    res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  }
});

export default router;

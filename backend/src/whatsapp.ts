import { Router, Request, Response } from 'express';
import { deliveries, gerarIdComanda } from './gateway';
import { salvarEntrega, obterProdutos } from './database';
import { broker } from './broker';
import { lojas } from './tenants';
import { Entrega, Prioridade, TipoCarga, StatusEntrega, FormaPagamento, Produto } from './types';

export interface CarrinhoItem {
  produtoId: string;
  nome: string;
  quantidade: number;
  precoUnitario: number;
}

export interface WhatsappSession {
  phone: string;
  state: 'WELCOME' | 'NAME' | 'ITEMS' | 'QUANTITY' | 'ADD_MORE' | 'CEP' | 'ADDRESS_NUMBER' | 'ADDRESS_MANUAL' | 'PAYMENT' | 'CONFIRM' | 'COMPLETED';
  nomeCliente?: string;
  carrinho?: CarrinhoItem[];
  tempProdutoSelecionado?: Produto;
  cep?: string;
  endereco?: string;
  bairro?: string;
  cidade?: string;
  formaPagamento?: FormaPagamento;
  valor?: number;
  lojaId?: string;
  messages?: Array<{ sender: 'customer' | 'bot'; text: string; timestamp: string }>;
}

export const whatsappSessions = new Map<string, WhatsappSession>();

class WhatsappBotService {
  public async processMessage(phone: string, text: string, lojaId: string): Promise<string> {
    let session = whatsappSessions.get(phone);
    if (!session) {
      session = { phone, state: 'WELCOME', lojaId };
      whatsappSessions.set(phone, session);
    }
    if (!session.messages) {
      session.messages = [];
    }

    const input = text.trim();
    const cleanInput = input.toLowerCase();

    // Log the customer's message
    session.messages.push({ sender: 'customer', text: input, timestamp: new Date().toISOString() });

    const getReply = async (): Promise<string> => {
      // Reset se o usuário digitar cancelar
      if (cleanInput === 'cancelar' && session.state !== 'WELCOME') {
        session.state = 'WELCOME';
        session.nomeCliente = undefined;
        session.carrinho = undefined;
        session.tempProdutoSelecionado = undefined;
        session.cep = undefined;
        session.endereco = undefined;
        session.bairro = undefined;
        session.cidade = undefined;
        session.formaPagamento = undefined;
        session.valor = undefined;
        session.messages = []; // Clear history
        return 'Pedido cancelado. Se desejar iniciar um novo pedido, digite qualquer mensagem.';
      }

      // Busca o nome da loja
      const lojaObj = lojas.find(l => l.id === lojaId);
      const nomeLoja = lojaObj ? lojaObj.nome : 'Nossa Loja';

      switch (session.state) {
        case 'WELCOME':
          session.state = 'NAME';
          return `Olá! Seja bem-vindo ao assistente virtual de entregas da *${nomeLoja}*! 🤖📦\n\nPara iniciarmos seu pedido, por favor digite o seu **Nome completo**:`;

        case 'NAME':
          if (input.length < 3) {
            return `Por favor, digite um nome válido (mínimo de 3 caracteres):`;
          }
          session.nomeCliente = input;
          session.state = 'ITEMS';
          const products = await obterProdutos(lojaId);
          return `Prazer em te conhecer, *${session.nomeCliente}*! 😊\n\nSelecione um produto do nosso cardápio digitando o **número** correspondente:\n\n` +
            products.map((p, idx) => `${idx + 1}️⃣ - *${p.nome}* - R$ ${p.preco.toFixed(2)}`).join('\n');

        case 'ITEMS': {
          const products = await obterProdutos(lojaId);
          const idx = parseInt(cleanInput) - 1;
          if (isNaN(idx) || idx < 0 || idx >= products.length) {
            return `⚠️ Opção inválida. Por favor, selecione um produto digitando o número correspondente:\n\n` +
              products.map((p, i) => `${i + 1}️⃣ - *${p.nome}* - R$ ${p.preco.toFixed(2)}`).join('\n');
          }
          const selectedProd = products[idx];
          session.tempProdutoSelecionado = selectedProd;
          session.state = 'QUANTITY';
          return `Você selecionou: *${selectedProd.nome}* (R$ ${selectedProd.preco.toFixed(2)})\n\nDigite a **quantidade** desejada (apenas números):`;
        }

        case 'QUANTITY': {
          const qty = parseInt(cleanInput);
          if (isNaN(qty) || qty <= 0) {
            return `⚠️ Quantidade inválida. Por favor, digite um número inteiro maior que 0:`;
          }
          if (!session.carrinho) {
            session.carrinho = [];
          }
          const prod = session.tempProdutoSelecionado!;
          session.carrinho.push({
            produtoId: prod.id,
            nome: prod.nome,
            quantidade: qty,
            precoUnitario: prod.preco
          });
          session.tempProdutoSelecionado = undefined;
          session.state = 'ADD_MORE';
          return `Adicionado com sucesso! 🛒\n\nDeseja adicionar mais algum item?\n\n1️⃣ - Sim, ver cardápio\n2️⃣ - Não, finalizar pedido`;
        }

        case 'ADD_MORE':
          if (cleanInput === '1' || cleanInput.includes('sim')) {
            const products = await obterProdutos(lojaId);
            session.state = 'ITEMS';
            return `Selecione outro produto do nosso cardápio digitando o número correspondente:\n\n` +
              products.map((p, i) => `${i + 1}️⃣ - *${p.nome}* - R$ ${p.preco.toFixed(2)}`).join('\n');
          } else if (cleanInput === '2' || cleanInput.includes('nao') || cleanInput.includes('não') || cleanInput.includes('finalizar')) {
            session.state = 'CEP';
            return `Perfeito! Para entregarmos seu pedido, por favor digite o seu **CEP** (apenas os 8 números, ex: 52050000):`;
          } else {
            return `Por favor, selecione uma opção válida:\n\n1️⃣ - Sim, ver cardápio\n2️⃣ - Não, finalizar pedido`;
          }

        case 'CEP': {
          const cep = cleanInput.replace(/\D/g, '');
          if (cep.length !== 8) {
            return `⚠️ CEP inválido. O CEP deve conter exatamente 8 dígitos (ex: 52050000). Por favor, tente novamente:`;
          }
          try {
            const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            const data = (await res.json()) as any;
            if (data.erro) {
              session.state = 'ADDRESS_MANUAL';
              return `⚠️ CEP não localizado no banco de dados da ViaCEP.\n\nPor favor, digite seu **endereço completo manualmente** (Rua, Número, Bairro, Cidade):`;
            }
            session.cep = cep;
            session.endereco = data.logradouro;
            session.bairro = data.bairro;
            session.cidade = data.localidade;
            session.state = 'ADDRESS_NUMBER';
            return `Encontrei o endereço! 📍\n*${data.logradouro}, ${data.bairro} - ${data.localidade}/${data.uf}*\n\nPor favor, informe agora o **Número** da residência e algum **Ponto de Referência / Complemento** (ex: Número 123, apto 402):`;
          } catch (err) {
            session.state = 'ADDRESS_MANUAL';
            return `⚠️ Ocorreu uma lentidão ao consultar o CEP online. Por favor, digite seu **endereço completo manualmente** (Rua, Número, Bairro, Cidade):`;
          }
        }

        case 'ADDRESS_NUMBER':
          session.endereco = `${session.endereco}, ${input}`;
          session.state = 'PAYMENT';
          return `Endereço registrado! 📍\n\nComo deseja realizar o **pagamento**? Digite o número correspondente:\n\n1️⃣ - Pix\n2️⃣ - Cartão (Maquininha)\n3️⃣ - Dinheiro`;

        case 'ADDRESS_MANUAL': {
          const parts = input.split(',').map(p => p.trim());
          if (parts.length < 3) {
            return `⚠️ Endereço incompleto. Por favor, tente digitar no formato:\n**Rua, Número, Bairro, Cidade** (separados por vírgula).`;
          }
          session.endereco = `${parts[0]}, ${parts[1]}`;
          session.bairro = parts[2] || 'Centro';
          session.cidade = parts[3] || 'Cidade';
          session.state = 'PAYMENT';
          return `Endereço registrado! 📍\n\nComo deseja realizar o **pagamento**? Digite o número correspondente:\n\n1️⃣ - Pix\n2️⃣ - Cartão (Maquininha)\n3️⃣ - Dinheiro`;
        }

        case 'PAYMENT':
          if (cleanInput === '1' || cleanInput.includes('pix')) {
            session.formaPagamento = 'pix';
          } else if (cleanInput === '2' || cleanInput.includes('cartao') || cleanInput.includes('maquininha') || cleanInput.includes('cartão')) {
            session.formaPagamento = 'maquininha';
          } else if (cleanInput === '3' || cleanInput.includes('dinheiro')) {
            session.formaPagamento = 'dinheiro';
          } else {
            return `Por favor, selecione uma opção válida:\n1️⃣ - Pix\n2️⃣ - Cartão (Maquininha)\n3️⃣ - Dinheiro`;
          }

          // Calcula valores reais com base no carrinho
          const subtotal = session.carrinho?.reduce((sum, item) => sum + (item.precoUnitario * item.quantidade), 0) || 0;
          const taxaEntrega = 5.00; // Taxa de entrega fixa
          const total = subtotal + taxaEntrega;
          session.valor = total;

          session.state = 'CONFIRM';
          const fpLabel = session.formaPagamento === 'pix' ? 'PIX' : session.formaPagamento === 'maquininha' ? 'Cartão (Maquininha)' : 'Dinheiro';
          const itensStr = session.carrinho?.map(item => `${item.quantidade}x *${item.nome}* (R$ ${(item.precoUnitario * item.quantidade).toFixed(2)})`).join('\n- ');

          return `Perfeito! Veja o **resumo do seu pedido** antes de finalizarmos:\n\n👤 *Cliente:* ${session.nomeCliente}\n🛒 *Itens:*\n- ${itensStr}\n📍 *Entrega:* ${session.endereco}, ${session.bairro} - ${session.cidade} ${session.cep ? '(CEP: ' + session.cep + ')' : ''}\n💳 *Pagamento:* ${fpLabel}\n💵 *Subtotal:* R$ ${subtotal.toFixed(2)}\n🚚 *Taxa de Entrega:* R$ ${taxaEntrega.toFixed(2)}\n💰 *Total:* R$ ${total.toFixed(2)}\n\nConfirma o pedido? Digite **SIM** para finalizar ou **CANCELAR** para reiniciar.`;

        case 'CONFIRM':
          if (cleanInput === 'sim') {
            // Cria a comanda no sistema
            const id = gerarIdComanda();
            const lojaObj = lojas.find(l => l.id === session.lojaId);
            const recebePedidos = lojaObj ? lojaObj.recebePedidos : false;

            const newDelivery: Entrega = {
              id,
              nomeCliente: session.nomeCliente || 'Cliente WhatsApp',
              endereco: session.endereco || 'Endereço WhatsApp',
              itens: session.carrinho?.map(item => `${item.quantidade}x ${item.nome}`) || [],
              prioridade: 'media' as Prioridade,
              tipoCarga: 'normal' as TipoCarga,
              status: 'RECEBIDO' as StatusEntrega,
              valor: session.valor,
              incidentes: [],
              urlWebhook: 'http://localhost:5000/api/simulator/webhook',
              logsWebhook: [],
              criadoEm: new Date().toISOString(),
              atualizadoEm: new Date().toISOString(),
              formaPagamento: session.formaPagamento || 'maquininha',
              bairro: session.bairro,
              cidade: session.cidade,
              referencia: 'Pedido WhatsApp (Bot)',
              lojaId: session.lojaId,
              tipoComanda: recebePedidos ? 'pedido' : 'entrega'
            };

            // Salva no banco de dados local e insere no gateway
            deliveries.set(id, newDelivery);
            await salvarEntrega(newDelivery);

            // Publica o evento para orquestração automática do dispatcher se for entrega direta
            if (!recebePedidos) {
              broker.publish('entrega.recebida', id, {
                deliveryId: id,
                cargoType: newDelivery.tipoCarga,
                priority: newDelivery.prioridade,
                clientName: newDelivery.nomeCliente,
                address: newDelivery.endereco,
                x: 40 + Math.floor(Math.random() * 55),
                y: 40 + Math.floor(Math.random() * 55)
              });
            }


            // Reset da sessão
            session.state = 'WELCOME';
            session.nomeCliente = undefined;
            session.carrinho = undefined;
            session.tempProdutoSelecionado = undefined;
            session.cep = undefined;
            session.endereco = undefined;
            session.bairro = undefined;
            session.cidade = undefined;
            session.formaPagamento = undefined;
            session.valor = undefined;

            return `🎉 **Pedido Confirmado com sucesso!**\n\nA sua comanda foi gerada: *${id}*.\n\nNossa equipe já foi notificada e o entregador será despachado em instantes! Obrigado por comprar conosco! 🙏`;
          } else {
            return `Digite **SIM** para confirmar o pedido ou **CANCELAR** para recomeçar.`;
          }

        default:
          session.state = 'WELCOME';
          return `Ocorreu um erro no fluxo do chat. Vamos recomeçar? Digite qualquer mensagem.`;
      }
    };

    const reply = await getReply();
    if (!session.messages) {
      session.messages = [];
    }
    session.messages.push({ sender: 'bot', text: reply, timestamp: new Date().toISOString() });
    return reply;
  }
}

export const whatsappBotService = new WhatsappBotService();

const router = Router();

router.post('/message', async (req: Request, res: Response) => {
  const { phone, text, lojaId } = req.body;
  if (!phone || !text || !lojaId) {
    res.status(400).json({ error: 'Campos phone, text e lojaId são obrigatórios.' });
    return;
  }

  try {
    const reply = await whatsappBotService.processMessage(phone, text, lojaId);
    res.json({ reply });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions', (req: Request, res: Response) => {
  res.json(Array.from(whatsappSessions.entries()));
});

export default router;

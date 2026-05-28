import { Router, Request, Response } from 'express';
import { deliveries, gerarIdComanda } from './gateway';
import { salvarEntrega } from './database';
import { broker } from './broker';
import { lojas } from './tenants';
import { Entrega, Prioridade, TipoCarga, StatusEntrega, FormaPagamento } from './types';

export interface WhatsappSession {
  phone: string;
  state: 'WELCOME' | 'NAME' | 'ITEMS' | 'ADDRESS' | 'PAYMENT' | 'CONFIRM' | 'COMPLETED';
  nomeCliente?: string;
  itens?: string[];
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
        session.itens = undefined;
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
          return `Prazer em te conhecer, *${session.nomeCliente}*! 😊\n\nAgora, digite os **itens do seu pedido** (separe por vírgula se for mais de um):\n_Exemplo: 1x Pizza Portuguesa, 1x Coca-cola lata_`;

        case 'ITEMS':
          if (input.length < 3) {
            return `Por favor, descreva os itens do seu pedido:`;
          }
          session.itens = input.split(',').map(i => i.trim());
          session.state = 'ADDRESS';
          return `Anotado! 📝\n\nAgora, por favor digite o **endereço de entrega completo** separado por vírgulas no formato abaixo:\n\n**Rua, Número, Bairro, Cidade**\n\n_Exemplo: Av. Paulista, 945, Bela Vista, São Paulo_`;

        case 'ADDRESS':
          const parts = input.split(',').map(p => p.trim());
          if (parts.length < 3) {
            return `⚠️ Endereço incompleto. Por favor, tente digitar no formato:\n**Rua, Número, Bairro, Cidade** (separados por vírgula).`;
          }
          session.endereco = `${parts[0]}, ${parts[1]}`;
          session.bairro = parts[2] || 'Centro';
          session.cidade = parts[3] || 'Abreu e Lima';
          
          session.state = 'PAYMENT';
          return `Endereço registrado! 📍\n\nComo deseja realizar o **pagamento**? Digite o número correspondente:\n\n1️⃣ - Pix\n2️⃣ - Cartão (Maquininha)\n3️⃣ - Dinheiro`;

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

          // Calcula valores simulados
          session.valor = Math.round((25 + Math.random() * 60) * 100) / 100;
          const total = session.valor + 5.00; // R$ 5,00 taxa fixa de entrega

          session.state = 'CONFIRM';
          const fpLabel = session.formaPagamento === 'pix' ? 'PIX' : session.formaPagamento === 'maquininha' ? 'Cartão (Maquininha)' : 'Dinheiro';
          return `Perfeito! Veja o **resumo do seu pedido** antes de finalizarmos:\n\n👤 *Cliente:* ${session.nomeCliente}\n📦 *Itens:* ${session.itens?.join(', ')}\n📍 *Entrega:* ${session.endereco}, ${session.bairro} - ${session.cidade}\n💳 *Pagamento:* ${fpLabel}\n💵 *Produtos:* R$ ${session.valor.toFixed(2)}\n🚚 *Taxa de Entrega:* R$ 5.00\n💰 *Total:* R$ ${total.toFixed(2)}\n\nConfirma o pedido? Digite **SIM** para finalizar ou **CANCELAR** para reiniciar.`;

        case 'CONFIRM':
          if (cleanInput === 'sim') {
            // Cria a comanda no sistema
            const id = gerarIdComanda();
            const totalVal = session.valor || 35.00;
            
            const newDelivery: Entrega = {
              id,
              nomeCliente: session.nomeCliente || 'Cliente WhatsApp',
              endereco: session.endereco || 'Endereço WhatsApp',
              itens: session.itens || [],
              prioridade: 'media' as Prioridade,
              tipoCarga: 'normal' as TipoCarga,
              status: 'RECEBIDO' as StatusEntrega,
              valor: totalVal,
              incidentes: [],
              urlWebhook: 'http://localhost:5000/api/simulator/webhook',
              logsWebhook: [],
              criadoEm: new Date().toISOString(),
              atualizadoEm: new Date().toISOString(),
              formaPagamento: session.formaPagamento || 'maquininha',
              bairro: session.bairro,
              cidade: session.cidade,
              referencia: 'Pedido WhatsApp (Bot)',
              lojaId: session.lojaId
            };

            // Salva no banco de dados local e insere no gateway
            deliveries.set(id, newDelivery);
            await salvarEntrega(newDelivery);

            // Publica o evento para orquestração automática do dispatcher
            broker.publish('entrega.recebida', id, {
              deliveryId: id,
              cargoType: newDelivery.tipoCarga,
              priority: newDelivery.prioridade,
              clientName: newDelivery.nomeCliente,
              address: newDelivery.endereco,
              x: 40 + Math.floor(Math.random() * 55),
              y: 40 + Math.floor(Math.random() * 55)
            });

            // Reset da sessão
            session.state = 'WELCOME';
            session.nomeCliente = undefined;
            session.itens = undefined;
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

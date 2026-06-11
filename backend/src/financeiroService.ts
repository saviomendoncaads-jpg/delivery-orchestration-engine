import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import mssql from './db';
import { pool } from './database';
import { verificarAdmin, revogarSessoesDaEmpresa } from './auth';
import { empresas, lojas } from './tenants';
import { getGateway } from './billing/gatewayFactory';
import { appendLedger } from './billing/ledgerService';
import { transicionar } from './billing/SubscriptionStateMachine';
import { hashPassword } from './security/password';

const router = Router();

// ==========================================
// 1. ROTINA DE CRON / VERIFICAÇÃO DE INADIMPLÊNCIA
// ==========================================

export async function rotinaVerificacaoInadimplencia() {
  try {
    if (!pool) return;
    console.log('[Financeiro] Executando rotina de verificação de faturas vencidas...');

    // 1. Obter dias de carência das configurações
    let diasCarenciaBloqueio = 5;
    const configRes = await pool.request().query('SELECT TOP 1 DIAS_CARENCIA_BLOQUEIO FROM CONFIGURACOES_COBRANCA');
    if (configRes.recordset.length > 0) {
      diasCarenciaBloqueio = configRes.recordset[0].DIAS_CARENCIA_BLOQUEIO;
    }

    const hoje = new Date();
    const hojeStr = hoje.toISOString().split('T')[0]; // YYYY-MM-DD

    // 2. Buscar todas as faturas PENDENTES ou ATRASADAS para reavaliação
    const faturasRes = await pool.request().query("SELECT * FROM FATURAS WHERE STATUS IN ('PENDENTE', 'ATRASADA')");
    const faturas = faturasRes.recordset;

    // Guardar empresas afetadas para atualização posterior
    const empresasComPendencia = new Set<string>();
    const empresasEmAtrasoCritico = new Set<string>();

    for (const fat of faturas) {
      const vencimento = new Date(fat.DATA_VENCIMENTO);
      const vencimentoStr = vencimento.toISOString().split('T')[0];

      if (vencimento < hoje && vencimentoStr !== hojeStr) {
        // A fatura está vencida!
        if (fat.STATUS === 'PENDENTE') {
          console.log(`[Financeiro] Fatura ${fat.ID} vencida. Alterando status de PENDENTE para ATRASADA.`);
          await pool.request()
            .input('id', mssql.VarChar, fat.ID)
            .query("UPDATE FATURAS SET STATUS = 'ATRASADA' WHERE ID = @id");
          fat.STATUS = 'ATRASADA';
        }

        empresasComPendencia.add(fat.EMPRESA_ID);

        // Calcular dias de atraso
        const diffTime = Math.abs(hoje.getTime() - vencimento.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > diasCarenciaBloqueio) {
          empresasEmAtrasoCritico.add(fat.EMPRESA_ID);
        }
      } else {
        // Se a data de vencimento é futura e por algum motivo estava como ATRASADA, corrige
        if (fat.STATUS === 'ATRASADA') {
          await pool.request()
            .input('id', mssql.VarChar, fat.ID)
            .query("UPDATE FATURAS SET STATUS = 'PENDENTE' WHERE ID = @id");
          fat.STATUS = 'PENDENTE';
        }
      }
    }

    // 3. Atualizar status de cada empresa no banco e na memória
    for (const emp of empresas) {
      const statusAnterior = emp.statusFinanceiro;

      // SUSPENSO/CANCELADO são de responsabilidade EXCLUSIVA da máquina de estados
      // da assinatura (saída desses estados só via pagamento/reativação, que deriva
      // o status da empresa). A rotina não toca neles — evita o conflito de duas
      // lógicas brigando pelo STATUS_FINANCEIRO (ex.: rotina resetar SUSPENSO->REGULAR).
      if (statusAnterior === 'SUSPENSO' || statusAnterior === 'CANCELADO') {
        continue;
      }

      let novoStatus = 'REGULAR';
      if (empresasEmAtrasoCritico.has(emp.id)) {
        novoStatus = 'INADIMPLENTE';
      }

      if (statusAnterior !== novoStatus) {
        console.log(`[Financeiro] Alterando status financeiro da empresa ${emp.nome} (${emp.id}): ${statusAnterior} -> ${novoStatus}`);
        
        // Atualiza banco
        await pool.request()
          .input('id', mssql.VarChar, emp.id)
          .input('status', mssql.VarChar, novoStatus)
          .query('UPDATE EMPRESAS SET STATUS_FINANCEIRO = @status WHERE ID = @id');
        
        // Atualiza em memória
        emp.statusFinanceiro = novoStatus;

        // Se ficou INADIMPLENTE, desloga todas as sessões das lojas vinculadas a essa empresa
        if (novoStatus === 'INADIMPLENTE') {
          console.log(`[Financeiro] Revogando sessões de lojas da empresa ${emp.nome} devido à inadimplência.`);
          await revogarSessoesDaEmpresa(emp.id);
        }
      }
    }

    console.log('[Financeiro] Rotina de verificação concluída.');
  } catch (err) {
    console.error('[Financeiro] Erro ao executar rotina de inadimplência:', err);
  }
}

// Inicializador da rotina e seed
export async function inicializarFinanceiro() {
  // Executa imediatamente na inicialização
  await seedFinanceiro();
  await rotinaVerificacaoInadimplencia();

  // Executa a cada 5 minutos
  setInterval(async () => {
    await rotinaVerificacaoInadimplencia();
  }, 5 * 60 * 1000);
}

// Seed para demonstrar o Painel Financeiro caso não haja dados
async function seedFinanceiro() {
  try {
    if (!pool) return;
    // Produção (SEED_DEMO=false): não cria empresa/loja/faturas de demonstração.
    if (process.env.SEED_DEMO === 'false') {
      console.log('[Financeiro] SEED_DEMO=false — seed de demonstração pulado (produção).');
      return;
    }

    // Verificar se já existem faturas
    const fatCount = await pool.request().query('SELECT COUNT(*) as qtd FROM FATURAS');
    if (fatCount.recordset[0].qtd > 0) {
      return;
    }

    console.log('[Financeiro] Banco de dados de faturas vazio. Iniciando seed de demonstração...');

    if (empresas.length === 0) {
      console.log('[Financeiro] Nenhuma empresa cadastrada para associar faturas. Criando empresa padrão...');
      const novaEmpresa = {
        id: crypto.randomUUID(),
        nome: 'Farmácia Pague Menos',
        cnpj: '01.234.567/0001-89',
        telefone: '(11) 98888-7777',
        email: 'financeiro@paguemenos.com.br',
        ativo: true,
        statusFinanceiro: 'REGULAR',
        criadoEm: new Date().toISOString()
      };
      // Salvar no banco
      await pool.request()
        .input('id', mssql.VarChar, novaEmpresa.id)
        .input('nome', mssql.NVarChar, novaEmpresa.nome)
        .input('cnpj', mssql.VarChar, novaEmpresa.cnpj)
        .input('tel', mssql.VarChar, novaEmpresa.telefone)
        .input('email', mssql.VarChar, novaEmpresa.email)
        .input('criado', mssql.VarChar, novaEmpresa.criadoEm)
        .query('INSERT INTO EMPRESAS (ID, NOME, CNPJ, TELEFONE, EMAIL, ATIVO, STATUS_FINANCEIRO, CRIADO_EM) VALUES (@id, @nome, @cnpj, @tel, @email, 1, @statusFinanceiro, @criado)');
      empresas.push(novaEmpresa);

      // Criar uma loja padrão para esta empresa para que a simulação funcione perfeitamente
      const senhaHashSeed = await hashPassword('123456');
      const novaLoja = {
        id: '41869dbf-4b09-4933-8bd2-11e60ccc092d', // ID fixo usado no simulador
        empresaId: novaEmpresa.id,
        nome: 'Pague Menos - Paulista',
        cnpj: '01.234.567/0002-78',
        endereco: 'Av. Paulista, 1000',
        bairro: 'Bela Vista',
        cidade: 'São Paulo',
        usuario: 'paguemenos',
        senhaHash: senhaHashSeed,
        chaveAcesso: 'DISTRE-MOCK-PAGUE-MENOS',
        ativo: true,
        criadoEm: new Date().toISOString(),
        recebePedidos: true
      };
      await pool.request()
        .input('id', mssql.VarChar, novaLoja.id)
        .input('empId', mssql.VarChar, novaLoja.empresaId)
        .input('nome', mssql.NVarChar, novaLoja.nome)
        .input('cnpj', mssql.VarChar, novaLoja.cnpj)
        .input('end', mssql.NVarChar, novaLoja.endereco)
        .input('bairro', mssql.NVarChar, novaLoja.bairro)
        .input('cidade', mssql.NVarChar, novaLoja.cidade)
        .input('user', mssql.VarChar, novaLoja.usuario)
        .input('pass', mssql.VarChar, novaLoja.senhaHash)
        .input('key', mssql.VarChar, novaLoja.chaveAcesso)
        .input('criado', mssql.VarChar, novaLoja.criadoEm)
        .query('INSERT INTO LOJAS (ID, EMPRESA_ID, NOME, CNPJ, ENDERECO, BAIRRO, CIDADE, USUARIO, SENHA_HASH, CHAVE_ACESSO, ATIVO, CRIADO_EM, RECEBE_PEDIDOS) VALUES (@id, @empId, @nome, @cnpj, @end, @bairro, @cidade, @user, @pass, @key, 1, @criado, 1)');
      lojas.push(novaLoja);
    }

    const agora = new Date();
    const agoraStr = agora.toISOString();

    // Cobrança por LOJA: uma assinatura + faturas por loja.
    for (const loja of lojas) {
      const lojaKey = loja.id.substring(0, 6);
      // 1. Assinatura ATIVA da loja no Plano Pro (silver)
      const assinaturaId = `sub-${crypto.randomUUID().substring(0, 8)}`;
      const proximoFat = new Date(agora.getFullYear(), agora.getMonth() + 1, 10).toISOString();
      await pool.request()
        .input('id', mssql.VarChar, assinaturaId)
        .input('empId', mssql.VarChar, loja.empresaId)
        .input('lojaId', mssql.VarChar, loja.id)
        .input('planoId', mssql.VarChar, 'silver')
        .input('proximo', mssql.VarChar, proximoFat)
        .input('criado', mssql.VarChar, agoraStr)
        .query("INSERT INTO ASSINATURAS_EMPRESAS (ID, EMPRESA_ID, LOJA_ID, PLANO_ID, STATUS, DIA_VENCIMENTO, CRIADO_EM, PROXIMO_FATURAMENTO) VALUES (@id, @empId, @lojaId, @planoId, 'ATIVA', 10, @criado, @proximo)");

      // 2. Fatura 1: Paga (Março/2026)
      const dataVenc1 = new Date(2026, 2, 10).toISOString();
      const dataPgto1 = new Date(2026, 2, 8).toISOString();
      await pool.request()
        .input('id', mssql.VarChar, `fat-mar-${lojaKey}`)
        .input('empId', mssql.VarChar, loja.empresaId)
        .input('lojaId', mssql.VarChar, loja.id)
        .input('subId', mssql.VarChar, assinaturaId)
        .input('valor', mssql.Decimal(10, 2), 299.00)
        .input('status', mssql.VarChar, 'PAGA')
        .input('emissao', mssql.VarChar, new Date(2026, 2, 1).toISOString())
        .input('venc', mssql.VarChar, dataVenc1)
        .input('pgto', mssql.VarChar, dataPgto1)
        .input('ref', mssql.VarChar, '03/2026')
        .input('criado', mssql.VarChar, dataVenc1)
        .query(`
          INSERT INTO FATURAS (ID, EMPRESA_ID, LOJA_ID, ASSINATURAS_EMPRESAS_ID, VALOR_BRUTO, VALOR_DESCONTO, STATUS, DATA_EMISSAO, DATA_VENCIMENTO, DATA_PAGAMENTO, REFERENCIA_MES_ANO, CRIADO_EM)
          VALUES (@id, @empId, @lojaId, @subId, @valor, 0.00, @status, @emissao, @venc, @pgto, @ref, @criado)
        `);

      // 3. Fatura 2: Paga (Abril/2026)
      const dataVenc2 = new Date(2026, 3, 10).toISOString();
      const dataPgto2 = new Date(2026, 3, 9).toISOString();
      await pool.request()
        .input('id', mssql.VarChar, `fat-abr-${lojaKey}`)
        .input('empId', mssql.VarChar, loja.empresaId)
        .input('lojaId', mssql.VarChar, loja.id)
        .input('subId', mssql.VarChar, assinaturaId)
        .input('valor', mssql.Decimal(10, 2), 299.00)
        .input('status', mssql.VarChar, 'PAGA')
        .input('emissao', mssql.VarChar, new Date(2026, 3, 1).toISOString())
        .input('venc', mssql.VarChar, dataVenc2)
        .input('pgto', mssql.VarChar, dataPgto2)
        .input('ref', mssql.VarChar, '04/2026')
        .input('criado', mssql.VarChar, dataVenc2)
        .query(`
          INSERT INTO FATURAS (ID, EMPRESA_ID, LOJA_ID, ASSINATURAS_EMPRESAS_ID, VALOR_BRUTO, VALOR_DESCONTO, STATUS, DATA_EMISSAO, DATA_VENCIMENTO, DATA_PAGAMENTO, REFERENCIA_MES_ANO, CRIADO_EM)
          VALUES (@id, @empId, @lojaId, @subId, @valor, 0.00, @status, @emissao, @venc, @pgto, @ref, @criado)
        `);

      // 4. Fatura 3: Pendente (próximo ciclo) — vence dia 10 do próximo mês, sem disparar
      // a suspensão D+7 da régua (não tranca o login da loja de demonstração).
      const vencFuturo = new Date(agora.getFullYear(), agora.getMonth() + 1, 10);
      const dataVenc3 = vencFuturo.toISOString();
      const ref3 = `${String(vencFuturo.getMonth() + 1).padStart(2, '0')}/${vencFuturo.getFullYear()}`;
      const emissao3 = new Date(agora.getFullYear(), agora.getMonth() + 1, 1).toISOString();
      await pool.request()
        .input('id', mssql.VarChar, `fat-mai-${lojaKey}`)
        .input('empId', mssql.VarChar, loja.empresaId)
        .input('lojaId', mssql.VarChar, loja.id)
        .input('subId', mssql.VarChar, assinaturaId)
        .input('valor', mssql.Decimal(10, 2), 299.00)
        .input('status', mssql.VarChar, 'PENDENTE')
        .input('emissao', mssql.VarChar, emissao3)
        .input('venc', mssql.VarChar, dataVenc3)
        .input('ref', mssql.VarChar, ref3)
        .input('criado', mssql.VarChar, dataVenc3)
        .query(`
          INSERT INTO FATURAS (ID, EMPRESA_ID, LOJA_ID, ASSINATURAS_EMPRESAS_ID, VALOR_BRUTO, VALOR_DESCONTO, STATUS, DATA_EMISSAO, DATA_VENCIMENTO, REFERENCIA_MES_ANO, CRIADO_EM)
          VALUES (@id, @empId, @lojaId, @subId, @valor, 0.00, @status, @emissao, @venc, @ref, @criado)
        `);

      console.log(`[Financeiro] Seed de faturas criado para a loja: ${loja.nome}`);
    }

  } catch (err) {
    console.error('[Financeiro] Erro ao rodar seed de faturas:', err);
  }
}

// ==========================================
// 2. ENDPOINTS DA API FINANCEIRA
// ==========================================

// Listar todas as faturas (com paginação e filtros)
router.get('/faturas', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { status, empresaId, dataInicio, dataFim, page, limit } = req.query;
    
    let query = `
      SELECT F.*, E.NOME as EmpresaNome, E.CNPJ as EmpresaCNPJ
      FROM FATURAS F
      JOIN EMPRESAS E ON F.EMPRESA_ID = E.ID
      WHERE 1=1
    `;

    const request = pool.request();

    if (status) {
      query += ' AND F.STATUS = @status';
      request.input('status', mssql.VarChar, status);
    }
    if (empresaId) {
      query += ' AND F.EMPRESA_ID = @empresaId';
      request.input('empresaId', mssql.VarChar, empresaId);
    }
    if (dataInicio) {
      query += ' AND F.DATA_VENCIMENTO >= @dataInicio';
      request.input('dataInicio', mssql.VarChar, dataInicio);
    }
    if (dataFim) {
      query += ' AND F.DATA_VENCIMENTO <= @dataFim';
      request.input('dataFim', mssql.VarChar, dataFim);
    }

    // Ordenação (vencimentos mais recentes primeiro, ou pendentes na frente)
    query += ' ORDER BY F.STATUS DESC, F.DATA_VENCIMENTO DESC';

    const result = await request.query(query);
    const rawFaturas = result.recordset;

    // Mapear campos para camelCase e formatar
    const faturasMapeadas = rawFaturas.map((r: any) => ({
      id: r.ID,
      empresaId: r.EMPRESA_ID,
      empresaNome: r.EmpresaNome,
      cnpj: r.EmpresaCNPJ,
      assinaturasEmpresasId: r.ASSINATURAS_EMPRESAS_ID || undefined,
      valorBruto: Number(r.VALOR_BRUTO),
      valorDesconto: Number(r.VALOR_DESCONTO),
      valorLiquido: Number(r.VALOR_BRUTO) - Number(r.VALOR_DESCONTO),
      status: r.STATUS,
      dataEmissao: r.DATA_EMISSAO,
      dataVencimento: r.DATA_VENCIMENTO,
      dataPagamento: r.DATA_PAGAMENTO || undefined,
      referenciaMesAno: r.REFERENCIA_MES_ANO,
      gatewayFaturaId: r.GATEWAY_FATURA_ID || undefined,
      boletoUrl: r.BOLETO_URL || undefined,
      pixCopiaCola: r.PIX_COPIA_COLA || undefined,
      criadoEm: r.CRIADO_EM
    }));

    // Paginação em JS para segurança de compatibilidade SQL Server
    const p = Number(page) || 1;
    const l = Number(limit) || 10;
    const startIdx = (p - 1) * l;
    const paginated = faturasMapeadas.slice(startIdx, startIdx + l);

    res.json({
      faturas: paginated,
      paginacao: {
        total: faturasMapeadas.length,
        paginas: Math.ceil(faturasMapeadas.length / l),
        paginaAtual: p
      }
    });

  } catch (err: any) {
    console.error('[Financeiro] Erro ao buscar faturas:', err);
    res.status(500).json({ error: err.message });
  }
});

// Criar cobrança manual (Fatura Avulsa)
router.post('/cobrar-manual', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { empresaId, valor, descricao, vencimento } = req.body;
    if (!empresaId || !valor || !vencimento) {
      res.status(400).json({ error: 'empresaId, valor e vencimento são obrigatórios.' });
      return;
    }

    const emp = empresas.find(e => e.id === empresaId);
    if (!emp) {
      res.status(404).json({ error: 'Empresa não encontrada.' });
      return;
    }

    const id = `fat-av-${crypto.randomUUID().substring(0, 8)}`;
    const dataEmissao = new Date().toISOString();
    const dataVenc = new Date(vencimento);
    const refMesAno = `${String(dataVenc.getMonth() + 1).padStart(2, '0')}/${dataVenc.getFullYear()}`;

    // Cobrança gerada pelo gateway abstrato (driver por env; MOCK por padrão).
    // O MockAdapter reproduz o mesmo formato de boleto/pix usado anteriormente.
    const gateway = getGateway();
    const cobranca = await gateway.criarCobranca({
      empresaId,
      faturaId: String(id),
      valor: Number(valor),
      vencimento: dataVenc.toISOString(),
      metodo: 'PIX',
      descricao: descricao || `Cobrança avulsa ${refMesAno}`,
    });
    const boletoUrl = cobranca.boletoUrl ?? null;
    const pixCopiaCola = cobranca.pixCopiaCola ?? null;

    await pool.request()
      .input('id', mssql.VarChar, id)
      .input('empId', mssql.VarChar, empresaId)
      .input('valor', mssql.Decimal(10, 2), Number(valor))
      .input('status', mssql.VarChar, 'PENDENTE')
      .input('emissao', mssql.VarChar, dataEmissao)
      .input('venc', mssql.VarChar, dataVenc.toISOString())
      .input('ref', mssql.VarChar, refMesAno)
      .input('boleto', mssql.NVarChar, boletoUrl)
      .input('pix', mssql.NVarChar, pixCopiaCola)
      .input('gwId', mssql.VarChar, cobranca.gatewayFaturaId)
      .input('criado', mssql.VarChar, dataEmissao)
      .query(`
        INSERT INTO FATURAS (ID, EMPRESA_ID, VALOR_BRUTO, VALOR_DESCONTO, STATUS, DATA_EMISSAO, DATA_VENCIMENTO, REFERENCIA_MES_ANO, BOLETO_URL, PIX_COPIA_COLA, GATEWAY_FATURA_ID, CRIADO_EM)
        VALUES (@id, @empId, @valor, 0.00, @status, @emissao, @venc, @ref, @boleto, @pix, @gwId, @criado)
      `);

    // Trilha de auditoria: emissão da fatura (contas a receber aberto).
    await appendLedger({
      empresaId,
      faturaId: String(id),
      tipo: 'ABERTURA',
      valor: Number(valor),
      origem: 'MANUAL_ADMIN',
      referenciaExterna: cobranca.gatewayFaturaId,
      metadados: { descricao: descricao || null, vencimento: dataVenc.toISOString() },
      criadoPor: 'ADMIN',
    });

    console.log(`[Financeiro] Fatura manual criada com sucesso para ${emp.nome}. Valor: R$ ${valor}`);

    // Reavaliar imediatamente o status financeiro da empresa
    await rotinaVerificacaoInadimplencia();

    res.status(201).json({
      success: true,
      fatura: {
        id,
        empresaId,
        valorBruto: Number(valor),
        valorDesconto: 0,
        valorLiquido: Number(valor),
        status: 'PENDENTE',
        dataEmissao,
        dataVencimento: dataVenc.toISOString(),
        referenciaMesAno: refMesAno,
        boletoUrl,
        pixCopiaCola
      }
    });

  } catch (err: any) {
    console.error('[Financeiro] Erro ao criar fatura manual:', err);
    res.status(500).json({ error: err.message });
  }
});

// Baixa manual (Conciliação)
router.put('/faturas/:id/baixa-manual', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { dataPagamento, comprovanteReferencia, observacoes } = req.body;

    const pgto = dataPagamento || new Date().toISOString();
    let assinaturaParaAtivar: string | null = null;

    // Operação atômica: SELECT com lock + baixa + histórico + ledger numa única
    // transação. O UPDLOCK/HOLDLOCK evita dupla-baixa em concorrência (dois
    // operadores ou webhook + conciliação manual no mesmo instante).
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      const fatRes = await tx.request()
        .input('id', mssql.VarChar, id)
        .query('SELECT * FROM FATURAS WITH (UPDLOCK, HOLDLOCK) WHERE ID = @id');

      if (fatRes.recordset.length === 0) {
        await tx.rollback();
        res.status(404).json({ error: 'Fatura não encontrada.' });
        return;
      }

      const fat = fatRes.recordset[0];
      if (fat.STATUS === 'PAGA') {
        await tx.rollback();
        res.status(400).json({ error: 'Esta fatura já está paga.' });
        return;
      }

      const valorLiquido = Number(fat.VALOR_BRUTO) - Number(fat.VALOR_DESCONTO);
      assinaturaParaAtivar = fat.ASSINATURAS_EMPRESAS_ID ?? null;

      // 1. Dar baixa na fatura (status = 'PAGA')
      await tx.request()
        .input('id', mssql.VarChar, id)
        .input('pgto', mssql.VarChar, pgto)
        .query("UPDATE FATURAS SET STATUS = 'PAGA', DATA_PAGAMENTO = @pgto WHERE ID = @id");

      // 2. Registrar no histórico de pagamentos (view operacional)
      const histId = `pay-${crypto.randomUUID().substring(0, 8)}`;
      const logs = JSON.stringify({ comprovanteReferencia, observacoes, tipoOperacao: 'ConciliacaoManualAdmin' });
      await tx.request()
        .input('id', mssql.VarChar, histId)
        .input('fatId', mssql.VarChar, id)
        .input('metodo', mssql.VarChar, 'CONCILIACAO_MANUAL')
        .input('valor', mssql.Decimal(10, 2), valorLiquido)
        .input('data', mssql.VarChar, pgto)
        .input('status', mssql.VarChar, 'SUCESSO')
        .input('log', mssql.NVarChar, logs)
        .query(`
          INSERT INTO HISTORICO_PAGAMENTOS (ID, FATURA_ID, METODO_PAGAMENTO, VALOR_PAGO, DATA_TRANSACAO, STATUS_TRANSACAO, LOG_TRANSACAO)
          VALUES (@id, @fatId, @metodo, @valor, @data, @status, @log)
        `);

      // 3. Ledger imutável (verdade contábil): crédito de pagamento
      await appendLedger({
        empresaId: fat.EMPRESA_ID,
        assinaturaId: fat.ASSINATURAS_EMPRESAS_ID ?? undefined,
        faturaId: String(id),
        tipo: 'CREDITO_PAGAMENTO',
        valor: valorLiquido,
        origem: 'MANUAL_ADMIN',
        referenciaExterna: comprovanteReferencia ?? undefined,
        metadados: { observacoes: observacoes ?? null, metodo: 'CONCILIACAO_MANUAL' },
        criadoPor: 'ADMIN',
      }, tx);

      await tx.commit();
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }

    console.log(`[Financeiro] Baixa manual registrada para a fatura ${id}.`);

    // 4. Pagamento reativa a assinatura via state machine (ATRASADA/SUSPENSA -> ATIVA),
    // que também deriva o STATUS_FINANCEIRO da empresa. Fora da transação da fatura.
    if (assinaturaParaAtivar) {
      try {
        await transicionar(assinaturaParaAtivar, 'payment.confirmed');
      } catch (e: any) {
        console.warn('[Financeiro] Falha ao reativar assinatura após baixa manual:', e?.message);
      }
    }

    // 5. Reavaliar o status financeiro da empresa (pode voltar para REGULAR se não houver outras vencidas)
    await rotinaVerificacaoInadimplencia();

    res.json({ success: true, message: 'Fatura quitada com sucesso.' });

  } catch (err: any) {
    console.error('[Financeiro] Erro ao dar baixa manual na fatura:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. RELATÓRIOS E AGREGAÇÕES ANALÍTICAS
// ==========================================

// Relatório: Faturamento Bruto vs Líquido Mensal
router.get('/relatorios/faturamento', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
          REFERENCIA_MES_ANO,
          SUM(VALOR_BRUTO) as FaturamentoBruto,
          SUM(VALOR_DESCONTO) as TotalDescontos,
          SUM(VALOR_BRUTO - VALOR_DESCONTO) as FaturamentoLiquido
      FROM FATURAS
      WHERE STATUS = 'PAGA'
      GROUP BY REFERENCIA_MES_ANO
    `;
    const result = await pool.request().query(query);
    
    // Formatar retorno
    const dados = result.recordset.map((r: any) => ({
      referencia: r.REFERENCIA_MES_ANO,
      bruto: Number(r.FaturamentoBruto || 0),
      desconto: Number(r.TotalDescontos || 0),
      liquido: Number(r.FaturamentoLiquido || 0)
    }));

    res.json(dados);
  } catch (err: any) {
    console.error('[Financeiro] Erro no relatório de faturamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// Relatório: Taxa de Inadimplência
router.get('/relatorios/inadimplencia', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
          REFERENCIA_MES_ANO,
          SUM(CASE WHEN STATUS = 'ATRASADA' THEN (VALOR_BRUTO - VALOR_DESCONTO) ELSE 0 END) as MRRPerdidoAtrasado,
          SUM(VALOR_BRUTO - VALOR_DESCONTO) as MRREmitidoTotal
      FROM FATURAS
      GROUP BY REFERENCIA_MES_ANO
    `;
    const result = await pool.request().query(query);

    const dados = result.recordset.map((r: any) => {
      const emitido = Number(r.MRREmitidoTotal || 0);
      const atrasado = Number(r.MRRPerdidoAtrasado || 0);
      const taxa = emitido > 0 ? Number(((atrasado / emitido) * 100).toFixed(2)) : 0;
      return {
        referencia: r.REFERENCIA_MES_ANO,
        emitido,
        atrasado,
        taxaInadimplencia: taxa
      };
    });

    res.json(dados);
  } catch (err: any) {
    console.error('[Financeiro] Erro no relatório de inadimplência:', err);
    res.status(500).json({ error: err.message });
  }
});

// Relatório: Previsibilidade de Receita (Contas a Receber baseado em Assinaturas)
router.get('/relatorios/previsibilidade', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
          AE.DIA_VENCIMENTO,
          COUNT(AE.ID) as TotalAssinaturas,
          SUM(COALESCE(AE.VALOR_PERSONALIZADO, P.VALOR_MENSAL)) as ProjecaoMRR
      FROM ASSINATURAS_EMPRESAS AE
      JOIN PLANOS P ON AE.PLANO_ID = P.ID
      WHERE AE.STATUS = 'ATIVA'
      GROUP BY AE.DIA_VENCIMENTO
    `;
    const result = await pool.request().query(query);

    const dados = result.recordset.map((r: any) => ({
      diaVencimento: r.DIA_VENCIMENTO,
      totalAssinaturas: r.TotalAssinaturas,
      mrrProjetado: Number(r.ProjecaoMRR || 0)
    }));

    res.json(dados);
  } catch (err: any) {
    console.error('[Financeiro] Erro no relatório de previsibilidade:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obter configurações de cobrança
router.get('/configuracoes', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.request().query('SELECT TOP 1 * FROM CONFIGURACOES_COBRANCA');
    if (result.recordset.length > 0) {
      const r = result.recordset[0];
      res.json({
        id: r.ID,
        diasCarenciaBloqueio: r.DIAS_CARENCIA_BLOQUEIO,
        multaPercentual: Number(r.MULTA_PERCENTUAL),
        jurosMesPercentual: Number(r.JUROS_MES_PERCENTUAL),
        emailNotificacaoDiasAntes: r.EMAIL_NOTIFICACAO_DIAS_ANTES,
        whatsappNotificacaoDiasAtraso: r.WHATSAPP_NOTIFICACAO_DIAS_ATRASO
      });
    } else {
      res.status(404).json({ error: 'Configurações de cobrança não encontradas.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar configurações de cobrança
router.put('/configuracoes', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { diasCarenciaBloqueio, multaPercentual, jurosMesPercentual, emailNotificacaoDiasAntes, whatsappNotificacaoDiasAtraso } = req.body;
    
    await pool.request()
      .input('id', mssql.VarChar, 'default')
      .input('carencia', mssql.Int, Number(diasCarenciaBloqueio))
      .input('multa', mssql.Decimal(5, 2), Number(multaPercentual))
      .input('juros', mssql.Decimal(5, 2), Number(jurosMesPercentual))
      .input('email', mssql.Int, Number(emailNotificacaoDiasAntes))
      .input('wa', mssql.Int, Number(whatsappNotificacaoDiasAtraso))
      .query(`
        UPDATE CONFIGURACOES_COBRANCA 
        SET DIAS_CARENCIA_BLOQUEIO = @carencia, 
            MULTA_PERCENTUAL = @multa, 
            JUROS_MES_PERCENTUAL = @juros, 
            EMAIL_NOTIFICACAO_DIAS_ANTES = @email, 
            WHATSAPP_NOTIFICACAO_DIAS_ATRASO = @wa
        WHERE ID = @id
      `);

    console.log('[Financeiro] Configurações de cobrança atualizadas com sucesso.');
    
    // Força uma reavaliação de inadimplência
    await rotinaVerificacaoInadimplencia();

    res.json({ success: true, message: 'Configurações atualizadas com sucesso.' });
  } catch (err: any) {
    console.error('[Financeiro] Erro ao atualizar configurações de cobrança:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. NOVOS ENDPOINTS — DASHBOARD, CHURN, ASSINATURAS, PLANOS
// ==========================================

// Dashboard KPIs Consolidados
router.get('/dashboard', verificarAdmin, async (req: Request, res: Response) => {
  try {
    // MRR Atual (soma dos planos de assinaturas ativas)
    const mrrRes = await pool.request().query(`
      SELECT SUM(COALESCE(AE.VALOR_PERSONALIZADO, P.VALOR_MENSAL)) as MRR
      FROM ASSINATURAS_EMPRESAS AE
      JOIN PLANOS P ON AE.PLANO_ID = P.ID
      WHERE AE.STATUS = 'ATIVA'
    `);
    const mrrAtual = Number(mrrRes.recordset[0]?.MRR || 0);

    // Faturas em aberto
    const abertoRes = await pool.request().query(`
      SELECT COUNT(*) as Qtd, SUM(VALOR_BRUTO - VALOR_DESCONTO) as Valor
      FROM FATURAS
      WHERE STATUS IN ('PENDENTE', 'ATRASADA')
    `);
    const totalFaturasEmAberto = abertoRes.recordset[0]?.Qtd || 0;
    const valorEmAberto = Number(abertoRes.recordset[0]?.Valor || 0);

    // Taxa de inadimplência por LOJA (cobrança por loja). Conta lojas INADIMPLENTE ou SUSPENSO.
    const totalLojas = lojas.length;
    const lojasInadimplentes = lojas.filter(l => l.statusFinanceiro === 'INADIMPLENTE' || l.statusFinanceiro === 'SUSPENSO').length;
    const lojasAtivas = lojas.filter(l => l.ativo).length;
    const taxaInadimplencia = totalLojas > 0 ? Number(((lojasInadimplentes / totalLojas) * 100).toFixed(2)) : 0;

    // Faturamento do mês atual
    const mesAtual = `${String(new Date().getMonth() + 1).padStart(2, '0')}/${new Date().getFullYear()}`;
    const fatMesRes = await pool.request()
      .input('ref', mssql.VarChar, mesAtual)
      .query(`
        SELECT 
          SUM(VALOR_BRUTO) as Bruto,
          SUM(VALOR_BRUTO - VALOR_DESCONTO) as Liquido
        FROM FATURAS
        WHERE STATUS = 'PAGA' AND REFERENCIA_MES_ANO = @ref
      `);
    const faturamentoBrutoMes = Number(fatMesRes.recordset[0]?.Bruto || 0);
    const faturamentoLiquidoMes = Number(fatMesRes.recordset[0]?.Liquido || 0);

    // MRR Projetado (próximo mês)
    const mrrProjetado = mrrAtual; // Baseado em assinaturas ativas

    res.json({
      mrrAtual,
      mrrProjetado,
      totalFaturasEmAberto,
      valorEmAberto,
      taxaInadimplencia,
      lojasAtivas,
      lojasInadimplentes,
      totalLojas,
      faturamentoBrutoMes,
      faturamentoLiquidoMes
    });
  } catch (err: any) {
    console.error('[Financeiro] Erro no dashboard:', err);
    res.status(500).json({ error: err.message });
  }
});

// Relatório: Churn Rate Financeiro
router.get('/relatorios/churn', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
          REFERENCIA_MES_ANO,
          SUM(CASE WHEN STATUS = 'CANCELADA' THEN (VALOR_BRUTO - VALOR_DESCONTO) ELSE 0 END) as ReceitaPerdida,
          SUM(VALOR_BRUTO - VALOR_DESCONTO) as ReceitaTotal,
          SUM(CASE WHEN STATUS = 'CANCELADA' THEN 1 ELSE 0 END) as FaturasCanceladas,
          COUNT(*) as FaturasTotal
      FROM FATURAS
      GROUP BY REFERENCIA_MES_ANO
    `;
    const result = await pool.request().query(query);

    const dados = result.recordset.map((r: any) => {
      const total = Number(r.ReceitaTotal || 0);
      const perdida = Number(r.ReceitaPerdida || 0);
      const churnRate = total > 0 ? Number(((perdida / total) * 100).toFixed(2)) : 0;
      return {
        referencia: r.REFERENCIA_MES_ANO,
        receitaTotal: total,
        receitaPerdida: perdida,
        faturasCanceladas: r.FaturasCanceladas,
        faturasTotal: r.FaturasTotal,
        churnRate
      };
    });

    res.json(dados);
  } catch (err: any) {
    console.error('[Financeiro] Erro no relatório de churn:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar Assinaturas
router.get('/assinaturas', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.request().query(`
      SELECT AE.*, P.NOME as PlanoNome, P.VALOR_MENSAL as PlanoValor, E.NOME as EmpresaNome, E.CNPJ as EmpresaCNPJ
      FROM ASSINATURAS_EMPRESAS AE
      JOIN PLANOS P ON AE.PLANO_ID = P.ID
      JOIN EMPRESAS E ON AE.EMPRESA_ID = E.ID
      ORDER BY AE.STATUS, E.NOME
    `);

    const assinaturas = result.recordset.map((r: any) => ({
      id: r.ID,
      empresaId: r.EMPRESA_ID,
      empresaNome: r.EmpresaNome,
      cnpj: r.EmpresaCNPJ,
      planoId: r.PLANO_ID,
      planoNome: r.PlanoNome,
      planoValor: Number(r.PlanoValor),
      valorPersonalizado: r.VALOR_PERSONALIZADO ? Number(r.VALOR_PERSONALIZADO) : null,
      valorEfetivo: r.VALOR_PERSONALIZADO ? Number(r.VALOR_PERSONALIZADO) : Number(r.PlanoValor),
      status: r.STATUS,
      diaVencimento: r.DIA_VENCIMENTO,
      proximoFaturamento: r.PROXIMO_FATURAMENTO || undefined,
      criadoEm: r.CRIADO_EM,
      canceladoEm: r.CANCELADO_EM || undefined
    }));

    res.json(assinaturas);
  } catch (err: any) {
    console.error('[Financeiro] Erro ao listar assinaturas:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar Planos
router.get('/planos', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.request().query('SELECT * FROM PLANOS ORDER BY VALOR_MENSAL');
    const planos = result.recordset.map((r: any) => ({
      id: r.ID,
      nome: r.NOME,
      descricao: r.DESCRICAO || '',
      valorMensal: Number(r.VALOR_MENSAL),
      limiteEntregasMes: r.LIMITE_ENTREGAS_MES,
      limiteLojas: r.LIMITE_LOJAS,
      limiteMotoristas: r.LIMITE_MOTORISTAS,
      ativo: r.ATIVO === 1 || r.ATIVO === true,
      criadoEm: r.CRIADO_EM
    }));
    res.json(planos);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Criar Plano
router.post('/planos', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { nome, descricao, valorMensal, limiteEntregasMes, limiteLojas, limiteMotoristas } = req.body;
    if (!nome || valorMensal === undefined) {
      res.status(400).json({ error: 'Nome e valorMensal são obrigatórios.' });
      return;
    }

    const id = `plan-${crypto.randomUUID().substring(0, 8)}`;
    await pool.request()
      .input('id', mssql.VarChar, id)
      .input('nome', mssql.NVarChar, nome)
      .input('desc', mssql.NVarChar, descricao || '')
      .input('valor', mssql.Decimal(10, 2), Number(valorMensal))
      .input('limE', mssql.Int, limiteEntregasMes || null)
      .input('limL', mssql.Int, limiteLojas || null)
      .input('limM', mssql.Int, limiteMotoristas || null)
      .input('criado', mssql.VarChar, new Date().toISOString())
      .query('INSERT INTO PLANOS (ID, NOME, DESCRICAO, VALOR_MENSAL, LIMITE_ENTREGAS_MES, LIMITE_LOJAS, LIMITE_MOTORISTAS, ATIVO, CRIADO_EM) VALUES (@id, @nome, @desc, @valor, @limE, @limL, @limM, 1, @criado)');

    res.status(201).json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Editar Plano
router.put('/planos/:id', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nome, descricao, valorMensal, limiteEntregasMes, limiteLojas, limiteMotoristas, ativo } = req.body;

    await pool.request()
      .input('id', mssql.VarChar, id)
      .input('nome', mssql.NVarChar, nome)
      .input('desc', mssql.NVarChar, descricao || '')
      .input('valor', mssql.Decimal(10, 2), Number(valorMensal))
      .input('limE', mssql.Int, limiteEntregasMes || null)
      .input('limL', mssql.Int, limiteLojas || null)
      .input('limM', mssql.Int, limiteMotoristas || null)
      .input('ativo', mssql.Bit, ativo !== false ? 1 : 0)
      .query('UPDATE PLANOS SET NOME = @nome, DESCRICAO = @desc, VALOR_MENSAL = @valor, LIMITE_ENTREGAS_MES = @limE, LIMITE_LOJAS = @limL, LIMITE_MOTORISTAS = @limM, ATIVO = @ativo WHERE ID = @id');

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Contestar Fatura
router.put('/faturas/:id/contestar', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;

    const fatRes = await pool.request()
      .input('id', mssql.VarChar, id)
      .query('SELECT * FROM FATURAS WHERE ID = @id');

    if (fatRes.recordset.length === 0) {
      res.status(404).json({ error: 'Fatura não encontrada.' });
      return;
    }
    if (fatRes.recordset[0].STATUS === 'PAGA') {
      res.status(400).json({ error: 'Não é possível contestar uma fatura já paga.' });
      return;
    }

    await pool.request()
      .input('id', mssql.VarChar, id)
      .query("UPDATE FATURAS SET STATUS = 'CONTESTADA' WHERE ID = @id");

    // Registrar no histórico
    const histId = `cont-${crypto.randomUUID().substring(0, 8)}`;
    await pool.request()
      .input('id', mssql.VarChar, histId)
      .input('fatId', mssql.VarChar, id)
      .input('valor', mssql.Decimal(10, 2), 0)
      .input('data', mssql.VarChar, new Date().toISOString())
      .input('log', mssql.NVarChar, JSON.stringify({ motivo, tipoOperacao: 'CONTESTACAO' }))
      .query("INSERT INTO HISTORICO_PAGAMENTOS (ID, FATURA_ID, METODO_PAGAMENTO, VALOR_PAGO, DATA_TRANSACAO, STATUS_TRANSACAO, LOG_TRANSACAO) VALUES (@id, @fatId, 'CONTESTACAO', @valor, @data, 'PENDENTE', @log)");

    // Trilha de auditoria: contestação (sem movimento de saldo).
    await appendLedger({
      empresaId: fatRes.recordset[0].EMPRESA_ID,
      faturaId: String(id),
      tipo: 'AJUSTE',
      valor: 0,
      origem: 'MANUAL_ADMIN',
      metadados: { evento: 'CONTESTACAO', motivo: motivo ?? null },
      criadoPor: 'ADMIN',
    });

    console.log(`[Financeiro] Fatura ${id} contestada.`);
    res.json({ success: true, message: 'Fatura marcada como contestada.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Cancelar Fatura
router.put('/faturas/:id/cancelar', verificarAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const fatRes = await pool.request()
      .input('id', mssql.VarChar, id)
      .query('SELECT * FROM FATURAS WHERE ID = @id');

    if (fatRes.recordset.length === 0) {
      res.status(404).json({ error: 'Fatura não encontrada.' });
      return;
    }
    if (fatRes.recordset[0].STATUS === 'PAGA') {
      res.status(400).json({ error: 'Não é possível cancelar uma fatura já paga.' });
      return;
    }

    await pool.request()
      .input('id', mssql.VarChar, id)
      .query("UPDATE FATURAS SET STATUS = 'CANCELADA' WHERE ID = @id");

    // Trilha de auditoria: cancelamento (baixa do contas a receber sem pagamento).
    await appendLedger({
      empresaId: fatRes.recordset[0].EMPRESA_ID,
      faturaId: String(id),
      tipo: 'CANCELAMENTO',
      valor: 0,
      origem: 'MANUAL_ADMIN',
      metadados: { valorOriginal: Number(fatRes.recordset[0].VALOR_BRUTO) - Number(fatRes.recordset[0].VALOR_DESCONTO) },
      criadoPor: 'ADMIN',
    });

    // Reavaliar inadimplência
    await rotinaVerificacaoInadimplencia();

    console.log(`[Financeiro] Fatura ${id} cancelada.`);
    res.json({ success: true, message: 'Fatura cancelada com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

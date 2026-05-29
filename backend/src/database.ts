import mssql from 'mssql/msnodesqlv8';
import crypto from 'crypto';
import { Entrega, Motorista, Empresa, Loja, TipoVeiculo, Produto } from './types';


const config: mssql.config = {
  server: 'localhost\\SQLEXPRESS',
  database: 'GESTAO_DADOS',
  driver: 'msnodesqlv8',
  options: {
    trustedConnection: true,
    trustServerCertificate: true
  }
};

export let pool: mssql.ConnectionPool;

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export async function conectarBanco() {
  try {
    pool = await new mssql.ConnectionPool(config).connect();
    console.log('[Banco de Dados] Conectado ao SQL Server (GESTAO_DADOS) com sucesso!');
    await inicializarBanco();
  } catch (err) {
    console.error('[Banco de Dados] Erro ao conectar ao SQL Server:', err);
  }
}

async function inicializarBanco() {
  const query = `
    IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'nomeCliente')
    BEGIN
      DROP TABLE ENTREGAS;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'DATA_HORA_CONCLUSAO')
    BEGIN
      DROP TABLE ENTREGAS;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'VALOR')
    BEGIN
      DROP TABLE ENTREGAS;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'LOJA_ID')
    BEGIN
      DROP TABLE ENTREGAS;
    END

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ENTREGAS' AND xtype='U')
    CREATE TABLE ENTREGAS (
      ID VARCHAR(50) PRIMARY KEY,
      NOME_CLIENTE NVARCHAR(255) NOT NULL,
      ENDERECO NVARCHAR(MAX) NOT NULL,
      ITENS NVARCHAR(MAX) NOT NULL,
      PRIORIDADE VARCHAR(50) NOT NULL,
      TIPO_CARGA VARCHAR(50) NOT NULL,
      STATUS VARCHAR(50) NOT NULL,
      MOTORISTA NVARCHAR(MAX) NULL,
      ROTA NVARCHAR(MAX) NULL,
      TELEMETRIA NVARCHAR(MAX) NULL,
      INCIDENTES NVARCHAR(MAX) NULL,
      URL_WEBHOOK NVARCHAR(MAX) NULL,
      LOGS_WEBHOOK NVARCHAR(MAX) NULL,
      CRIADO_EM VARCHAR(100) NOT NULL,
      ATUALIZADO_EM VARCHAR(100) NOT NULL,
      RECEBEDOR_NOME NVARCHAR(255) NULL,
      RECEBEDOR_CPF NVARCHAR(50) NULL,
      COMPROVANTE_FOTO_URL NVARCHAR(500) NULL,
      ASSINATURA_BASE64 NVARCHAR(MAX) NULL,
      JUSTIFICATIVA_DESVIO_COORDENADA NVARCHAR(MAX) NULL,
      DATA_HORA_CONCLUSAO VARCHAR(100) NULL,
      SEQUENCIA_ESPERADA INT NULL,
      SEQUENCIA_REALIZADA INT NULL,
      VALOR DECIMAL(10, 2) NULL,
      LOJA_ID VARCHAR(100) NULL,
      NOME_LOJA NVARCHAR(255) NULL,
      NOME_EMPRESA NVARCHAR(255) NULL,
      CLIENTE_DOCUMENTO NVARCHAR(50) NULL,
      ROMANEIO_ID VARCHAR(100) NULL,
      BAIRRO NVARCHAR(255) NULL,
      CIDADE NVARCHAR(255) NULL,
      FORMA_PAGAMENTO VARCHAR(100) NULL,
      DESPACHADO_EM VARCHAR(100) NULL,
      TIPO_COMANDA VARCHAR(50) NOT NULL DEFAULT 'entrega',
      REFERENCIA NVARCHAR(MAX) NULL
    );

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'CLIENTE_DOCUMENTO')
    BEGIN
      ALTER TABLE ENTREGAS ADD CLIENTE_DOCUMENTO NVARCHAR(50) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'ROMANEIO_ID')
    BEGIN
      ALTER TABLE ENTREGAS ADD ROMANEIO_ID VARCHAR(100) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'BAIRRO')
    BEGIN
      ALTER TABLE ENTREGAS ADD BAIRRO NVARCHAR(255) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'CIDADE')
    BEGIN
      ALTER TABLE ENTREGAS ADD CIDADE NVARCHAR(255) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'FORMA_PAGAMENTO')
    BEGIN
      ALTER TABLE ENTREGAS ADD FORMA_PAGAMENTO VARCHAR(100) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'DESPACHADO_EM')
    BEGIN
      ALTER TABLE ENTREGAS ADD DESPACHADO_EM VARCHAR(100) NULL;
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'TIPO_COMANDA')
    BEGIN
      ALTER TABLE ENTREGAS ADD TIPO_COMANDA VARCHAR(50) NOT NULL DEFAULT 'entrega';
    END

    IF OBJECT_ID('ENTREGAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ENTREGAS') AND name = 'REFERENCIA')
    BEGIN
      ALTER TABLE ENTREGAS ADD REFERENCIA NVARCHAR(MAX) NULL;
    END


    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='LOGS_EVENTOS' AND xtype='U')
    CREATE TABLE LOGS_EVENTOS (
      ID VARCHAR(50) PRIMARY KEY,
      TOPICO VARCHAR(150) NOT NULL,
      ENTREGA_ID VARCHAR(50) NOT NULL,
      CONTEUDO NVARCHAR(MAX) NOT NULL,
      TIMESTAMP_REGISTRO VARCHAR(100) NOT NULL
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ADMINISTRADORES' AND xtype='U')
    CREATE TABLE ADMINISTRADORES (
      USUARIO VARCHAR(100) PRIMARY KEY,
      SENHA_HASH VARCHAR(256) NOT NULL
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='MOTORISTAS' AND xtype='U')
    CREATE TABLE MOTORISTAS (
      ID VARCHAR(50) PRIMARY KEY,
      NOME NVARCHAR(255) NOT NULL,
      TIPO_VEICULO VARCHAR(50) NOT NULL,
      STATUS VARCHAR(50) NOT NULL,
      LOJA_ID VARCHAR(100) NULL,
      CODIGO_VINCULO VARCHAR(50) NOT NULL UNIQUE,
      DISPOSITIVO_CONECTADO BIT NOT NULL DEFAULT 0,
      X INT NULL,
      Y INT NULL,
      ULTIMA_ATUALIZACAO VARCHAR(100) NULL
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EMPRESAS' AND xtype='U')
    CREATE TABLE EMPRESAS (
      ID VARCHAR(50) PRIMARY KEY,
      NOME NVARCHAR(255) NOT NULL,
      CNPJ VARCHAR(20) NOT NULL UNIQUE,
      TELEFONE VARCHAR(50) NULL,
      EMAIL VARCHAR(100) NULL,
      ATIVO BIT NOT NULL DEFAULT 1,
      CRIADO_EM VARCHAR(100) NOT NULL
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='LOJAS' AND xtype='U')
    CREATE TABLE LOJAS (
      ID VARCHAR(50) PRIMARY KEY,
      EMPRESA_ID VARCHAR(50) NOT NULL FOREIGN KEY REFERENCES EMPRESAS(ID),
      NOME NVARCHAR(255) NOT NULL,
      CNPJ VARCHAR(20) NULL,
      ENDERECO NVARCHAR(500) NULL,
      BAIRRO NVARCHAR(100) NULL,
      CIDADE NVARCHAR(100) NULL,
      USUARIO VARCHAR(100) NOT NULL UNIQUE,
      SENHA_HASH VARCHAR(256) NOT NULL,
      CHAVE_ACESSO VARCHAR(100) NOT NULL UNIQUE,
      ATIVO BIT NOT NULL DEFAULT 1,
      CRIADO_EM VARCHAR(100) NOT NULL,
      RECEBE_PEDIDOS BIT NOT NULL DEFAULT 0
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='TIPOS_VEICULOS' AND xtype='U')
    CREATE TABLE TIPOS_VEICULOS (
      ID VARCHAR(50) PRIMARY KEY,
      NOME NVARCHAR(255) NOT NULL
    );

    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PRODUTOS' AND xtype='U')
    CREATE TABLE PRODUTOS (
      ID VARCHAR(50) PRIMARY KEY,
      NOME NVARCHAR(255) NOT NULL,
      PRECO DECIMAL(10, 2) NOT NULL,
      LOJA_ID VARCHAR(100) NULL,
      ATIVO BIT NOT NULL DEFAULT 1,
      IMAGEM_URL NVARCHAR(500) NULL
    );

    -- Garante que se a tabela LOJAS já existe, ela tenha a coluna CNPJ
    IF OBJECT_ID('LOJAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LOJAS') AND name = 'CNPJ')
    BEGIN
      ALTER TABLE LOJAS ADD CNPJ VARCHAR(20) NULL;
    END

    -- Garante que se a tabela LOJAS já existe, ela tenha a coluna RECEBE_PEDIDOS
    IF OBJECT_ID('LOJAS') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LOJAS') AND name = 'RECEBE_PEDIDOS')
    BEGIN
      ALTER TABLE LOJAS ADD RECEBE_PEDIDOS BIT NOT NULL DEFAULT 0;
    END

    -- Cria índice único condicional para CNPJ da loja (permitindo que registros antigos fiquem NULL)
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UIX_LOJAS_CNPJ' AND object_id = OBJECT_ID('LOJAS'))
    BEGIN
      CREATE UNIQUE INDEX UIX_LOJAS_CNPJ ON LOJAS(CNPJ) WHERE CNPJ IS NOT NULL;
    END
  `;
  try {
    await pool.request().query(query);
    console.log('[Banco de Dados] Tabelas "ENTREGAS", "LOGS_EVENTOS", "ADMINISTRADORES", "MOTORISTAS", "EMPRESAS", "LOJAS", "TIPOS_VEICULOS" e "PRODUTOS" verificadas/criadas com sucesso.');
    
    // Seed dos tipos de veículos padrão
    const vtCount = await pool.request().query('SELECT COUNT(*) as qtd FROM TIPOS_VEICULOS');
    if (vtCount.recordset[0].qtd === 0) {
      const defaultTypes = [
        { id: 'drone', name: 'Drone' },
        { id: 'motorcycle', name: 'Motocicleta' },
        { id: 'van', name: 'Van' },
        { id: 'refrigerated_truck', name: 'Caminhão Refrigerado' }
      ];
      for (const vt of defaultTypes) {
        await pool.request()
          .input('id', mssql.VarChar, vt.id)
          .input('nome', mssql.NVarChar, vt.name)
          .query('INSERT INTO TIPOS_VEICULOS (ID, NOME) VALUES (@id, @nome)');
      }
      console.log('[Banco de Dados] Tipos de veículos padrão cadastrados com sucesso.');
    }

    // Seed dos produtos padrão
    const prodCount = await pool.request().query('SELECT COUNT(*) as qtd FROM PRODUTOS');
    if (prodCount.recordset[0].qtd === 0) {
      const defaultProducts = [
        { id: 'prod-1', nome: 'Pizza Margherita', preco: 42.90, imagemUrl: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=500' },
        { id: 'prod-2', nome: 'Pizza Calabresa', preco: 45.90, imagemUrl: 'https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=500' },
        { id: 'prod-3', nome: 'Pizza Quatro Queijos', preco: 49.90, imagemUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500' },
        { id: 'prod-4', nome: 'Coca-Cola 2L', preco: 11.00, imagemUrl: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500' },
        { id: 'prod-5', nome: 'Guaraná Antarctica 2L', preco: 9.90, imagemUrl: 'https://images.unsplash.com/photo-1527960656366-ee418099e338?w=500' },
        { id: 'prod-6', nome: 'Água Mineral Sem Gás', preco: 4.50, imagemUrl: 'https://images.unsplash.com/photo-1608885828989-43a110d13b4c?w=500' },
        { id: 'prod-7', nome: 'Batata Frita Tradicional', preco: 25.00, imagemUrl: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=500' }
      ];
      for (const prod of defaultProducts) {
        await pool.request()
          .input('id', mssql.VarChar, prod.id)
          .input('nome', mssql.NVarChar, prod.nome)
          .input('preco', mssql.Decimal(10, 2), prod.preco)
          .input('imagemUrl', mssql.NVarChar, prod.imagemUrl)
          .query('INSERT INTO PRODUTOS (ID, NOME, PRECO, ATIVO, IMAGEM_URL) VALUES (@id, @nome, @preco, 1, @imagemUrl)');
      }
      console.log('[Banco de Dados] Produtos padrão cadastrados com sucesso.');
    }
    
    // Seed do administrador master
    const countRes = await pool.request().query('SELECT COUNT(*) as qtd FROM ADMINISTRADORES WHERE USUARIO = \'admin\'');
    if (countRes.recordset[0].qtd === 0) {
      const hash = hashPassword('@Shaythresh666');
      await pool.request()
        .input('usuario', mssql.VarChar, 'admin')
        .input('senhaHash', mssql.VarChar, hash)
        .query('INSERT INTO ADMINISTRADORES (USUARIO, SENHA_HASH) VALUES (@usuario, @senhaHash)');
      console.log('[Banco de Dados] Administrador padrão "admin" cadastrado no banco de dados com a senha criptografada.');
    }
  } catch (err) {
    console.error('[Banco de Dados] Erro ao inicializar tabelas:', err);
  }
}

export async function salvarEvento(evt: Entrega | any) {
  try {
    if (!pool) return;
    const query = `
      INSERT INTO LOGS_EVENTOS (ID, TOPICO, ENTREGA_ID, CONTEUDO, TIMESTAMP_REGISTRO)
      VALUES (@id, @topico, @entrega_id, @conteudo, @timestamp_registro);
    `;
    await pool.request()
      .input('id', mssql.VarChar, evt.id)
      .input('topico', mssql.VarChar, evt.topic)
      .input('entrega_id', mssql.VarChar, evt.deliveryId)
      .input('conteudo', mssql.NVarChar, JSON.stringify(evt.payload))
      .input('timestamp_registro', mssql.VarChar, evt.timestamp)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar log de evento ${evt.id}:`, err);
  }
}

export async function obterEntregas(): Promise<Entrega[]> {
  try {
    if (!pool) return [];
    const result = await pool.request().query('SELECT * FROM ENTREGAS');
    return result.recordset.map((row: any) => ({
      id: row.ID,
      nomeCliente: row.NOME_CLIENTE,
      endereco: row.ENDERECO,
      itens: JSON.parse(row.ITENS),
      prioridade: row.PRIORIDADE,
      tipoCarga: row.TIPO_CARGA,
      status: row.STATUS,
      motorista: row.MOTORISTA ? JSON.parse(row.MOTORISTA) : undefined,
      rota: row.ROTA ? JSON.parse(row.ROTA) : undefined,
      telemetria: row.TELEMETRIA ? JSON.parse(row.TELEMETRIA) : undefined,
      incidentes: row.INCIDENTES ? JSON.parse(row.INCIDENTES) : [],
      urlWebhook: row.URL_WEBHOOK || undefined,
      logsWebhook: row.LOGS_WEBHOOK ? JSON.parse(row.LOGS_WEBHOOK) : [],
      criadoEm: row.CRIADO_EM,
      atualizadoEm: row.ATUALIZADO_EM,
      recebedorNome: row.RECEBEDOR_NOME || undefined,
      recebedorCPF: row.RECEBEDOR_CPF || undefined,
      comprovanteFotoUrl: row.COMPROVANTE_FOTO_URL || undefined,
      assinaturaBase64: row.ASSINATURA_BASE64 || undefined,
      justificativaDesvioCoordenada: row.JUSTIFICATIVA_DESVIO_COORDENADA || undefined,
      dataHoraConclusao: row.DATA_HORA_CONCLUSAO || undefined,
      sequenciaEsperada: row.SEQUENCIA_ESPERADA !== null ? row.SEQUENCIA_ESPERADA : undefined,
      sequenciaRealizada: row.SEQUENCIA_REALIZADA !== null ? row.SEQUENCIA_REALIZADA : undefined,
      valor: row.VALOR !== null && row.VALOR !== undefined ? Number(row.VALOR) : undefined,
      lojaId: row.LOJA_ID || undefined,
      nomeLoja: row.NOME_LOJA || undefined,
      nomeEmpresa: row.NOME_EMPRESA || undefined,
      clienteDocumento: row.CLIENTE_DOCUMENTO || undefined,
      romaneioId: row.ROMANEIO_ID || undefined,
      bairro: row.BAIRRO || undefined,
      cidade: row.CIDADE || undefined,
      formaPagamento: row.FORMA_PAGAMENTO || undefined,
      despachadoEm: row.DESPACHADO_EM || undefined,
      tipoComanda: (row.TIPO_COMANDA || 'entrega') as 'pedido' | 'entrega',
      referencia: row.REFERENCIA || undefined
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter entregas:', err);
    return [];
  }
}

export async function salvarEntrega(e: Entrega) {
  try {
    if (!pool) return;
    const query = `
      MERGE INTO ENTREGAS AS target
      USING (SELECT @id AS ID) AS source
      ON target.ID = source.ID
      WHEN MATCHED THEN
        UPDATE SET 
          NOME_CLIENTE = @nomeCliente,
          ENDERECO = @endereco,
          ITENS = @itens,
          PRIORIDADE = @prioridade,
          TIPO_CARGA = @tipoCarga,
          STATUS = @status,
          MOTORISTA = @motorista,
          ROTA = @rota,
          TELEMETRIA = @telemetria,
          INCIDENTES = @incidentes,
          URL_WEBHOOK = @urlWebhook,
          LOGS_WEBHOOK = @logsWebhook,
          ATUALIZADO_EM = @atualizadoEm,
          RECEBEDOR_NOME = @recebedorNome,
          RECEBEDOR_CPF = @recebedorCPF,
          COMPROVANTE_FOTO_URL = @comprovanteFotoUrl,
          ASSINATURA_BASE64 = @assinaturaBase64,
          JUSTIFICATIVA_DESVIO_COORDENADA = @justificativaDesvioCoordenada,
          DATA_HORA_CONCLUSAO = @dataHoraConclusao,
          SEQUENCIA_ESPERADA = @sequenciaEsperada,
          SEQUENCIA_REALIZADA = @sequenciaRealizada,
          VALOR = @valor,
          LOJA_ID = @lojaId,
          NOME_LOJA = @nomeLoja,
          NOME_EMPRESA = @nomeEmpresa,
          CLIENTE_DOCUMENTO = @clienteDocumento,
          ROMANEIO_ID = @romaneioId,
          BAIRRO = @bairro,
          CIDADE = @cidade,
          FORMA_PAGAMENTO = @formaPagamento,
          DESPACHADO_EM = @despachadoEm,
          TIPO_COMANDA = @tipoComanda,
          REFERENCIA = @referencia
      WHEN NOT MATCHED THEN
        INSERT (ID, NOME_CLIENTE, ENDERECO, ITENS, PRIORIDADE, TIPO_CARGA, STATUS, MOTORISTA, ROTA, TELEMETRIA, INCIDENTES, URL_WEBHOOK, LOGS_WEBHOOK, CRIADO_EM, ATUALIZADO_EM, RECEBEDOR_NOME, RECEBEDOR_CPF, COMPROVANTE_FOTO_URL, ASSINATURA_BASE64, JUSTIFICATIVA_DESVIO_COORDENADA, DATA_HORA_CONCLUSAO, SEQUENCIA_ESPERADA, SEQUENCIA_REALIZADA, VALOR, LOJA_ID, NOME_LOJA, NOME_EMPRESA, CLIENTE_DOCUMENTO, ROMANEIO_ID, BAIRRO, CIDADE, FORMA_PAGAMENTO, DESPACHADO_EM, TIPO_COMANDA, REFERENCIA)
        VALUES (@id, @nomeCliente, @endereco, @itens, @prioridade, @tipoCarga, @status, @motorista, @rota, @telemetria, @incidentes, @urlWebhook, @logsWebhook, @criadoEm, @atualizadoEm, @recebedorNome, @recebedorCPF, @comprovanteFotoUrl, @assinaturaBase64, @justificativaDesvioCoordenada, @dataHoraConclusao, @sequenciaEsperada, @sequenciaRealizada, @valor, @lojaId, @nomeLoja, @nomeEmpresa, @clienteDocumento, @romaneioId, @bairro, @cidade, @formaPagamento, @despachadoEm, @tipoComanda, @referencia);
    `;
    
    await pool.request()
      .input('id', mssql.VarChar, e.id)
      .input('nomeCliente', mssql.NVarChar, e.nomeCliente)
      .input('endereco', mssql.NVarChar, e.endereco)
      .input('itens', mssql.NVarChar, JSON.stringify(e.itens))
      .input('prioridade', mssql.VarChar, e.prioridade)
      .input('tipoCarga', mssql.VarChar, e.tipoCarga)
      .input('status', mssql.VarChar, e.status)
      .input('motorista', mssql.NVarChar, e.motorista ? JSON.stringify(e.motorista) : null)
      .input('rota', mssql.NVarChar, e.rota ? JSON.stringify(e.rota) : null)
      .input('telemetria', mssql.NVarChar, e.telemetria ? JSON.stringify(e.telemetria) : null)
      .input('incidentes', mssql.NVarChar, JSON.stringify(e.incidentes))
      .input('urlWebhook', mssql.NVarChar, e.urlWebhook || null)
      .input('logsWebhook', mssql.NVarChar, JSON.stringify(e.logsWebhook))
      .input('criadoEm', mssql.VarChar, e.criadoEm)
      .input('atualizadoEm', mssql.VarChar, e.atualizadoEm)
      .input('recebedorNome', mssql.NVarChar, e.recebedorNome || null)
      .input('recebedorCPF', mssql.NVarChar, e.recebedorCPF || null)
      .input('comprovanteFotoUrl', mssql.NVarChar, e.comprovanteFotoUrl || null)
      .input('assinaturaBase64', mssql.NVarChar, e.assinaturaBase64 || null)
      .input('justificativaDesvioCoordenada', mssql.NVarChar, e.justificativaDesvioCoordenada || null)
      .input('dataHoraConclusao', mssql.VarChar, e.dataHoraConclusao || null)
      .input('sequenciaEsperada', mssql.Int, e.sequenciaEsperada !== undefined ? e.sequenciaEsperada : null)
      .input('sequenciaRealizada', mssql.Int, e.sequenciaRealizada !== undefined ? e.sequenciaRealizada : null)
      .input('valor', mssql.Decimal(10, 2), e.valor !== undefined && e.valor !== null ? e.valor : null)
      .input('lojaId', mssql.VarChar, e.lojaId || null)
      .input('nomeLoja', mssql.NVarChar, e.nomeLoja || null)
      .input('nomeEmpresa', mssql.NVarChar, e.nomeEmpresa || null)
      .input('clienteDocumento', mssql.NVarChar, e.clienteDocumento || null)
      .input('romaneioId', mssql.VarChar, e.romaneioId || null)
      .input('bairro', mssql.NVarChar, e.bairro || null)
      .input('cidade', mssql.NVarChar, e.cidade || null)
      .input('formaPagamento', mssql.VarChar, e.formaPagamento || null)
      .input('despachadoEm', mssql.VarChar, e.despachadoEm || null)
      .input('tipoComanda', mssql.VarChar, e.tipoComanda || 'entrega')
      .input('referencia', mssql.NVarChar, e.referencia || null)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar entrega ${e.id}:`, err);
  }
}

export async function verificarAdminNoBanco(usuario: string, senhaHash: string): Promise<boolean> {
  try {
    if (!pool) return false;
    const result = await pool.request()
      .input('usuario', mssql.VarChar, usuario)
      .input('senhaHash', mssql.VarChar, senhaHash)
      .query('SELECT 1 FROM ADMINISTRADORES WHERE USUARIO = @usuario AND SENHA_HASH = @senhaHash');
    return result.recordset.length > 0;
  } catch (err) {
    console.error('[Banco de Dados] Erro ao verificar administrador no banco:', err);
    return false;
  }
}

export async function obterMotoristas(): Promise<Motorista[]> {
  try {
    if (!pool) return [];
    const result = await pool.request().query('SELECT * FROM MOTORISTAS');
    return result.recordset.map((row: any) => ({
      id: row.ID,
      name: row.NOME,
      vehicleType: row.TIPO_VEICULO,
      status: row.STATUS as 'ocioso' | 'ocupado',
      lojaId: row.LOJA_ID || undefined,
      codigoVinculo: row.CODIGO_VINCULO,
      dispositivoConectado: row.DISPOSITIVO_CONECTADO === 1 || row.DISPOSITIVO_CONECTADO === true,
      localizacaoAtual: row.X !== null && row.Y !== null ? { x: row.X, y: row.Y } : undefined,
      ultimaAtualizacao: row.ULTIMA_ATUALIZACAO || undefined
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter motoristas:', err);
    return [];
  }
}

export async function salvarMotorista(m: Motorista) {
  try {
    if (!pool) return;
    const query = `
      MERGE INTO MOTORISTAS AS target
      USING (SELECT @id AS ID) AS source
      ON target.ID = source.ID
      WHEN MATCHED THEN
        UPDATE SET 
          NOME = @nome,
          TIPO_VEICULO = @tipoVeiculo,
          STATUS = @status,
          LOJA_ID = @lojaId,
          CODIGO_VINCULO = @codigoVinculo,
          DISPOSITIVO_CONECTADO = @dispositivoConectado,
          X = @x,
          Y = @y,
          ULTIMA_ATUALIZACAO = @ultimaAtualizacao
      WHEN NOT MATCHED THEN
        INSERT (ID, NOME, TIPO_VEICULO, STATUS, LOJA_ID, CODIGO_VINCULO, DISPOSITIVO_CONECTADO, X, Y, ULTIMA_ATUALIZACAO)
        VALUES (@id, @nome, @tipoVeiculo, @status, @lojaId, @codigoVinculo, @dispositivoConectado, @x, @y, @ultimaAtualizacao);
    `;
    
    await pool.request()
      .input('id', mssql.VarChar, m.id)
      .input('nome', mssql.NVarChar, m.name)
      .input('tipoVeiculo', mssql.VarChar, m.vehicleType)
      .input('status', mssql.VarChar, m.status)
      .input('lojaId', mssql.VarChar, m.lojaId || null)
      .input('codigoVinculo', mssql.VarChar, m.codigoVinculo)
      .input('dispositivoConectado', mssql.Bit, m.dispositivoConectado ? 1 : 0)
      .input('x', mssql.Int, m.localizacaoAtual?.x !== undefined ? m.localizacaoAtual.x : null)
      .input('y', mssql.Int, m.localizacaoAtual?.y !== undefined ? m.localizacaoAtual.y : null)
      .input('ultimaAtualizacao', mssql.VarChar, m.ultimaAtualizacao || null)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar motorista ${m.id}:`, err);
  }
}

export async function deletarMotorista(id: string) {
  try {
    if (!pool) return;
    await pool.request()
      .input('id', mssql.VarChar, id)
      .query('DELETE FROM MOTORISTAS WHERE ID = @id');
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao deletar motorista ${id}:`, err);
  }
}

export async function obterEmpresas(): Promise<Empresa[]> {
  try {
    if (!pool) return [];
    const result = await pool.request().query('SELECT * FROM EMPRESAS');
    return result.recordset.map((row: any) => ({
      id: row.ID,
      nome: row.NOME,
      cnpj: row.CNPJ,
      telefone: row.TELEFONE || undefined,
      email: row.EMAIL || undefined,
      ativo: row.ATIVO === 1 || row.ATIVO === true,
      criadoEm: row.CRIADO_EM
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter empresas:', err);
    return [];
  }
}

export async function salvarEmpresa(e: Empresa) {
  try {
    if (!pool) return;
    const query = `
      MERGE INTO EMPRESAS AS target
      USING (SELECT @id AS ID) AS source
      ON target.ID = source.ID
      WHEN MATCHED THEN
        UPDATE SET 
          NOME = @nome,
          CNPJ = @cnpj,
          TELEFONE = @telefone,
          EMAIL = @email,
          ATIVO = @ativo
      WHEN NOT MATCHED THEN
        INSERT (ID, NOME, CNPJ, TELEFONE, EMAIL, ATIVO, CRIADO_EM)
        VALUES (@id, @nome, @cnpj, @telefone, @email, @ativo, @criadoEm);
    `;
    await pool.request()
      .input('id', mssql.VarChar, e.id)
      .input('nome', mssql.NVarChar, e.nome)
      .input('cnpj', mssql.VarChar, e.cnpj)
      .input('telefone', mssql.VarChar, e.telefone || null)
      .input('email', mssql.VarChar, e.email || null)
      .input('ativo', mssql.Bit, e.ativo ? 1 : 0)
      .input('criadoEm', mssql.VarChar, e.criadoEm)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar empresa ${e.id}:`, err);
    throw err;
  }
}

export async function deletarEmpresa(id: string) {
  try {
    if (!pool) return;
    await pool.request()
      .input('id', mssql.VarChar, id)
      .query('DELETE FROM EMPRESAS WHERE ID = @id');
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao deletar empresa ${id}:`, err);
    throw err;
  }
}

export async function obterLojas(): Promise<Loja[]> {
  try {
    if (!pool) return [];
    const result = await pool.request().query('SELECT * FROM LOJAS');
    return result.recordset.map((row: any) => ({
      id: row.ID,
      empresaId: row.EMPRESA_ID,
      nome: row.NOME,
      cnpj: row.CNPJ || undefined,
      endereco: row.ENDERECO || undefined,
      bairro: row.BAIRRO || undefined,
      cidade: row.CIDADE || undefined,
      usuario: row.USUARIO,
      senhaHash: row.SENHA_HASH,
      chaveAcesso: row.CHAVE_ACESSO,
      ativo: row.ATIVO === 1 || row.ATIVO === true,
      criadoEm: row.CRIADO_EM,
      recebePedidos: row.RECEBE_PEDIDOS === 1 || row.RECEBE_PEDIDOS === true
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter lojas:', err);
    return [];
  }
}

export async function salvarLoja(l: Loja) {
  try {
    if (!pool) return;
    const query = `
      MERGE INTO LOJAS AS target
      USING (SELECT @id AS ID) AS source
      ON target.ID = source.ID
      WHEN MATCHED THEN
        UPDATE SET 
          EMPRESA_ID = @empresaId,
          NOME = @nome,
          CNPJ = @cnpj,
          ENDERECO = @endereco,
          BAIRRO = @bairro,
          CIDADE = @cidade,
          USUARIO = @usuario,
          SENHA_HASH = @senhaHash,
          CHAVE_ACESSO = @chaveAcesso,
          ATIVO = @ativo,
          RECEBE_PEDIDOS = @recebePedidos
      WHEN NOT MATCHED THEN
        INSERT (ID, EMPRESA_ID, NOME, CNPJ, ENDERECO, BAIRRO, CIDADE, USUARIO, SENHA_HASH, CHAVE_ACESSO, ATIVO, CRIADO_EM, RECEBE_PEDIDOS)
        VALUES (@id, @empresaId, @nome, @cnpj, @endereco, @bairro, @cidade, @usuario, @senhaHash, @chaveAcesso, @ativo, @criadoEm, @recebePedidos);
    `;
    await pool.request()
      .input('id', mssql.VarChar, l.id)
      .input('empresaId', mssql.VarChar, l.empresaId)
      .input('nome', mssql.NVarChar, l.nome)
      .input('cnpj', mssql.VarChar, l.cnpj || null)
      .input('endereco', mssql.NVarChar, l.endereco || null)
      .input('bairro', mssql.NVarChar, l.bairro || null)
      .input('cidade', mssql.NVarChar, l.cidade || null)
      .input('usuario', mssql.VarChar, l.usuario)
      .input('senhaHash', mssql.VarChar, l.senhaHash)
      .input('chaveAcesso', mssql.VarChar, l.chaveAcesso)
      .input('ativo', mssql.Bit, l.ativo ? 1 : 0)
      .input('criadoEm', mssql.VarChar, l.criadoEm)
      .input('recebePedidos', mssql.Bit, l.recebePedidos ? 1 : 0)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar loja ${l.id}:`, err);
    throw err;
  }
}

export async function deletarLoja(id: string) {
  try {
    if (!pool) return;
    await pool.request()
      .input('id', mssql.VarChar, id)
      .query('DELETE FROM LOJAS WHERE ID = @id');
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao deletar loja ${id}:`, err);
    throw err;
  }
}

export async function obterTiposVeiculos(): Promise<TipoVeiculo[]> {
  try {
    if (!pool) return [];
    const result = await pool.request().query('SELECT * FROM TIPOS_VEICULOS');
    return result.recordset.map((row: any) => ({
      id: row.ID,
      name: row.NOME
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter tipos de veículos:', err);
    return [];
  }
}

export async function salvarTipoVeiculo(vt: TipoVeiculo) {
  try {
    if (!pool) return;
    const query = `
      MERGE INTO TIPOS_VEICULOS AS target
      USING (SELECT @id AS ID) AS source
      ON target.ID = source.ID
      WHEN MATCHED THEN
        UPDATE SET NOME = @nome
      WHEN NOT MATCHED THEN
        INSERT (ID, NOME) VALUES (@id, @nome);
    `;
    await pool.request()
      .input('id', mssql.VarChar, vt.id)
      .input('nome', mssql.NVarChar, vt.name)
      .query(query);
  } catch (err) {
    console.error(`[Banco de Dados] Erro ao salvar tipo de veículo ${vt.id}:`, err);
    throw err;
  }
}

export async function obterProdutos(lojaId?: string): Promise<Produto[]> {
  try {
    if (!pool) return [];
    let query = 'SELECT * FROM PRODUTOS WHERE ATIVO = 1';
    const request = pool.request();
    if (lojaId) {
      query += ' AND (LOJA_ID = @lojaId OR LOJA_ID IS NULL)';
      request.input('lojaId', mssql.VarChar, lojaId);
    } else {
      query += ' AND LOJA_ID IS NULL';
    }
    const result = await request.query(query);
    return result.recordset.map((row: any) => ({
      id: row.ID,
      nome: row.NOME,
      preco: Number(row.PRECO),
      lojaId: row.LOJA_ID || undefined,
      ativo: row.ATIVO === 1 || row.ATIVO === true,
      imagemUrl: row.IMAGEM_URL || undefined
    }));
  } catch (err) {
    console.error('[Banco de Dados] Erro ao obter produtos:', err);
    return [];
  }
}


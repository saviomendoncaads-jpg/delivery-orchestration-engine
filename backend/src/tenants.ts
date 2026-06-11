import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Empresa, Loja } from './types';
import {
  obterEmpresas,
  salvarEmpresa,
  deletarEmpresa,
  obterLojas,
  salvarLoja,
  deletarLoja
} from './database';
import { criarAssinaturaComPrimeiraFatura, listarPlanosAtivos } from './billing/subscriptionService';
import { geocodificarEndereco } from './geocoding';
import { obterSessaoDoRequest, verificarAdmin } from './auth';
import { hashPassword } from './security/password';

const TENANTS_FILE = path.join(__dirname, '..', 'tenants-data.json');

export let empresas: Empresa[] = [];
export let lojas: Loja[] = [];

// Carrega dados salvos do banco de dados (e migra do arquivo JSON se necessário)
export async function carregarTenantsDoBanco() {
  try {
    console.log('[Tenants] Carregando empresas e lojas do banco de dados...');
    
    // Obter do banco primeiro
    let empresasBanco = await obterEmpresas();
    let lojasBanco = await obterLojas();

    // Se o banco de dados estiver vazio, fazer a migração do JSON
    if (empresasBanco.length === 0 && fs.existsSync(TENANTS_FILE)) {
      console.log('[Tenants] Banco de dados vazio. Iniciando migração do tenants-data.json...');
      const dataJson = JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf-8'));
      
      const empresasJson: Empresa[] = Array.isArray(dataJson.empresas) ? dataJson.empresas : [];
      const lojasJson: Loja[] = Array.isArray(dataJson.lojas) ? dataJson.lojas : [];

      console.log(`[Tenants] Migrando ${empresasJson.length} empresas e ${lojasJson.length} lojas...`);

      // Salvar empresas
      for (const e of empresasJson) {
        await salvarEmpresa(e);
      }

      // Salvar lojas tratando duplicidades de usuário (usuario)
      const usernamesSet = new Set<string>();
      for (const l of lojasJson) {
        let username = l.usuario.trim().toLowerCase();
        if (usernamesSet.has(username)) {
          let suffix = 1;
          let newUsername = `${username}_${suffix}`;
          while (usernamesSet.has(newUsername)) {
            suffix++;
            newUsername = `${username}_${suffix}`;
          }
          console.log(`[Tenants] Usuário duplicado detectado: "${username}". Renomeado para "${newUsername}"`);
          l.usuario = newUsername;
        }
        usernamesSet.add(l.usuario);
        await salvarLoja(l);
      }

      // Renomear arquivo json
      const migratedPath = TENANTS_FILE + '.migrated';
      fs.renameSync(TENANTS_FILE, migratedPath);
      console.log(`[Tenants] Migração concluída com sucesso! Arquivo original renomeado para ${migratedPath}`);

      // Recarregar do banco
      empresasBanco = await obterEmpresas();
      lojasBanco = await obterLojas();
    }

    empresas = empresasBanco;
    lojas = lojasBanco;
    console.log(`[Tenants] Carregamento concluído: ${empresas.length} empresas e ${lojas.length} lojas em memória.`);

    // Backfill automático em background: geocodifica lojas que já existem mas
    // não têm latitude/longitude resolvidas. Throttled pelo próprio módulo de geocoding.
    void preencherCoordenadasFaltantes();
  } catch (e) {
    console.error('[Tenants] Erro ao carregar/migrar tenants do banco de dados:', e);
  }
}

// Geocodifica em segundo plano as lojas sem latitude/longitude, atualizando o banco
// e o cache em memória conforme cada uma é resolvida. Roda assíncrono para não bloquear o boot.
async function preencherCoordenadasFaltantes() {
  const pendentes = lojas.filter(l => (l.latitude === undefined || l.longitude === undefined) && (l.endereco || l.bairro || l.cidade || l.cep));
  if (pendentes.length === 0) return;
  console.log(`[Tenants] Resolvendo coordenadas de ${pendentes.length} loja(s) em background...`);
  let ok = 0, fail = 0;
  for (const loja of pendentes) {
    try {
      const coord = await geocodificarEndereco({
        endereco: loja.endereco,
        numero: loja.numero,
        bairro: loja.bairro,
        cidade: loja.cidade,
        uf: loja.uf,
        cep: loja.cep
      });
      if (coord) {
        loja.latitude = coord.latitude;
        loja.longitude = coord.longitude;
        await salvarLoja(loja);
        ok++;
        console.log(`[Tenants] ✔ Loja "${loja.nome}" → (${coord.latitude}, ${coord.longitude})`);
      } else {
        fail++;
        console.warn(`[Tenants] ✖ Loja "${loja.nome}" sem coordenadas — endereço cadastrado não foi encontrado. Preencha CEP para melhor precisão.`);
      }
    } catch (err) {
      fail++;
      console.error(`[Tenants] ✖ Falha no backfill da loja ${loja.id}:`, err);
    }
  }
  console.log(`[Tenants] Backfill concluído: ${ok} resolvida(s), ${fail} sem resultado.`);
}

// Resolve coordenadas a partir do endereço; mantém as atuais em caso de falha.
async function resolverCoordenadasLoja(loja: Loja): Promise<void> {
  if (!loja.endereco && !loja.bairro && !loja.cidade && !loja.cep) return;
  const coord = await geocodificarEndereco({
    endereco: loja.endereco,
    numero: loja.numero,
    bairro: loja.bairro,
    cidade: loja.cidade,
    uf: loja.uf,
    cep: loja.cep
  });
  if (coord) {
    loja.latitude = coord.latitude;
    loja.longitude = coord.longitude;
  }
}

function gerarChaveAcesso(): string {
  const rand = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DISTRE-${rand()}-${rand()}-${rand()}`;
}

const router = Router();

// ─── FUNIL PÚBLICO: PREÇOS + CADASTRO SELF-SERVICE ─────────────────────────────

// Planos ativos (público) — alimenta a página de preços e o formulário de cadastro.
router.get('/planos', async (_req: Request, res: Response) => {
  try {
    res.json(await listarPlanosAtivos());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Limite anti-abuso para o cadastro público (cria tenants reais).
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos cadastros a partir deste IP. Tente novamente mais tarde.' },
});

// Cadastro self-service: a empresa cria a própria conta (empresa + 1ª loja),
// escolhe um plano e recebe a cobrança (Pix/Boleto) da 1ª mensalidade para ativar.
// Mirror do fluxo administrativo, porém público — com rollback se qualquer etapa falhar.
router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  const { empresa: empIn, loja: lojaIn, planoId, diaVencimento } = req.body || {};

  if (!empIn?.nome || !empIn?.cnpj) {
    res.status(400).json({ error: 'Dados da empresa (nome e CNPJ) são obrigatórios.' });
    return;
  }
  if (!lojaIn?.nome || !lojaIn?.usuario || !lojaIn?.senha) {
    res.status(400).json({ error: 'Dados da loja (nome, usuário e senha) são obrigatórios.' });
    return;
  }
  if (String(lojaIn.senha).length < 6) {
    res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
    return;
  }
  if (!lojaIn?.endereco || !lojaIn?.cidade) {
    res.status(400).json({ error: 'Endereço e cidade da loja são obrigatórios (para roteirização das entregas).' });
    return;
  }
  if (!planoId) {
    res.status(400).json({ error: 'Escolha um plano de assinatura.' });
    return;
  }

  const empresaCnpj = String(empIn.cnpj).trim();
  const lojaUsuario = String(lojaIn.usuario).trim().toLowerCase();
  const lojaCnpj = lojaIn.cnpj ? String(lojaIn.cnpj).trim() : undefined;

  if (empresas.some(e => e.cnpj === empresaCnpj)) {
    res.status(409).json({ error: 'Já existe uma empresa com este CNPJ.' });
    return;
  }
  if (lojas.some(l => l.usuario === lojaUsuario)) {
    res.status(409).json({ error: 'Este usuário de acesso já está em uso. Escolha outro.' });
    return;
  }
  if (lojaCnpj && lojas.some(l => l.cnpj === lojaCnpj)) {
    res.status(409).json({ error: 'Já existe uma loja com este CNPJ.' });
    return;
  }

  // 1) Empresa.
  const empresa: Empresa = {
    id: crypto.randomUUID(),
    nome: String(empIn.nome).trim(),
    cnpj: empresaCnpj,
    telefone: empIn.telefone?.trim() || undefined,
    email: empIn.email?.trim() || undefined,
    ativo: true,
    statusFinanceiro: 'REGULAR',
    criadoEm: new Date().toISOString(),
  };
  try {
    await salvarEmpresa(empresa);
    empresas.push(empresa);
  } catch (err: any) {
    res.status(500).json({ error: 'Falha ao criar empresa.', details: err.message });
    return;
  }

  // 2) Primeira loja da empresa.
  const loja: Loja = {
    id: crypto.randomUUID(),
    empresaId: empresa.id,
    nome: String(lojaIn.nome).trim(),
    cnpj: lojaCnpj,
    endereco: lojaIn.endereco?.trim() || undefined,
    numero: lojaIn.numero?.trim() || undefined,
    bairro: lojaIn.bairro?.trim() || undefined,
    cidade: lojaIn.cidade?.trim() || undefined,
    uf: lojaIn.uf?.trim().toUpperCase() || undefined,
    cep: lojaIn.cep?.trim() || undefined,
    usuario: lojaUsuario,
    senhaHash: await hashPassword(String(lojaIn.senha)),
    chaveAcesso: gerarChaveAcesso(),
    ativo: true,
    criadoEm: new Date().toISOString(),
    recebePedidos: lojaIn.recebePedidos === true || lojaIn.recebePedidos === 'true',
  };
  try {
    await resolverCoordenadasLoja(loja);
    await salvarLoja(loja);
    lojas.push(loja);
  } catch (err: any) {
    await deletarEmpresa(empresa.id).catch(() => {});
    const ie = empresas.findIndex(e => e.id === empresa.id);
    if (ie !== -1) empresas.splice(ie, 1);
    res.status(500).json({ error: 'Falha ao criar loja.', details: err.message });
    return;
  }

  // 3) Assinatura + 1ª fatura (gera a cobrança Pix/Boleto no gateway).
  try {
    const assinatura = await criarAssinaturaComPrimeiraFatura({
      empresaId: empresa.id,
      lojaId: loja.id,
      planoId,
      diaVencimento: diaVencimento ? Number(diaVencimento) : undefined,
    });

    res.status(201).json({
      success: true,
      mensagem: 'Conta criada com sucesso! Pague a 1ª mensalidade para ativar o painel.',
      empresa: { id: empresa.id, nome: empresa.nome },
      loja: { id: loja.id, nome: loja.nome, usuario: loja.usuario, chaveAcesso: loja.chaveAcesso },
      assinatura: {
        id: assinatura.assinaturaId,
        plano: assinatura.planoNome,
        valor: assinatura.valor,
        vencimento: assinatura.vencimento,
      },
      pagamento: {
        faturaId: assinatura.faturaId,
        pixCopiaCola: assinatura.pixCopiaCola,
        boletoUrl: assinatura.boletoUrl,
        linkPagamento: assinatura.linkPagamento,
      },
    });
  } catch (subErr: any) {
    // Rollback total: não deixa empresa/loja órfã sem assinatura.
    await deletarLoja(loja.id).catch(() => {});
    const il = lojas.findIndex(l => l.id === loja.id);
    if (il !== -1) lojas.splice(il, 1);
    await deletarEmpresa(empresa.id).catch(() => {});
    const ie = empresas.findIndex(e => e.id === empresa.id);
    if (ie !== -1) empresas.splice(ie, 1);
    res.status(400).json({ error: `Falha ao criar assinatura: ${subErr.message}` });
    return;
  }
});

// ─── EMPRESAS ────────────────────────────────────────────────────────────────

// Listar todas as empresas (com contagem de lojas)
router.get('/empresas', verificarAdmin, (_req: Request, res: Response) => {
  const result = empresas.map(e => ({
    ...e,
    totalLojas: lojas.filter(l => l.empresaId === e.id).length,
    lojasAtivas: lojas.filter(l => l.empresaId === e.id && l.ativo).length,
  }));
  res.json(result);
});

// Criar empresa
router.post('/empresas', verificarAdmin, async (req: Request, res: Response) => {
  const { nome, cnpj, telefone, email } = req.body;
  if (!nome || !cnpj) {
    res.status(400).json({ error: 'Nome e CNPJ são obrigatórios' });
    return;
  }
  const cleanCnpj = cnpj.trim();
  if (empresas.some(e => e.cnpj === cleanCnpj)) {
    res.status(400).json({ error: 'CNPJ já cadastrado' });
    return;
  }
  const empresa: Empresa = {
    id: crypto.randomUUID(),
    nome: nome.trim(),
    cnpj: cleanCnpj,
    telefone: telefone?.trim() || undefined,
    email: email?.trim() || undefined,
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  try {
    await salvarEmpresa(empresa);
    empresas.push(empresa);
    res.status(201).json(empresa);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar empresa no banco de dados', details: err.message });
  }
});

// Atualizar empresa
router.put('/empresas/:id', verificarAdmin, async (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.id);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  const { nome, cnpj, telefone, email } = req.body;
  
  if (cnpj) {
    const cleanCnpj = cnpj.trim();
    if (empresas.some(e => e.cnpj === cleanCnpj && e.id !== empresa.id)) {
      res.status(400).json({ error: 'CNPJ já cadastrado para outra empresa' });
      return;
    }
    empresa.cnpj = cleanCnpj;
  }

  if (nome) empresa.nome = nome.trim();
  if (telefone !== undefined) empresa.telefone = telefone.trim() || undefined;
  if (email !== undefined) empresa.email = email.trim() || undefined;

  try {
    await salvarEmpresa(empresa);
    res.json(empresa);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar empresa no banco de dados', details: err.message });
  }
});

// Ativar/desativar empresa
router.patch('/empresas/:id/toggle', verificarAdmin, async (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.id);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  empresa.ativo = !empresa.ativo;
  try {
    await salvarEmpresa(empresa);
    res.json(empresa);
  } catch (err: any) {
    empresa.ativo = !empresa.ativo; // Reverter estado em caso de falha
    res.status(500).json({ error: 'Erro ao alterar status da empresa', details: err.message });
  }
});

// Remover empresa (somente se não tiver lojas)
router.delete('/empresas/:id', verificarAdmin, async (req: Request, res: Response) => {
  const idx = empresas.findIndex(e => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  if (lojas.some(l => l.empresaId === req.params.id)) {
    res.status(400).json({ error: 'Remova todas as lojas antes de excluir a empresa' });
    return;
  }
  try {
    await deletarEmpresa(req.params.id as string);
    empresas.splice(idx, 1);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao remover empresa no banco de dados', details: err.message });
  }
});

// ─── LOJAS ───────────────────────────────────────────────────────────────────

// Listar lojas de uma empresa (sem expor senhaHash)
router.get('/empresas/:empresaId/lojas', verificarAdmin, (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.empresaId);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  const result = lojas
    .filter(l => l.empresaId === req.params.empresaId)
    .map(({ senhaHash: _h, ...rest }) => rest);
  res.json(result);
});

// Criar loja
router.post('/empresas/:empresaId/lojas', verificarAdmin, async (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.empresaId);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  const { nome, cnpj, endereco, numero, bairro, cidade, uf, cep, usuario, senha, recebePedidos, planoId, diaVencimento } = req.body;
  if (!nome || !usuario || !senha || !cnpj) {
    res.status(400).json({ error: 'Nome, CNPJ, usuário e senha são obrigatórios' });
    return;
  }
  if (!planoId) {
    res.status(400).json({ error: 'Plano de assinatura é obrigatório' });
    return;
  }

  const cleanUsuario = usuario.trim().toLowerCase();
  const cleanCnpj = cnpj.trim();

  // Validação de Usuário único
  if (lojas.some(l => l.usuario === cleanUsuario)) {
    res.status(400).json({ error: 'Usuário já cadastrado em outra loja' });
    return;
  }

  // Validação de CNPJ único
  if (lojas.some(l => l.cnpj === cleanCnpj)) {
    res.status(400).json({ error: 'CNPJ já cadastrado para outra loja' });
    return;
  }

  const loja: Loja = {
    id: crypto.randomUUID(),
    empresaId: req.params.empresaId as string,
    nome: nome.trim(),
    cnpj: cleanCnpj,
    endereco: endereco?.trim() || undefined,
    numero: numero?.trim() || undefined,
    bairro: bairro?.trim() || undefined,
    cidade: cidade?.trim() || undefined,
    uf: uf?.trim().toUpperCase() || undefined,
    cep: cep?.trim() || undefined,
    usuario: cleanUsuario,
    senhaHash: await hashPassword(senha),
    chaveAcesso: gerarChaveAcesso(),
    ativo: true,
    criadoEm: new Date().toISOString(),
    recebePedidos: recebePedidos === true || recebePedidos === 'true'
  };

  // Resolve coordenadas geográficas a partir do endereço informado (automático, sem ação manual)
  await resolverCoordenadasLoja(loja);

  try {
    await salvarLoja(loja);
    lojas.push(loja);

    // Cobrança por loja: cria a assinatura ATIVA + 1ª fatura PENDENTE com o plano escolhido.
    let assinatura;
    try {
      assinatura = await criarAssinaturaComPrimeiraFatura({
        empresaId: loja.empresaId,
        lojaId: loja.id,
        planoId,
        diaVencimento: diaVencimento ? Number(diaVencimento) : undefined,
      });
    } catch (subErr: any) {
      // Loja foi criada, mas a assinatura falhou (ex.: plano inválido). Desfaz a loja
      // para não deixar loja órfã sem assinatura, e reporta o erro.
      await deletarLoja(loja.id);
      const idx = lojas.findIndex(l => l.id === loja.id);
      if (idx !== -1) lojas.splice(idx, 1);
      res.status(400).json({ error: `Erro ao criar assinatura da loja: ${subErr.message}` });
      return;
    }

    const { senhaHash: _h, ...lojaPublica } = loja;
    res.status(201).json({ ...lojaPublica, assinatura });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar loja no banco de dados', details: err.message });
  }
});

// Atualizar loja
router.put('/empresas/:empresaId/lojas/:lojaId', verificarAdmin, async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  const { nome, cnpj, endereco, numero, bairro, cidade, uf, cep, usuario, senha, recebePedidos } = req.body;

  if (usuario) {
    const cleanUsuario = usuario.trim().toLowerCase();
    if (lojas.some(l => l.usuario === cleanUsuario && l.id !== loja.id)) {
      res.status(400).json({ error: 'Usuário já cadastrado em outra loja' });
      return;
    }
    loja.usuario = cleanUsuario;
  }

  if (cnpj) {
    const cleanCnpj = cnpj.trim();
    if (lojas.some(l => l.cnpj === cleanCnpj && l.id !== loja.id)) {
      res.status(400).json({ error: 'CNPJ já cadastrado para outra loja' });
      return;
    }
    loja.cnpj = cleanCnpj;
  }

  if (nome) loja.nome = nome.trim();
  const enderecoMudou =
    (endereco !== undefined && endereco.trim() !== (loja.endereco || '')) ||
    (numero !== undefined && numero.trim() !== (loja.numero || '')) ||
    (bairro !== undefined && bairro.trim() !== (loja.bairro || '')) ||
    (cidade !== undefined && cidade.trim() !== (loja.cidade || '')) ||
    (uf !== undefined && uf.trim().toUpperCase() !== (loja.uf || '')) ||
    (cep !== undefined && cep.trim() !== (loja.cep || ''));
  if (endereco !== undefined) loja.endereco = endereco.trim() || undefined;
  if (numero !== undefined) loja.numero = numero.trim() || undefined;
  if (bairro !== undefined) loja.bairro = bairro.trim() || undefined;
  if (cidade !== undefined) loja.cidade = cidade.trim() || undefined;
  if (uf !== undefined) loja.uf = uf.trim().toUpperCase() || undefined;
  if (cep !== undefined) loja.cep = cep.trim() || undefined;
  if (recebePedidos !== undefined) {
    loja.recebePedidos = recebePedidos === true || recebePedidos === 'true';
  }

  if (senha) loja.senhaHash = await hashPassword(senha);

  // Re-geocodifica automaticamente quando o endereço, bairro ou cidade mudam
  if (enderecoMudou) {
    loja.latitude = undefined;
    loja.longitude = undefined;
    await resolverCoordenadasLoja(loja);
  }

  try {
    await salvarLoja(loja);
    const { senhaHash: _h, ...lojaPublica } = loja;
    res.json(lojaPublica);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar loja no banco de dados', details: err.message });
  }
});

// Ativar/desativar loja
router.patch('/empresas/:empresaId/lojas/:lojaId/toggle', verificarAdmin, async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  loja.ativo = !loja.ativo;
  try {
    await salvarLoja(loja);
    const { senhaHash: _h, ...lojaPublica } = loja;
    res.json(lojaPublica);
  } catch (err: any) {
    loja.ativo = !loja.ativo; // Reverter
    res.status(500).json({ error: 'Erro ao atualizar status da loja', details: err.message });
  }
});

// Alterar senha da loja
router.patch('/empresas/:empresaId/lojas/:lojaId/alterar-senha', verificarAdmin, async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  const { novaSenha } = req.body;
  if (!novaSenha) { res.status(400).json({ error: 'Nova senha é obrigatória' }); return; }
  const antigaSenhaHash = loja.senhaHash;
  loja.senhaHash = await hashPassword(novaSenha);
  try {
    await salvarLoja(loja);
    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err: any) {
    loja.senhaHash = antigaSenhaHash; // Reverter
    res.status(500).json({ error: 'Erro ao alterar senha da loja', details: err.message });
  }
});

// Self-service: a loja autenticada define manualmente as próprias coordenadas
// (tipicamente vindo da Geolocation API do navegador — "use minha localização atual").
router.post('/loja-atual/coordenadas', async (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (sessao?.tipo !== 'loja' || !sessao.lojaId) {
    res.status(403).json({ error: 'Apenas sessões de loja podem usar este endpoint.' });
    return;
  }
  const loja = lojas.find(l => l.id === sessao.lojaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }

  const { latitude, longitude } = req.body || {};
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'latitude e longitude numéricos são obrigatórios.' });
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: 'Coordenadas fora do intervalo válido.' });
    return;
  }

  loja.latitude = lat;
  loja.longitude = lng;
  try {
    await salvarLoja(loja);
    res.json({ success: true, latitude: lat, longitude: lng });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar coordenadas', details: err.message });
  }
});

// Self-service: a loja autenticada força a re-geocodificação do próprio endereço.
router.post('/loja-atual/regeocode', async (req: Request, res: Response) => {
  const sessao = obterSessaoDoRequest(req);
  if (sessao?.tipo !== 'loja' || !sessao.lojaId) {
    res.status(403).json({ error: 'Apenas sessões de loja podem usar este endpoint.' });
    return;
  }
  const loja = lojas.find(l => l.id === sessao.lojaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  if (!loja.endereco && !loja.bairro && !loja.cidade && !loja.cep) {
    res.status(400).json({ error: 'Loja sem endereço cadastrado. Peça ao administrador para preencher CEP / endereço.' });
    return;
  }
  loja.latitude = undefined;
  loja.longitude = undefined;
  await resolverCoordenadasLoja(loja);
  try {
    await salvarLoja(loja);
    if (loja.latitude !== undefined && loja.longitude !== undefined) {
      res.json({ success: true, latitude: loja.latitude, longitude: loja.longitude });
    } else {
      res.status(404).json({ error: 'Não foi possível localizar este endereço. Verifique CEP, número, bairro, cidade e UF.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar nova localização', details: err.message });
  }
});

// Forçar nova geocodificação do endereço da loja (ignora cache do banco — refaz a chamada externa).
router.post('/empresas/:empresaId/lojas/:lojaId/regeocode', verificarAdmin, async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  if (!loja.endereco && !loja.bairro && !loja.cidade && !loja.cep) {
    res.status(400).json({ error: 'Loja não tem endereço cadastrado. Preencha CEP ou endereço antes de localizar no mapa.' });
    return;
  }
  // Limpa coords atuais para forçar nova resolução
  loja.latitude = undefined;
  loja.longitude = undefined;
  await resolverCoordenadasLoja(loja);
  try {
    await salvarLoja(loja);
    if (loja.latitude !== undefined && loja.longitude !== undefined) {
      res.json({ success: true, latitude: loja.latitude, longitude: loja.longitude });
    } else {
      res.status(404).json({ error: 'Não foi possível localizar este endereço. Verifique CEP, número, bairro, cidade e UF.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar nova localização', details: err.message });
  }
});

// Regenerar chave de acesso
router.post('/empresas/:empresaId/lojas/:lojaId/regenerar-chave', verificarAdmin, async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  const antigaChave = loja.chaveAcesso;
  loja.chaveAcesso = gerarChaveAcesso();
  try {
    await salvarLoja(loja);
    res.json({ chaveAcesso: loja.chaveAcesso });
  } catch (err: any) {
    loja.chaveAcesso = antigaChave; // Reverter
    res.status(500).json({ error: 'Erro ao regenerar chave de acesso', details: err.message });
  }
});

// Remover loja
router.delete('/empresas/:empresaId/lojas/:lojaId', verificarAdmin, async (req: Request, res: Response) => {
  const idx = lojas.findIndex(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (idx === -1) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  try {
    await deletarLoja(req.params.lojaId as string);
    lojas.splice(idx, 1);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao remover loja do banco de dados', details: err.message });
  }
});

export default router;

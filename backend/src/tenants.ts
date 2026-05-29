import { Router, Request, Response } from 'express';
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
  } catch (e) {
    console.error('[Tenants] Erro ao carregar/migrar tenants do banco de dados:', e);
  }
}

function gerarChaveAcesso(): string {
  const rand = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DISTRE-${rand()}-${rand()}-${rand()}`;
}

export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const router = Router();

// ─── EMPRESAS ────────────────────────────────────────────────────────────────

// Listar todas as empresas (com contagem de lojas)
router.get('/empresas', (_req: Request, res: Response) => {
  const result = empresas.map(e => ({
    ...e,
    totalLojas: lojas.filter(l => l.empresaId === e.id).length,
    lojasAtivas: lojas.filter(l => l.empresaId === e.id && l.ativo).length,
  }));
  res.json(result);
});

// Criar empresa
router.post('/empresas', async (req: Request, res: Response) => {
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
router.put('/empresas/:id', async (req: Request, res: Response) => {
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
router.patch('/empresas/:id/toggle', async (req: Request, res: Response) => {
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
router.delete('/empresas/:id', async (req: Request, res: Response) => {
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
router.get('/empresas/:empresaId/lojas', (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.empresaId);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  const result = lojas
    .filter(l => l.empresaId === req.params.empresaId)
    .map(({ senhaHash: _h, ...rest }) => rest);
  res.json(result);
});

// Criar loja
router.post('/empresas/:empresaId/lojas', async (req: Request, res: Response) => {
  const empresa = empresas.find(e => e.id === req.params.empresaId);
  if (!empresa) { res.status(404).json({ error: 'Empresa não encontrada' }); return; }
  const { nome, cnpj, endereco, bairro, cidade, usuario, senha, recebePedidos } = req.body;
  if (!nome || !usuario || !senha || !cnpj) {
    res.status(400).json({ error: 'Nome, CNPJ, usuário e senha são obrigatórios' });
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
    bairro: bairro?.trim() || undefined,
    cidade: cidade?.trim() || undefined,
    usuario: cleanUsuario,
    senhaHash: hashPassword(senha),
    chaveAcesso: gerarChaveAcesso(),
    ativo: true,
    criadoEm: new Date().toISOString(),
    recebePedidos: recebePedidos === true || recebePedidos === 'true'
  };

  try {
    await salvarLoja(loja);
    lojas.push(loja);
    const { senhaHash: _h, ...lojaPublica } = loja;
    res.status(201).json(lojaPublica);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar loja no banco de dados', details: err.message });
  }
});

// Atualizar loja
router.put('/empresas/:empresaId/lojas/:lojaId', async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  const { nome, cnpj, endereco, bairro, cidade, usuario, senha, recebePedidos } = req.body;

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
  if (endereco !== undefined) loja.endereco = endereco.trim() || undefined;
  if (bairro !== undefined) loja.bairro = bairro.trim() || undefined;
  if (cidade !== undefined) loja.cidade = cidade.trim() || undefined;
  if (recebePedidos !== undefined) {
    loja.recebePedidos = recebePedidos === true || recebePedidos === 'true';
  }
  
  if (senha) loja.senhaHash = hashPassword(senha);

  try {
    await salvarLoja(loja);
    const { senhaHash: _h, ...lojaPublica } = loja;
    res.json(lojaPublica);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar loja no banco de dados', details: err.message });
  }
});

// Ativar/desativar loja
router.patch('/empresas/:empresaId/lojas/:lojaId/toggle', async (req: Request, res: Response) => {
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
router.patch('/empresas/:empresaId/lojas/:lojaId/alterar-senha', async (req: Request, res: Response) => {
  const loja = lojas.find(l => l.id === req.params.lojaId && l.empresaId === req.params.empresaId);
  if (!loja) { res.status(404).json({ error: 'Loja não encontrada' }); return; }
  const { novaSenha } = req.body;
  if (!novaSenha) { res.status(400).json({ error: 'Nova senha é obrigatória' }); return; }
  const antigaSenhaHash = loja.senhaHash;
  loja.senhaHash = hashPassword(novaSenha);
  try {
    await salvarLoja(loja);
    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err: any) {
    loja.senhaHash = antigaSenhaHash; // Reverter
    res.status(500).json({ error: 'Erro ao alterar senha da loja', details: err.message });
  }
});

// Regenerar chave de acesso
router.post('/empresas/:empresaId/lojas/:lojaId/regenerar-chave', async (req: Request, res: Response) => {
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
router.delete('/empresas/:empresaId/lojas/:lojaId', async (req: Request, res: Response) => {
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

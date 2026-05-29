import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Sessao } from './types';
import { lojas, empresas } from './tenants';
import { verificarAdminNoBanco } from './database';

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const router = Router();

// Sessões ativas em memória (token → Sessao)
export const sessions = new Map<string, Sessao>();

// Senha do administrador master (configurável via variável de ambiente)
const ADMIN_USUARIO = process.env.ADMIN_USUARIO || 'admin';
const ADMIN_SENHA_HASH = hashPassword(process.env.ADMIN_SENHA || 'admin@distre2026');

// ─── LOGIN DA LOJA ────────────────────────────────────────────────────────────
router.post('/login', (req: Request, res: Response) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    return;
  }

  const loja = lojas.find(l => l.usuario === usuario.trim().toLowerCase() && l.ativo);
  if (!loja || loja.senhaHash !== hashPassword(senha)) {
    res.status(401).json({ error: 'Credenciais inválidas ou loja inativa' });
    return;
  }

  const empresa = empresas.find(e => e.id === loja.empresaId);
  if (!empresa || !empresa.ativo) {
    res.status(401).json({ error: 'Empresa vinculada está inativa' });
    return;
  }

  // Bloqueio por inadimplência: empresa suspensa/cancelada não pode reabrir sessão.
  if (empresa.statusFinanceiro === 'SUSPENSO' || empresa.statusFinanceiro === 'CANCELADO') {
    res.status(402).json({
      error: 'Assinatura suspensa por inadimplência. Regularize o pagamento para acessar o painel.',
      codigo: 'PAYMENT_REQUIRED'
    });
    return;
  }

  const token = crypto.randomUUID();
  const sessao: Sessao = {
    tipo: 'loja',
    lojaId: loja.id,
    nomeLoja: loja.nome,
    nomeEmpresa: empresa.nome,
    token,
    criadoEm: new Date().toISOString(),
    recebePedidos: loja.recebePedidos
  };
  sessions.set(token, sessao);

  res.json({
    token,
    tipo: 'loja',
    lojaId: loja.id,
    nomeLoja: loja.nome,
    nomeEmpresa: empresa.nome,
    recebePedidos: loja.recebePedidos
  });
});

// ─── LOGIN ADMINISTRADOR ──────────────────────────────────────────────────────
router.post('/admin', async (req: Request, res: Response) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    return;
  }

  const eValido = await verificarAdminNoBanco(usuario.trim(), hashPassword(senha)) ||
                  (usuario.trim() === ADMIN_USUARIO && hashPassword(senha) === ADMIN_SENHA_HASH);

  if (!eValido) {
    res.status(401).json({ error: 'Credenciais administrativas incorretas' });
    return;
  }

  const token = crypto.randomUUID();
  const sessao: Sessao = {
    tipo: 'admin',
    token,
    criadoEm: new Date().toISOString(),
  };
  sessions.set(token, sessao);
  res.json({ token, tipo: 'admin' });
});

// ─── VERIFICAR SESSÃO ATUAL ───────────────────────────────────────────────────
router.get('/me', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Não autenticado' }); return; }
  const sessao = sessions.get(token);
  if (!sessao) { res.status(401).json({ error: 'Sessão inválida ou expirada' }); return; }
  // Retorna tudo menos o token interno
  const { token: _t, ...dadosSessao } = sessao;
  res.json({ ...dadosSessao, token });
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
router.post('/logout', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ─── MIDDLEWARE DE AUTENTICAÇÃO ───────────────────────────────────────────────

/** Obter a sessão do request sem bloquear (retorna null se não autenticado) */
export function obterSessaoDoRequest(req: Request): Sessao | null {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  return sessions.get(token) || null;
}

/** Middleware que exige autenticação válida */
export function verificarSessao(req: Request & { sessao?: Sessao }, res: Response, next: NextFunction) {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Autenticação necessária' });
    return;
  }
  req.sessao = sessao;
  next();
}

/**
 * Middleware que bloqueia ações de escrita de lojas cuja empresa está
 * SUSPENSA/CANCELADA por inadimplência (grace period D+7 esgotado).
 * Sessões admin e leitura não são afetadas — só mutações de loja.
 */
export function exigirEmpresaAdimplente(req: Request & { sessao?: Sessao }, res: Response, next: NextFunction) {
  const sessao = obterSessaoDoRequest(req);
  if (sessao?.tipo === 'loja' && sessao.lojaId) {
    const loja = lojas.find(l => l.id === sessao.lojaId);
    const empresa = loja ? empresas.find(e => e.id === loja.empresaId) : undefined;
    if (empresa && (empresa.statusFinanceiro === 'SUSPENSO' || empresa.statusFinanceiro === 'CANCELADO')) {
      res.status(402).json({
        error: 'Assinatura suspensa por inadimplência. Regularize o pagamento para continuar operando.',
        codigo: 'PAYMENT_REQUIRED'
      });
      return;
    }
  }
  next();
}

/** Middleware que exige perfil de administrador */
export function verificarAdmin(req: Request & { sessao?: Sessao }, res: Response, next: NextFunction) {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao || sessao.tipo !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito ao administrador' });
    return;
  }
  req.sessao = sessao;
  next();
}

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { obterSessaoDoRequest, exigirLojaAdimplente } from './auth';
import { obterProdutosDaLoja, salvarProduto, deletarProduto, salvarLoja } from './database';
import { lojas } from './tenants';
import { Produto, Sessao } from './types';

// ============================================================================
// GESTÃO DA VITRINE — rotas autenticadas usadas pelo painel da loja para
// montar o cardápio público: CRUD de produtos, logomarca e upload de imagens.
// Escopo de segurança: sessão de LOJA só enxerga/edita o próprio catálogo;
// admin pode operar qualquer loja via ?lojaId=.
// ============================================================================

const router = Router();

// Imagens enviadas pelo painel ficam em backend/uploads, servidas em /uploads.
export const uploadsDir = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch { /* já existe */ }

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // 3 MB por imagem
const PRECO_MAXIMO = 100000;

interface RequestComSessao extends Request {
  sessao?: Sessao;
}

function exigirSessao(req: RequestComSessao, res: Response, next: NextFunction) {
  const sessao = obterSessaoDoRequest(req);
  if (!sessao) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  req.sessao = sessao;
  next();
}

// Loja autenticada opera a si mesma; admin escolhe a loja via query/body.
function resolverLojaId(req: RequestComSessao): string | undefined {
  const sessao = req.sessao!;
  if (sessao.tipo === 'loja') return sessao.lojaId;
  const lojaId = (req.query.lojaId as string) || (req.body?.lojaId as string) || '';
  return lojaId.trim() || undefined;
}

function textoLimpo(valor: unknown, max: number): string {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, max);
}

function validarProdutoEntrada(body: any): { nome: string; preco: number; descricao?: string; imagemUrl?: string } | { erro: string } {
  const nome = textoLimpo(body?.nome, 255);
  if (!nome) return { erro: 'nome é obrigatório.' };
  const preco = Number(String(body?.preco ?? '').replace(',', '.'));
  if (!Number.isFinite(preco) || preco <= 0 || preco > PRECO_MAXIMO) {
    return { erro: `preco deve ser um número entre 0,01 e ${PRECO_MAXIMO}.` };
  }
  return {
    nome,
    preco: Number(preco.toFixed(2)),
    descricao: textoLimpo(body?.descricao, 500) || undefined,
    imagemUrl: textoLimpo(body?.imagemUrl, 600) || undefined
  };
}

router.use(exigirSessao);

// GET /api/gestao/produtos — catálogo próprio da loja (inclui inativos)
router.get('/produtos', async (req: RequestComSessao, res: Response) => {
  try {
    const lojaId = resolverLojaId(req);
    if (!lojaId) {
      res.status(400).json({ error: 'lojaId é obrigatório para sessão de administrador.' });
      return;
    }
    res.json(await obterProdutosDaLoja(lojaId));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao listar produtos.' });
  }
});

// POST /api/gestao/produtos — cadastra produto no catálogo da loja
router.post('/produtos', exigirLojaAdimplente, async (req: RequestComSessao, res: Response) => {
  try {
    const lojaId = resolverLojaId(req);
    if (!lojaId) {
      res.status(400).json({ error: 'lojaId é obrigatório para sessão de administrador.' });
      return;
    }
    const dados = validarProdutoEntrada(req.body);
    if ('erro' in dados) {
      res.status(400).json({ error: dados.erro });
      return;
    }
    const produto: Produto = {
      id: `prod-${crypto.randomBytes(5).toString('hex')}`,
      nome: dados.nome,
      preco: dados.preco,
      lojaId,
      ativo: true,
      imagemUrl: dados.imagemUrl,
      descricao: dados.descricao
    };
    await salvarProduto(produto);
    res.status(201).json(produto);
  } catch (err: any) {
    console.error('[GestaoVitrine] Erro ao criar produto:', err);
    res.status(500).json({ error: 'Erro ao salvar o produto.' });
  }
});

// PUT /api/gestao/produtos/:id — edita dados e/ou ativa/desativa
router.put('/produtos/:id', exigirLojaAdimplente, async (req: RequestComSessao, res: Response) => {
  try {
    const lojaId = resolverLojaId(req);
    if (!lojaId) {
      res.status(400).json({ error: 'lojaId é obrigatório para sessão de administrador.' });
      return;
    }
    const existentes = await obterProdutosDaLoja(lojaId);
    const atual = existentes.find(p => p.id === req.params.id);
    if (!atual) {
      res.status(404).json({ error: 'Produto não encontrado no catálogo desta loja.' });
      return;
    }
    const dados = validarProdutoEntrada({ ...atual, ...req.body });
    if ('erro' in dados) {
      res.status(400).json({ error: dados.erro });
      return;
    }
    const atualizado: Produto = {
      ...atual,
      nome: dados.nome,
      preco: dados.preco,
      descricao: dados.descricao,
      imagemUrl: dados.imagemUrl,
      ativo: typeof req.body?.ativo === 'boolean' ? req.body.ativo : atual.ativo
    };
    await salvarProduto(atualizado);
    res.json(atualizado);
  } catch (err: any) {
    console.error('[GestaoVitrine] Erro ao atualizar produto:', err);
    res.status(500).json({ error: 'Erro ao atualizar o produto.' });
  }
});

// DELETE /api/gestao/produtos/:id — remove definitivamente do catálogo
router.delete('/produtos/:id', exigirLojaAdimplente, async (req: RequestComSessao, res: Response) => {
  try {
    const lojaId = resolverLojaId(req);
    if (!lojaId) {
      res.status(400).json({ error: 'lojaId é obrigatório para sessão de administrador.' });
      return;
    }
    const removeu = await deletarProduto(String(req.params.id), lojaId);
    if (!removeu) {
      res.status(404).json({ error: 'Produto não encontrado no catálogo desta loja.' });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('[GestaoVitrine] Erro ao excluir produto:', err);
    res.status(500).json({ error: 'Erro ao excluir o produto.' });
  }
});

// PUT /api/gestao/loja — configurações da vitrine (hoje: logomarca)
router.put('/loja', exigirLojaAdimplente, async (req: RequestComSessao, res: Response) => {
  try {
    const lojaId = resolverLojaId(req);
    const loja = lojas.find(l => l.id === lojaId);
    if (!loja) {
      res.status(404).json({ error: 'Loja não encontrada.' });
      return;
    }
    if ('logoUrl' in (req.body || {})) {
      loja.logoUrl = textoLimpo(req.body.logoUrl, 600) || undefined;
    }
    await salvarLoja(loja);
    res.json({ success: true, logoUrl: loja.logoUrl });
  } catch (err: any) {
    console.error('[GestaoVitrine] Erro ao salvar loja:', err);
    res.status(500).json({ error: 'Erro ao salvar as configurações da loja.' });
  }
});

// POST /api/gestao/upload — recebe { dataUrl } (base64) e devolve a URL pública.
// O router é montado com express.json({ limit: '5mb' }) no index.ts.
router.post('/upload', exigirLojaAdimplente, (req: RequestComSessao, res: Response) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      res.status(400).json({ error: 'Envie uma imagem PNG, JPG ou WEBP (campo dataUrl em base64).' });
      return;
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: 'Imagem deve ter entre 1 byte e 3 MB.' });
      return;
    }
    const extensao = match[1] === 'jpeg' ? 'jpg' : match[1];
    const nomeArquivo = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extensao}`;
    fs.writeFileSync(path.join(uploadsDir, nomeArquivo), buffer);
    res.status(201).json({ url: `/uploads/${nomeArquivo}` });
  } catch (err: any) {
    console.error('[GestaoVitrine] Erro no upload:', err);
    res.status(500).json({ error: 'Erro ao salvar a imagem.' });
  }
});

export default router;

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ============================================================================
// VITRINE & PRODUTOS — modal do painel da loja (aberto pelo menu flutuante).
// Permite montar o cardápio público sem SQL: cadastrar/editar produtos com
// foto, preço e descrição, definir a logomarca e copiar o link da vitrine.
// Consome as rotas autenticadas /api/gestao/* (gestaoVitrine.ts no backend).
// ============================================================================

interface ProdutoGestao {
  id: string;
  nome: string;
  preco: number;
  descricao?: string;
  imagemUrl?: string;
  ativo: boolean;
}

interface Props {
  backendUrl: string;
  token: string;
  lojaId: string;
  nomeLoja: string;
  onClose: () => void;
}

const FORM_VAZIO = { id: '', nome: '', preco: '', descricao: '', imagemUrl: '' };
const MAX_IMAGEM_BYTES = 3 * 1024 * 1024;

const estiloInput: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-thin)',
  borderRadius: '8px',
  padding: '0.55rem 0.75rem',
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
  outline: 'none'
};

const estiloLabel: React.CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--text-secondary)',
  display: 'block',
  marginBottom: '0.3rem',
  fontWeight: 600
};

const estiloBotaoPrimario: React.CSSProperties = {
  background: 'var(--accent)',
  color: 'var(--accent-contrast)',
  border: 'none',
  borderRadius: '8px',
  padding: '0.55rem 1rem',
  fontWeight: 700,
  fontSize: '0.82rem',
  cursor: 'pointer'
};

const estiloBotaoSuave: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-thin)',
  borderRadius: '8px',
  padding: '0.5rem 0.9rem',
  fontSize: '0.8rem',
  cursor: 'pointer'
};

export default function GestaoVitrine({ backendUrl, token, lojaId, nomeLoja, onClose }: Props) {
  const [produtos, setProdutos] = useState<ProdutoGestao[]>([]);
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [enviandoImagem, setEnviandoImagem] = useState(false);
  const [formAberto, setFormAberto] = useState(false);
  const [form, setForm] = useState(FORM_VAZIO);
  const inputFotoRef = useRef<HTMLInputElement>(null);
  const inputLogoRef = useRef<HTMLInputElement>(null);

  const linkVitrine = `${window.location.origin}/loja/${lojaId}`;

  async function gestaoFetch(caminho: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${backendUrl}${caminho}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(corpo?.error || `Erro ${res.status} ao comunicar com o servidor.`);
    return corpo;
  }

  // URLs de /uploads são relativas ao backend (em dev o painel roda no Vite).
  function urlImagem(url?: string): string | undefined {
    if (!url) return undefined;
    return url.startsWith('/') ? `${backendUrl}${url}` : url;
  }

  useEffect(() => {
    let ativo = true;
    (async () => {
      try {
        const [lista, cardapio] = await Promise.all([
          gestaoFetch('/api/gestao/produtos'),
          fetch(`${backendUrl}/api/vitrine/${encodeURIComponent(lojaId)}`).then(r => (r.ok ? r.json() : null))
        ]);
        if (!ativo) return;
        setProdutos(Array.isArray(lista) ? lista : []);
        setLogoUrl(cardapio?.loja?.logoUrl || '');
      } catch (e: any) {
        if (ativo) setErro(e.message || 'Erro ao carregar o catálogo.');
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => {
      ativo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lojaId]);

  function mostrarAviso(texto: string) {
    setAviso(texto);
    window.setTimeout(() => setAviso(null), 3500);
  }

  // Lê o arquivo, valida e envia ao backend; devolve a URL pública (/uploads/...).
  async function enviarImagem(arquivo: File): Promise<string | null> {
    if (!/^image\/(png|jpe?g|webp)$/.test(arquivo.type)) {
      setErro('Envie uma imagem PNG, JPG ou WEBP.');
      return null;
    }
    if (arquivo.size > MAX_IMAGEM_BYTES) {
      setErro('A imagem deve ter no máximo 3 MB.');
      return null;
    }
    setErro(null);
    setEnviandoImagem(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(String(leitor.result));
        leitor.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
        leitor.readAsDataURL(arquivo);
      });
      const resp = await gestaoFetch('/api/gestao/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl })
      });
      return resp.url as string;
    } catch (e: any) {
      setErro(e.message || 'Erro ao enviar a imagem.');
      return null;
    } finally {
      setEnviandoImagem(false);
    }
  }

  async function aoEscolherFotoProduto(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (!arquivo) return;
    const url = await enviarImagem(arquivo);
    if (url) setForm(f => ({ ...f, imagemUrl: url }));
  }

  async function aoEscolherLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (!arquivo) return;
    const url = await enviarImagem(arquivo);
    if (!url) return;
    try {
      await gestaoFetch('/api/gestao/loja', { method: 'PUT', body: JSON.stringify({ logoUrl: url }) });
      setLogoUrl(url);
      mostrarAviso('Logomarca atualizada! Ela já aparece na vitrine.');
    } catch (e: any) {
      setErro(e.message);
    }
  }

  async function removerLogo() {
    try {
      await gestaoFetch('/api/gestao/loja', { method: 'PUT', body: JSON.stringify({ logoUrl: '' }) });
      setLogoUrl('');
      mostrarAviso('Logomarca removida — a vitrine volta a mostrar a inicial da loja.');
    } catch (e: any) {
      setErro(e.message);
    }
  }

  function abrirNovoProduto() {
    setForm(FORM_VAZIO);
    setFormAberto(true);
    setErro(null);
  }

  function abrirEdicao(p: ProdutoGestao) {
    setForm({
      id: p.id,
      nome: p.nome,
      preco: p.preco.toFixed(2).replace('.', ','),
      descricao: p.descricao || '',
      imagemUrl: p.imagemUrl || ''
    });
    setFormAberto(true);
    setErro(null);
  }

  async function salvarProduto(e: React.FormEvent) {
    e.preventDefault();
    const preco = Number(form.preco.replace(/\./g, '').replace(',', '.'));
    if (!form.nome.trim()) {
      setErro('Informe o nome do produto.');
      return;
    }
    if (!Number.isFinite(preco) || preco <= 0) {
      setErro('Informe um preço válido (ex.: 19,90).');
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      const corpo = JSON.stringify({
        nome: form.nome,
        preco,
        descricao: form.descricao,
        imagemUrl: form.imagemUrl
      });
      const salvo: ProdutoGestao = form.id
        ? await gestaoFetch(`/api/gestao/produtos/${form.id}`, { method: 'PUT', body: corpo })
        : await gestaoFetch('/api/gestao/produtos', { method: 'POST', body: corpo });
      setProdutos(lista => {
        const existe = lista.some(p => p.id === salvo.id);
        const nova = existe ? lista.map(p => (p.id === salvo.id ? salvo : p)) : [...lista, salvo];
        return nova.sort((a, b) => a.nome.localeCompare(b.nome));
      });
      setFormAberto(false);
      setForm(FORM_VAZIO);
      mostrarAviso(form.id ? 'Produto atualizado!' : 'Produto adicionado ao cardápio!');
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo(p: ProdutoGestao) {
    try {
      const salvo: ProdutoGestao = await gestaoFetch(`/api/gestao/produtos/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ativo: !p.ativo })
      });
      setProdutos(lista => lista.map(item => (item.id === salvo.id ? salvo : item)));
    } catch (e: any) {
      setErro(e.message);
    }
  }

  async function excluirProduto(p: ProdutoGestao) {
    if (!window.confirm(`Excluir "${p.nome}" definitivamente do cardápio?`)) return;
    try {
      await gestaoFetch(`/api/gestao/produtos/${p.id}`, { method: 'DELETE' });
      setProdutos(lista => lista.filter(item => item.id !== p.id));
      mostrarAviso('Produto excluído.');
    } catch (e: any) {
      setErro(e.message);
    }
  }

  async function copiarLink() {
    try {
      await navigator.clipboard.writeText(linkVitrine);
      mostrarAviso('Link copiado! Cole no WhatsApp, Instagram ou gere um QR code.');
    } catch {
      mostrarAviso('Não consegui copiar automaticamente — selecione e copie o link acima.');
    }
  }

  function Miniatura({ url, nome, tamanho }: { url?: string; nome: string; tamanho: number }) {
    const src = urlImagem(url);
    const base: React.CSSProperties = {
      width: tamanho,
      height: tamanho,
      borderRadius: '8px',
      flexShrink: 0,
      objectFit: 'cover',
      border: '1px solid var(--border-thin)'
    };
    if (src) return <img src={src} alt={nome} style={base} />;
    return (
      <div
        style={{
          ...base,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg-secondary)',
          color: 'var(--color-amber)',
          fontWeight: 800,
          fontSize: tamanho * 0.42
        }}
        aria-hidden="true"
      >
        {nome.charAt(0).toUpperCase()}
      </div>
    );
  }

  return createPortal(
    <div className="report-modal-overlay" onClick={onClose}>
      <div className="report-modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="report-modal-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-amber)', marginRight: '0.5rem' }}>
              <path d="M3 9 L4.4 4.5 H19.6 L21 9" />
              <path d="M4.5 9 V19.5 H19.5 V9" />
              <path d="M9.5 19.5 V14 H14.5 V19.5" />
            </svg>
            Vitrine &amp; Produtos — {nomeLoja}
          </h2>
          <button className="report-modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="report-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '70vh', overflowY: 'auto' }}>
          {/* Link público da vitrine */}
          <section>
            <label style={estiloLabel}>Link do cardápio (divulgue aos clientes)</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input readOnly value={linkVitrine} style={{ ...estiloInput, fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }} onFocus={e => e.target.select()} />
              <button style={estiloBotaoPrimario} onClick={copiarLink}>Copiar</button>
              <a href={linkVitrine} target="_blank" rel="noreferrer" style={{ ...estiloBotaoSuave, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                Abrir
              </a>
            </div>
          </section>

          {/* Logomarca */}
          <section>
            <label style={estiloLabel}>Logomarca da loja (aparece no topo da vitrine)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Miniatura url={logoUrl} nome={nomeLoja} tamanho={52} />
              <button style={estiloBotaoSuave} onClick={() => inputLogoRef.current?.click()} disabled={enviandoImagem}>
                {enviandoImagem ? 'Enviando…' : logoUrl ? 'Trocar logo' : 'Enviar logo'}
              </button>
              {logoUrl && (
                <button style={{ ...estiloBotaoSuave, color: 'var(--color-rose)' }} onClick={removerLogo}>
                  Remover
                </button>
              )}
              <input ref={inputLogoRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={aoEscolherLogo} />
            </div>
          </section>

          {/* Produtos */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <label style={{ ...estiloLabel, marginBottom: 0 }}>Produtos do cardápio ({produtos.length})</label>
              {!formAberto && (
                <button style={estiloBotaoPrimario} onClick={abrirNovoProduto}>+ Novo produto</button>
              )}
            </div>

            {formAberto && (
              <form onSubmit={salvarProduto} style={{ border: '1px solid var(--border-thin)', borderRadius: '10px', padding: '0.9rem', marginBottom: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem', background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 220px' }}>
                    <label style={estiloLabel}>Nome *</label>
                    <input style={estiloInput} value={form.nome} maxLength={255} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder="Ex.: Dipirona 500mg (20 comp.)" />
                  </div>
                  <div style={{ flex: '0 1 130px' }}>
                    <label style={estiloLabel}>Preço (R$) *</label>
                    <input style={estiloInput} inputMode="decimal" value={form.preco} onChange={e => setForm(f => ({ ...f, preco: e.target.value.replace(/[^\d.,]/g, '') }))} placeholder="19,90" />
                  </div>
                </div>
                <div>
                  <label style={estiloLabel}>Descrição (aparece no card do produto)</label>
                  <input style={estiloInput} value={form.descricao} maxLength={500} onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))} placeholder="Ex.: Analgésico e antitérmico. Caixa com 20 comprimidos." />
                </div>
                <div>
                  <label style={estiloLabel}>Foto do produto</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <Miniatura url={form.imagemUrl} nome={form.nome || '?'} tamanho={44} />
                    <button type="button" style={estiloBotaoSuave} onClick={() => inputFotoRef.current?.click()} disabled={enviandoImagem}>
                      {enviandoImagem ? 'Enviando…' : form.imagemUrl ? 'Trocar foto' : 'Enviar foto'}
                    </button>
                    {form.imagemUrl && (
                      <button type="button" style={{ ...estiloBotaoSuave, color: 'var(--color-rose)' }} onClick={() => setForm(f => ({ ...f, imagemUrl: '' }))}>
                        Remover
                      </button>
                    )}
                    <input ref={inputFotoRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={aoEscolherFotoProduto} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
                  <button type="button" style={estiloBotaoSuave} onClick={() => { setFormAberto(false); setForm(FORM_VAZIO); }}>
                    Cancelar
                  </button>
                  <button type="submit" style={estiloBotaoPrimario} disabled={salvando || enviandoImagem}>
                    {salvando ? 'Salvando…' : form.id ? 'Salvar alterações' : 'Adicionar produto'}
                  </button>
                </div>
              </form>
            )}

            {carregando ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Carregando catálogo…</p>
            ) : produtos.length === 0 && !formAberto ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                Nenhum produto cadastrado ainda — clique em <strong>+ Novo produto</strong> para montar seu cardápio.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-thin)', borderRadius: '10px', overflow: 'hidden' }}>
                {produtos.map((p, i) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.6rem 0.8rem', borderTop: i === 0 ? 'none' : '1px solid var(--border-thin)', opacity: p.ativo ? 1 : 0.55 }}>
                    <Miniatura url={p.imagemUrl} nome={p.nome} tamanho={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nome}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-amber)', fontWeight: 700 }}>
                        {p.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        {!p.ativo && <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontWeight: 500 }}>oculto da vitrine</span>}
                      </div>
                    </div>
                    <button style={{ ...estiloBotaoSuave, padding: '0.35rem 0.6rem', fontSize: '0.72rem' }} onClick={() => abrirEdicao(p)}>Editar</button>
                    <button style={{ ...estiloBotaoSuave, padding: '0.35rem 0.6rem', fontSize: '0.72rem' }} onClick={() => alternarAtivo(p)}>
                      {p.ativo ? 'Ocultar' : 'Exibir'}
                    </button>
                    <button style={{ ...estiloBotaoSuave, padding: '0.35rem 0.6rem', fontSize: '0.72rem', color: 'var(--color-rose)' }} onClick={() => excluirProduto(p)}>
                      Excluir
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {erro && (
            <p style={{ color: 'var(--color-rose)', fontSize: '0.8rem', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', borderRadius: '8px', padding: '0.6rem 0.8rem', margin: 0 }} role="alert">
              {erro}
            </p>
          )}
          {aviso && (
            <p style={{ color: 'var(--color-emerald)', fontSize: '0.8rem', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '8px', padding: '0.6rem 0.8rem', margin: 0 }} role="status">
              {aviso}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

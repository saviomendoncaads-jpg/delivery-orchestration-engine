// Cliente HTTP centralizado da vitrine.
// Mesmo padrão do App.tsx: VITE_BACKEND_URL vazio = mesma origem (produção,
// backend Express serve o build); não definido = dev local na porta 5000.
const _viteBackend = (import.meta as any).env?.VITE_BACKEND_URL;
export const BACKEND_URL: string = _viteBackend === undefined ? 'http://localhost:5000' : _viteBackend;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function lerErro(res: Response): Promise<never> {
  let mensagem = `Erro ${res.status} ao comunicar com o servidor.`;
  try {
    const corpo = await res.json();
    if (corpo?.error) mensagem = corpo.error;
  } catch {
    /* resposta sem corpo JSON — mantém a mensagem genérica */
  }
  throw new ApiError(res.status, mensagem);
}

export async function apiGet<T>(caminho: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${caminho}`);
  if (!res.ok) await lerErro(res);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(caminho: string, corpo: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  if (!res.ok) await lerErro(res);
  return res.json() as Promise<T>;
}

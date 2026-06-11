// Geocodificação de endereços brasileiros.
// Estratégia: tenta primeiro Nominatim (OpenStreetMap) com a string completa.
// Se houver CEP, faz duas consultas — uma com CEP e outra sem — e fica com o melhor resultado.
//
// Termos de uso do Nominatim exigem User-Agent identificável e máximo de 1 req/s.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'DistreDeliveryOrchestrator/1.0 (contato@distre.com.br)';

// Cache em memória: chave é a query normalizada, valor é {lat, lng} ou null (não encontrado)
const cache = new Map<string, { latitude: number; longitude: number } | null>();

let lastCallAt = 0;
const MIN_INTERVAL_MS = 1100;

function normalizar(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizarCep(cep?: string): string | undefined {
  if (!cep) return undefined;
  const digitos = cep.replace(/\D/g, '');
  if (digitos.length !== 8) return undefined;
  return `${digitos.slice(0, 5)}-${digitos.slice(5)}`;
}

async function aguardarThrottle(): Promise<void> {
  const agora = Date.now();
  const espera = lastCallAt + MIN_INTERVAL_MS - agora;
  if (espera > 0) {
    await new Promise(resolve => setTimeout(resolve, espera));
  }
  lastCallAt = Date.now();
}

export interface EnderecoParaGeocodificar {
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
}

function montarQuery(end: EnderecoParaGeocodificar, incluirCep: boolean): string {
  const logradouroComNumero = end.numero
    ? `${end.endereco || ''} ${end.numero}`.trim()
    : end.endereco;

  const partes = [
    logradouroComNumero,
    end.bairro,
    end.cidade,
    end.uf,
    incluirCep ? normalizarCep(end.cep) : undefined,
    'Brasil'
  ];

  return partes
    .filter(Boolean)
    .map(s => (s as string).trim())
    .filter(s => s.length > 0)
    .join(', ');
}

async function consultarNominatim(query: string, params?: URLSearchParams): Promise<{ latitude: number; longitude: number } | null> {
  const chave = normalizar(params ? `STRUCT|${params.toString()}` : query);
  if (cache.has(chave)) {
    const r = cache.get(chave) ?? null;
    console.log(`[Geocoding] cache: "${query}" → ${r ? `(${r.latitude}, ${r.longitude})` : 'null'}`);
    return r;
  }

  await aguardarThrottle();

  try {
    const base = params
      ? `${NOMINATIM_URL}?${params.toString()}&format=json&limit=1&countrycodes=br&addressdetails=1`
      : `${NOMINATIM_URL}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;
    console.log(`[Geocoding] → Nominatim: ${params ? '[STRUCTURED] ' : ''}"${query}"`);
    const resp = await fetch(base, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5'
      }
    });

    if (!resp.ok) {
      console.warn(`[Geocoding] ✖ HTTP ${resp.status} para "${query}"`);
      cache.set(chave, null);
      return null;
    }

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[Geocoding] ✖ SEM RESULTADOS para "${query}"`);
      cache.set(chave, null);
      return null;
    }

    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn(`[Geocoding] ✖ lat/lng inválido para "${query}"`);
      cache.set(chave, null);
      return null;
    }

    const resultado = { latitude: lat, longitude: lng };
    cache.set(chave, resultado);
    console.log(`[Geocoding] ✔ "${query}" → (${lat}, ${lng})`);
    return resultado;
  } catch (err: any) {
    console.error(`[Geocoding] ✖ Erro em "${query}":`, err.message);
    cache.set(chave, null);
    return null;
  }
}

// Enriquece endereço usando ViaCEP quando há CEP — preenche bairro/cidade/UF se vierem em branco.
async function enriquecerComViaCep(end: EnderecoParaGeocodificar): Promise<EnderecoParaGeocodificar> {
  const cep = normalizarCep(end.cep);
  if (!cep) return end;
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cep.replace('-', '')}/json/`);
    if (!resp.ok) return end;
    const data: any = await resp.json();
    if (data?.erro) return end;
    return {
      ...end,
      endereco: end.endereco || data.logradouro || undefined,
      bairro: end.bairro || data.bairro || undefined,
      cidade: end.cidade || data.localidade || undefined,
      uf: end.uf || data.uf || undefined,
      cep
    };
  } catch (err: any) {
    console.warn(`[Geocoding] ViaCEP falhou para CEP ${cep}: ${err.message}`);
    return end;
  }
}

// Capitaliza nomes próprios — Nominatim costuma errar com strings 100% MAIÚSCULAS.
// Ex.: "RUA SESSENTA E UM" → "Rua Sessenta e Um"
function capitalizar(s?: string): string | undefined {
  if (!s) return undefined;
  const minusculas = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
  return s.toLowerCase().split(/\s+/).map((w, i) => {
    if (i > 0 && minusculas.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function montarStructuredParams(end: EnderecoParaGeocodificar): URLSearchParams | null {
  const params = new URLSearchParams();
  let temAlgo = false;

  const logradouro = capitalizar(end.endereco);
  if (logradouro) {
    const street = end.numero ? `${end.numero} ${logradouro}` : logradouro;
    params.set('street', street);
    temAlgo = true;
  }
  const cidade = capitalizar(end.cidade);
  if (cidade) { params.set('city', cidade); temAlgo = true; }
  if (end.uf) { params.set('state', end.uf.toUpperCase()); }
  const cep = normalizarCep(end.cep);
  if (cep) { params.set('postalcode', cep); temAlgo = true; }
  params.set('country', 'Brasil');

  return temAlgo ? params : null;
}

export async function geocodificarEndereco(
  endIn: EnderecoParaGeocodificar
): Promise<{ latitude: number; longitude: number } | null> {
  // Enriquece com ViaCEP (preenche campos vazios a partir do CEP — gratuito, oficial dos Correios)
  const end = await enriquecerComViaCep(endIn);

  // 0. PRINCIPAL: busca estruturada (street, city, state, postalcode separados).
  // Funciona muito melhor para endereços brasileiros do que a query única, e
  // converte strings em MAIÚSCULAS para Title Case (Nominatim é case-sensitive na prática).
  const structured = montarStructuredParams(end);
  if (structured) {
    const desc = `street=${structured.get('street') || ''} city=${structured.get('city') || ''} cep=${structured.get('postalcode') || ''}`;
    const r = await consultarNominatim(desc, structured);
    if (r) return r;
  }

  // 1. Free-form com CEP (se houver) — algumas vezes acerta onde a estruturada não acha
  if (normalizarCep(end.cep)) {
    const r = await consultarNominatim(montarQuery({ ...end, endereco: capitalizar(end.endereco), cidade: capitalizar(end.cidade) }, true));
    if (r) return r;
  }

  // 2. Free-form sem CEP, capitalizado
  const queryCompleta = montarQuery({ ...end, endereco: capitalizar(end.endereco), cidade: capitalizar(end.cidade) }, false);
  if (queryCompleta && queryCompleta !== 'Brasil') {
    const r = await consultarNominatim(queryCompleta);
    if (r) return r;
  }

  // 3. Fallback de bairro
  if (end.bairro || end.cidade) {
    const queryRegiao = montarQuery({ bairro: capitalizar(end.bairro), cidade: capitalizar(end.cidade), uf: end.uf }, false);
    if (queryRegiao && queryRegiao !== 'Brasil') {
      console.log('[Geocoding] Tentando fallback de bairro/cidade...');
      const r = await consultarNominatim(queryRegiao);
      if (r) return r;
    }
  }

  // 4. Fallback de cidade
  if (end.cidade) {
    const queryCidade = montarQuery({ cidade: capitalizar(end.cidade), uf: end.uf }, false);
    if (queryCidade && queryCidade !== 'Brasil') {
      console.log('[Geocoding] Tentando fallback de cidade...');
      const r = await consultarNominatim(queryCidade);
      if (r) return r;
    }
  }

  return null;
}

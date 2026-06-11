import mssql from '../db';
import { pool } from '../database';
import { getGateway } from './gatewayFactory';
import { appendLedger } from './ledgerService';
import { transicionar } from './SubscriptionStateMachine';
import { revogarSessoesDaLoja, revogarSessoesDaEmpresa } from '../auth';
import { lojas, empresas } from '../tenants';

// Régua de cobrança automatizada (Smart Dunning):
//   D-3  -> gera/garante cobrança (Pix/Boleto) + lembrete
//   D-0  -> alerta de vencimento do dia
//   D+3  -> marca atraso + retentativa de cartão + alerta
//   D+7  -> suspende a empresa e bloqueia o painel (grace period esgotado)
//
// Idempotente por estágio: a coluna FATURAS.PROXIMA_ACAO_DUNNING guarda o último
// estágio aplicado; cada estágio dispara uma única vez e só avança (nunca regride),
// então rodar a régua com frequência ou perder um dia não duplica ações.

type Estagio = 'LEMBRETE_D3' | 'VENCE_HOJE' | 'ATRASO_D3' | 'SUSPENSAO_D7';

const RANK: Record<Estagio, number> = {
  LEMBRETE_D3: 1,
  VENCE_HOJE: 2,
  ATRASO_D3: 3,
  SUSPENSAO_D7: 4,
};

let executando = false;

/** Calcula o estágio-alvo da régua a partir dos dias até o vencimento. */
function estagioAlvo(diasAteVenc: number): Estagio | null {
  if (diasAteVenc >= 1 && diasAteVenc <= 3) return 'LEMBRETE_D3';
  if (diasAteVenc <= 0 && diasAteVenc > -3) return 'VENCE_HOJE';
  if (diasAteVenc <= -3 && diasAteVenc > -7) return 'ATRASO_D3';
  if (diasAteVenc <= -7) return 'SUSPENSAO_D7';
  return null; // ainda faltam mais de 3 dias: nada a fazer
}

function diasAteVencimento(dataVencimento: string): number {
  const venc = new Date(dataVencimento);
  venc.setHours(0, 0, 0, 0);
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.round((venc.getTime() - hoje.getTime()) / 86_400_000);
}

/** Executa a régua sobre todas as faturas em aberto. Seguro contra reentrância. */
export async function executarReguaCobranca(): Promise<void> {
  if (!pool || executando) return;
  executando = true;
  try {
    const faturasRes = await pool.request()
      .query("SELECT * FROM FATURAS WHERE STATUS IN ('PENDENTE', 'ATRASADA')");

    for (const fat of faturasRes.recordset) {
      try {
        const dias = diasAteVencimento(fat.DATA_VENCIMENTO);
        const alvo = estagioAlvo(dias);
        if (!alvo) continue;

        const aplicadoRank = RANK[(fat.PROXIMA_ACAO_DUNNING as Estagio)] ?? 0;
        if (RANK[alvo] <= aplicadoRank) continue; // estágio já aplicado (ou mais avançado)

        await aplicarEstagio(alvo, fat);

        await pool.request()
          .input('id', mssql.VarChar, fat.ID)
          .input('e', mssql.VarChar, alvo)
          .query('UPDATE FATURAS SET PROXIMA_ACAO_DUNNING = @e WHERE ID = @id');
      } catch (err: any) {
        console.error(`[Dunning] Falha ao processar fatura ${fat.ID}:`, err?.message);
      }
    }
  } finally {
    executando = false;
  }
}

async function aplicarEstagio(estagio: Estagio, fat: any): Promise<void> {
  switch (estagio) {
    case 'LEMBRETE_D3':
      await garantirCobrancaGerada(fat);
      notificar(fat, 'LEMBRETE_D3');
      break;

    case 'VENCE_HOJE':
      notificar(fat, 'VENCE_HOJE');
      break;

    case 'ATRASO_D3':
      if (fat.STATUS === 'PENDENTE') {
        await pool.request()
          .input('id', mssql.VarChar, fat.ID)
          .query("UPDATE FATURAS SET STATUS = 'ATRASADA' WHERE ID = @id AND STATUS = 'PENDENTE'");
      }
      if (fat.METODO_PAGAMENTO === 'CARTAO' && fat.GATEWAY_FATURA_ID) {
        try {
          await getGateway().reprocessarCartao(fat.GATEWAY_FATURA_ID);
          console.log(`[Dunning] Retentativa de cartão disparada p/ fatura ${fat.ID}.`);
        } catch (e: any) {
          console.warn(`[Dunning] Retentativa de cartão falhou p/ ${fat.ID}:`, e?.message);
        }
      }
      await appendLedger({
        empresaId: fat.EMPRESA_ID,
        assinaturaId: fat.ASSINATURAS_EMPRESAS_ID ?? undefined,
        faturaId: fat.ID,
        tipo: 'MARCA_ATRASO',
        valor: 0,
        origem: 'DUNNING',
        metadados: { estagio },
        criadoPor: 'SYSTEM',
      });
      // Reflete o atraso na assinatura (ATIVA -> ATRASADA) para habilitar a suspensão em D+7.
      if (fat.ASSINATURAS_EMPRESAS_ID) {
        await transicionar(fat.ASSINATURAS_EMPRESAS_ID, 'payment.overdue');
      }
      notificar(fat, 'ATRASO_D3');
      break;

    case 'SUSPENSAO_D7': {
      // Via state machine quando há assinatura (deriva status da loja + revoga sessões da loja).
      // Fallback para faturas avulsas sem assinatura: suspende a loja (ou a empresa, se legado).
      let suspensoViaSM = false;
      if (fat.ASSINATURAS_EMPRESAS_ID) {
        const r = await transicionar(fat.ASSINATURAS_EMPRESAS_ID, 'SUSPENDER');
        suspensoViaSM = r.ok;
      }
      if (!suspensoViaSM) {
        if (fat.LOJA_ID) await suspenderLoja(fat.LOJA_ID, fat.EMPRESA_ID);
        else await suspenderEmpresa(fat.EMPRESA_ID, fat.ASSINATURAS_EMPRESAS_ID);
      }
      notificar(fat, 'SUSPENSAO_D7');
      break;
    }
  }
}

/** Gera a cobrança no gateway se a fatura ainda não tiver uma. */
async function garantirCobrancaGerada(fat: any): Promise<void> {
  if (fat.GATEWAY_FATURA_ID) return; // já gerada
  const gateway = getGateway();
  const cobranca = await gateway.criarCobranca({
    empresaId: fat.EMPRESA_ID,
    faturaId: fat.ID,
    valor: Number(fat.VALOR_BRUTO) - Number(fat.VALOR_DESCONTO),
    vencimento: fat.DATA_VENCIMENTO,
    metodo: (fat.METODO_PAGAMENTO as 'PIX' | 'BOLETO' | 'CARTAO') || 'PIX',
    descricao: `Mensalidade ${fat.REFERENCIA_MES_ANO}`,
  });
  await pool.request()
    .input('id', mssql.VarChar, fat.ID)
    .input('boleto', mssql.NVarChar, cobranca.boletoUrl ?? null)
    .input('pix', mssql.NVarChar, cobranca.pixCopiaCola ?? null)
    .input('gw', mssql.VarChar, cobranca.gatewayFaturaId)
    .query('UPDATE FATURAS SET BOLETO_URL = @boleto, PIX_COPIA_COLA = @pix, GATEWAY_FATURA_ID = @gw WHERE ID = @id');
  console.log(`[Dunning] Cobrança gerada p/ fatura ${fat.ID} (${cobranca.gatewayFaturaId}).`);
}

/** Suspende a LOJA (grace period esgotado): bloqueia painel da loja + revoga suas sessões. */
async function suspenderLoja(lojaId: string, empresaId: string): Promise<void> {
  const loja = lojas.find((l) => l.id === lojaId);
  if (!loja || loja.statusFinanceiro === 'SUSPENSO' || loja.statusFinanceiro === 'CANCELADO') return;

  await pool.request()
    .input('id', mssql.VarChar, lojaId)
    .input('s', mssql.VarChar, 'SUSPENSO')
    .query('UPDATE LOJAS SET STATUS_FINANCEIRO = @s WHERE ID = @id');
  loja.statusFinanceiro = 'SUSPENSO';

  await revogarSessoesDaLoja(lojaId);

  await appendLedger({
    empresaId,
    tipo: 'SUSPENSAO',
    valor: 0,
    origem: 'DUNNING',
    metadados: { motivo: 'grace period D+7 esgotado', lojaId },
    criadoPor: 'SYSTEM',
  });

  console.log(`[Dunning] Loja ${loja.nome} SUSPENSA por inadimplência (D+7).`);
}

/** Suspende a empresa (legado, assinatura sem LOJA_ID): bloqueia painel + revoga sessões. */
async function suspenderEmpresa(empresaId: string, assinaturaId?: string): Promise<void> {
  const emp = empresas.find((e) => e.id === empresaId);
  // Idempotente: não re-suspende quem já está SUSPENSO/CANCELADO.
  if (!emp || emp.statusFinanceiro === 'SUSPENSO' || emp.statusFinanceiro === 'CANCELADO') return;

  await pool.request()
    .input('id', mssql.VarChar, empresaId)
    .input('s', mssql.VarChar, 'SUSPENSO')
    .query('UPDATE EMPRESAS SET STATUS_FINANCEIRO = @s WHERE ID = @id');
  emp.statusFinanceiro = 'SUSPENSO';

  if (assinaturaId) {
    await pool.request()
      .input('id', mssql.VarChar, assinaturaId)
      .input('em', mssql.VarChar, new Date().toISOString())
      .query('UPDATE ASSINATURAS_EMPRESAS SET SUSPENSA_EM = @em WHERE ID = @id');
  }

  // Revoga sessões ativas das lojas vinculadas (Map + banco).
  await revogarSessoesDaEmpresa(empresaId);

  await appendLedger({
    empresaId,
    assinaturaId,
    tipo: 'SUSPENSAO',
    valor: 0,
    origem: 'DUNNING',
    metadados: { motivo: 'grace period D+7 esgotado' },
    criadoPor: 'SYSTEM',
  });

  console.log(`[Dunning] Empresa ${emp.nome} SUSPENSA por inadimplência (D+7).`);
}

/**
 * Ponto de integração de notificações (e-mail/WhatsApp). Hoje apenas registra;
 * conectar ao whatsapp.ts / serviço de e-mail é um passo futuro de baixo risco.
 */
function notificar(fat: any, tipo: Estagio): void {
  console.log(`[Dunning][Notificação:${tipo}] Empresa ${fat.EMPRESA_ID} | Fatura ${fat.ID} | Ref ${fat.REFERENCIA_MES_ANO}`);
}

/** Inicia a régua: execução imediata + varredura periódica (idempotente). */
export function iniciarDunning(): void {
  executarReguaCobranca().catch((e) => console.error('[Dunning] Erro na execução inicial:', e));
  setInterval(() => {
    executarReguaCobranca().catch((e) => console.error('[Dunning] Erro na régua:', e));
  }, 60 * 60 * 1000); // a cada 1 hora
  console.log('[Dunning] Régua de cobrança iniciada (intervalo 1h).');
}

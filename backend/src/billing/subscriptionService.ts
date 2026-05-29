import crypto from 'crypto';
import mssql from 'mssql/msnodesqlv8';
import { pool } from '../database';
import { getGateway } from './gatewayFactory';
import { appendLedger } from './ledgerService';

// Criação de assinatura POR LOJA + primeira fatura. Usado pelo cadastro de loja
// (tenants.ts). Mantém a regra de billing no módulo billing — tenants não toca
// em pool/mssql/gateway diretamente.

export async function criarAssinaturaComPrimeiraFatura(opts: {
  empresaId: string;
  lojaId: string;
  planoId: string;
  diaVencimento?: number;
}): Promise<{ assinaturaId: string; faturaId: string; valor: number; planoNome: string }> {
  if (!pool) throw new Error('Banco indisponível');

  // Valida o plano (precisa existir e estar ativo).
  const planoRes = await pool.request()
    .input('id', mssql.VarChar, opts.planoId)
    .query('SELECT * FROM PLANOS WHERE ID = @id AND ATIVO = 1');
  if (planoRes.recordset.length === 0) {
    throw new Error('Plano inválido ou inativo');
  }
  const plano = planoRes.recordset[0];
  const valor = Number(plano.VALOR_MENSAL);
  const dia = opts.diaVencimento && opts.diaVencimento >= 1 && opts.diaVencimento <= 28 ? opts.diaVencimento : 10;

  const agora = new Date();
  const agoraIso = agora.toISOString();

  // Assinatura ATIVA da loja.
  const assinaturaId = `sub-${crypto.randomUUID().substring(0, 8)}`;
  const proximoFat = new Date(agora.getFullYear(), agora.getMonth() + 1, dia).toISOString();
  await pool.request()
    .input('id', mssql.VarChar, assinaturaId)
    .input('empId', mssql.VarChar, opts.empresaId)
    .input('lojaId', mssql.VarChar, opts.lojaId)
    .input('planoId', mssql.VarChar, opts.planoId)
    .input('dia', mssql.Int, dia)
    .input('criado', mssql.VarChar, agoraIso)
    .input('proximo', mssql.VarChar, proximoFat)
    .query(`INSERT INTO ASSINATURAS_EMPRESAS (ID, EMPRESA_ID, LOJA_ID, PLANO_ID, STATUS, DIA_VENCIMENTO, CRIADO_EM, PROXIMO_FATURAMENTO)
            VALUES (@id, @empId, @lojaId, @planoId, 'ATIVA', @dia, @criado, @proximo)`);

  // Primeira fatura PENDENTE: vence no dia escolhido (deste mês se ainda não passou; senão, do próximo).
  const venc = new Date(agora.getFullYear(), agora.getMonth(), dia);
  if (venc < agora) venc.setMonth(venc.getMonth() + 1);
  const vencIso = venc.toISOString();
  const refMesAno = `${String(venc.getMonth() + 1).padStart(2, '0')}/${venc.getFullYear()}`;
  const faturaId = `fat-${crypto.randomUUID().substring(0, 8)}`;

  const gateway = getGateway();
  const cobranca = await gateway.criarCobranca({
    empresaId: opts.empresaId,
    faturaId,
    valor,
    vencimento: vencIso,
    metodo: 'PIX',
    descricao: `Mensalidade ${plano.NOME} ${refMesAno}`,
  });

  await pool.request()
    .input('id', mssql.VarChar, faturaId)
    .input('empId', mssql.VarChar, opts.empresaId)
    .input('lojaId', mssql.VarChar, opts.lojaId)
    .input('subId', mssql.VarChar, assinaturaId)
    .input('valor', mssql.Decimal(10, 2), valor)
    .input('emissao', mssql.VarChar, agoraIso)
    .input('venc', mssql.VarChar, vencIso)
    .input('ref', mssql.VarChar, refMesAno)
    .input('boleto', mssql.NVarChar, cobranca.boletoUrl ?? null)
    .input('pix', mssql.NVarChar, cobranca.pixCopiaCola ?? null)
    .input('gw', mssql.VarChar, cobranca.gatewayFaturaId)
    .input('criado', mssql.VarChar, agoraIso)
    .query(`INSERT INTO FATURAS
              (ID, EMPRESA_ID, LOJA_ID, ASSINATURAS_EMPRESAS_ID, VALOR_BRUTO, VALOR_DESCONTO, STATUS, DATA_EMISSAO, DATA_VENCIMENTO, REFERENCIA_MES_ANO, BOLETO_URL, PIX_COPIA_COLA, GATEWAY_FATURA_ID, CRIADO_EM)
            VALUES (@id, @empId, @lojaId, @subId, @valor, 0.00, 'PENDENTE', @emissao, @venc, @ref, @boleto, @pix, @gw, @criado)`);

  // Trilha de auditoria: abertura da assinatura/fatura da loja.
  await appendLedger({
    empresaId: opts.empresaId,
    assinaturaId,
    faturaId,
    tipo: 'ABERTURA',
    valor,
    origem: 'MANUAL_ADMIN',
    metadados: { evento: 'cadastro_loja', lojaId: opts.lojaId, planoId: opts.planoId },
    criadoPor: 'ADMIN',
  });

  return { assinaturaId, faturaId, valor, planoNome: plano.NOME };
}

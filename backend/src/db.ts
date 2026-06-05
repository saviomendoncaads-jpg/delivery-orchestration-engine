import type * as Mssql from 'mssql';

/**
 * Driver do SQL Server selecionável por variável de ambiente, para o MESMO código
 * rodar no dev local (Windows) e em produção (Azure SQL / Linux / container):
 *
 *   DB_DRIVER=tedious  → driver puro JS (mssql/tedious). Necessário p/ Azure SQL,
 *                        Linux e containers. Exige SQL Authentication + encrypt.
 *   (vazio/qualquer)   → msnodesqlv8 (binding nativo Windows) com Autenticação
 *                        Integrada do Windows. Default do dev local.
 *
 * O `require` é condicional de propósito: assim o binding nativo do msnodesqlv8
 * NÃO é carregado em Linux (onde ele não existe) quando DB_DRIVER=tedious.
 * Todos os módulos de dados importam o mssql daqui, nunca de 'mssql/msnodesqlv8'.
 */
const usarTedious = (process.env.DB_DRIVER || '').toLowerCase() === 'tedious';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mssql = (usarTedious ? require('mssql') : require('mssql/msnodesqlv8')) as typeof import('mssql');

export default mssql;

// Tipos para anotações: `mssql.X` em posição de TIPO não funciona via default import,
// então re-exportamos os tipos usados nas assinaturas dos serviços de dados.
export type ConnectionPool = Mssql.ConnectionPool;
export type Transaction = Mssql.Transaction;
export type Request = Mssql.Request;
export type config = Mssql.config;

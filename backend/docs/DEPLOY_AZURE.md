# Deploy na Azure (com banco SQL grátis)

> Guia prático para subir o Distre na Azure usando o **Azure SQL Database (oferta gratuita)**,
> mantendo o custo o mais baixo possível. Inclui o que é realmente grátis e onde há pegadinha.

---

## 0. O que é grátis e o que não é (leia primeiro)

| Componente | Opção grátis | Pegadinha |
|---|---|---|
| **Banco** (Azure SQL Database) | ✅ Oferta gratuita: serverless, ~100 mil vCore-seg/mês + 32 GB. 1 por assinatura. | Auto-pausa ao atingir o limite; "acorda" na 1ª query (pequena latência). Ótimo p/ início. |
| **Frontend** (build Vite estático) | ✅ Azure Static Web Apps (plano Free) | Praticamente sem pegadinha — é só arquivo estático. |
| **Backend** (Node, API + WebSocket + workers) | ⚠️ App Service **F1 (grátis)** existe, mas **dorme** após ~20 min e tem cota de CPU/dia | Esse backend é always-on (tempo real + régua de cobrança). No F1 ele dorme e quebra. Para **produção 24/7** o realista é um tier pago pequeno (~US$13/mês B1) **ou** rodar o backend numa máquina que você já tenha (só o banco fica na Azure grátis). |

**Resumo:** banco e frontend dá pra ter de graça. O backend always-on de verdade não tem almoço grátis na Azure — mas dá pra começar no F1 (demo) e migrar pro B1 quando tiver cliente.

---

## 1. Criar o Azure SQL Database grátis

1. Portal Azure → **Create a resource** → **SQL Database**.
2. **Resource group**: crie um (ex.: `distre-rg`).
3. **Database name**: `distre`.
4. **Server**: **Create new** → nome único (ex.: `distre-sql-sp`), região (ex.: Brazil South), **Authentication = SQL authentication**, defina **admin login** (ex.: `distreadmin`) e uma **senha forte**. Guarde.
5. **Compute + storage** → **Configure** → escolha **Serverless** e procure a opção **"Apply free offer" / "Use free Azure SQL Database"** (até esgotar o grátis). Confirme.
6. Crie. Anote o servidor: `distre-sql-sp.database.windows.net`.

### Firewall
Server SQL → **Networking** → **Public access** → adicione:
- **"Allow Azure services and resources to access this server"** = Yes (se o backend rodar na Azure), **e/ou**
- O **IP público** da máquina/serviço onde o backend roda (regra de firewall).

> O **schema é criado sozinho** no primeiro boot do backend (`inicializarBanco()` cria todas as tabelas, incluindo `SESSOES`, `LEDGER_FINANCEIRO`, etc.). Não precisa rodar SQL manual.

---

## 2. Variáveis de ambiente do backend (produção)

```env
NODE_ENV=production
PORT=8080                      # App Service injeta a porta; respeite process.env.PORT

# Banco — Azure SQL exige driver tedious + SQL auth + encrypt
DB_DRIVER=tedious
DB_SERVER=distre-sql-sp.database.windows.net
DB_DATABASE=distre
DB_PORT=1433
DB_USER=distreadmin
DB_PASSWORD=********
DB_ENCRYPT=true
DB_TRUST_SERVER_CERT=false

# Segurança
ADMIN_USUARIO=admin
ADMIN_SENHA=********           # OBRIGATÓRIO definir em produção
CORS_ORIGINS=https://SEU-FRONTEND.azurestaticapps.net

# Pagamento (quando for cobrar de verdade)
PAYMENT_GATEWAY=ASAAS
ASAAS_API_KEY=********
ASAAS_ENV=production
ASAAS_WEBHOOK_TOKEN=********

# Escala (opcional, multi-instância)
TRUST_PROXY=1
# REDIS_URL=...
# RUN_BACKGROUND_JOBS=true      # em multi-instância, true só no worker
```

---

## 3. Subir o backend

### Opção A — App Service Linux (F1 grátis p/ testar, B1 ~US$13/mês p/ produção)
1. Crie um **App Service** (Linux, runtime **Node 20**).
2. Em **Configuration → Application settings**, cole as variáveis da seção 2.
3. Deploy: via GitHub Actions (App Service gera o workflow), ou `az webapp up`, ou ZIP deploy.
   - Build: `npm install && npm run build` no `backend/`; start: `node dist/index.js`.
4. F1 dorme — para produção real mude o plano para **B1** (Always On).

> O driver `tedious` é puro JS: **não** precisa de ODBC nem de build nativo no Linux. Por isso `DB_DRIVER=tedious`.

### Opção B — manter o backend numa máquina sua (custo zero na Azure)
Só o banco fica na Azure (grátis). O backend roda onde você já tem (um PC sempre ligado, mini-servidor). Mesmo `.env` da seção 2; garanta que o IP da máquina está liberado no firewall do SQL.

---

## 4. Subir o frontend (Azure Static Web Apps — grátis)

1. Build apontando para a API:
   ```bash
   cd frontend
   echo "VITE_BACKEND_URL=https://SEU-BACKEND.azurewebsites.net" > .env
   npm install && npm run build      # gera frontend/dist
   ```
2. Crie um **Static Web App** (plano Free), conecte ao repositório (app location `frontend`, output `dist`) ou faça upload do `dist`.
3. Anote a URL (`https://SEU-FRONTEND.azurestaticapps.net`) e coloque-a em `CORS_ORIGINS` do backend.
4. A **landing** (`site/index.html`) também pode ir num Static Web App; aponte para a API com `?api=https://SEU-BACKEND...` ou edite o `BACKEND_URL` nela.

---

## 5. Asaas em produção (quando for cobrar)

1. Conta Asaas produção → pegue a **API key** → `ASAAS_API_KEY` + `ASAAS_ENV=production`.
2. Webhooks → crie apontando para `https://SEU-BACKEND.../api/billing/webhooks/pagamento`, defina o **token de autenticação** = `ASAAS_WEBHOOK_TOKEN`.
3. Teste primeiro no **sandbox** (`ASAAS_ENV=sandbox`) com um cadastro de teste no `/signup` antes de ligar produção.

---

## 6. Checklist final

- [ ] Azure SQL grátis criado + firewall liberado p/ o backend.
- [ ] Backend com `DB_DRIVER=tedious` + credenciais + `ADMIN_SENHA` + `CORS_ORIGINS`.
- [ ] 1º boot criou as tabelas (ver log `Conectado ao SQL Server`).
- [ ] Frontend buildado com `VITE_BACKEND_URL` correto e publicado.
- [ ] (Quando cobrar) Asaas produção + webhook + token.
- [ ] Login admin testado em produção; um `/signup` de teste no sandbox.
- [ ] Decisão de compute: F1 (demo, dorme) vs B1 (produção 24/7) vs máquina própria.

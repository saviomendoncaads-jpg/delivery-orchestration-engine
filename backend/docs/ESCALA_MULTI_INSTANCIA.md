# Escala Horizontal (Multi-instância) — Estado e Roadmap

> Como rodar o Distre em 2+ réplicas atrás de um load balancer sem perder eventos,
> duplicar cobranças ou servir estado inconsistente.

---

## 1. O problema central

Hoje o backend mantém o **estado autoritativo em memória de processo**:

- `deliveries` (Map) e `drivers` (array) em [`gateway.ts`](../src/gateway.ts) são carregados do banco no boot, **mutados em memória** e persistidos no SQL Server.
- Os agentes (`dispatcher`, `monitor`, `integrator`) e o broker de eventos operam sobre esse estado em memória.
- O broadcast periódico (1s) em [`index.ts`](../src/index.ts) envia o **snapshot completo** do estado da instância.

Com 2 réplicas (A e B) atrás de um LB, uma entrega criada via REST na instância A muta o `deliveries` de A e grava no banco — mas o `deliveries` de B **não enxerga** a mudança até B reiniciar. As réplicas divergem. Esse é o bloqueador real de multi-instância — **não** é o socket.io em si.

---

## 2. O que já está pronto (fundação — nesta branch)

| Item | Onde | Efeito |
|---|---|---|
| **Sessões duráveis** | tabela `SESSOES` + `auth.ts` | Login sobrevive a restart/deploy e é compartilhável entre réplicas (lido do banco). |
| **Adapter Redis (gated)** | `REDIS_URL` em `index.ts` | `io.emit`/eventos do socket.io propagam entre réplicas via pub/sub. Sem `REDIS_URL` = single-instance. |
| **`trust proxy` (gated)** | `TRUST_PROXY` em `index.ts` | IP real do cliente atrás de LB (rate-limit correto). |
| **Workers singleton (gated)** | `RUN_BACKGROUND_JOBS` em `index.ts` | Webhook worker + dunning rodam em **uma** instância (evita baixa/cobrança duplicada). |
| **Broadcast por-instância** | `io.local` em `index.ts` | O snapshot de 1s vai só aos clientes locais — réplicas não sobrescrevem o snapshot umas das outras. |

> Tudo acima é **backward-compatible**: sem as env vars, o comportamento é idêntico ao de instância única.

---

## 3. O que falta (o refactor de estado — precisa de ambiente rodando)

O passo que falta é **tirar o estado autoritativo da memória de processo**. Duas abordagens:

### Opção A — Banco como fonte da verdade (mais simples, recomendado p/ começar)
- As rotas de mutação/leitura de entregas passam a ler/escrever direto no SQL Server (já é o store), removendo o cache `deliveries`/`drivers` em memória como "verdade".
- O snapshot de 1s vira **consulta ao banco** (ou alimentado por cache curto invalidado por evento).
- Custo: mais carga no banco; mitigável com índices + um cache Redis de leitura com TTL curto.

### Opção B — Redis como cache compartilhado + pub/sub de invalidação
- `deliveries`/`drivers` viram entradas no Redis; mutações publicam um evento de invalidação que todas as réplicas consomem (o adapter já dá o canal pub/sub).
- Mais performático, mais complexo (consistência de cache).

### Coordenação dos agentes (crítico)
- `dispatcher`/`monitor`/`integrator` e os `setInterval` de varredura **não podem** rodar em todas as réplicas (processamento duplicado, corrida de despacho).
- Curto prazo: rode-os só na instância worker (`RUN_BACKGROUND_JOBS=true`) — já habilitado para webhook/dunning; estender o mesmo gate aos agentes e ao broadcast de 1s.
- Médio prazo: **leader election** via lock no SQL Server (`sp_getapplock`) ou Redis (`SET NX PX`), para failover automático do "líder".

---

## 4. Topologia recomendada (alvo)

```
            ┌─────────────┐
   Internet │ Load Balancer│  (sticky sessions p/ WebSocket: ip_hash / cookie)
            └──────┬──────┘
        ┌──────────┼──────────┐
        ▼          ▼          ▼
     web-1       web-2     worker-1
  (HTTP+WS)   (HTTP+WS)   RUN_BACKGROUND_JOBS=true
  RUN_BG=false RUN_BG=false  (agentes, dunning, webhook worker, broadcast)
        └──────────┴───── Redis (socket.io adapter + cache) ─────┘
                          SQL Server (fonte da verdade)
```

Passos de migração (cada um deployável isolado):
1. **Já feito:** sessões duráveis, adapter Redis gated, trust proxy, gate de workers, `io.local`.
2. Provisionar Redis; setar `REDIS_URL` em todas as réplicas e `TRUST_PROXY` atrás do LB.
3. Configurar **sticky sessions** no LB para o handshake WebSocket.
4. Estender `RUN_BACKGROUND_JOBS=false` para também pausar agentes + broadcast nas instâncias web; manter `true` só no worker.
5. Refatorar leitura/escrita de entregas para a fonte compartilhada (Opção A ou B).
6. (Opcional) Leader election para HA do worker.

---

## 5. Checklist de produção (multi-instância)

- [ ] `REDIS_URL` definido em todas as réplicas.
- [ ] `TRUST_PROXY` definido (valor = nº de proxies).
- [ ] `RUN_BACKGROUND_JOBS=true` em exatamente **uma** instância.
- [ ] Sticky sessions habilitado no LB para WebSocket.
- [ ] Estado de entregas migrado para fonte compartilhada (passo 5) — **pré-requisito para web-2 servir dados corretos**.
- [ ] `CORS_ORIGINS` com os domínios reais.
- [ ] SQL Server externalizado por env (hoje fixo em `database.ts`).

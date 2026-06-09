# Vitrine Pública — Painel do Cliente (cardápio + checkout)

Interface onde o **cliente final** monta o pedido. Servida em `/loja/<lojaId>`
(mesma SPA React do painel; o `main.tsx` roteia pelo pathname e o cliente baixa
apenas o chunk da vitrine). Os pedidos entram no Distre pela API abaixo e caem
como **comanda RECEBIDO** no painel da loja (Kanban de Comandas / despacho).

## Por que não usar `/api/integracao/pedidos` aqui?

A rota de integração ERP exige `X-Api-Key` (a `chaveAcesso` da loja). Embutir
essa chave num site público vazaria a credencial no navegador. A vitrine usa
rotas **sem credencial**, com proteções próprias:

- **Preço nunca vem do cliente**: o payload referencia produtos por `produtoId`
  e o backend recalcula subtotal/total com o preço do banco (`PRODUTOS`).
- Produto inexistente/inativo no catálogo da loja → `400` (derruba o pedido).
- Rate limit próprio (60 req/min/IP) em `/api/vitrine`.
- Limites anti-abuso: máx. 50 itens distintos, quantidade 1–99, campos de texto
  truncados no servidor.
- Loja `SUSPENSO`/`CANCELADO` (billing) não exibe cardápio nem aceita pedido.
- Teto mensal de entregas do plano (mesmo enforcement das demais vias).

Código: `backend/src/vitrine.ts` (montado em `backend/src/index.ts`).

## `GET /api/vitrine/:lojaId`

Dados públicos da loja + produtos ativos (inclui produtos globais, `LOJA_ID NULL`).

```json
{
  "loja": {
    "id": "loja-10",
    "nome": "Pizzaria Forno Real",
    "bairro": "Centro",
    "cidade": "Abreu e Lima",
    "uf": "PE",
    "aceitandoPedidos": true
  },
  "produtos": [
    {
      "id": "prod-1",
      "nome": "Pizza Margherita",
      "descricao": "Molho de tomate italiano, mussarela fresca e manjericão.",
      "preco": 42.9,
      "imagemUrl": "https://…"
    }
  ]
}
```

## `POST /api/vitrine/:lojaId/pedidos`

Payload enviado pelo checkout (repare: **sem preços**):

```json
{
  "cliente": {
    "nome": "Maria Souza",
    "telefone": "(81) 98888-7777"
  },
  "itens": [
    { "produtoId": "prod-1", "quantidade": 2, "observacao": "borda recheada" },
    { "produtoId": "prod-4", "quantidade": 1 }
  ],
  "endereco": {
    "cep": "53520-070",
    "logradouro": "Rua do Chumbo",
    "numero": "142",
    "bairro": "Timbó",
    "cidade": "Abreu e Lima",
    "uf": "PE",
    "complemento": "Casa B",
    "referencia": "Portão azul, em frente à praça"
  },
  "pagamento": { "forma": "dinheiro", "troco": 150 },
  "observacao": "Sem cebola na calabresa, por favor"
}
```

Regras:

- Obrigatórios: `cliente.nome`, `endereco.logradouro`, `itens[]` (não vazio),
  `pagamento.forma` ∈ `pix | cartao | dinheiro`.
- `troco` só faz sentido com `dinheiro` e deve ser ≥ total (validado no servidor).
- `cartao` é normalizado para `maquininha` na comanda; telefone, troco e
  observações entram no campo `referencia` da comanda.
- O endereço é geocodificado (Nominatim) para o pino real no mapa do despacho.
- `tipoComanda` segue `loja.recebePedidos`: `true` → `pedido` (Kanban, sem
  despacho automático); `false` → `entrega` (publica `entrega.recebida` no broker).

Resposta `201`:

```json
{
  "success": true,
  "pedidoId": "CMD-1234",
  "status": "RECEBIDO",
  "total": 96.8,
  "subtotal": 96.8,
  "taxaEntrega": 0,
  "itens": [
    { "produtoId": "prod-1", "nome": "Pizza Margherita", "quantidade": 2, "precoUnitario": 42.9 }
  ]
}
```

Teste rápido com o servidor local de pé:

```bash
curl -s http://localhost:5000/api/vitrine/loja-10
curl -s -X POST http://localhost:5000/api/vitrine/loja-10/pedidos \
  -H "Content-Type: application/json" \
  -d '{"cliente":{"nome":"Teste"},"itens":[{"produtoId":"prod-1","quantidade":1}],"endereco":{"logradouro":"Rua A","numero":"1","bairro":"Centro","cidade":"Abreu e Lima","uf":"PE"},"pagamento":{"forma":"pix"}}'
```

## Frontend (`frontend/src/cliente/`)

```
cliente/
├── PainelCliente.tsx        # raiz: carrega cardápio e roteia catálogo/checkout/confirmação
├── cliente.css              # design "bistrô noir" (base escura Distre + acento âmbar)
├── types.ts                 # contratos espelhando vitrine.ts + formatarPreco
├── context/
│   └── CarrinhoContext.tsx  # Context API + useReducer; persiste em localStorage POR loja
├── services/
│   ├── api.ts               # fetch centralizado (VITE_BACKEND_URL, mesmo padrão do App)
│   ├── pedidoService.ts     # buscarCardapio, montarPayload, criarPedido
│   └── cep.ts               # autofill via ViaCEP + máscara de CEP
└── components/
    ├── CatalogoProdutos.tsx # grid de cards (foto/descrição/preço, stepper de qtd)
    ├── CarrinhoDrawer.tsx   # sacola (drawer desktop / bottom-sheet mobile)
    ├── CheckoutForm.tsx     # endereço + pagamento + observações
    └── PedidoConfirmado.tsx # confirmação com nº do pedido
```

A taxa de entrega é v1 = 0 ("combinada com a loja" na UI); o campo `taxaEntrega`
já existe na resposta para quando houver frete por loja.

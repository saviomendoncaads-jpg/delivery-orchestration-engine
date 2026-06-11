# Gestor Distre — App Desktop da Loja (POC)

App desktop (Electron) que roda na máquina da loja, recebe os pedidos em tempo real
do backend e **imprime a comanda 80mm de forma silenciosa** (sem diálogo) — o mesmo
modelo do "Gestor de Pedidos" do iFood.

Por que desktop e não navegador: só uma camada nativa consegue imprimir silenciosamente
numa impressora específica. O navegador, por segurança, sempre abre o diálogo.

## Como rodar (dev)

Pré-requisito: backend rodando (ex.: `http://localhost:5000`) e uma loja cadastrada.

```bash
cd gestor-desktop
npm install        # baixa o Electron (~alguns MB)
npm start
```

1. Em **Conexão da Loja**, informe a URL do backend, usuário e senha da loja → **Conectar**.
2. Em **Impressora 80mm**, selecione sua impressora térmica → **Imprimir comanda de teste**
   (valida a impressão silenciosa). A escolha fica salva.
3. Quando um pedido novo entra na fila, a comanda **sai sozinha** na impressora.

## Como funciona

- **Conexão:** faz login (`POST /api/auth/login`) e abre um Socket.io com o token; escuta
  `initial_state` / `system_status` e detecta pedidos novos (`tipoComanda='pedido'`, `RECEBIDO`).
- **Impressão silenciosa:** renderiza a comanda 80mm num `BrowserWindow` oculto e usa
  `webContents.print({ silent: true, deviceName })` — imprime direto pelo driver da impressora,
  sem diálogo e sem precisar da flag `--kiosk-printing`.
- **Anti-duplicação:** ignora o backlog na 1ª sincronização e nunca reimprime a mesma comanda.

## Empacotar para .exe (distribuir às lojas)

```bash
npm run dist       # gera instalador NSIS em dist/ (Windows)
```

## Evolução para ESC/POS cru (opcional)

A função `imprimirComanda` em `main.js` é o único ponto de impressão. Para enviar
**ESC/POS** direto (USB/serial/IP) — útil para corte de papel, gaveta, QR nativo —
trocar `webContents.print` por [`node-thermal-printer`](https://www.npmjs.com/package/node-thermal-printer)
apontando para a impressora (por nome, USB ou IP). A interface não muda.

## Próximos passos sugeridos

- Auto-aceite do pedido após impressão (chamar `/api/deliveries/:id/prepare`).
- Som/alerta ao chegar pedido.
- Reconexão automática e fila offline (imprimir quando a impressora voltar).
- Auto-update do app (electron-updater).

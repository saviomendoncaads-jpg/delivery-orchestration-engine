const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { io } = require('socket.io-client');

let mainWindow = null;
let socket = null;
let printerName = null;            // deviceName da impressora 80mm selecionada
const comandasImpressas = new Set();
let backlogMarcado = false;        // ignora pedidos antigos na 1a sincronizacao

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    backgroundColor: '#090d16',
    title: 'Gestor Distre',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ===== Comanda 80mm (mesmo layout do ticket web) =====
function buildComandaHtml(o) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const itens = Array.isArray(o.itens) && o.itens.length ? o.itens : [];
  const linhas = itens.length
    ? itens.map((i) => `<div class="row"><span class="it">${esc(i)}</span></div>`).join('')
    : '<div class="muted">Sem itens detalhados</div>';
  const valor = o.valor != null ? Number(o.valor) : 0;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: 80mm; padding: 4mm 3mm; font-family: 'Courier New', monospace; color: #000; background: #fff; font-size: 12px; line-height: 1.35; }
    .center { text-align: center; } .b { font-weight: 700; } .xl { font-size: 18px; }
    .row { display: flex; justify-content: space-between; gap: 6px; } .it { flex: 1; } .muted { font-style: italic; color: #444; }
    .sep { border-top: 1px dashed #000; margin: 6px 0; } .sep-solid { border-top: 2px solid #000; margin: 6px 0; }
    .total { font-size: 15px; font-weight: 700; }
  </style></head><body>
    <div class="center b xl">${esc(o.nomeLoja || 'DISTRE')}</div>
    <div class="center">COMANDA DE PEDIDO</div>
    <div class="sep-solid"></div>
    <div class="row"><span>COMANDA:</span><span class="b">${esc(o.id)}</span></div>
    <div class="row"><span>DATA/HORA:</span><span>${new Date().toLocaleString('pt-BR')}</span></div>
    ${o.formaPagamento ? `<div class="row"><span>PAGAMENTO:</span><span>${esc(String(o.formaPagamento).toUpperCase())}</span></div>` : ''}
    <div class="sep"></div>
    <div class="b">CLIENTE</div>
    <div>${esc(o.nomeCliente)}</div>
    ${o.clienteDocumento ? `<div>CPF/CNPJ: ${esc(o.clienteDocumento)}</div>` : ''}
    <div class="sep"></div>
    <div class="b">ENTREGA</div>
    <div>${esc(o.endereco)}</div>
    ${o.bairro ? `<div>Bairro: ${esc(o.bairro)}</div>` : ''}
    ${o.cidade ? `<div>Cidade: ${esc(o.cidade)}</div>` : ''}
    ${o.referencia ? `<div>Ref: ${esc(o.referencia)}</div>` : ''}
    <div class="sep"></div>
    <div class="b">ITENS</div>
    ${linhas}
    <div class="sep-solid"></div>
    <div class="row total"><span>TOTAL:</span><span>R$ ${valor.toFixed(2)}</span></div>
    <div class="sep"></div>
    <div class="center">Gestor Distre</div>
  </body></html>`;
}

// Impressao SILENCIOSA via driver da impressora (sem dialogo). Esta e a forma como
// apps desktop imprimem em termica. Para ESC/POS cru (raw bytes), trocar este metodo
// por node-thermal-printer apontando p/ USB/IP — a interface (imprimirComanda) nao muda.
function imprimirComanda(o) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(buildComandaHtml(o));
    win.loadURL(html);
    win.webContents.once('did-finish-load', () => {
      const opts = { silent: true, printBackground: true, margins: { marginType: 'none' } };
      if (printerName) opts.deviceName = printerName;
      win.webContents.print(opts, (success, reason) => {
        mainWindow?.webContents.send('print-result', { id: o.id, success, reason: reason || null });
        try { win.close(); } catch (_) { /* ignore */ }
        resolve(success);
      });
    });
  });
}

// ===== IPC =====
ipcMain.handle('listar-impressoras', async () => {
  if (!mainWindow) return [];
  try { return await mainWindow.webContents.getPrintersAsync(); }
  catch { return []; }
});

ipcMain.handle('definir-impressora', (_e, name) => { printerName = name || null; return true; });

ipcMain.handle('teste-impressao', async () => {
  return imprimirComanda({
    id: 'TESTE-0001', nomeLoja: 'LOJA TESTE', nomeCliente: 'Cliente de Teste',
    endereco: 'Av. Paulista, 1000 - Bela Vista', bairro: 'Bela Vista', cidade: 'Sao Paulo',
    itens: ['1x Pizza Margherita', '2x Refrigerante 2L'], valor: 75.5, formaPagamento: 'pix',
  });
});

ipcMain.handle('conectar', async (_e, { backendUrl, usuario, senha }) => {
  const base = (backendUrl || 'http://localhost:5000').replace(/\/$/, '');
  const resp = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha }),
  });
  if (!resp.ok) {
    const er = await resp.json().catch(() => ({}));
    throw new Error(er.error || `Login falhou (HTTP ${resp.status})`);
  }
  const sess = await resp.json();

  if (socket) { try { socket.disconnect(); } catch (_) {} }
  comandasImpressas.clear();
  backlogMarcado = false;

  socket = io(base, { auth: { token: sess.token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => mainWindow?.webContents.send('status', { conectado: true, loja: sess.nomeLoja }));
  socket.on('disconnect', () => mainWindow?.webContents.send('status', { conectado: false }));
  socket.on('connect_error', (err) => mainWindow?.webContents.send('status', { conectado: false, erro: err.message }));

  const handleState = (data) => {
    const deliveries = (data && data.deliveries) || [];
    const pedidos = deliveries.filter((d) => d.tipoComanda === 'pedido' && d.status === 'RECEBIDO');
    if (!backlogMarcado) {
      pedidos.forEach((d) => comandasImpressas.add(d.id));
      backlogMarcado = true;
      mainWindow?.webContents.send('pedidos', pedidos);
      return;
    }
    const novos = pedidos.filter((d) => !comandasImpressas.has(d.id));
    novos.forEach((d) => {
      comandasImpressas.add(d.id);
      imprimirComanda({ ...d, nomeLoja: sess.nomeLoja });
    });
    mainWindow?.webContents.send('pedidos', pedidos);
    if (novos.length) mainWindow?.webContents.send('novo-pedido', { qtd: novos.length });
  };

  socket.on('initial_state', handleState);
  socket.on('system_status', handleState);

  return { nomeLoja: sess.nomeLoja, lojaId: sess.lojaId };
});

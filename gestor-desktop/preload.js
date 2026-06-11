const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura renderer <-> main (contextIsolation ligado).
contextBridge.exposeInMainWorld('gestor', {
  listarImpressoras: () => ipcRenderer.invoke('listar-impressoras'),
  definirImpressora: (nome) => ipcRenderer.invoke('definir-impressora', nome),
  testeImpressao: () => ipcRenderer.invoke('teste-impressao'),
  conectar: (cfg) => ipcRenderer.invoke('conectar', cfg),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onPedidos: (cb) => ipcRenderer.on('pedidos', (_e, d) => cb(d)),
  onNovoPedido: (cb) => ipcRenderer.on('novo-pedido', (_e, d) => cb(d)),
  onPrintResult: (cb) => ipcRenderer.on('print-result', (_e, d) => cb(d)),
});

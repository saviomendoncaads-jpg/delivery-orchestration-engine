const $ = (id) => document.getElementById(id);
const connPill = $('conn');
const ordersEl = $('orders');
const toastEl = $('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function renderOrders(pedidos) {
  if (!pedidos || pedidos.length === 0) {
    ordersEl.innerHTML = '<div class="empty">Nenhum pedido na fila.</div>';
    return;
  }
  ordersEl.innerHTML = pedidos.map((p) => `
    <div class="order">
      <div class="id">${p.id}</div>
      <div class="cli"><b>${p.nomeCliente || '-'}</b></div>
      <div class="end">${p.endereco || ''}</div>
      <div class="val">R$ ${(p.valor != null ? Number(p.valor) : 0).toFixed(2)}</div>
    </div>`).join('');
}

async function carregarImpressoras() {
  const lista = await window.gestor.listarImpressoras();
  const sel = $('impressora');
  const salva = localStorage.getItem('gestor_impressora') || '';
  sel.innerHTML = '<option value="">(impressora padrão do sistema)</option>' +
    lista.map((p) => `<option value="${p.name}" ${p.name === salva ? 'selected' : ''}>${p.displayName || p.name}${p.isDefault ? ' (padrão)' : ''}</option>`).join('');
  if (salva) window.gestor.definirImpressora(salva);
}

$('impressora').addEventListener('change', (e) => {
  const nome = e.target.value;
  localStorage.setItem('gestor_impressora', nome);
  window.gestor.definirImpressora(nome);
});

$('btnAtualizar').addEventListener('click', carregarImpressoras);

$('btnTeste').addEventListener('click', async () => {
  const ok = await window.gestor.testeImpressao();
  toast(ok ? 'Comanda de teste enviada à impressora.' : 'Falha ao imprimir (veja a impressora).');
});

$('btnConectar').addEventListener('click', async () => {
  const cfg = {
    backendUrl: $('backendUrl').value.trim(),
    usuario: $('usuario').value.trim(),
    senha: $('senha').value,
  };
  // persiste config básica (menos a senha)
  localStorage.setItem('gestor_backend', cfg.backendUrl);
  localStorage.setItem('gestor_usuario', cfg.usuario);
  try {
    const r = await window.gestor.conectar(cfg);
    toast(`Conectado: ${r.nomeLoja || 'loja'}`);
  } catch (err) {
    toast('Erro: ' + (err.message || 'falha ao conectar'));
  }
});

// Eventos vindos do main
window.gestor.onStatus((d) => {
  if (d.conectado) {
    connPill.textContent = 'Conectado' + (d.loja ? ' · ' + d.loja : '');
    connPill.className = 'pill on';
  } else {
    connPill.textContent = 'Desconectado' + (d.erro ? ' · ' + d.erro : '');
    connPill.className = 'pill off';
  }
});
window.gestor.onPedidos(renderOrders);
window.gestor.onNovoPedido((d) => toast(`Novo pedido! Imprimindo ${d.qtd} comanda(s)...`));
window.gestor.onPrintResult((d) => {
  if (!d.success) toast(`Impressão falhou (${d.id}): ${d.reason || 'sem impressora?'}`);
});

// Init
$('backendUrl').value = localStorage.getItem('gestor_backend') || 'http://localhost:5000';
$('usuario').value = localStorage.getItem('gestor_usuario') || '';
carregarImpressoras();

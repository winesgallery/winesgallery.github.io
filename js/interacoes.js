// interacoes.js — Wine's Gallery
// Histórico de interações por cliente (ligações, visitas, emails, WhatsApp)
 
const TIPOS_INTERACAO = [
  { key: 'ligacao',   label: '📞 Ligação',         cor: '#2980b9' },
  { key: 'visita',    label: '🤝 Visita presencial', cor: '#27ae60' },
  { key: 'email',     label: '📧 E-mail',            cor: '#8e44ad' },
  { key: 'whatsapp',  label: '💬 WhatsApp',          cor: '#25d366' },
  { key: 'proposta',  label: '📄 Proposta enviada',  cor: '#e67e22' },
  { key: 'outro',     label: '📌 Outro',             cor: '#7f8c8d' },
];
 
async function renderInteracoes(clienteId = null) {
  const div = document.getElementById('interacoes-content');
  if (!div) return;
  div.innerHTML = '<div style="padding:10px;color:var(--txt-mid);">Carregando...</div>';
 
  let rows = [];
  try { rows = await dbCall('select', 'interacoes', { select: '*', order: 'data_interacao.desc' }); } catch (e) {}
 
  // Filtrar por cliente se especificado
  if (clienteId) rows = rows.filter(r => r.cliente_id === clienteId);
  else if (CU.role === 'vendedor') rows = rows.filter(r => r.usuario_login === CU.user);
  else if (CU.role === 'gerente' || CU.role === 'coordenador') {
    const equipe = new Set([CU.user, ...usersCache.filter(u => u.reportaPara === CU.user).map(u => u.user)]);
    rows = rows.filter(r => equipe.has(r.usuario_login));
  }
 
  // Enriquecer com dados do cliente
  const cliMap = {};
  S.clientes().forEach(c => cliMap[c.id] = c);
  clientesCache.forEach(c => { if (!cliMap[c.id]) cliMap[c.id] = c; });
 
  const filtroTipo = document.getElementById('int-filtro-tipo')?.value || '';
  const filtroUser = document.getElementById('int-filtro-user')?.value || '';
  if (filtroTipo) rows = rows.filter(r => r.tipo === filtroTipo);
  if (filtroUser) rows = rows.filter(r => r.usuario_login === filtroUser);
 
  if (!rows.length) {
    div.innerHTML = '<div class="empty"><p>Nenhuma interação registrada.</p></div>';
    return;
  }
 
  div.innerHTML = rows.map(r => {
    const cli = cliMap[r.cliente_id] || {};
    const tipo = TIPOS_INTERACAO.find(t => t.key === r.tipo) || { label: r.tipo, cor: '#7f8c8d' };
    const data = r.data_interacao ? new Date(r.data_interacao).toLocaleDateString('pt-BR') : '';
    return `<div style="background:var(--cream);border-radius:10px;padding:12px;margin-bottom:8px;border-left:4px solid ${tipo.cor};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
        <div>
          <span style="background:${tipo.cor};color:white;padding:2px 8px;border-radius:4px;font-size:10px;">${tipo.label}</span>
          ${!clienteId ? `<strong style="font-size:12px;margin-left:8px;">${cli.razao || '—'}</strong>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:10px;color:var(--txt-mid);">${data} · ${r.usuario_login || ''}</span>
          ${CU.role === 'admin' || r.usuario_login === CU.user ? `<button class="bsm bsm-d" onclick="excluirInteracao(${r.id})">🗑</button>` : ''}
        </div>
      </div>
      <div style="font-size:12px;margin-bottom:6px;">${r.descricao || ''}</div>
      ${r.proximo_passo ? `<div style="font-size:11px;color:var(--wine);padding:5px 8px;background:white;border-radius:5px;">→ Próximo passo: ${r.proximo_passo}</div>` : ''}
    </div>`;
  }).join('');
}
 
function abrirNovaInteracao(clienteId = '', clienteNome = '') {
  document.getElementById('int-id').value = '';
  document.getElementById('int-cliente-busca').value = clienteNome;
  document.getElementById('int-cliente-id').value = clienteId;
  document.getElementById('int-tipo').value = 'ligacao';
  document.getElementById('int-descricao').value = '';
  document.getElementById('int-proximo').value = '';
  document.getElementById('int-data').value = new Date().toISOString().slice(0, 10);
  document.getElementById('modal-interacao').classList.add('open');
}
 
async function salvarInteracao() {
  const clienteId = document.getElementById('int-cliente-id').value;
  const clienteNome = document.getElementById('int-cliente-busca').value;
  const tipo = document.getElementById('int-tipo').value;
  const descricao = document.getElementById('int-descricao').value;
  const proximo = document.getElementById('int-proximo').value;
  const data = document.getElementById('int-data').value;
 
  if (!clienteNome || !descricao) { showToast('Preencha o cliente e a descrição'); return; }
 
  const dataObj = { cliente_id: clienteId, cliente_nome: clienteNome, tipo, descricao, proximo_passo: proximo, usuario_login: CU.user, data_interacao: data ? new Date(data).toISOString() : new Date().toISOString() };
  try {
    await dbCall('insert', 'interacoes', { data: dataObj });
    audit('criar', `Interação registrada: ${clienteNome} (${tipo})`);
    closeModal('modal-interacao');
    showToast('Interação registrada!', true);
    renderInteracoes();
  } catch (e) { showToast('Erro: ' + e.message); }
}
 
async function excluirInteracao(id) {
  if (!confirm('Excluir esta interação?')) return;
  try { await dbCall('delete', 'interacoes', { filters: { id } }); renderInteracoes(); showToast('Excluído', true); }
  catch (e) { showToast('Erro: ' + e.message); }
}
 
function buscarClienteInteracao() {
  const q = (document.getElementById('int-cliente-busca')?.value || '').trim();
  const drop = document.getElementById('int-cliente-drop');
  if (!drop || q.length < 2) { if (drop) drop.style.display = 'none'; return; }
  const todos = [...S.clientes()];
  clientesCache.forEach(c => { if (!todos.find(x => x.id === c.id)) todos.push(c); });
  const matches = todos.filter(c => (c.razao || '').toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  drop.innerHTML = matches.map(c => `<div onclick="selecionarClienteInteracao('${c.id}','${(c.razao||'').replace(/'/g,"\\'")}')\"
    style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:0.5px solid var(--stripe);"
    onmouseover="this.style.background='var(--cream)'" onmouseout="this.style.background=''">
    ${c.razao} <span style="font-size:10px;color:var(--txt-mid);">${c.cnpj || ''}</span>
  </div>`).join('');
  drop.style.display = matches.length ? 'block' : 'none';
}
 
function selecionarClienteInteracao(id, nome) {
  document.getElementById('int-cliente-id').value = id;
  document.getElementById('int-cliente-busca').value = nome;
  document.getElementById('int-cliente-drop').style.display = 'none';
}
 

// tarefas.js — Wine's Gallery
// Tarefas e lembretes vinculados a clientes ou pedidos
 
async function renderTarefas() {
  const div = document.getElementById('tarefas-content');
  if (!div) return;
  div.innerHTML = '<div style="padding:10px;color:var(--txt-mid);">Carregando...</div>';
 
  let rows = [];
  try { rows = await dbCall('select', 'tarefas', { select: '*', order: 'data_vencimento.asc' }); } catch (e) {}
 
  const isAdmin = CU.role === 'admin';
  const isGerente = CU.role === 'gerente' || CU.role === 'coordenador';
  if (!isAdmin && !isGerente) rows = rows.filter(r => r.responsavel === CU.user);
 
  const statusFiltro = document.getElementById('trf-status')?.value || 'pendente';
  if (statusFiltro !== 'todas') rows = rows.filter(r => r.status === statusFiltro);
 
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
 
  if (!rows.length) {
    div.innerHTML = '<div class="empty"><p>Nenhuma tarefa encontrada.</p></div>';
    return;
  }
 
  const prioridadeCor = { alta: 'var(--red)', normal: 'var(--gold)', baixa: 'var(--txt-mid)' };
 
  div.innerHTML = rows.map(r => {
    const venc = r.data_vencimento ? new Date(r.data_vencimento + 'T12:00') : null;
    const atrasada = venc && venc < hoje && r.status === 'pendente';
    const hoje_flag = venc && venc.toDateString() === hoje.toDateString();
    const cor = atrasada ? 'var(--red)' : hoje_flag ? 'var(--gold)' : 'var(--cream)';
    return `<div style="background:${cor};border-radius:10px;padding:12px;margin-bottom:8px;opacity:${r.status==='concluida'?0.6:1};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" ${r.status === 'concluida' ? 'checked' : ''} onchange="toggleTarefa(${r.id},this.checked)" style="width:16px;height:16px;cursor:pointer;">
          <div>
            <div style="font-size:13px;font-weight:bold;${r.status==='concluida'?'text-decoration:line-through;color:var(--txt-mid);':''}">${r.titulo}</div>
            <div style="font-size:10px;color:var(--txt-mid);">${r.cliente_nome || ''} ${r.pedido_id ? '· Pedido: ' + r.pedido_id : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span style="color:${prioridadeCor[r.prioridade]||'var(--txt-mid)'};font-size:10px;font-weight:bold;">${r.prioridade?.toUpperCase() || 'NORMAL'}</span>
          ${venc ? `<span style="font-size:10px;color:${atrasada?'var(--red)':hoje_flag?'var(--wine)':'var(--txt-mid)'};">${atrasada?'⚠️ ':hoje_flag?'🔔 ':''}${venc.toLocaleDateString('pt-BR')}</span>` : ''}
          <span style="font-size:10px;color:var(--txt-mid);">${r.responsavel || ''}</span>
          <button class="bsm bsm-w" onclick="editarTarefa(${r.id})">✏️</button>
          <button class="bsm bsm-d" onclick="excluirTarefa(${r.id})">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
 
async function contarTarefasHoje() {
  try {
    const rows = await dbCall('select', 'tarefas', { select: 'id,data_vencimento,status,responsavel' });
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
    const pendentes = rows.filter(r => {
      if (r.status !== 'pendente') return false;
      if (r.responsavel !== CU.user && CU.role === 'vendedor') return false;
      if (!r.data_vencimento) return false;
      const d = new Date(r.data_vencimento + 'T12:00');
      return d <= amanha;
    });
    return pendentes.length;
  } catch (e) { return 0; }
}
 
function abrirNovaTarefa(clienteId = '', clienteNome = '', pedidoId = '') {
  document.getElementById('trf-id').value = '';
  document.getElementById('trf-titulo').value = '';
  document.getElementById('trf-cliente-busca').value = clienteNome;
  document.getElementById('trf-cliente-id').value = clienteId;
  document.getElementById('trf-pedido').value = pedidoId;
  document.getElementById('trf-responsavel').value = CU.user;
  document.getElementById('trf-vencimento').value = '';
  document.getElementById('trf-prioridade').value = 'normal';
  // Popular select de responsáveis
  const selR = document.getElementById('trf-responsavel');
  selR.innerHTML = usersCache.filter(u => u.ativo).map(u =>
    `<option value="${u.user}" ${u.user === CU.user ? 'selected' : ''}>${u.name}</option>`
  ).join('');
  document.getElementById('modal-tarefa').classList.add('open');
}
 
async function editarTarefa(id) {
  let rows = []; try { rows = await dbCall('select', 'tarefas', { select: '*', filters: { id } }); } catch (e) {}
  const r = rows[0]; if (!r) return;
  document.getElementById('trf-id').value = r.id;
  document.getElementById('trf-titulo').value = r.titulo;
  document.getElementById('trf-cliente-busca').value = r.cliente_nome || '';
  document.getElementById('trf-cliente-id').value = r.cliente_id || '';
  document.getElementById('trf-pedido').value = r.pedido_id || '';
  document.getElementById('trf-vencimento').value = r.data_vencimento || '';
  document.getElementById('trf-prioridade').value = r.prioridade || 'normal';
  const selR = document.getElementById('trf-responsavel');
  selR.innerHTML = usersCache.filter(u => u.ativo).map(u =>
    `<option value="${u.user}" ${u.user === r.responsavel ? 'selected' : ''}>${u.name}</option>`
  ).join('');
  document.getElementById('modal-tarefa').classList.add('open');
}
 
async function salvarTarefa() {
  const id = document.getElementById('trf-id').value;
  const titulo = document.getElementById('trf-titulo').value.trim();
  const clienteId = document.getElementById('trf-cliente-id').value;
  const clienteNome = document.getElementById('trf-cliente-busca').value;
  const pedidoId = document.getElementById('trf-pedido').value;
  const responsavel = document.getElementById('trf-responsavel').value;
  const vencimento = document.getElementById('trf-vencimento').value;
  const prioridade = document.getElementById('trf-prioridade').value;
 
  if (!titulo) { showToast('Informe o título da tarefa'); return; }
 
  const data = { titulo, cliente_id: clienteId, cliente_nome: clienteNome, pedido_id: pedidoId, responsavel, data_vencimento: vencimento || null, prioridade, status: 'pendente', created_by: CU.user };
  try {
    if (id) {
      await dbCall('update', 'tarefas', { data, filters: { id } });
    } else {
      data.created_at = new Date().toISOString();
      await dbCall('insert', 'tarefas', { data });
    }
    audit('criar', `Tarefa: ${titulo}`);
    closeModal('modal-tarefa');
    showToast('Tarefa salva!', true);
    renderTarefas();
    atualizarBadgeTarefas();
  } catch (e) { showToast('Erro: ' + e.message); }
}
 
async function toggleTarefa(id, concluida) {
  try {
    await dbCall('update', 'tarefas', { data: { status: concluida ? 'concluida' : 'pendente' }, filters: { id } });
    renderTarefas();
    atualizarBadgeTarefas();
  } catch (e) { showToast('Erro: ' + e.message); }
}
 
async function excluirTarefa(id) {
  if (!confirm('Excluir esta tarefa?')) return;
  try { await dbCall('delete', 'tarefas', { filters: { id } }); renderTarefas(); atualizarBadgeTarefas(); }
  catch (e) { showToast('Erro: ' + e.message); }
}
 
async function atualizarBadgeTarefas() {
  const count = await contarTarefasHoje();
  // Integrar com o badge do sino de notificações
  const badge = document.getElementById('notif-badge');
  const bell = document.getElementById('notif-bell');
  if (count > 0 && badge && bell) {
    bell.style.display = 'block';
    // Somar com aprovações pendentes se já existir número
    const atual = parseInt(badge.textContent) || 0;
    // Usar tarefas separadamente no tooltip
    badge.title = `${count} tarefa(s) vencendo hoje/atrasadas`;
  }
}
 
function buscarClienteTarefa() {
  const q = (document.getElementById('trf-cliente-busca')?.value || '').trim();
  const drop = document.getElementById('trf-cliente-drop');
  if (!drop || q.length < 2) { if (drop) drop.style.display = 'none'; return; }
  const todos = [...S.clientes()];
  clientesCache.forEach(c => { if (!todos.find(x => x.id === c.id)) todos.push(c); });
  const matches = todos.filter(c => (c.razao || '').toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  drop.innerHTML = matches.map(c => `<div onclick="selecionarClienteTarefa('${c.id}','${(c.razao||'').replace(/'/g,"\\'")}')\"
    style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:0.5px solid var(--stripe);"
    onmouseover="this.style.background='var(--cream)'" onmouseout="this.style.background=''">
    ${c.razao}
  </div>`).join('');
  drop.style.display = matches.length ? 'block' : 'none';
}
 
function selecionarClienteTarefa(id, nome) {
  document.getElementById('trf-cliente-id').value = id;
  document.getElementById('trf-cliente-busca').value = nome;
  document.getElementById('trf-cliente-drop').style.display = 'none';
}
 

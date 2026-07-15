// pipeline.js — Wine's Gallery
// Pipeline de vendas B2B: funil por etapa, valor esperado, probabilidade
 
const ETAPAS_PIPELINE = [
  { key: 'prospeccao',   label: 'Prospecção',   cor: '#8e44ad', prob: 10 },
  { key: 'qualificacao', label: 'Qualificação',  cor: '#2980b9', prob: 25 },
  { key: 'proposta',     label: 'Proposta',      cor: '#d4a017', prob: 50 },
  { key: 'negociacao',   label: 'Negociação',    cor: '#e67e22', prob: 75 },
  { key: 'fechado',      label: 'Fechado ✅',    cor: '#27ae60', prob: 100 },
  { key: 'perdido',      label: 'Perdido ❌',    cor: '#c0392b', prob: 0  },
];
 
let pipelineViewMode = 'kanban'; // 'kanban' | 'lista'
 
async function renderPipeline() {
  const div = document.getElementById('pipeline-content');
  if (!div) return;
  div.innerHTML = '<div style="padding:10px;color:var(--txt-mid);">Carregando...</div>';
 
  let rows = [];
  try { rows = await dbCall('select', 'pipeline', { select: '*', order: 'updated_at.desc' }); } catch (e) {}
 
  // Filtrar por papel
  const isAdmin = CU.role === 'admin';
  const isGerente = CU.role === 'gerente' || CU.role === 'coordenador';
  if (!isAdmin && !isGerente) rows = rows.filter(r => r.vendedor_login === CU.user);
  else if (isGerente) {
    const equipe = new Set([CU.user, ...usersCache.filter(u => u.reportaPara === CU.user).map(u => u.user)]);
    rows = rows.filter(r => equipe.has(r.vendedor_login));
  }
 
  // Enriquecer com dados do cliente
  const cliMap = {};
  S.clientes().forEach(c => cliMap[c.id] = c);
  clientesCache.forEach(c => { if (!cliMap[c.id]) cliMap[c.id] = c; });
 
  if (pipelineViewMode === 'kanban') {
    renderPipelineKanban(rows, cliMap, div);
  } else {
    renderPipelineLista(rows, cliMap, div);
  }
}
 
function renderPipelineKanban(rows, cliMap, div) {
  const por_etapa = {};
  ETAPAS_PIPELINE.forEach(e => por_etapa[e.key] = []);
  rows.forEach(r => { if (por_etapa[r.etapa]) por_etapa[r.etapa].push(r); });
 
  const totalValor = rows.filter(r => r.etapa !== 'perdido').reduce((s, r) => s + (r.valor_esperado || 0) * ((r.probabilidade || 0) / 100), 0);
 
  div.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
      <button class="bsm bsm-w" onclick="pipelineViewMode='kanban';renderPipeline()" style="${pipelineViewMode==='kanban'?'background:var(--wine);color:var(--gold);':''}">📋 Kanban</button>
      <button class="bsm bsm-w" onclick="pipelineViewMode='lista';renderPipeline()" style="${pipelineViewMode==='lista'?'background:var(--wine);color:var(--gold);':''}">📄 Lista</button>
      <button class="btn-wine" onclick="abrirNovoPipeline()" style="margin-left:auto;">+ Nova oportunidade</button>
      <div style="font-size:11px;color:var(--txt-mid);">Pipeline ponderado: <strong>${fmtBRL(totalValor)}</strong></div>
    </div>
    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:10px;">
      ${ETAPAS_PIPELINE.map(etapa => {
        const cards = por_etapa[etapa.key] || [];
        const total = cards.reduce((s, r) => s + (r.valor_esperado || 0), 0);
        return `<div style="min-width:200px;flex:1;background:var(--cream);border-radius:10px;padding:10px;">
          <div style="font-size:11px;font-weight:bold;color:white;background:${etapa.cor};padding:5px 10px;border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between;">
            <span>${etapa.label}</span>
            <span style="font-size:10px;opacity:.9;">${cards.length}</span>
          </div>
          <div style="font-size:10px;color:var(--txt-mid);margin-bottom:8px;text-align:center;">${fmtBRL(total)}</div>
          ${cards.map(r => {
            const cli = cliMap[r.cliente_id] || {};
            return `<div onclick="abrirDetalhesPipeline(${r.id})" style="background:white;border-radius:7px;padding:9px;margin-bottom:6px;cursor:pointer;border-left:3px solid ${etapa.cor};box-shadow:0 1px 4px rgba(0,0,0,.07);">
              <div style="font-size:12px;font-weight:bold;margin-bottom:3px;">${cli.razao || r.cliente_nome || '—'}</div>
              <div style="font-size:10px;color:var(--txt-mid);">${fmtBRL(r.valor_esperado || 0)} · ${r.probabilidade || 0}%</div>
              <div style="font-size:10px;color:var(--txt-mid);">${r.vendedor_login || ''}</div>
            </div>`;
          }).join('')}
          <button onclick="abrirNovoPipelineEtapa('${etapa.key}')" style="width:100%;padding:5px;border:1px dashed var(--stripe);background:none;border-radius:6px;cursor:pointer;font-size:11px;color:var(--txt-mid);margin-top:4px;">+ Adicionar</button>
        </div>`;
      }).join('')}
    </div>`;
}
 
function renderPipelineLista(rows, cliMap, div) {
  if (!rows.length) { div.innerHTML = '<div class="empty"><p>Nenhuma oportunidade cadastrada.</p></div>'; return; }
  div.innerHTML = `
    <div style="margin-bottom:10px;text-align:right;"><button class="btn-wine" onclick="abrirNovoPipeline()">+ Nova oportunidade</button></div>
    <div class="tbl-scroll"><table style="width:100%;border-collapse:collapse;font-size:11px;min-width:600px;">
      <thead><tr style="border-bottom:2px solid var(--stripe);">
        <th style="padding:7px 6px;text-align:left;">Cliente</th>
        <th style="padding:7px 6px;">Etapa</th>
        <th style="padding:7px 6px;">Valor</th>
        <th style="padding:7px 6px;text-align:center;">Prob.</th>
        <th style="padding:7px 6px;">Vendedor</th>
        <th style="padding:7px 6px;">Atualizado</th>
        <th></th>
      </tr></thead>
      <tbody>${rows.map(r => {
        const cli = cliMap[r.cliente_id] || {};
        const etapa = ETAPAS_PIPELINE.find(e => e.key === r.etapa) || {};
        return `<tr style="border-bottom:0.5px solid var(--stripe);cursor:pointer;" onclick="abrirDetalhesPipeline(${r.id})">
          <td style="padding:7px 6px;font-weight:bold;">${cli.razao || r.cliente_nome || '—'}</td>
          <td style="padding:7px 6px;"><span style="background:${etapa.cor};color:white;padding:2px 7px;border-radius:4px;font-size:10px;">${etapa.label || r.etapa}</span></td>
          <td style="padding:7px 6px;">${fmtBRL(r.valor_esperado || 0)}</td>
          <td style="padding:7px 6px;text-align:center;">${r.probabilidade || 0}%</td>
          <td style="padding:7px 6px;font-size:10px;">${r.vendedor_login || ''}</td>
          <td style="padding:7px 6px;font-size:10px;color:var(--txt-mid);">${r.updated_at ? new Date(r.updated_at).toLocaleDateString('pt-BR') : ''}</td>
          <td style="padding:7px 6px;"><button class="bsm bsm-d" onclick="event.stopPropagation();excluirPipeline(${r.id})">🗑</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}
 
function abrirNovoPipeline(etapaInicial = 'prospeccao') {
  document.getElementById('pip-id').value = '';
  document.getElementById('pip-cliente-busca').value = '';
  document.getElementById('pip-cliente-id').value = '';
  document.getElementById('pip-valor').value = '';
  document.getElementById('pip-prob').value = '';
  document.getElementById('pip-obs').value = '';
  document.getElementById('pip-etapa').value = etapaInicial;
  document.getElementById('pip-vendedor').value = CU.user;
  document.getElementById('modal-pipeline').classList.add('open');
}
 
function abrirNovoPipelineEtapa(etapa) { abrirNovoPipeline(etapa); }
 
async function abrirDetalhesPipeline(id) {
  let rows = []; try { rows = await dbCall('select', 'pipeline', { select: '*', filters: { id } }); } catch (e) {}
  const r = rows[0]; if (!r) return;
  document.getElementById('pip-id').value = r.id;
  document.getElementById('pip-cliente-busca').value = r.cliente_nome || '';
  document.getElementById('pip-cliente-id').value = r.cliente_id || '';
  document.getElementById('pip-etapa').value = r.etapa;
  document.getElementById('pip-valor').value = r.valor_esperado || '';
  document.getElementById('pip-prob').value = r.probabilidade || '';
  document.getElementById('pip-obs').value = r.observacoes || '';
  document.getElementById('pip-vendedor').value = r.vendedor_login || CU.user;
  document.getElementById('modal-pipeline').classList.add('open');
}
 
async function salvarPipeline() {
  const id = document.getElementById('pip-id').value;
  const clienteId = document.getElementById('pip-cliente-id').value;
  const clienteNome = document.getElementById('pip-cliente-busca').value;
  const etapa = document.getElementById('pip-etapa').value;
  const valor = parseFloat(document.getElementById('pip-valor').value) || 0;
  const prob = parseInt(document.getElementById('pip-prob').value) || ETAPAS_PIPELINE.find(e => e.key === etapa)?.prob || 0;
  const obs = document.getElementById('pip-obs').value;
  const vendedor = document.getElementById('pip-vendedor').value || CU.user;
 
  if (!clienteNome) { showToast('Selecione um cliente'); return; }
 
  const data = { cliente_id: clienteId, cliente_nome: clienteNome, etapa, valor_esperado: valor, probabilidade: prob, observacoes: obs, vendedor_login: vendedor, updated_at: new Date().toISOString() };
  try {
    if (id) {
      await dbCall('update', 'pipeline', { data, filters: { id } });
    } else {
      data.created_at = new Date().toISOString();
      await dbCall('insert', 'pipeline', { data });
    }
    audit('editar', `Pipeline: ${clienteNome} → ${etapa}`);
    closeModal('modal-pipeline');
    showToast('Oportunidade salva!', true);
    renderPipeline();
  } catch (e) { showToast('Erro: ' + e.message); }
}
 
async function excluirPipeline(id) {
  if (!confirm('Remover esta oportunidade do pipeline?')) return;
  try { await dbCall('delete', 'pipeline', { filters: { id } }); renderPipeline(); showToast('Removido', true); }
  catch (e) { showToast('Erro: ' + e.message); }
}
 
function buscarClientePipeline() {
  const q = (document.getElementById('pip-cliente-busca')?.value || '').trim();
  const drop = document.getElementById('pip-cliente-drop');
  if (!drop || q.length < 2) { if (drop) drop.style.display = 'none'; return; }
  const todos = [...S.clientes()];
  clientesCache.forEach(c => { if (!todos.find(x => x.id === c.id)) todos.push(c); });
  const matches = todos.filter(c => (c.razao || '').toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  if (!matches.length) { drop.style.display = 'none'; return; }
  drop.innerHTML = matches.map(c => `<div onclick="selecionarClientePipeline('${c.id}','${(c.razao||'').replace(/'/g,"\\'")}')\"
    style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:0.5px solid var(--stripe);"
    onmouseover="this.style.background='var(--cream)'" onmouseout="this.style.background=''">
    ${c.razao} <span style="font-size:10px;color:var(--txt-mid);">${c.cnpj || ''}</span>
  </div>`).join('');
  drop.style.display = 'block';
}
 
function selecionarClientePipeline(id, nome) {
  document.getElementById('pip-cliente-id').value = id;
  document.getElementById('pip-cliente-busca').value = nome;
  document.getElementById('pip-cliente-drop').style.display = 'none';
}

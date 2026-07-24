// api/sync-bling.js — Sync NFs Bling ↔ CRM com preview e confirmação
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const CLIENT_ID     = process.env.BLING_CLIENT_ID;
  const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
 
  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET)
    return res.status(500).json({ erro: 'Variáveis de ambiente não configuradas' });
 
  const body = req.body || {};
  const modo = body.modo || 'preview';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  // ── Fetch com retry ──
  async function fetchBling(url, options = {}, maxRetries = 4) {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await sleep(1200 * i);
      const r = await fetch(url, options);
      if (r.status !== 429) return r;
    }
    throw new Error('Rate limit persistente');
  }
 
  const sbH = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
 
  async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH });
    return r.json();
  }
 
  async function sbUpsert(table, data) {
    return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...sbH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data)
    });
  }
 
  async function getToken() {
    const rows = await sbGet('bling_tokens?id=eq.1&select=*');
    const row  = rows?.[0];
    if (!row?.refresh_token) return null;
    const expired = Date.now() > (new Date(row.expires_at || 0).getTime() - 60000);
    if (!expired) return row.access_token;
 
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const rf = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
    });
    const d = await rf.json();
    if (!rf.ok || !d.access_token) return null;
 
    await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1`, {
      method: 'PATCH', headers: sbH,
      body: JSON.stringify({
        access_token: d.access_token,
        refresh_token: d.refresh_token || row.refresh_token,
        expires_at: new Date(Date.now() + (d.expires_in || 21600) * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
    });
    return d.access_token;
  }
 
  // ════════════════════════════════════════
  // MODO: IMPORTAR (NFs já aprovadas pelo admin)
  // ════════════════════════════════════════
  if (modo === 'importar') {
    const nfs = body.nfs || [];
    let importadas = 0;
 
    // Carregar De/Para
    let deParaMap = {};
    try {
      const dp = await sbGet('rotulos_depara?select=codigo_bling,nome');
      (dp || []).forEach(r => { if (r.codigo_bling) deParaMap[r.codigo_bling.trim()] = r.nome.trim(); });
    } catch(e) {}
 
    for (const nf of nfs) {
      try {
        const clienteSnapshot = JSON.stringify({
          razao:  nf.cliente || 'Importado do Bling',
          cnpj:   nf.cnpj   || '',
          tipo:   nf.cnpj && nf.cnpj.replace(/\D/g,'').length > 11 ? 'PJ' : 'PF',
          tel:    nf.telefone || '',
          email:  nf.email    || '',
          end:    nf.endereco  || '',
          cidade: nf.municipio || '',
          cep:    nf.cep       || ''
        });
 
        const itens = (nf.itens || []).map(it => ({
          nome:  deParaMap[(it.cod||'').trim()] || it.nome || '—',
          cod:   it.cod   || '',
          qty:   it.qty   || 1,
          price: it.price || 0,
          total: (it.qty||1) * (it.price||0),
          safra: ''
        }));
 
        await sbUpsert('pedidos', {
          id:                `BLING-${nf.blingId}`,
          bling_id:          String(nf.blingId),
          bling_sent_at:     nf.dataEmissao ? `${nf.dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
          status:            'fechado',
          tipo:              nf.cnpj && nf.cnpj.replace(/\D/g,'').length > 11 ? 'B2B' : 'B2C',
          origem:            'bling_sync',
          total:             nf.total || 0,
          fat_data:          nf.dataEmissao,
          fat_forma:         nf.fat_forma  || '',
          fat_parcelas:      nf.fat_parcelas || 1,
          fat_prazos:        nf.fat_prazos  || '',
          vendedor_login:    '',
          excluido:          false,
          cliente_snapshot:  clienteSnapshot,
          itens_snapshot:    JSON.stringify(itens),
          comments_snapshot: '[]',
          history_snapshot:  '[]',
          created_at:        new Date().toISOString(),
          updated_at:        new Date().toISOString()
        });
        importadas++;
      } catch(e) {
        console.error('Erro ao importar NF', nf.blingId, e.message);
      }
    }
 
    await sbUpsert('bling_sync_log', {
      id: Date.now(), executado_em: new Date().toISOString(),
      importadas, atualizadas: 0, erros: 0, data_inicio: 'manual'
    }).catch(() => {});
 
    return res.status(200).json({ ok: true, importadas });
  }
 
  // ════════════════════════════════════════
  // MODO: PREVIEW (busca NFs e compara com CRM)
  // ════════════════════════════════════════
  const dataInicio = body.dataInicio || '2026-07-24';
  const paginas    = parseInt(body.paginas) || 50;
 
  const token = await getToken();
  if (!token) return res.status(401).json({ erro: 'Bling não autorizado.' });
 
  const bH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
 
  // Carregar pedidos existentes no CRM para comparação
  const pedidosExistentes = await sbGet('pedidos?select=id,bling_id,total,fat_data,cliente_snapshot&excluido=eq.false').catch(() => []);
 
  // Indexar por bling_id (string)
  const porBlingId = {};
  (pedidosExistentes || []).forEach(p => {
    if (p.bling_id) porBlingId[String(p.bling_id)] = p;
  });
 
  // Indexar por CNPJ+mês para detecção de duplicatas manuais
  const porCnpjMes = {};
  (pedidosExistentes || []).forEach(p => {
    try {
      const cli  = JSON.parse(p.cliente_snapshot || '{}');
      const cnpj = (cli.cnpj || '').replace(/\D/g, '');
      const mes  = (p.fat_data || p.created_at || '').substring(0, 7);
      if (cnpj && mes) {
        const key = `${cnpj}_${mes}`;
        if (!porCnpjMes[key]) porCnpjMes[key] = [];
        porCnpjMes[key].push(p);
      }
    } catch(e) {}
  });
 
  // Buscar NFs do Bling
  const nfsEncontradas = [];
  let pagina = 1;
 
  while (pagina <= paginas) {
    await sleep(pagina > 1 ? 500 : 0);
    const url = `https://www.bling.com.br/Api/v3/nfe?pagina=${pagina}&limite=100&dataEmissaoInicial=${dataInicio}`;
 
    let pr;
    try { pr = await fetchBling(url, { headers: bH }); }
    catch(e) { break; }
 
    const pd = await pr.json();
    if (!pr.ok) return res.status(200).json({ erro: 'Bling retornou erro: ' + JSON.stringify(pd) });
 
    const nfs = pd?.data || [];
    if (!nfs.length) break;
 
    for (const nf of nfs) {
      await sleep(350);
 
      // Buscar detalhe completo
      let src = nf;
      try {
        const dr = await fetchBling(`https://www.bling.com.br/Api/v3/nfe/${nf.id}`, { headers: bH });
        const dd = await dr.json();
        src = dd?.data || nf;
        await sleep(350);
      } catch(e) {}
 
      const blingId     = String(nf.id);
      const dataEmissao = (src.dataEmissao || '').substring(0, 10);
      const total       = parseFloat(src.valorNota || src.totalProdutos || 0);
      const contato     = src.contato || nf.contato || {};
      const cnpj        = (contato.numeroDocumento || '').replace(/\D/g, '');
      const mesEmissao  = dataEmissao.substring(0, 7);
 
      // Verificar status
      let status    = 'nova';
      let matchInfo = '—';
 
      if (porBlingId[blingId]) {
        // Já existe por bling_id (foi enviado pelo CRM)
        status    = 'ja_existe';
        matchInfo = 'Pedido CRM: ' + porBlingId[blingId].id;
      } else if (cnpj && mesEmissao) {
        // Verificar possível duplicata manual (mesmo CNPJ + mesmo mês + valor próximo)
        const candidatos = porCnpjMes[`${cnpj}_${mesEmissao}`] || [];
        const match = candidatos.find(p => {
          const diff = Math.abs((p.total || 0) - total);
          const pct  = total > 0 ? diff / total : 0;
          return pct < 0.05; // menos de 5% de diferença no valor
        });
        if (match) {
          status    = 'possivel_duplicata';
          matchInfo = `Pedido CRM ${match.id} · ${fmtReais(match.total)} · mesmo mês`;
        }
      }
 
      // Itens para importação posterior
      const itens = (src.itens || []).map(it => ({
        cod:   it.codigo    || '',
        nome:  it.descricao || '—',
        qty:   parseFloat(it.quantidade || 1),
        price: parseFloat(it.valor      || 0)
      }));
 
      // Parcelas
      const parcelas   = src.parcelas || [];
      const fatPrazos  = parcelas.map(p => {
        const dias = Math.round((new Date(p.data) - new Date(dataEmissao)) / 86400000);
        return String(Math.max(0, dias));
      }).join(',');
 
      nfsEncontradas.push({
        blingId,
        numero:      src.numero    || nf.numero || blingId,
        dataEmissao,
        cliente:     contato.nome  || 'Desconhecido',
        cnpj,
        telefone:    contato.telefone || '',
        email:       contato.email    || '',
        endereco:    contato.endereco?.endereco   || '',
        municipio:   contato.endereco?.municipio  || '',
        cep:         contato.endereco?.cep        || '',
        total,
        itens,
        fat_forma:    parcelas.length ? 'bling' : '',
        fat_parcelas: parcelas.length || 1,
        fat_prazos:   fatPrazos,
        status,
        matchInfo
      });
    }
    pagina++;
  }
 
  return res.status(200).json({ nfs: nfsEncontradas });
}
 
function fmtReais(v) {
  return 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

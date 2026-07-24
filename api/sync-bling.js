// api/sync-bling.js — Importa NFs do Bling para o Supabase
 
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
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
 
  const { dataInicio = '2026-01-01', paginas = 50, debug = false } = req.body || req.query || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  async function fetchBling(url, options = {}, maxRetries = 4) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await sleep(1200 * attempt);
      const resp = await fetch(url, options);
      if (resp.status !== 429) return resp;
    }
    throw new Error('Rate limit persistente');
  }
 
  const sbH = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
 
  async function sbUpsert(table, data) {
    return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...sbH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data)
    });
  }
 
  async function getToken() {
    const r    = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=*`, { headers: sbH });
    const rows = await r.json();
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
 
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Bling não autorizado.' });
 
    const bH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
 
    // ── MODO DEBUG: inspecionar estrutura real da API ──
    if (debug === 'true' || debug === true) {
      const testList = await fetchBling(
        `https://www.bling.com.br/Api/v3/nfe?pagina=1&limite=2&dataEmissaoInicial=${dataInicio}`,
        { headers: bH }
      );
      const listData = await testList.json();
      const primeiraId = listData?.data?.[0]?.id;
 
      let detalheData = null;
      if (primeiraId) {
        await sleep(400);
        const dr = await fetchBling(`https://www.bling.com.br/Api/v3/nfe/${primeiraId}`, { headers: bH });
        detalheData = await dr.json();
      }
 
      return res.status(200).json({
        debug: true,
        total_lista: listData?.data?.length || 0,
        amostra_lista: listData?.data?.[0] || null,        // campos da listagem
        amostra_detalhe: detalheData?.data || null,        // campos do detalhe
        campos_lista: Object.keys(listData?.data?.[0] || {}),
        campos_detalhe: Object.keys(detalheData?.data || {})
      });
    }
 
    // ── SYNC NORMAL ──
    let totalImportadas = 0, totalAtualizadas = 0, totalEncontrados = 0;
    let erros = [], pagina = 1;
    const maxPaginas = parseInt(paginas) || 50;
 
    while (pagina <= maxPaginas) {
      await sleep(pagina > 1 ? 500 : 0);
      const url = `https://www.bling.com.br/Api/v3/nfe?pagina=${pagina}&limite=100&dataEmissaoInicial=${dataInicio}`;
      
      let pageResp;
      try { pageResp = await fetchBling(url, { headers: bH }); }
      catch(e) { erros.push(`Pág ${pagina}: ${e.message}`); break; }
 
      const pageData = await pageResp.json();
      if (!pageResp.ok) {
        if (pagina === 1) return res.status(200).json({
          ok: false, status_http: pageResp.status, resposta_bling: pageData
        });
        break;
      }
 
      const nfs = pageData?.data || [];
      if (!nfs.length) break;
      totalEncontrados += nfs.length;
 
      for (const nf of nfs) {
        await sleep(350);
        try {
          // Buscar detalhe completo da NF
          let detalhe = null;
          try {
            const dr = await fetchBling(`https://www.bling.com.br/Api/v3/nfe/${nf.id}`, { headers: bH });
            const dd = await dr.json();
            detalhe = dd?.data || null;
            await sleep(350);
          } catch(e) { console.warn('Detalhe NF falhou:', nf.id, e.message); }
 
          // Usar detalhe se disponível, senão lista mínima
          const src = detalhe || nf;
 
          // ── Extrair campos — estrutura confirmada via debug ──
          // dataEmissao vem como "2026-07-23 18:38:28" — pegar só data
          const dataEmissao = (src.dataEmissao || '').substring(0, 10);
 
          // Total: campo valorNota no detalhe da NF
          const total = parseFloat(src.valorNota || src.totalProdutos || src.total || 0);
 
          // Contato
          const contato = src.contato || {};
          const nomeCliente = contato.nome || 'Importado do Bling';
          const docCliente  = (contato.numeroDocumento || '').replace(/\D/g,'');
          const tipoCliente = docCliente.length > 11 ? 'PJ' : 'PF';
 
          // Itens: itens[].descricao, .quantidade, .valor (unitário), .codigo
          const itensRaw = src.itens || [];
          const itens = itensRaw.map(it => ({
            nome:  it.descricao || '—',
            cod:   it.codigo    || '',
            qty:   parseFloat(it.quantidade || 1),
            price: parseFloat(it.valor      || 0),
            total: parseFloat(it.valorTotal || (it.quantidade * it.valor) || 0),
            safra: ''
          }));
 
          const blingId = String(nf.id);
          const clienteSnapshot = JSON.stringify({
            razao: nomeCliente, cnpj: docCliente, tipo: tipoCliente
          });
          const itensSnapshot = JSON.stringify(itens);
 
          // Verificar se já existe
          const ex = await fetch(
            `${SUPABASE_URL}/rest/v1/pedidos?bling_id=eq.${blingId}&select=id,total,fat_data`,
            { headers: sbH }
          );
          const exRows  = await ex.json();
          const jaExiste = exRows?.[0];
 
          if (jaExiste) {
            // Sempre atualiza registros importados do Bling (garante dados completos)
            await sbUpsert('pedidos', {
              id:               jaExiste.id,
              fat_data:         dataEmissao,
              total,
              cliente_snapshot: clienteSnapshot,
              itens_snapshot:   itensSnapshot,
              updated_at:       new Date().toISOString()
            });
            totalAtualizadas++;
          } else {
            await sbUpsert('pedidos', {
              id:                `BLING-${blingId}`,
              bling_id:          blingId,
              bling_sent_at:     dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
              status:            'fechado',
              tipo:              tipoCliente === 'PJ' ? 'B2B' : 'B2C',
              origem:            'bling_sync',
              total,
              fat_data:          dataEmissao,
              fat_forma:         '', fat_parcelas: 1, fat_prazos: '',
              vendedor_login:    '',
              excluido:          false,
              cliente_snapshot:  clienteSnapshot,
              itens_snapshot:    itensSnapshot,
              comments_snapshot: '[]',
              history_snapshot:  '[]',
              created_at:        new Date().toISOString(),
              updated_at:        new Date().toISOString()
            });
            totalImportadas++;
          }
        } catch(e) {
          erros.push(`NF ${nf.id}: ${e.message}`);
        }
      }
      pagina++;
    }
 
    await sbUpsert('bling_sync_log', {
      id: Date.now(), executado_em: new Date().toISOString(),
      importadas: totalImportadas, atualizadas: totalAtualizadas,
      erros: erros.length, detalhes: erros.join('\n').substring(0,2000)||null,
      data_inicio: dataInicio
    }).catch(()=>{});
 
    return res.status(200).json({
      ok: true, importadas: totalImportadas,
      atualizadas: totalAtualizadas,
      total_encontrados: totalEncontrados,
      erros: erros.length, detalheErros: erros.slice(0,5)
    });
 
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}

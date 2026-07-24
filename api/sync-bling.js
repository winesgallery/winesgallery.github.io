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
 
  const { dataInicio = '2026-01-01', paginas = 50 } = req.body || req.query || {};
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
        access_token:  d.access_token,
        refresh_token: d.refresh_token || row.refresh_token,
        expires_at:    new Date(Date.now() + (d.expires_in || 21600) * 1000).toISOString(),
        updated_at:    new Date().toISOString()
      })
    });
    return d.access_token;
  }
 
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Bling não autorizado. Acesse /api/bling-connect.' });
 
    const bH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
 
    let totalImportadas = 0, totalAtualizadas = 0, totalEncontrados = 0;
    let erros = [], pagina = 1;
    const maxPaginas = parseInt(paginas) || 10;
 
    while (pagina <= maxPaginas) {
      await sleep(pagina > 1 ? 500 : 0);
 
      // NF-e autorizadas a partir da data de início
      const url = `https://www.bling.com.br/Api/v3/nfe?pagina=${pagina}&limite=100&dataEmissaoInicial=${dataInicio}`;
      console.log(`Buscando página ${pagina}`);
 
      let pageResp;
      try { pageResp = await fetchBling(url, { headers: bH }); }
      catch(e) { erros.push(`Pág ${pagina}: ${e.message}`); break; }
 
      const pageData = await pageResp.json();
 
      if (!pageResp.ok) {
        if (pagina === 1) return res.status(200).json({
          ok: false, diagnostico: true,
          status_http: pageResp.status,
          resposta_bling: pageData,
          mensagem: 'Erro ao buscar NFs.'
        });
        break;
      }
 
      const nfs = pageData?.data || [];
      console.log(`Página ${pagina}: ${nfs.length} NFs`);
      if (!nfs.length) break;
      totalEncontrados += nfs.length;
 
      for (const nf of nfs) {
        await sleep(300);
        try {
          // Buscar detalhes completos da NF
          let detalhe = nf;
          if (nf.id) {
            try {
              const dr = await fetchBling(`https://www.bling.com.br/Api/v3/nfe/${nf.id}`, { headers: bH });
              const dd = await dr.json();
              detalhe = dd?.data || nf;
              await sleep(300);
            } catch(e) { console.warn('Detalhe NF falhou:', nf.id); }
          }
 
          const blingId      = String(nf.id);
          const dataEmissao  = (detalhe.dataEmissao || nf.dataEmissao || '').substring(0, 10);
          const total        = parseFloat(detalhe.totalProdutos || detalhe.valor || nf.totalProdutos || 0);
          const contato      = detalhe.contato || nf.contato || {};
 
          const clienteJson = JSON.stringify({
            razao: contato.nome || 'Importado do Bling',
            cnpj:  (contato.numeroDocumento || '').replace(/\D/g, ''),
            tipo:  contato.tipoPessoa === 'J' ? 'PJ' : 'PF'
          });
 
          const itensJson = JSON.stringify((detalhe.itens || []).map(it => ({
            nome:  it.descricao || it.produto?.descricao || '—',
            qty:   parseFloat(it.quantidade || 1),
            price: parseFloat(it.valor || 0),
            safra: ''
          })));
 
          // Verificar se já existe
          const ex      = await fetch(`${SUPABASE_URL}/rest/v1/pedidos?bling_id=eq.${blingId}&select=id,total,fat_data`, { headers: sbH });
          const exRows  = await ex.json();
          const jaExiste = exRows?.[0];
 
          if (jaExiste) {
            if (jaExiste.fat_data !== dataEmissao || Math.abs((jaExiste.total || 0) - total) > 0.01) {
              await sbUpsert('pedidos', { id: jaExiste.id, fat_data: dataEmissao, total, updated_at: new Date().toISOString() });
              totalAtualizadas++;
            }
          } else {
            await sbUpsert('pedidos', {
              id:                `BLING-${blingId}`,
              bling_id:          blingId,
              bling_sent_at:     dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
              status:            'fechado',
              tipo:              'B2B',
              origem:            'bling_sync',
              total,
              fat_data:          dataEmissao,
              fat_forma:         '',
              fat_parcelas:      1,
              fat_prazos:        '',
              bling_id:          blingId,
              vendedor_login:    '',
              excluido:          false,
              cliente_snapshot:  clienteJson,
              itens_snapshot:    itensJson,
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
 
    // Log do sync
    await sbUpsert('bling_sync_log', {
      id: Date.now(), executado_em: new Date().toISOString(),
      importadas: totalImportadas, atualizadas: totalAtualizadas,
      erros: erros.length, detalhes: erros.join('\n').substring(0,2000) || null,
      data_inicio: dataInicio
    }).catch(() => {});
 
    return res.status(200).json({
      ok: true,
      importadas: totalImportadas,
      atualizadas: totalAtualizadas,
      total_encontrados: totalEncontrados,
      erros: erros.length,
      detalheErros: erros.slice(0, 5)
    });
 
  } catch(err) {
    console.error('SYNC ERRO:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

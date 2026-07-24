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
 
  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }
 
  const { dataInicio = '2026-01-01', paginas = 10 } = req.body || req.query || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  // ── fetchBling com retry ──
  async function fetchBling(url, options = {}, maxRetries = 4) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await sleep(1200 * attempt);
      const resp = await fetch(url, options);
      if (resp.status !== 429) return resp;
    }
    throw new Error('Rate limit persistente');
  }
 
  // ── Supabase helpers ──
  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
 
  async function sbUpsert(table, data) {
    return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data)
    });
  }
 
  // ── Obter access token ──
  async function getToken() {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=*`, { headers: sbHeaders });
    const rows = await r.json();
    const row = rows?.[0];
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
      method: 'PATCH', headers: sbHeaders,
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
    if (!token) return res.status(401).json({ error: 'Bling não autorizado. Acesse /api/bling-connect.' });
 
    const bHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
 
    // ── DIAGNÓSTICO: testar o endpoint primeiro ──
    const testUrl = `https://www.bling.com.br/Api/v3/nfe?pagina=1&limite=10&dataEmissaoInicial=${dataInicio}`;
    console.log('Testando endpoint:', testUrl);
 
    const testResp = await fetchBling(testUrl, { headers: bHeaders });
    const testData = await testResp.json();
 
    console.log('Status HTTP:', testResp.status);
    console.log('Resposta diagnóstico:', JSON.stringify(testData).substring(0, 500));
 
    // Se deu erro no endpoint, retornar diagnóstico
    if (!testResp.ok) {
      return res.status(200).json({
        ok: false,
        diagnostico: true,
        status_http: testResp.status,
        resposta_bling: testData,
        mensagem: 'Endpoint NF retornou erro — veja resposta_bling para detalhes'
      });
    }
 
    const nfsTotal = testData?.data || [];
    console.log(`Página de teste: ${nfsTotal.length} NFs, estrutura:`, JSON.stringify(nfsTotal[0] || {}).substring(0, 300));
 
    // Se veio 0 mesmo sem filtro de situação, testar pedidos de venda como fallback
    if (nfsTotal.length === 0) {
      // Tentar via pedidos de venda
      const pedUrl = `https://www.bling.com.br/Api/v3/pedidos/vendas?pagina=1&limite=10&dataEmissaoInicial=${dataInicio}`;
      const pedResp = await fetchBling(pedUrl, { headers: bHeaders });
      const pedData = await pedResp.json();
 
      return res.status(200).json({
        ok: false,
        diagnostico: true,
        nfe_encontradas: 0,
        pedidos_venda_encontrados: (pedData?.data || []).length,
        amostra_pedidos: (pedData?.data || []).slice(0,2),
        mensagem: 'Nenhuma NF encontrada. Testando pedidos de venda como alternativa.'
      });
    }
 
    // ── Se encontrou NFs, processar todas as páginas ──
    let totalImportadas = 0;
    let totalAtualizadas = 0;
    let erros = [];
    let pagina = 1;
    const maxPaginas = parseInt(paginas) || 10;
 
    // Processar a página de teste
    const todasNFs = [...nfsTotal];
 
    // Buscar páginas restantes
    while (pagina < maxPaginas) {
      pagina++;
      await sleep(500);
      const url = `https://www.bling.com.br/Api/v3/nfe?pagina=${pagina}&limite=100&dataEmissaoInicial=${dataInicio}`;
      try {
        const r = await fetchBling(url, { headers: bHeaders });
        const d = await r.json();
        const nfs = d?.data || [];
        if (!nfs.length) break;
        todasNFs.push(...nfs);
      } catch(e) { erros.push(`Pág ${pagina}: ${e.message}`); break; }
    }
 
    console.log(`Total NFs para processar: ${todasNFs.length}`);
 
    for (const nf of todasNFs) {
      await sleep(300);
      try {
        // Buscar detalhes se necessário
        let detalhe = nf;
        if (!nf.itens && nf.id) {
          try {
            const dr = await fetchBling(`https://www.bling.com.br/Api/v3/nfe/${nf.id}`, { headers: bHeaders });
            const dd = await dr.json();
            detalhe = dd?.data || nf;
            await sleep(300);
          } catch(e) { console.warn('Detalhe falhou:', nf.id); }
        }
 
        const dataEmissao = (detalhe.dataEmissao || nf.dataEmissao || '').substring(0, 10);
        const total = parseFloat(detalhe.totalProdutos || detalhe.valor || detalhe.total || nf.totalProdutos || nf.valor || 0);
        const blingId = String(nf.id);
 
        // Verificar se já existe
        const ex = await fetch(`${SUPABASE_URL}/rest/v1/pedidos?bling_id=eq.${blingId}&select=id,total,fat_data`, { headers: sbHeaders });
        const exRows = await ex.json();
        const jaExiste = exRows?.[0];
 
        const clienteJson = JSON.stringify({
          razao: detalhe.contato?.nome || nf.contato?.nome || 'Importado do Bling',
          cnpj: (detalhe.contato?.numeroDocumento || '').replace(/\D/g, ''),
          tipo: detalhe.contato?.tipoPessoa === 'J' ? 'PJ' : 'PF'
        });
 
        const itensJson = JSON.stringify((detalhe.itens || []).map(it => ({
          nome: it.descricao || it.produto?.descricao || '—',
          qty: it.quantidade || 1,
          price: parseFloat(it.valor || 0),
          safra: ''
        })));
 
        if (jaExiste) {
          if (jaExiste.fat_data !== dataEmissao || Math.abs((jaExiste.total||0) - total) > 0.01) {
            await sbUpsert('pedidos', { id: jaExiste.id, fat_data: dataEmissao, total, updated_at: new Date().toISOString() });
            totalAtualizadas++;
          }
        } else {
          await sbUpsert('pedidos', {
            id: `BLING-${blingId}`,
            bling_id: blingId,
            bling_sent_at: dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
            status: 'fechado',
            origem: 'bling_sync',
            total,
            data: dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
            fat_data: dataEmissao,
            fat_forma: '', fat_parcelas: 1, fat_prazos: '',
            cliente_json: clienteJson,
            itens_json: itensJson,
            vendedor: '', vendedor_name: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
          totalImportadas++;
        }
      } catch(e) {
        erros.push(`NF ${nf.id}: ${e.message}`);
      }
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
      total_nfs_encontradas: todasNFs.length,
      erros: erros.length,
      detalheErros: erros.slice(0,5)
    });
 
  } catch (err) {
    console.error('SYNC ERRO:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

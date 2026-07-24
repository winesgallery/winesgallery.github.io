// api/sync-bling.js — Importa NFs do Bling para o Supabase
// Chamado pelo Vercel Cron (diariamente às 6h) ou manualmente pelo admin
 
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
 
  // Data de início: parâmetro ou 2026-01-01
  const { dataInicio = '2026-01-01', paginas = 10 } = req.body || req.query || {};
 
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  // ── fetchBling com retry para rate limit ──
  async function fetchBling(url, options = {}, maxRetries = 4) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = 1200 * attempt;
        console.log(`Rate limit — aguardando ${wait}ms (tentativa ${attempt + 1})`);
        await sleep(wait);
      }
      const resp = await fetch(url, options);
      if (resp.status !== 429) return resp;
    }
    throw new Error('Rate limit persistente após múltiplas tentativas');
  }
 
  // ── Supabase helpers ──
  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates'
  };
 
  async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
    return r.json();
  }
 
  async function sbUpsert(table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data)
    });
    return r;
  }
 
  // ── Obter access token ──
  async function getToken() {
    const rows = await sbGet('bling_tokens?id=eq.1&select=*');
    const row  = rows?.[0];
    if (!row?.refresh_token) return null;
 
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (Date.now() < expiresAt - 60000) return row.access_token;
 
    // Renovar
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) return null;
 
    const newExp = new Date(Date.now() + (d.expires_in || 21600) * 1000).toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({
        access_token: d.access_token,
        refresh_token: d.refresh_token || row.refresh_token,
        expires_at: newExp,
        updated_at: new Date().toISOString()
      })
    });
    return d.access_token;
  }
 
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Bling não autorizado. Acesse /api/bling-connect.' });
 
    const bHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
 
    // ── Buscar NFs emitidas no Bling (paginado) ──
    let totalImportadas = 0;
    let totalAtualizadas = 0;
    let pagina = 1;
    let maxPaginas = parseInt(paginas) || 10;
    let erros = [];
 
    while (pagina <= maxPaginas) {
      console.log(`Buscando NFs — página ${pagina}...`);
      const url = `https://www.bling.com.br/Api/v3/nfe?pagina=${pagina}&limite=100&dataEmissaoInicial=${dataInicio}&situacao=6`;
      // situacao=6 = NF autorizada (emitida com sucesso)
 
      let nfResp;
      try {
        nfResp = await fetchBling(url, { headers: bHeaders });
      } catch (e) {
        erros.push(`Página ${pagina}: ${e.message}`);
        break;
      }
 
      const nfData = await nfResp.json();
      const nfs    = nfData?.data || [];
 
      console.log(`Página ${pagina}: ${nfs.length} NFs encontradas`);
      if (!nfs.length) break; // sem mais resultados
 
      for (const nf of nfs) {
        await sleep(300); // pausa entre NFs para não estourar rate limit
 
        try {
          // Buscar detalhes completos da NF
          let detalhe = nf;
          if (!nf.contato?.nome || !nf.itens) {
            try {
              const dr = await fetchBling(
                `https://www.bling.com.br/Api/v3/nfe/${nf.id}`,
                { headers: bHeaders }
              );
              const dd = await dr.json();
              detalhe = dd?.data || nf;
              await sleep(300);
            } catch (e) {
              console.warn(`Detalhe NF ${nf.id} falhou:`, e.message);
            }
          }
 
          // Verificar se já existe no Supabase pelo bling_id
          const existing = await sbGet(`pedidos?bling_id=eq.${nf.id}&select=id,total,fat_data`);
          const jaExiste  = existing?.[0];
 
          const dataEmissao = (detalhe.dataEmissao || nf.dataEmissao || '').substring(0, 10);
          const total = parseFloat(detalhe.totalProdutos || detalhe.total || nf.totalProdutos || 0);
 
          const clienteJson = JSON.stringify({
            razao: detalhe.contato?.nome || nf.contato?.nome || 'Importado do Bling',
            cnpj:  (detalhe.contato?.numeroDocumento || '').replace(/\D/g, ''),
            tipo:  detalhe.contato?.tipoPessoa === 'J' ? 'PJ' : 'PF'
          });
 
          const itensJson = JSON.stringify(
            (detalhe.itens || []).map(it => ({
              nome:  it.descricao || it.produto?.descricao || '—',
              qty:   it.quantidade || 1,
              price: parseFloat(it.valor || 0),
              safra: ''
            }))
          );
 
          if (jaExiste) {
            // Atualizar: data e total podem ter mudado
            if (jaExiste.fat_data !== dataEmissao || Math.abs((jaExiste.total || 0) - total) > 0.01) {
              await sbUpsert('pedidos', {
                id:           jaExiste.id,
                fat_data:     dataEmissao,
                total:        total,
                updated_at:   new Date().toISOString()
              });
              totalAtualizadas++;
            }
          } else {
            // Criar novo pedido importado
            const novoPedido = {
              id:           `BLING-${nf.id}`,
              bling_id:     String(nf.id),
              bling_sent_at: dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
              status:       'fechado',
              origem:       'bling_sync',
              total:        total,
              data:         dataEmissao ? `${dataEmissao}T12:00:00.000Z` : new Date().toISOString(),
              fat_data:     dataEmissao,
              fat_forma:    '',
              fat_parcelas: 1,
              fat_prazos:   '',
              cliente_json: clienteJson,
              itens_json:   itensJson,
              vendedor:     '',      // sem vendedor identificado no Bling
              vendedor_name:'',
              created_at:   new Date().toISOString(),
              updated_at:   new Date().toISOString()
            };
            await sbUpsert('pedidos', novoPedido);
            totalImportadas++;
          }
        } catch (e) {
          erros.push(`NF ${nf.id}: ${e.message}`);
          console.error(`Erro NF ${nf.id}:`, e.message);
        }
      }
 
      pagina++;
      await sleep(500); // pausa entre páginas
    }
 
    // Gravar log do sync
    await sbUpsert('bling_sync_log', {
      id:            Date.now(),
      executado_em:  new Date().toISOString(),
      importadas:    totalImportadas,
      atualizadas:   totalAtualizadas,
      erros:         erros.length,
      detalhes:      erros.join('\n').substring(0, 2000) || null,
      data_inicio:   dataInicio
    }).catch(() => {}); // log opcional
 
    return res.status(200).json({
      ok:          true,
      importadas:  totalImportadas,
      atualizadas: totalAtualizadas,
      erros:       erros.length,
      detalheErros: erros.slice(0, 10)
    });
 
  } catch (err) {
    console.error('SYNC BLING ERRO:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

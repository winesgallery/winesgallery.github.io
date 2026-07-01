// api/bling-precos.js — Sincroniza preços de produtos com as tabelas de preço do Bling API v3
// Body esperado: { codigoProduto, canal ('b2b'|'b2c'), preco }
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLIENT_ID    = process.env.BLING_CLIENT_ID;
  const CLIENT_SECRET= process.env.BLING_CLIENT_SECRET;
 
  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }
 
  const { codigoProduto, canal, preco } = req.body || {};
  if (!codigoProduto || !canal || preco == null) {
    return res.status(400).json({ error: 'codigoProduto, canal e preco são obrigatórios' });
  }
 
  try {
    // 1. Buscar access token válido do Supabase
    const accessToken = await getValidAccessToken(SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET);
    if (!accessToken) {
      return res.status(401).json({ error: 'Bling não autorizado. Acesse /api/bling-connect.' });
    }
 
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
 
    // 2. Buscar o ID do produto pelo código
    const prodResp = await fetch(`https://www.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigoProduto)}&limite=5`, { headers });
    const prodData = await prodResp.json();
    const produto = prodData?.data?.[0];
    if (!produto?.id) {
      return res.status(404).json({ error: `Produto com código "${codigoProduto}" não encontrado no Bling` });
    }
    const produtoId = produto.id;
 
    // 3. Buscar tabelas de preço cadastradas no Bling
    const tabResp = await fetch('https://www.bling.com.br/Api/v3/tabelasDePrecos?limite=100', { headers });
    const tabData = await tabResp.json();
    const tabelas = tabData?.data || [];
 
    // Identificar tabela B2B ou B2C pelo nome (busca parcial, case insensitive)
    const keyword = canal === 'b2b' ? 'b2b' : 'b2c';
    const tabela = tabelas.find(t => (t.nome || '').toLowerCase().includes(keyword));
    if (!tabela?.id) {
      return res.status(404).json({ error: `Tabela de preço "${canal.toUpperCase()}" não encontrada no Bling. Verifique os nomes das tabelas em Bling > Vendas > Tabelas de Preço.` });
    }
    const tabelaId = tabela.id;
 
    // 4. Atualizar o preço do produto na tabela
    const updateResp = await fetch(`https://www.bling.com.br/Api/v3/tabelasDePrecos/${tabelaId}/itens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        produto: { id: produtoId },
        preco: parseFloat(preco)
      })
    });
    const updateData = await updateResp.json();
 
    if (!updateResp.ok) {
      // Tentar PATCH se POST falhar (produto já existe na tabela)
      const patchResp = await fetch(`https://www.bling.com.br/Api/v3/tabelasDePrecos/${tabelaId}/itens/${produtoId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ preco: parseFloat(preco) })
      });
      const patchData = await patchResp.json();
      if (!patchResp.ok) {
        return res.status(patchResp.status).json({ error: patchData });
      }
      return res.status(200).json({ ok: true, produtoId, tabelaId, preco, via: 'patch' });
    }
 
    return res.status(200).json({ ok: true, produtoId, tabelaId, preco, via: 'post' });
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 
// Reutiliza mesma lógica de refresh do bling.js
async function getValidAccessToken(SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET) {
  const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const getResp = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=*`, { headers });
  const rows = await getResp.json();
  const row = rows?.[0];
  if (!row || !row.refresh_token) return null;
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const isExpired = Date.now() > (expiresAt - 60000);
  if (!isExpired) return row.access_token;
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const refreshResp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  });
  const refreshData = await refreshResp.json();
  if (!refreshResp.ok || !refreshData.access_token) return null;
  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 21600) * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ access_token: refreshData.access_token, refresh_token: refreshData.refresh_token || row.refresh_token, expires_at: newExpiresAt, updated_at: new Date().toISOString() })
  });
  return refreshData.access_token;
}

// api/bling.js — Proxy Vercel para Bling API v3 (com OAuth2 automático)
// O front-end não precisa mais enviar nenhum token; este arquivo
// cuida de buscar, renovar e usar o token salvo no Supabase.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLIENT_ID = process.env.BLING_CLIENT_ID;
  const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;

  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Variáveis de ambiente do Bling/Supabase não configuradas' });
  }

  const { endpoint, payload } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint é obrigatório' });
  }

  try {
    const accessToken = await getValidAccessToken(SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET);

    if (!accessToken) {
      return res.status(401).json({ error: 'Bling ainda não foi autorizado. Acesse /api/bling-connect para conectar.' });
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: result });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getValidAccessToken(SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };

  const getResp = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=*`, { headers });
  const rows = await getResp.json();
  const row = rows?.[0];

  if (!row || !row.refresh_token) return null;

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const isExpired = Date.now() > (expiresAt - 60000); // renova com 1 min de folga

  if (!isExpired) return row.access_token;

  // Renovar usando o refresh_token
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const refreshResp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token
    })
  });

  const refreshData = await refreshResp.json();
  if (!refreshResp.ok || !refreshData.access_token) return null;

  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 21600) * 1000).toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      access_token: refreshData.access_token,
      refresh_token: refreshData.refresh_token || row.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString()
    })
  });

  return refreshData.access_token;
}

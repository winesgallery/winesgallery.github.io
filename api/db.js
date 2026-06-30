// api/db.js — Proxy Vercel para Supabase
// As variáveis SUPABASE_URL e SUPABASE_SERVICE_KEY são configuradas
// nas Vercel Environment Variables (nunca ficam no código)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase não configurado' });
  }

  const { method, table, data, filters, select } = req.body;

  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };

  // Adicionar filtros na URL (ex: ?id=eq.PED-123&excluido=eq.false)
  if (filters && Object.keys(filters).length > 0) {
    const params = Object.entries(filters)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    url += '?' + params;
  }

  // Campos a retornar
  if (select) {
    url += (url.includes('?') ? '&' : '?') + 'select=' + select;
  }

  try {
    let fetchOptions = { headers };
    
    switch (method) {
      case 'SELECT':
        fetchOptions.method = 'GET';
        break;
      case 'INSERT':
        fetchOptions.method = 'POST';
        fetchOptions.body = JSON.stringify(data);
        break;
      case 'UPDATE':
        fetchOptions.method = 'PATCH';
        fetchOptions.body = JSON.stringify(data);
        break;
      case 'DELETE':
        fetchOptions.method = 'DELETE';
        break;
      case 'UPSERT':
        fetchOptions.method = 'POST';
        fetchOptions.body = JSON.stringify(data);
        headers['Prefer'] = 'return=representation,resolution=merge-duplicates';
        break;
      default:
        return res.status(400).json({ error: 'Método inválido' });
    }

    const response = await fetch(url, fetchOptions);
    const result = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: result });
    }
    
    return res.status(200).json({ data: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// api/db.js — Proxy Vercel para Supabase REST (PostgREST)
// Contrato do body (POST):
// { method: 'select'|'insert'|'update'|'upsert'|'delete', table, data, filters, select, order, onConflict }
// - filters: objeto { coluna: valor } -> aplica "coluna=eq.valor" (igualdade simples)
// - select: string de colunas (ex: '*' ou 'id,nome'), só usado em 'select'
// - order: string (ex: 'created_at.desc')
// - onConflict: string de coluna(s) para upsert (ex: 'usuario')
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase não configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes)' });
  }
 
  const { method, table, data, filters, select, order, onConflict } = req.body || {};
  if (!method || !table) {
    return res.status(400).json({ error: 'method e table são obrigatórios' });
  }
 
  const baseHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
 
  function buildQuery() {
    const params = [];
    if (filters && typeof filters === 'object') {
      for (const [col, val] of Object.entries(filters)) {
        params.push(`${col}=eq.${encodeURIComponent(val)}`);
      }
    }
    if (method === 'select') {
      params.push(`select=${encodeURIComponent(select || '*')}`);
      if (order) params.push(`order=${encodeURIComponent(order)}`);
    }
    return params.length ? `?${params.join('&')}` : '';
  }
 
  try {
    let url = `${SUPABASE_URL}/rest/v1/${table}${buildQuery()}`;
    let opts = { headers: { ...baseHeaders } };
 
    if (method === 'select') {
      opts.method = 'GET';
    } else if (method === 'insert') {
      opts.method = 'POST';
      opts.headers['Prefer'] = 'return=representation';
      opts.body = JSON.stringify(data);
    } else if (method === 'upsert') {
      opts.method = 'POST';
      opts.headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
      if (onConflict) url += (url.includes('?') ? '&' : '?') + `on_conflict=${encodeURIComponent(onConflict)}`;
      opts.body = JSON.stringify(data);
    } else if (method === 'update') {
      opts.method = 'PATCH';
      opts.headers['Prefer'] = 'return=representation';
      opts.body = JSON.stringify(data);
    } else if (method === 'delete') {
      opts.method = 'DELETE';
      opts.headers['Prefer'] = 'return=representation';
    } else {
      return res.status(400).json({ error: 'method inválido: ' + method });
    }
 
    const resp = await fetch(url, opts);
    const text = await resp.text();
    const result = text ? JSON.parse(text) : [];
 
    if (!resp.ok) {
      return res.status(resp.status).json({ error: result });
    }
    return res.status(200).json({ data: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

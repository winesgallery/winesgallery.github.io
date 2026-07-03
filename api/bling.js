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
 
    // Para pedidos de venda e orçamentos, o Bling exige um contato.id válido.
    // Se o payload veio só com nome/documento, resolve (busca ou cria) o contato primeiro.
    if (payload?.contato && !payload.contato.id && (endpoint.includes('/pedidos/vendas') || endpoint.includes('/orcamentos'))) {
      const contatoId = await resolveContatoId(payload.contato, accessToken);
      if (!contatoId) {
        return res.status(400).json({ error: { description: 'Não foi possível localizar nem cadastrar o contato no Bling. Verifique se o CNPJ/CPF do cliente está correto.' } });
      }
      payload.contato = { id: contatoId };
    }
 
    // Resolve o ID da forma de pagamento (PIX/Boleto/Transferência) cadastrada no Bling
    if (Array.isArray(payload?.parcelas) && payload.parcelas.length) {
      const formaPagamentoId = await resolveFormaPagamentoId(payload.parcelas[0].formaPagamentoTipo, accessToken);
      if (!formaPagamentoId) {
        return res.status(400).json({ error: { description: 'Não foi possível localizar uma forma de pagamento cadastrada no Bling. Cadastre formas de pagamento em Bling > Vendas > Formas de Pagamento.' } });
      }
      payload.parcelas = payload.parcelas.map(p => ({
        valor: p.valor,
        dataVencimento: p.dataVencimento,
        formaPagamento: { id: formaPagamentoId }
      }));
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
 
async function resolveFormaPagamentoId(tipo, accessToken) {
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const keywords = { pix: 'pix', boleto: 'boleto', transferencia: 'transferência' };
  const keyword = keywords[tipo] || tipo || '';
 
  try {
    const resp = await fetch('https://www.bling.com.br/Api/v3/formas-pagamentos?limite=100', { headers });
    const data = await resp.json();
    const lista = data?.data || [];
    if (!lista.length) return null;
    const match = lista.find(f => (f.descricao || '').toLowerCase().includes(keyword.toLowerCase()));
    return (match || lista[0]).id;
  } catch (e) {
    return null;
  }
}
async function resolveContatoId(contato, accessToken) {
  const documento = (contato.documento || '').replace(/\D/g, '');
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
 
  if (documento) {
    try {
      // Busca por documento — sem filtro de situação para pegar ativos e inativos
      const searchResp = await fetch(
        `https://www.bling.com.br/Api/v3/contatos?numeroDocumento=${documento}&limite=5`,
        { headers }
      );
      const searchData = await searchResp.json();
      // Pegar primeiro resultado independente do status
      const found = searchData?.data?.[0];
      if (found?.id) {
        // Se inativo, reativar
        if (found.situacao === 'I') {
          await fetch(`https://www.bling.com.br/Api/v3/contatos/${found.id}`, {
            method: 'PUT', headers,
            body: JSON.stringify({ ...found, situacao: 'A' })
          });
        }
        return found.id;
      }
      // Tentar busca alternativa por nome se não achou por documento
      if (contato.nome) {
        const nameResp = await fetch(
          `https://www.bling.com.br/Api/v3/contatos?pesquisa=${encodeURIComponent(contato.nome)}&limite=5`,
          { headers }
        );
        const nameData = await nameResp.json();
        // Procurar correspondência por documento
        const byDoc = (nameData?.data || []).find(c =>
          (c.numeroDocumento || '').replace(/\D/g, '') === documento
        );
        if (byDoc?.id) return byDoc.id;
      }
    } catch (e) { /* segue para criar */ }
  }
 
  // Não encontrou: cria um contato novo
  try {
    const tipoPessoa = documento.length > 11 ? 'J' : 'F';
    const body = {
      nome: contato.nome || 'Cliente sem nome',
      tipoPessoa,
      situacao: 'A'
    };
    if (documento) body.numeroDocumento = documento;
    if (tipoPessoa === 'J' && contato.ie) body.ie = contato.ie;
 
    const createResp = await fetch('https://www.bling.com.br/Api/v3/contatos', {
      method: 'POST', headers,
      body: JSON.stringify(body)
    });
    const createData = await createResp.json();
    if (createResp.ok && createData?.data?.id) return createData.data.id;
 
    // Se falhou na criação, logar o motivo real
    console.error('Falha ao criar contato no Bling:', JSON.stringify(createData));
 
    // Tentar busca sem documento como último recurso
    if (documento) {
      const retryResp = await fetch(`https://www.bling.com.br/Api/v3/contatos?numeroDocumento=${documento}&limite=5`, { headers });
      const retryData = await retryResp.json();
      const retryFound = retryData?.data?.[0];
      if (retryFound?.id) return retryFound.id;
    }
    return null;
  } catch (e) {
    console.error('Erro ao resolver contato:', e.message);
    return null;
  }
}

// api/bling.js — Proxy Vercel para Bling API v3 (com OAuth2 + retry automático)
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const CLIENT_ID     = process.env.BLING_CLIENT_ID;
  const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
 
  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Variáveis de ambiente do Bling/Supabase não configuradas' });
  }
 
  const { endpoint, payload } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint é obrigatório' });
 
  // ── Helper: sleep ──
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  // ── Helper: fetch com retry automático para rate limit (429) ──
  async function fetchBling(url, options, maxRetries = 4) {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = 1000 * attempt; // 1s, 2s, 3s
        console.log(`Rate limit atingido — aguardando ${wait}ms antes da tentativa ${attempt + 1}...`);
        await sleep(wait);
      }
      try {
        const resp = await fetch(url, options);
        // Rate limit → aguardar e tentar de novo
        if (resp.status === 429) {
          lastErr = new Error('rate_limit');
          continue;
        }
        return resp;
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries - 1) await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error('Máximo de tentativas atingido (rate limit)');
  }
 
  try {
    const accessToken = await getValidAccessToken(
      SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET, sleep
    );
 
    if (!accessToken) {
      return res.status(401).json({
        error: 'Bling ainda não foi autorizado. Acesse /api/bling-connect para conectar.'
      });
    }
 
    const blingHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
 
    const isVendaOuOrc = endpoint.includes('/pedidos/vendas') || endpoint.includes('/orcamentos');
 
    // ── 1. Resolver contato ──
    if (payload?.contato && !payload.contato.id && isVendaOuOrc) {
      const diag = [];
      const contatoId = await resolveContatoId(payload.contato, blingHeaders, fetchBling, sleep, diag);
      if (!contatoId) {
        console.error('DIAGNOSTICO CONTATO:', JSON.stringify(diag));
        return res.status(400).json({
          error: {
            description: 'Não foi possível localizar nem cadastrar o contato no Bling. Verifique o CNPJ/CPF do cliente.',
            diagnostico: diag
          }
        });
      }
      payload.contato = { id: contatoId };
      await sleep(350); // pausa antes da próxima chamada
    }
 
    // ── 2. Resolver forma de pagamento ──
    if (Array.isArray(payload?.parcelas) && payload.parcelas.length) {
      const tipo = payload.parcelas[0].formaPagamentoTipo;
      const formaPagamentoId = await resolveFormaPagamentoId(tipo, blingHeaders, fetchBling);
      if (!formaPagamentoId) {
        return res.status(400).json({
          error: { description: 'Nenhuma forma de pagamento encontrada no Bling. Cadastre em Bling > Vendas > Formas de Pagamento.' }
        });
      }
      payload.parcelas = payload.parcelas.map(p => ({
        valor: p.valor,
        dataVencimento: p.dataVencimento,
        formaPagamento: { id: formaPagamentoId }
      }));
      await sleep(350);
    }
 
    // ── 3. Resolver produtos (com delay entre cada item) ──
    if (Array.isArray(payload?.itens) && payload.itens.length && isVendaOuOrc) {
      for (const item of payload.itens) {
        if (item.codigo && !item.produto) {
          let prod = null;
 
          // Busca por código
          try {
            const r1 = await fetchBling(
              `https://www.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(item.codigo)}&limite=5`,
              { headers: blingHeaders }
            );
            const d1 = await r1.json();
            prod = d1?.data?.[0];
          } catch (e) {
            console.warn('Erro busca produto por código:', e.message);
          }
 
          // Busca por descrição se não achou por código
          if (!prod?.id && item.descricao) {
            await sleep(400); // pausa obrigatória entre buscas
            try {
              const r2 = await fetchBling(
                `https://www.bling.com.br/Api/v3/produtos?nome=${encodeURIComponent(item.descricao)}&limite=5`,
                { headers: blingHeaders }
              );
              const d2 = await r2.json();
              prod = d2?.data?.[0];
            } catch (e) {
              console.warn('Erro busca produto por nome:', e.message);
            }
          }
 
          if (prod?.id) {
            item.produto = { id: prod.id };
            delete item.codigo;
            delete item.descricao;
          } else {
            console.warn(`Produto não encontrado: código=${item.codigo}`);
          }
 
          await sleep(400); // pausa entre itens
        }
      }
    }
 
    // ── 4. Enviar pedido/orçamento ao Bling ──
    console.log('PAYLOAD ENVIADO AO BLING:', JSON.stringify(payload));
 
    const response = await fetchBling(endpoint, {
      method: 'POST',
      headers: blingHeaders,
      body: JSON.stringify(payload)
    });
 
    const result = await response.json();
 
    if (!response.ok) {
      console.error('ERRO DO BLING:', JSON.stringify(result));
      return res.status(response.status).json({ error: result });
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    console.error('ERRO BLING HANDLER:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
 
// ── OAuth: busca ou renova o access token ──
async function getValidAccessToken(SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, CLIENT_SECRET, sleep) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
 
  const getResp = await fetch(
    `${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=*`,
    { headers }
  );
  const rows = await getResp.json();
  const row  = rows?.[0];
 
  if (!row?.refresh_token) return null;
 
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const isExpired  = Date.now() > (expiresAt - 60000);
 
  if (!isExpired) return row.access_token;
 
  // Renovar token
  const basicAuth   = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const refreshResp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
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
      access_token:  refreshData.access_token,
      refresh_token: refreshData.refresh_token || row.refresh_token,
      expires_at:    newExpiresAt,
      updated_at:    new Date().toISOString()
    })
  });
 
  return refreshData.access_token;
}
 
// ── Resolver forma de pagamento pelo tipo ──
async function resolveFormaPagamentoId(tipo, blingHeaders, fetchBling) {
  const keywords = { pix: 'pix', boleto: 'boleto', transferencia: 'transferência', dinheiro: 'dinheiro' };
  const keyword  = keywords[tipo] || tipo || '';
 
  try {
    const resp = await fetchBling(
      'https://www.bling.com.br/Api/v3/formas-pagamentos?limite=100',
      { headers: blingHeaders }
    );
    const data  = await resp.json();
    const lista = data?.data || [];
    if (!lista.length) return null;
    const match = lista.find(f => (f.descricao || '').toLowerCase().includes(keyword.toLowerCase()));
    return (match || lista[0]).id;
  } catch (e) {
    return null;
  }
}
 
// ── Resolver contato: busca por CNPJ/CPF ou nome, cria se não existir ──
// Cada passo registra em `diag` o que o Bling respondeu (status + trecho do corpo),
// para que o motivo real apareça no e-mail de falha.
function formatarDocumento(d) {
  if (d.length === 14) return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
  return d;
}
 
async function resolveContatoId(contato, blingHeaders, fetchBling, sleep, diag = []) {
  const documento = (contato.documento || '').replace(/\D/g, '');
  const soDigitos = v => String(v || '').replace(/\D/g, '');
  const trecho = o => { try { return JSON.stringify(o).slice(0, 400); } catch (e) { return String(o).slice(0, 400); } };
 
  // Faz uma busca, registra o resultado e devolve a lista de contatos (ou null se deu erro)
  async function listar(passo, queryString) {
    try {
      const r = await fetchBling(
        `https://www.bling.com.br/Api/v3/contatos?${queryString}&limite=20`,
        { headers: blingHeaders }
      );
      const txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) {}
      if (!r.ok) {
        diag.push({ passo, status: r.status, resposta: txt.slice(0, 400) });
        return null;
      }
      const lista = d?.data || [];
      diag.push({ passo, status: r.status, encontrados: lista.length });
      return lista;
    } catch (e) {
      diag.push({ passo, erro: e.message });
      return null;
    }
  }
 
  // Escolhe, na lista, o contato cujo documento bate; se só houver 1 resultado, usa ele
  function escolher(lista) {
    if (!lista || !lista.length) return null;
    if (documento) {
      const porDoc = lista.find(c => soDigitos(c.numeroDocumento) === documento);
      if (porDoc?.id) return porDoc.id;
    }
    return null;
  }
 
  // 1. Por documento (só dígitos e depois com pontuação)
  if (documento) {
    let achou = escolher(await listar('busca numeroDocumento (digitos)', `numeroDocumento=${documento}`));
    if (achou) return achou;
    await sleep(400);
 
    const fmt = formatarDocumento(documento);
    if (fmt !== documento) {
      achou = escolher(await listar('busca numeroDocumento (formatado)', `numeroDocumento=${encodeURIComponent(fmt)}`));
      if (achou) return achou;
      await sleep(400);
    }
 
    // pesquisa livre pelo documento
    achou = escolher(await listar('pesquisa pelo documento', `pesquisa=${documento}`));
    if (achou) return achou;
    await sleep(400);
  }
 
  // 2. Por nome
  if (contato.nome) {
    const lista = await listar('pesquisa por nome', `pesquisa=${encodeURIComponent(contato.nome)}`);
    const porDoc = escolher(lista);
    if (porDoc) return porDoc;
    // só aceita único resultado por nome quando o cadastro no Bling não tem documento para conferir
    if (lista && lista.length === 1 && lista[0]?.id && !soDigitos(lista[0].numeroDocumento)) return lista[0].id;
    await sleep(400);
  }
 
  // 3. Criar contato
  try {
    const tipoPessoa = documento.length > 11 ? 'J' : 'F';
    const body = { nome: contato.nome || 'Cliente', tipo: tipoPessoa, situacao: 'A' };
    if (documento) body.numeroDocumento = documento;
    if (tipoPessoa === 'J') {
      if (contato.ie) { body.ie = contato.ie; body.indicadorIe = 1; }
      else body.indicadorIe = 9; // não contribuinte
    }
    if (contato.telefone) body.celular = soDigitos(contato.telefone);
    if (contato.email) body.email = contato.email;
    const geral = contato.endereco?.geral;
    if (geral && (geral.endereco || geral.cep || geral.municipio)) {
      // "São Paulo SP" → município "São Paulo" + UF "SP"
      let municipio = (geral.municipio || '').trim(), uf = '';
      const m = municipio.match(/^(.*?)[\s,\-\/]+([A-Za-z]{2})$/);
      if (m) { municipio = m[1].trim(); uf = m[2].toUpperCase(); }
      body.endereco = { geral: { endereco: geral.endereco || '', cep: geral.cep || '', municipio, uf } };
    }
 
    const r = await fetchBling(
      'https://www.bling.com.br/Api/v3/contatos',
      { method: 'POST', headers: blingHeaders, body: JSON.stringify(body) }
    );
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) {}
    diag.push({ passo: 'cadastro do contato', status: r.status, resposta: txt.slice(0, 600) });
 
    if (r.ok && d?.data?.id) return d.data.id;
 
    // Bling pode rejeitar por duplicidade mas já ter o contato — tentar buscar de novo
    if (documento) {
      await sleep(600);
      const achou = escolher(await listar('nova busca após falha no cadastro', `numeroDocumento=${documento}`));
      if (achou) return achou;
    }
 
    console.error('Falha ao criar contato:', txt);
    return null;
  } catch (e) {
    diag.push({ passo: 'cadastro do contato', erro: e.message });
    console.error('Erro ao resolver contato:', e.message);
    return null;
  }
}
 

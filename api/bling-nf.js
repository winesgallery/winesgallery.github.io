// api/bling-nf.js
// Busca no Bling as notas fiscais dos pedidos que ainda estão "aguardando NF" e grava em pedido_fluxo.
// POST (ou GET, para uso em cron) sem corpo: verifica até 12 pedidos pendentes, os verificados há mais tempo primeiro.
// Pedidos com NF informada à mão (nf_manual = true) nunca são tocados.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const CID = process.env.BLING_CLIENT_ID;
  const CSEC = process.env.BLING_CLIENT_SECRET;
  if (!SB || !KEY || !CID || !CSEC) return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });

  const sb = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { verificados: 0, emitidas: [], semNota: 0, erros: [] };

  try {
    const pend = await (await fetch(
      `${SB}/rest/v1/pedido_fluxo?nf_status=eq.aguardando&nf_manual=eq.false&select=pedido_id&order=nf_verificado_em.asc.nullsfirst&limit=12`,
      { headers: sb })).json();
    if (!Array.isArray(pend) || !pend.length) return res.status(200).json(out);

    const inList = pend.map(r => `"${String(r.pedido_id).replace(/"/g, '')}"`).join(',');
    const peds = await (await fetch(
      `${SB}/rest/v1/pedidos?id=in.(${encodeURIComponent(inList)})&select=id,bling_id`, { headers: sb })).json();
    const blingDe = {};
    (peds || []).forEach(p => { blingDe[p.id] = p.bling_id; });
    // amostras (bonificação) também têm NF: o ID do Bling delas fica em pedidos_amostras
    const faltam = pend.map(r => r.pedido_id).filter(id => !blingDe[id]);
    if (faltam.length) {
      const il = faltam.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const ams = await (await fetch(
        `${SB}/rest/v1/pedidos_amostras?id=in.(${encodeURIComponent(il)})&select=id,bling_id`, { headers: sb })).json();
      (Array.isArray(ams) ? ams : []).forEach(a => { blingDe[a.id] = a.bling_id; });
    }

    const token = await getValidAccessToken(SB, KEY, CID, CSEC);
    if (!token) return res.status(401).json({ error: 'Bling não conectado. Acesse /api/bling-connect.' });
    const bh = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    const patch = (pid, data) => fetch(`${SB}/rest/v1/pedido_fluxo?pedido_id=eq.${encodeURIComponent(pid)}`,
      { method: 'PATCH', headers: sb, body: JSON.stringify(data) });

    for (const r of pend) {
      const pid = r.pedido_id;
      const bid = blingDe[pid];
      const agora = new Date().toISOString();
      try {
        out.verificados++;
        if (!bid) { await patch(pid, { nf_verificado_em: agora, nf_erro: 'Pedido sem ID do Bling' }); continue; }
        const pr = await fetch(`https://api.bling.com.br/Api/v3/pedidos/vendas/${bid}`, { headers: bh });
        const pj = await pr.json();
        if (!pr.ok) throw new Error('Bling pedido ' + pr.status + ': ' + JSON.stringify(pj).slice(0, 200));
        const nfId = pj?.data?.notaFiscal?.id;
        await sleep(400);
        if (!nfId) { out.semNota++; await patch(pid, { nf_verificado_em: agora, nf_erro: null }); continue; }
        const nr = await fetch(`https://api.bling.com.br/Api/v3/nfe/${nfId}`, { headers: bh });
        const nj = await nr.json();
        if (!nr.ok) throw new Error('Bling NF ' + nr.status + ': ' + JSON.stringify(nj).slice(0, 200));
        const d = nj?.data || {};
        const numero = d.numero ? String(d.numero) : '';
        const chave = d.chaveAcesso || '';
        const sit = d.situacao != null ? String(d.situacao) : '';
        const emitida = !!numero && (!!chave || sit === '5' || sit === '6');
        if (!emitida) {
          await patch(pid, { nf_verificado_em: agora, nf_bling_id: String(nfId), nf_bling_situacao: sit, nf_erro: null });
        } else {
          await patch(pid, {
            nf_status: 'emitida', nf_origem: 'bling', nf_bling_id: String(nfId), nf_bling_situacao: sit,
            nf_numero: numero, nf_serie: d.serie != null ? String(d.serie) : null, nf_chave: chave || null,
            nf_data: d.dataEmissao ? String(d.dataEmissao).slice(0, 10) : null,
            nf_pdf_url: d.linkPDF || d.linkDanfe || null, nf_xml_url: d.xml || null,
            nf_verificado_em: agora, nf_emitida_em: agora, nf_erro: null,
          });
          await fetch(`${SB}/rest/v1/pedido_fluxo_historico`, { method: 'POST', headers: sb,
            body: JSON.stringify({ pedido_id: pid, etapa: 'nf', texto: 'NF ' + numero + ' emitida (buscada no Bling)', usuario: 'sistema' }) });
          out.emitidas.push(pid);
        }
        await sleep(400);
      } catch (e) {
        out.erros.push({ pedido: pid, erro: e.message });
        await patch(pid, { nf_verificado_em: agora, nf_erro: String(e.message).slice(0, 300) });
      }
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getValidAccessToken(SB, KEY, CID, CSEC) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const rows = await (await fetch(`${SB}/rest/v1/bling_tokens?id=eq.1&select=*`, { headers })).json();
  const row = rows?.[0];
  if (!row?.refresh_token) return null;
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (Date.now() <= exp - 60000) return row.access_token;
  const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const rr = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const rd = await rr.json();
  if (!rr.ok || !rd.access_token) return null;
  await fetch(`${SB}/rest/v1/bling_tokens?id=eq.1`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ access_token: rd.access_token, refresh_token: rd.refresh_token || row.refresh_token,
      expires_at: new Date(Date.now() + (rd.expires_in || 21600) * 1000).toISOString(), updated_at: new Date().toISOString() }),
  });
  return rd.access_token;
}

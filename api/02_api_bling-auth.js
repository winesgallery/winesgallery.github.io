// api/bling-auth.js — Recebe o callback OAuth2 do Bling
// Troca o "code" por access_token + refresh_token e salva no Supabase
// Acesse este endpoint visitando o link de autorização do Bling

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLIENT_ID = process.env.BLING_CLIENT_ID;
  const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
  const REDIRECT_URI = process.env.BLING_REDIRECT_URI;

  if (!SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send('Variáveis de ambiente do Bling não configuradas no Vercel.');
  }

  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Código de autorização não recebido. Use o link de autorização do Bling.');
  }

  try {
    const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const tokenResp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok || !tokenData.access_token) {
      return res.status(400).send('Falha ao trocar código por token: ' + JSON.stringify(tokenData));
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 21600) * 1000).toISOString();

    // Salva (upsert) na tabela bling_tokens, linha única id=1
    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      })
    });

    if (!saveResp.ok) {
      const err = await saveResp.json();
      return res.status(500).send('Token obtido, mas falhou ao salvar no Supabase: ' + JSON.stringify(err));
    }

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>✅ Bling conectado com sucesso!</h2>
        <p>Pode fechar esta aba e voltar para o sistema de pedidos.</p>
      </body></html>
    `);
  } catch (err) {
    return res.status(500).send('Erro: ' + err.message);
  }
}

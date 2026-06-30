// api/bling-connect.js — Acesse esta URL no navegador para autorizar o app no Bling
// Ex: https://winesgallerygithub.vercel.app/api/bling-connect

export default async function handler(req, res) {
  const CLIENT_ID = process.env.BLING_CLIENT_ID;
  const REDIRECT_URI = process.env.BLING_REDIRECT_URI;

  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send('BLING_CLIENT_ID ou BLING_REDIRECT_URI não configurados no Vercel.');
  }

  const state = Math.random().toString(36).slice(2);
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.writeHead(302, { Location: url });
  res.end();
}

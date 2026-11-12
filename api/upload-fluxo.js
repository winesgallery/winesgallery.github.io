// api/upload-fluxo.js
// Recebe um arquivo em base64 e salva no bucket privado "fluxo" (NF, boletos, comprovantes, CT-e).
// Devolve o caminho e uma URL assinada válida por 5 anos.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'fluxo';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { filename, contentType, base64, pasta } = req.body || {};
    if (!filename || !contentType || !base64) {
      return res.status(400).json({ error: 'filename, contentType e base64 são obrigatórios' });
    }
    const dir = String(pasta || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = `${dir}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const buffer = Buffer.from(base64, 'base64');
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buffer,
    });
    if (!up.ok) return res.status(500).json({ error: 'Falha no upload: ' + (await up.text()) });
    const sign = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 365 * 5 }),
    });
    const sj = await sign.json();
    const url = sj.signedURL ? `${SUPABASE_URL}/storage/v1${sj.signedURL}` : null;
    return res.status(200).json({ path, url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

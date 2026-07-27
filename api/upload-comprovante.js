// api/upload-comprovante.js
// Recebe um arquivo em base64 e salva no bucket "comprovantes" do Supabase Storage.
// Reaproveita as mesmas variáveis de ambiente já usadas em api/db.js (SUPABASE_URL, SUPABASE_SERVICE_KEY).
// Se os nomes das variáveis no seu projeto forem diferentes, ajuste as duas linhas abaixo.
 
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'comprovantes';
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const { filename, contentType, base64 } = req.body || {};
    if (!filename || !contentType || !base64) {
      return res.status(400).json({ error: 'filename, contentType e base64 são obrigatórios' });
    }
 
    const path = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const buffer = Buffer.from(base64, 'base64');
 
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: buffer,
      }
    );
    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return res.status(500).json({ error: 'Falha no upload: ' + errText });
    }
 
    // Bucket privado — gera uma URL assinada válida por 90 dias para exibição no app.
    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 90 }),
      }
    );
    const signJson = await signResp.json();
    const signedUrl = signJson.signedURL
      ? `${SUPABASE_URL}/storage/v1${signJson.signedURL}`
      : null;
 
    return res.status(200).json({ path, url: signedUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

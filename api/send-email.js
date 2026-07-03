// api/send-email.js — Envia email com PDF do pedido via Resend
// Body: { para, cc, subject, body, pdfBase64, pdfFileName }
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
 
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY não configurada no Vercel' });
  }
 
  const { para, cc, subject, body, pdfBase64, pdfFileName } = req.body || {};
  if (!para || !subject) {
    return res.status(400).json({ error: 'para e subject são obrigatórios' });
  }
 
  // Montar payload do Resend
  const payload = {
    from: 'Wine\'s Gallery <pedidos@winesgallery.com.br>',
    to: [para],
    subject,
    text: body || '',
    // HTML simples com o mesmo conteúdo
    html: `<pre style="font-family:monospace;font-size:13px;line-height:1.6;">${(body || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`,
  };
 
  // CC opcional
  if (cc) payload.cc = [cc];
 
  // PDF em anexo (base64)
  if (pdfBase64 && pdfFileName) {
    payload.attachments = [{
      filename: pdfFileName,
      content: pdfBase64,
    }];
  }
 
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
 
    const data = await resp.json();
 
    if (!resp.ok) {
      return res.status(resp.status).json({ error: data?.message || data?.error || JSON.stringify(data) });
    }
 
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

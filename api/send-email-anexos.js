// api/send-email-anexos.js
// Envia e-mail pelo Resend ANEXANDO arquivos do bucket privado "fluxo" (NF, boletos, comprovantes).
// Recebe: { para, cc, subject, body, anexos: [{ url, filename }] }
// Só aceita URLs assinadas do próprio bucket "fluxo" do Supabase do projeto.
const SUPABASE_URL = process.env.SUPABASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'Wines Gallery <pedidos@winesgallery.com.br>';
const PREFIXO = `${SUPABASE_URL}/storage/v1/object/sign/fluxo/`;
const LIMITE_TOTAL = 30 * 1024 * 1024; // 30 MB (limite do Resend: 40 MB)

export const config = { api: { bodyParser: { sizeLimit: '1mb' }, maxDuration: 60 } };

const lista = (v) => String(v || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY não configurada' });
    const { para, cc, subject, body, anexos } = req.body || {};
    const to = lista(para);
    if (!to.length || !subject || !body) return res.status(400).json({ error: 'Informe destinatário, assunto e mensagem' });

    const attachments = [];
    let total = 0;
    for (const a of Array.isArray(anexos) ? anexos : []) {
      if (!a || typeof a.url !== 'string' || !a.url.startsWith(PREFIXO)) {
        return res.status(400).json({ error: 'Anexo inválido (só arquivos do sistema são aceitos)' });
      }
      const r = await fetch(a.url);
      if (!r.ok) return res.status(502).json({ error: `Não consegui buscar o arquivo "${a.filename || 'anexo'}" (HTTP ${r.status})` });
      const buf = Buffer.from(await r.arrayBuffer());
      total += buf.length;
      if (total > LIMITE_TOTAL) return res.status(413).json({ error: 'Os anexos passam de 30 MB no total' });
      const nome = String(a.filename || 'anexo.pdf').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      attachments.push({ filename: nome, content: buf.toString('base64') });
    }

    const payload = { from: FROM, to, subject, text: body };
    const ccs = lista(cc);
    if (ccs.length) payload.cc = ccs;
    if (attachments.length) payload.attachments = attachments;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: j.message || j.error || 'Falha no envio pelo Resend' });
    return res.status(200).json({ ok: true, id: j.id, anexos: attachments.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

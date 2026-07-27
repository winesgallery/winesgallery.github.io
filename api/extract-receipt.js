// api/extract-receipt.js
// Recebe um comprovante/boleto em base64 e pede pra Claude extrair os dados estruturados.
// Requer a variável de ambiente ANTHROPIC_API_KEY configurada no Vercel (Settings → Environment Variables).
 
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
 
const CATEGORIAS_VALIDAS = ['frete', 'imposto', 'custo_fixo', 'custo_variavel', 'evento', 'outro'];
 
const PROMPT = `Você está analisando um comprovante de pagamento, boleto ou nota fiscal de despesa de uma importadora/distribuidora de vinhos.
Extraia os dados e responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois, no formato:
{
  "descricao": "string curta descrevendo o que é a despesa (ex: fornecedor + o que foi pago)",
  "valor": number (apenas o número, sem R$, sem separador de milhar, use ponto decimal),
  "data_vencimento": "YYYY-MM-DD" (data de vencimento ou pagamento do documento),
  "categoria": uma destas opções exatas: "frete", "imposto", "custo_fixo", "custo_variavel", "evento", "outro",
  "fornecedor": "string com o nome do fornecedor/beneficiário, se identificável"
}
Se algum campo não for identificável, use null nesse campo (exceto valor, que deve ser sua melhor estimativa numérica).
Categorize como "custo_fixo" se parecer aluguel, salário, contador, sistema/software, marketing, telefonia. Categorize como "frete" se for transportadora/logística. Categorize como "imposto" se for DARF, guia de imposto, ICMS/PIS/COFINS/IPI. Categorize como "evento" se mencionar degustação, feira, evento, patrocínio. Caso contrário, "outro".`;
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no Vercel ainda. Configure em Settings → Environment Variables.' });
  }
 
  try {
    const { base64, contentType } = req.body || {};
    if (!base64 || !contentType) {
      return res.status(400).json({ error: 'base64 e contentType são obrigatórios' });
    }
 
    const isPdf = contentType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } };
 
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [
          { role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] },
        ],
      }),
    });
 
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(500).json({ error: data?.error?.message || 'Erro na API da Claude' });
    }
 
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    let parsed;
    try {
      const clean = (textBlock?.text || '').replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(500).json({ error: 'Não consegui interpretar a resposta da IA', raw: textBlock?.text });
    }
 
    if (!CATEGORIAS_VALIDAS.includes(parsed.categoria)) parsed.categoria = 'outro';
 
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

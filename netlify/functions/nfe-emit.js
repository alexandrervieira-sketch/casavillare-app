/**
 * Netlify Function — Proxy seguro para NFE.io
 * Casa Villare Ambientes Planejados
 *
 * Esta função recebe o payload do sistema, adiciona a API Key no servidor
 * (nunca exposta no navegador) e envia para a API NFE.io.
 *
 * Endpoint: /.netlify/functions/nfe-emit (POST)
 * Body: { payload: {...}, apiKey: "...", empresaId: "..." }
 */

exports.handler = async (event) => {
  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Headers CORS para permitir chamada do browser
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Preflight OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { payload, apiKey, empresaId } = JSON.parse(event.body || '{}');

    if (!apiKey || !empresaId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'API Key e ID da Empresa são obrigatórios.' })
      };
    }

    if (!payload || !payload.itens || !payload.itens.length) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Payload inválido: sem itens.' })
      };
    }

    // Chama a API NFE.io
    const nfeUrl = `https://api.nfe.io/v1/companies/${empresaId}/productinvoices`;

    const response = await fetch(nfeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Erro interno: ${err.message}` })
    };
  }
};

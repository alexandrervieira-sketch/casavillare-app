/**
 * Firebase Cloud Function — Proxy seguro para NFE.io
 * Casa Villare Ambientes Planejados
 *
 * Recebe o payload do sistema, adiciona a API Key no servidor
 * (nunca exposta no navegador) e encaminha para a API NFE.io.
 *
 * Endpoint via Firebase Hosting rewrite: /api/nfe-emit (POST)
 * Body: { payload: {...}, apiKey: "...", empresaId: "..." }
 */

const functions = require('firebase-functions');
const fetch = require('node-fetch');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.nfeEmit = functions.https.onRequest(async (req, res) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.set(CORS_HEADERS).status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.set(CORS_HEADERS).status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { payload, apiKey, empresaId } = req.body || {};

    if (!apiKey || !empresaId) {
      res.set(CORS_HEADERS).status(400).json({ error: 'API Key e ID da Empresa são obrigatórios.' });
      return;
    }

    if (!payload || !payload.itens || !payload.itens.length) {
      res.set(CORS_HEADERS).status(400).json({ error: 'Payload inválido: sem itens.' });
      return;
    }

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

    res.set(CORS_HEADERS).status(response.status).json(data);

  } catch (err) {
    res.set(CORS_HEADERS).status(500).json({ error: `Erro interno: ${err.message}` });
  }
});

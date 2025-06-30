// server.js - Versão Multi-Tenant com LOGS DE DEBUG APRIMORADOS
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO MULTI-TENANT ---
const GHL_API_KEY_MAP_JSON = process.env.GHL_API_KEY_MAP_JSON || '{}';
const GHL_API_KEY_MAP = JSON.parse(GHL_API_KEY_MAP_JSON);

// ROTA DO WEBHOOK PARA O OPENPHONE
app.post('/openphone-webhook', async (req, res) => {
    console.log('--- OpenPhone Webhook Recebido (DEBUG MODE) ---');
    console.log('Corpo completo do webhook:', JSON.stringify(req.body, null, 2)); // DEBUG: Mostra tudo que recebemos

    if (Object.keys(GHL_API_KEY_MAP).length === 0) {
        console.error('[ERRO DE CONFIGURAÇÃO] O mapa de API Keys (GHL_API_KEY_MAP_JSON) está vazio ou não foi configurado.');
        return res.status(500).send('Erro de configuração do servidor.');
    }
    console.log('[DEBUG] Mapa de API Keys carregado com sucesso.');

    const eventType = req.body.type;
    const callData = req.body.data?.object;

    if (eventType !== 'call.recording.ready' || !callData) {
        return res.status(200).send('Webhook ignorado (não é call.recording.ready).');
    }

    let userOpenPhoneNumber;
    let apiKeyForThisCall;

    if (GHL_API_KEY_MAP[callData.from]) {
        userOpenPhoneNumber = callData.from;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.from];
    } else if (GHL_API_KEY_MAP[callData.to]) {
        userOpenPhoneNumber = callData.to;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.to];
    }

    console.log(`[DEBUG] Tentando rotear. From: ${callData.from}, To: ${callData.to}`);

    if (!apiKeyForThisCall) {
        console.warn(`[ROTEAMENTO FALHOU] Nenhum dos números da chamada corresponde a uma API Key.`);
        console.warn('[DEBUG] Chaves do mapa configurado:', Object.keys(GHL_API_KEY_MAP));
        return res.status(200).send('Número não encontrado no mapa de roteamento.');
    }
    
    console.log(`[ROTEAMENTO OK] Número OpenPhone identificado: ${userOpenPhoneNumber}. A API Key será usada.`);

    const contactPhoneNumber = callData.from === userOpenPhoneNumber ? callData.to : callData.from;
    const duration = callData.duration;
    const recordingUrl = callData.recordingUrl;
    const formattedPhoneNumber = `+${contactPhoneNumber.replace(/\D/g, '')}`;

    console.log(`[DEBUG] Buscando contato no GHL com o número: ${formattedPhoneNumber}`);

    try {
        const searchResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/lookup?phone=${encodeURIComponent(formattedPhoneNumber)}`, {
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}` }
        });
        
        const responseText = await searchResponse.text(); // Lê como texto para debug
        if (!searchResponse.ok) {
            console.error(`[ERRO GHL LOOKUP] Status: ${searchResponse.status}. Resposta: ${responseText}`);
            throw new Error(`Falha ao buscar contato no GHL.`);
        }
        
        const searchData = JSON.parse(responseText);
        if (searchData.contacts.length === 0) {
            console.log(`[Webhook] Contato ${formattedPhoneNumber} não encontrado na sub-conta GHL.`);
            return res.status(200).send('Contato não encontrado.');
        }

        const contactId = searchData.contacts[0].id;
        console.log(`[Webhook] Contato encontrado. ID: ${contactId}.`);

        const noteBody = `Chamada via OpenPhone Concluída.\n\nDuração: ${Math.round(duration)} segundos.\nGravação: ${recordingUrl || 'N/A'}`;
        console.log(`[DEBUG] Corpo da nota a ser criada: "${noteBody}"`);

        const noteResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
            body: JSON.stringify({ body: noteBody })
        });
        
        const noteResponseText = await noteResponse.text();
        if (!noteResponse.ok) {
            console.error(`[ERRO GHL NOTE] Status: ${noteResponse.status}. Resposta: ${noteResponseText}`);
            throw new Error('Falha ao criar nota no GHL.');
        }

        console.log(`✅ [SUCESSO] Nota criada para o contato ${contactId}.`);
        res.status(200).send('Webhook processado e nota criada.');

    } catch (error) {
        console.error('[ERRO NO PROCESSAMENTO]', error.message);
        res.status(500).send('Erro ao processar o webhook.');
    }
});

app.get('/', (req, res) => res.status(200).send('Servidor GHL-OpenPhone (DEBUG MODE) está no ar!'));
app.listen(port, () => console.log(`Servidor Multi-Tenant (DEBUG MODE) rodando na porta ${port}`));
// server.js - Versão Multi-Tenant para GHL e OpenPhone
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO MULTI-TENANT ---
// O mapa que associa um número OpenPhone a uma GHL API Key.
// Será carregado a partir das variáveis de ambiente do nosso servidor online (Render).
const GHL_API_KEY_MAP = process.env.GHL_API_KEY_MAP_JSON 
    ? JSON.parse(process.env.GHL_API_KEY_MAP_JSON) 
    : {};

// ROTA DO WEBHOOK PARA O OPENPHONE
app.post('/openphone-webhook', async (req, res) => {
    console.log('--- OpenPhone Webhook Recebido (Lógica Multi-Tenant) ---');

    if (Object.keys(GHL_API_KEY_MAP).length === 0) {
        console.error('[ERRO DE CONFIGURAÇÃO] O mapa de API Keys (GHL_API_KEY_MAP_JSON) não está configurado no servidor.');
        return res.status(500).send('Erro de configuração do servidor.');
    }

    const eventType = req.body.type;
    const callData = req.body.data?.object;

    if (eventType !== 'call.recording.ready' || !callData) {
        return res.status(200).send('Webhook ignorado (não é uma chamada finalizada com gravação).');
    }

    // 1. IDENTIFICAR O NÚMERO INTERNO (OPENPHONE) E A API KEY CORRETA
    let userOpenPhoneNumber;
    let apiKeyForThisCall;

    if (GHL_API_KEY_MAP[callData.from]) {
        userOpenPhoneNumber = callData.from;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.from];
    } else if (GHL_API_KEY_MAP[callData.to]) {
        userOpenPhoneNumber = callData.to;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.to];
    }

    if (!apiKeyForThisCall) {
        console.warn(`[ROTEAMENTO FALHOU] Nenhum dos números da chamada (${callData.from}, ${callData.to}) corresponde a uma API Key configurada.`);
        return res.status(200).send('Número de origem/destino não encontrado no mapa de roteamento.');
    }
    
    console.log(`[ROTEAMENTO OK] Chamada do número ${userOpenPhoneNumber} será registrada na sub-conta GHL correspondente.`);

    // 2. IDENTIFICAR O NÚMERO DO CLIENTE E DADOS DA CHAMADA
    const contactPhoneNumber = callData.from === userOpenPhoneNumber ? callData.to : callData.from;
    const duration = callData.duration;
    const recordingUrl = callData.recordingUrl;
    const formattedPhoneNumber = `+${contactPhoneNumber.replace(/\D/g, '')}`;

    try {
        // 3. USAR A API KEY CORRETA PARA BUSCAR O CONTATO NO GHL
        const searchResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/lookup?phone=${encodeURIComponent(formattedPhoneNumber)}`, {
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}` }
        });

        if (!searchResponse.ok) throw new Error(`Falha ao buscar contato no GHL. Status: ${searchResponse.status}`);
        
        const searchData = await searchResponse.json();
        if (searchData.contacts.length === 0) {
            console.log(`[Webhook] Contato ${formattedPhoneNumber} não encontrado na sub-conta GHL correspondente.`);
            return res.status(200).send('Contato não encontrado no GHL.');
        }

        const contactId = searchData.contacts[0].id;
        console.log(`[Webhook] Contato encontrado. ID: ${contactId}.`);

        // 4. USAR A API KEY CORRETA PARA CRIAR A NOTA
        const noteBody = `Chamada via OpenPhone Concluída.\n\nDuração: ${Math.round(duration)} segundos.\nGravação: ${recordingUrl || 'N/A'}`;
        
        await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKeyForThisCall}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
            },
            body: JSON.stringify({ body: noteBody })
        });

        console.log(`✅ [SUCESSO] Nota criada para o contato ${contactId} na sub-conta correta.`);
        res.status(200).send('Webhook processado e nota criada.');

    } catch (error) {
        console.error('[ERRO NO PROCESSAMENTO] Erro ao processar o webhook multi-tenant:', error.message);
        res.status(500).send('Erro ao processar o webhook.');
    }
});

app.get('/', (req, res) => {
  res.status(200).send('Servidor da Integração GHL-OpenPhone (Multi-Tenant) está no ar!');
});

app.listen(port, () => console.log(`Servidor Multi-Tenant rodando na porta ${port}`));
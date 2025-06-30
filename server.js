// server.js - Versão Multi-Tenant com CORREÇÃO FINAL
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GHL_API_KEY_MAP_JSON = process.env.GHL_API_KEY_MAP_JSON || '{}';
const GHL_API_KEY_MAP = JSON.parse(GHL_API_KEY_MAP_JSON);

app.post('/openphone-webhook', async (req, res) => {
    console.log('--- OpenPhone Webhook Recebido (v1.1) ---');
    
    if (Object.keys(GHL_API_KEY_MAP).length === 0) {
        console.error('[ERRO DE CONFIGURAÇÃO] O mapa de API Keys (GHL_API_KEY_MAP_JSON) está vazio.');
        return res.status(500).send('Erro de configuração do servidor.');
    }
    
    const eventType = req.body.type;
    const callData = req.body.data?.object;

    if (eventType !== 'call.recording.completed' || !callData) {
        return res.status(200).send(`Webhook ignorado (tipo: ${eventType}). Processamos apenas 'call.recording.completed'.`);
    }

    console.log('[INFO] Processando evento call.recording.completed...');

    let userOpenPhoneNumber, apiKeyForThisCall;

    if (GHL_API_KEY_MAP[callData.from]) {
        userOpenPhoneNumber = callData.from;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.from];
    } else if (GHL_API_KEY_MAP[callData.to]) {
        userOpenPhoneNumber = callData.to;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.to];
    }

    if (!apiKeyForThisCall) {
        console.warn(`[ROTEAMENTO FALHOU] Nenhum dos números da chamada (${callData.from}, ${callData.to}) corresponde a uma API Key.`);
        return res.status(200).send('Número não encontrado no mapa de roteamento.');
    }
    
    console.log(`[ROTEAMENTO OK] Chamada do número ${userOpenPhoneNumber} será registrada na sub-conta GHL correta.`);

    // ================== INÍCIO DA CORREÇÃO ==================
    // Os dados de mídia vêm dentro de um array. Precisamos acessá-lo.
    const mediaData = callData.media && callData.media.length > 0 ? callData.media[0] : {};
    const duration = mediaData.duration || 0; // Pega a duração do objeto de mídia, ou 0 se não houver
    const recordingUrl = mediaData.url || ''; // Pega o URL do objeto de mídia, ou string vazia
    // =================== FIM DA CORREÇÃO ====================

    const contactPhoneNumber = callData.from === userOpenPhoneNumber ? callData.to : callData.from;
    const formattedPhoneNumber = `+${contactPhoneNumber.replace(/\D/g, '')}`;
    
    console.log(`[INFO] Buscando contato no GHL com o número: ${formattedPhoneNumber}`);

    try {
        const searchResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/lookup?phone=${encodeURIComponent(formattedPhoneNumber)}`, {
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}` }
        });
        
        const responseText = await searchResponse.text();
        if (!searchResponse.ok) throw new Error(`Falha ao buscar contato no GHL. Status: ${searchResponse.status}. Resposta: ${responseText}`);
        
        const searchData = JSON.parse(responseText);
        if (searchData.contacts.length === 0) {
            console.log(`[INFO] Contato ${formattedPhoneNumber} não encontrado na sub-conta GHL.`);
            return res.status(200).send('Contato não encontrado.');
        }

        const contactId = searchData.contacts[0].id;
        console.log(`[INFO] Contato encontrado. ID: ${contactId}.`);

        const noteBody = `Chamada via OpenPhone Concluída.\n\nDuração: ${Math.round(duration)} segundos.\nGravação: ${recordingUrl || 'N/A'}`;
        console.log(`[INFO] Criando nota para o contato ${contactId}.`);

        const noteResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
            body: JSON.stringify({ body: noteBody })
        });
        
        if (!noteResponse.ok) throw new Error(`Falha ao criar nota no GHL. Status: ${noteResponse.status}. Resposta: ${await noteResponse.text()}`);

        console.log(`✅ [SUCESSO] Nota criada para o contato ${contactId}.`);
        res.status(200).send('Webhook processado e nota criada.');

    } catch (error) {
        console.error('[ERRO NO PROCESSAMENTO]', error.message);
        res.status(500).send('Erro ao processar o webhook.');
    }
});

app.get('/', (req, res) => res.status(200).send('Servidor GHL-OpenPhone (v1.1 - CORRIGIDO) está no ar!'));
app.listen(port, () => console.log(`Servidor Multi-Tenant (v1.1 - CORRIGIDO) rodando na porta ${port}`));
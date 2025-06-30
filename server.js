// server.js - v2.1 com Correção no Relatório
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initializeDatabase = async () => {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS calls (
            id SERIAL PRIMARY KEY,
            call_id VARCHAR(255) UNIQUE,
            contact_id VARCHAR(255),
            ghl_api_key VARCHAR(255),
            call_time TIMESTAMPTZ,
            duration INT,
            was_answered BOOLEAN,
            recording_url TEXT
        );
    `;
    try {
        await pool.query(createTableQuery);
        console.log('Tabela "calls" verificada/criada com sucesso.');
    } catch (err) {
        console.error('Erro ao inicializar o banco de dados:', err);
    }
};

const TENANT_CONFIG_JSON = process.env.TENANT_CONFIG_JSON || '[]';
const TENANT_CONFIG = JSON.parse(TENANT_CONFIG_JSON);
const GHL_API_KEY_MAP = {};
TENANT_CONFIG.forEach(tenant => {
    GHL_API_KEY_MAP[tenant.openPhoneNumber] = tenant.ghlApiKey;
});

app.use(express.json());

app.post('/openphone-webhook', async (req, res) => {
    const eventType = req.body.type;
    const callData = req.body.data?.object;

    if (eventType !== 'call.recording.completed' || !callData) {
        return res.status(200).send('Webhook ignorado.');
    }

    let userOpenPhoneNumber, apiKeyForThisCall;
    if (GHL_API_KEY_MAP[callData.from]) {
        userOpenPhoneNumber = callData.from;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.from];
    } else if (GHL_API_KEY_MAP[callData.to]) {
        userOpenPhoneNumber = callData.to;
        apiKeyForThisCall = GHL_API_KEY_MAP[callData.to];
    }

    if (!apiKeyForThisCall) return res.status(200).send('Roteamento falhou.');
    
    try {
        const contactPhoneNumber = callData.from === userOpenPhoneNumber ? callData.to : callData.from;
        const searchResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/lookup?phone=${encodeURIComponent(`+${contactPhoneNumber.replace(/\D/g, '')}`)}`, {
            headers: { 'Authorization': `Bearer ${apiKeyForThisCall}` }
        });
        const searchData = await searchResponse.json();
        if (searchData.contacts.length === 0) return res.status(200).send('Contato não encontrado no GHL.');
        
        const contactId = searchData.contacts[0].id;
        const mediaData = callData.media && callData.media.length > 0 ? callData.media[0] : {};
        
        const insertQuery = `
            INSERT INTO calls (call_id, contact_id, ghl_api_key, call_time, duration, was_answered, recording_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (call_id) DO NOTHING;
        `;
        const values = [
            callData.id,
            contactId,
            apiKeyForThisCall,
            callData.createdAt,
            mediaData.duration || 0,
            !!callData.answeredAt,
            mediaData.url || null
        ];
        await pool.query(insertQuery, values);
        console.log(`Chamada ${callData.id} salva no banco de dados.`);
        res.status(200).send('Chamada processada e salva.');

    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).send('Erro interno.');
    }
});


// --- ENDPOINT DE RELATÓRIO (CORRIGIDO) ---
app.get('/reports', async (req, res) => {
    const { period, date } = req.query;
    
    // ================== INÍCIO DA CORREÇÃO ==================
    const periodMap = {
        daily: 'day',
        weekly: 'week',
        monthly: 'month'
    };

    const sqlIntervalUnit = periodMap[period]; // Traduz 'daily' para 'day', etc.

    if (!sqlIntervalUnit || !date) {
        return res.status(400).send('Parâmetros "period" (daily, weekly, monthly) e "date" (YYYY-MM-DD) são necessários.');
    }
    // =================== FIM DA CORREÇÃO ====================

    try {
        const callsQuery = `
            SELECT * FROM calls
            WHERE call_time::date >= date_trunc('${sqlIntervalUnit}', $1::date)
              AND call_time::date < date_trunc('${sqlIntervalUnit}', $1::date) + '1 ${sqlIntervalUnit}'::interval;
        `;
        const { rows: calls } = await pool.query(callsQuery, [date]);

        let totalCalls = calls.length;
        let answeredCalls = calls.filter(c => c.was_answered).length;
        let scheduledMeetings = 0;

        const uniqueContacts = [...new Set(calls.map(c => c.contact_id))];
        for (const contactId of uniqueContacts) {
            const callForContact = calls.find(c => c.contact_id === contactId);
            const ghlApiKey = callForContact.ghl_api_key;
            const callDate = new Date(callForContact.call_time).toISOString().split('T')[0];
            const expectedTag = `reuniao-agendada-${callDate}`;

            const contactDetailsResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
                headers: { 'Authorization': `Bearer ${ghlApiKey}` }
            });
            const contactDetails = await contactDetailsResponse.json();
            if (contactDetails.contact && contactDetails.contact.tags.includes(expectedTag)) {
                scheduledMeetings++;
            }
        }

        res.json({
            period,
            date,
            totalCalls,
            answeredCalls,
            scheduledMeetings
        });

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.status(200).send('Servidor de Relatórios GHL-OpenPhone (v2.1 - CORRIGIDO) no ar!'));
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    initializeDatabase();
});
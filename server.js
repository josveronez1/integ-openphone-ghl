// server.js - v3.3 Final - Criação de Notas e Relatórios
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
            ghl_api_key TEXT,
            phone_number_from VARCHAR(255),
            call_time TIMESTAMPTZ,
            duration INT,
            was_answered BOOLEAN,
            recording_url TEXT
        );
    `;
    try {
        await pool.query(createTableQuery);
        await pool.query('ALTER TABLE calls ADD COLUMN IF NOT EXISTS phone_number_from VARCHAR(255);');
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

    if (!callData || !callData.id) {
        return res.status(200).send('Webhook ignored (no call data).');
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

        if (eventType === 'call.completed') {
            const insertQuery = `
                INSERT INTO calls (call_id, contact_id, ghl_api_key, phone_number_from, call_time, was_answered)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (call_id) DO NOTHING;
            `;
            const values = [
                callData.id, contactId, apiKeyForThisCall, userOpenPhoneNumber, callData.createdAt, !!callData.answeredAt
            ];
            await pool.query(insertQuery, values);
            console.log(`Chamada ${callData.id} (call.completed) inserida/verificada no banco de dados.`);
            return res.status(200).send('Evento call.completed processado.');

        } else if (eventType === 'call.recording.completed') {
            const mediaData = callData.media && callData.media.length > 0 ? callData.media[0] : {};
            const duration = mediaData.duration || 0;
            const recordingUrl = mediaData.url || null;

            // ================== INÍCIO DA CORREÇÃO ==================
            // PASSO 1: Criar a nota no GHL (a parte que estava faltando)
            const noteBody = `Call Completed via OpenPhone.\n\nDuration: ${Math.round(duration)} seconds.\nRecording: ${recordingUrl || 'N/A'}`;
            await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKeyForThisCall}`,
                    'Content-Type': 'application/json',
                    'Version': '2021-07-28'
                },
                body: JSON.stringify({ body: noteBody })
            });
            console.log(`Nota da chamada ${callData.id} criada no GHL para o contato ${contactId}.`);
            // =================== FIM DA CORREÇÃO ====================

            // PASSO 2: Atualizar o registro no nosso banco de dados
            const updateQuery = `
                UPDATE calls
                SET duration = $1, recording_url = $2, was_answered = true
                WHERE call_id = $3;
            `;
            const values = [duration, recordingUrl, callData.id];
            await pool.query(updateQuery, values);
            console.log(`Gravação da chamada ${callData.id} atualizada no banco de dados.`);
            return res.status(200).send('Evento call.recording.completed processado e nota criada.');
        }

        res.status(200).send(`Webhook do tipo ${eventType} ignorado.`);

    } catch (error) {
        console.error(`Erro processando webhook para a chamada ${callData.id}:`, error);
        res.status(500).send('Erro interno.');
    }
});

// O endpoint de relatórios não precisa de nenhuma alteração
app.get('/reports', async (req, res) => {
    const { period, date } = req.query;
    const periodMap = { daily: 'day', weekly: 'week', monthly: 'month' };
    const sqlIntervalUnit = periodMap[period];

    if (!sqlIntervalUnit || !date) {
        return res.status(400).send('Parameters "period" (daily, weekly, monthly) and "date" (YYYY-MM-DD) are required.');
    }

    try {
        const callsQuery = `
            SELECT * FROM calls
            WHERE call_time::date >= date_trunc('${sqlIntervalUnit}', $1::date)
              AND call_time::date < date_trunc('${sqlIntervalUnit}', $1::date) + '1 ${sqlIntervalUnit}'::interval;
        `;
        const { rows: calls } = await pool.query(callsQuery, [date]);

        const reportData = {};

        for (const call of calls) {
            const tenant = TENANT_CONFIG.find(t => t.ghlApiKey === call.ghl_api_key);
            if (!tenant) continue;

            if (!reportData[tenant.name]) {
                reportData[tenant.name] = {};
            }
            if (!reportData[tenant.name][call.phone_number_from]) {
                reportData[tenant.name][call.phone_number_from] = {
                    totalCalls: 0,
                    answeredCalls: 0,
                    scheduledMeetings: 0,
                    contactsWithMeetings: new Set()
                };
            }
            reportData[tenant.name][call.phone_number_from].totalCalls++;
            if (call.was_answered) {
                reportData[tenant.name][call.phone_number_from].answeredCalls++;
            }
        }

        const uniqueContacts = [...new Set(calls.map(c => c.contact_id))];
        for (const contactId of uniqueContacts) {
            const callForContact = calls.find(c => c.contact_id === contactId);
            const tenant = TENANT_CONFIG.find(t => t.ghlApiKey === callForContact.ghl_api_key);
            if (!tenant) continue;

            const callDate = new Date(callForContact.call_time).toISOString().split('T')[0];
            const expectedTag = `reuniao-agendada-${callDate}`;

            const contactDetailsResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
                headers: { 'Authorization': `Bearer ${tenant.ghlApiKey}` }
            });
            const contactDetails = await contactDetailsResponse.json();
            if (contactDetails.contact && contactDetails.contact.tags.includes(expectedTag)) {
                const group = reportData[tenant.name]?.[callForContact.phone_number_from];
                if (group && !group.contactsWithMeetings.has(contactId)) {
                    group.scheduledMeetings++;
                    group.contactsWithMeetings.add(contactId);
                }
            }
        }

        res.send(generateReportHtml(reportData, period, date));

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).send(`<h1>Error generating report</h1><p>${error.message}</p>`);
    }
});

function generateReportHtml(data, period, date) {
    let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Call Report</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7f9; color: #333; margin: 0; padding: 20px; }
                .container { max-width: 900px; margin: 0 auto; background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
                h1 { color: #2c3e50; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
                h2 { color: #34495e; background-color: #ecf0f1; padding: 12px; border-radius: 5px; margin-top: 40px; }
                .report-section { margin-top: 20px; border: 1px solid #ddd; border-radius: 5px; padding: 20px; }
                .phone-number { font-weight: bold; font-size: 1.1em; color: #2980b9; }
                ul { list-style-type: none; padding-left: 0; }
                li { background-color: #fdfdfd; padding: 10px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
                li:last-child { border-bottom: none; }
                .metric-label { font-weight: 500; }
                .metric-value { font-weight: bold; font-size: 1.2em; color: #2c3e50; background-color: #ecf0f1; padding: 5px 10px; border-radius: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Call Report</h1>
                <p><strong>Period:</strong> ${period.charAt(0).toUpperCase() + period.slice(1)} | <strong>Reference Date:</strong> ${date}</p>
    `;

    if (Object.keys(data).length === 0) {
        html += '<p>No data found for this period.</p>';
    } else {
        for (const accountName in data) {
            html += `<h2>${accountName}</h2>`;
            for (const phoneNumber in data[accountName]) {
                const stats = data[accountName][phoneNumber];
                html += `
                    <div class="report-section">
                        <p class="phone-number">Phone Number: ${phoneNumber}</p>
                        <ul>
                            <li><span class="metric-label">Total Calls Made:</span> <span class="metric-value">${stats.totalCalls}</span></li>
                            <li><span class="metric-label">Answered Calls:</span> <span class="metric-value">${stats.answeredCalls}</span></li>
                            <li><span class="metric-label">Meetings Scheduled:</span> <span class="metric-value">${stats.scheduledMeetings}</span></li>
                        </ul>
                    </div>
                `;
            }
        }
    }

    html += `
            </div>
        </body>
        </html>
    `;
    return html;
}

app.get('/', (req, res) => res.status(200).send('GHL-OpenPhone Report Server (v3.3 - Final) is running!'));
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    initializeDatabase();
});
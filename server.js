// server.js - v5.3 com Layout Horizontal (Wide)
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DO BANCO DE DADOS E TENANTS (sem alterações) ---
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

// --- LÓGICA DO WEBHOOK (sem alterações) ---
app.post('/openphone-webhook', async (req, res) => {
    const eventType = req.body.type;
    const callData = req.body.data?.object;
    if (!callData || !callData.id) return res.status(200).send('Webhook ignored.');
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
        const searchResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/lookup?phone=${encodeURIComponent(`+${contactPhoneNumber.replace(/\D/g, '')}`)}`, { headers: { 'Authorization': `Bearer ${apiKeyForThisCall}` } });
        const searchData = await searchResponse.json();
        if (searchData.contacts.length === 0) return res.status(200).send('Contato não encontrado no GHL.');
        const contactId = searchData.contacts[0].id;
        if (eventType === 'call.completed') {
            const insertQuery = `INSERT INTO calls (call_id, contact_id, ghl_api_key, phone_number_from, call_time, was_answered) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (call_id) DO NOTHING;`;
            const values = [callData.id, contactId, apiKeyForThisCall, userOpenPhoneNumber, callData.createdAt, !!callData.answeredAt];
            await pool.query(insertQuery, values);
            return res.status(200).send('Evento call.completed processado.');
        } else if (eventType === 'call.recording.completed') {
            const mediaData = callData.media && callData.media.length > 0 ? callData.media[0] : {};
            const duration = mediaData.duration || 0;
            const recordingUrl = mediaData.url || null;
            const noteBody = `Call Completed via OpenPhone.\n\nDuration: ${Math.round(duration)} seconds.\nRecording: ${recordingUrl || 'N/A'}`;
            await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes`, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKeyForThisCall}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ body: noteBody }) });
            const updateQuery = `UPDATE calls SET duration = $1, recording_url = $2, was_answered = true WHERE call_id = $3;`;
            const values = [duration, recordingUrl, callData.id];
            await pool.query(updateQuery, values);
            return res.status(200).send('Evento call.recording.completed processado e nota criada.');
        }
        res.status(200).send(`Webhook do tipo ${eventType} ignorado.`);
    } catch (error) {
        console.error(`Erro processando webhook para a chamada ${callData.id}:`, error);
        res.status(500).send('Erro interno.');
    }
});


// --- LÓGICA DE GERAÇÃO DE DADOS PARA O RELATÓRIO (sem alterações) ---
async function getReportData(period, date, accountId = null) {
    const periodMap = { daily: 'day', weekly: 'week', monthly: 'month' };
    const sqlIntervalUnit = periodMap[period];
    if (!sqlIntervalUnit) throw new Error('Período inválido.');
    const callsQuery = `
        SELECT * FROM calls
        WHERE call_time::date >= date_trunc('${sqlIntervalUnit}', $1::date)
          AND call_time::date < date_trunc('${sqlIntervalUnit}', $1::date) + '1 ${sqlIntervalUnit}'::interval;
    `;
    const { rows: allCalls } = await pool.query(callsQuery, [date]);
    let filteredCalls = allCalls;
    let accountName = 'All Accounts';
    if (accountId) {
        const tenantsForAccount = TENANT_CONFIG.filter(t => t.id === accountId);
        if (tenantsForAccount.length > 0) {
            const ghlApiKeysForAccount = tenantsForAccount.map(t => t.ghlApiKey);
            filteredCalls = allCalls.filter(c => ghlApiKeysForAccount.includes(c.ghl_api_key));
            accountName = tenantsForAccount[0].name;
        } else {
            filteredCalls = [];
        }
    }
    const reportData = {};
    for (const call of filteredCalls) {
        const tenant = TENANT_CONFIG.find(t => t.ghlApiKey === call.ghl_api_key);
        if (!tenant) continue;
        const groupKey = tenant.name; // Agrupando pelo nome da conta
        if (!reportData[groupKey]) {
            reportData[groupKey] = { totalCalls: 0, answeredCalls: 0, scheduledMeetings: 0, contactsWithMeetings: new Set() };
        }
        reportData[groupKey].totalCalls++;
        if (call.was_answered) {
            reportData[groupKey].answeredCalls++;
        }
    }
    const uniqueContacts = [...new Set(filteredCalls.map(c => c.contact_id))];
    for (const contactId of uniqueContacts) {
        const callForContact = filteredCalls.find(c => c.contact_id === contactId);
        const tenant = TENANT_CONFIG.find(t => t.ghlApiKey === callForContact.ghl_api_key);
        if (!tenant) continue;
        const callDate = new Date(callForContact.call_time).toISOString().split('T')[0];
        const expectedTag = `reuniao-agendada-${callDate}`;
        const contactDetailsResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, { headers: { 'Authorization': `Bearer ${tenant.ghlApiKey}` } });
        const contactDetails = await contactDetailsResponse.json();
        if (contactDetails.contact && contactDetails.contact.tags.includes(expectedTag)) {
            const group = reportData[tenant.name];
            if (group && !group.contactsWithMeetings.has(contactId)) {
                group.scheduledMeetings++;
                group.contactsWithMeetings.add(contactId);
            }
        }
    }
    return { reportData, accountName };
}

// ================== INÍCIO DA ATUALIZAÇÃO DO LAYOUT ==================

// --- GERAÇÃO DE HTML (COM NOVO LAYOUT) ---
function generateHtmlShell(pageTitle, content) {
    return `
        <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${pageTitle}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7f9; color: #333; margin: 0; padding: 20px; }
            .container { max-width: 1200px; margin: 0 auto; background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
            h1, h3 { color: #2c3e50; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
            .reports-container { display: flex; flex-wrap: wrap; gap: 20px; justify-content: space-around; margin-top: 20px; }
            .report-block { flex: 1; min-width: 300px; border: 1px solid #e0e0e0; padding: 20px; border-radius: 8px; background-color: #fafafa; }
            ul { list-style-type: none; padding-left: 0; }
            li { background-color: #fdfdfd; padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-size: 1.1em;}
            li:last-child { border-bottom: none; }
            .metric-label { font-weight: 500; }
            .metric-value { font-weight: bold; font-size: 1.2em; color: #2c3e50; background-color: #ecf0f1; padding: 5px 12px; border-radius: 20px; }
            .date-picker-container { margin: 20px 0; padding: 15px; background: #e8f0fe; border: 1px solid #d6e3f4; border-radius: 5px; text-align: center; }
            .date-picker-container label { font-weight: bold; margin-right: 10px; }
            input[type="date"] { padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 1em; }
        </style></head><body><div class="container">${content}</div></body></html>`;
}

function generateReportBlockHtml(reportData) {
    let blockHtml = '';
    if (Object.keys(reportData).length === 0) {
        blockHtml = '<p>No data found for this period.</p>';
    } else {
        for (const accountName in reportData) {
            const stats = reportData[accountName];
            blockHtml += `
                <ul>
                    <li><span class="metric-label">Total Calls Made:</span> <span class="metric-value">${stats.totalCalls}</span></li>
                    <li><span class="metric-label">Answered Calls:</span> <span class="metric-value">${stats.answeredCalls}</span></li>
                    <li><span class="metric-label">Meetings Scheduled:</span> <span class="metric-value">${stats.scheduledMeetings}</span></li>
                </ul>
            `;
        }
    }
    return blockHtml;
}


// --- ROTAS DO DASHBOARD (COM NOVO LAYOUT) ---
app.get('/:accountId/dashboard', async (req, res) => {
    try {
        const { accountId } = req.params;
        const tenantInfo = TENANT_CONFIG.find(t => t.id === accountId);
        if (!tenantInfo) return res.status(404).send('Account not found.');
        const today = new Date().toISOString().split('T')[0];
        const daily = await getReportData('daily', today, accountId);
        const weekly = await getReportData('weekly', today, accountId);
        const monthly = await getReportData('monthly', today, accountId);
        
        const pageTitle = `${tenantInfo.name} - Dashboard`;

        let htmlContent = `
            <h1>${pageTitle}</h1>
            <div class="date-picker-container">
                <label for="report-date">View Daily Report for a Specific Date:</label>
                <input type="date" id="report-date">
            </div>
            <div class="reports-container">
                <div class="report-block">
                    <h3>Today's Report</h3>
                    ${generateReportBlockHtml(daily.reportData)}
                </div>
                <div class="report-block">
                    <h3>This Week's Report</h3>
                    ${generateReportBlockHtml(weekly.reportData)}
                </div>
                <div class="report-block">
                    <h3>This Month's Report</h3>
                    ${generateReportBlockHtml(monthly.reportData)}
                </div>
            </div>
            <script>
                document.getElementById('report-date').addEventListener('change', function() {
                    if (this.value) {
                        window.location.href = '/${accountId}/reports?period=daily&date=' + this.value;
                    }
                });
            </script>
        `;
        res.send(generateHtmlShell(pageTitle, htmlContent));
    } catch (error) {
        console.error('Erro ao gerar dashboard:', error);
        res.status(500).send(generateHtmlShell('Error', `<h1>Error generating dashboard</h1><p>${error.message}</p>`));
    }
});

app.get('/:accountId/reports', async (req, res) => {
    try {
        const { accountId } = req.params;
        const { period, date } = req.query;
        if (!period || !date) return res.status(400).send('Parameters "period" and "date" are required.');
        const { reportData, accountName } = await getReportData(period, date, accountId);
        const pageTitle = `${accountName} - Report for ${date}`;
        let htmlContent = `
            <h1>${pageTitle}</h1>
            <p><a href="/${accountId}/dashboard">&larr; Back to ${accountName} Dashboard</a></p>
            <div class="reports-container">
                <div class="report-block">
                    ${generateReportBlockHtml(reportData)}
                </div>
            </div>
        `;
        res.send(generateHtmlShell(pageTitle, htmlContent));
    } catch (error) {
        res.status(500).send(generateHtmlShell('Error', `<h1>Error generating report</h1><p>${error.message}</p>`));
    }
});

// --- ROTAS DE REDIRECIONAMENTO E RAIZ (sem alterações) ---
app.get('/:accountId', (req, res) => {
    const { accountId } = req.params;
    res.redirect(`/${accountId}/dashboard`);
});

app.get('/', (req, res) => {
    const uniqueTenants = TENANT_CONFIG.filter((tenant, index, self) => index === self.findIndex((t) => t.id === tenant.id));
    const reportLinks = uniqueTenants.map(t => `<li><a href="/${t.id}">${t.name} Dashboard</a></li>`);
    let htmlContent = `<h1>Reporting Server</h1><p>Please select a client dashboard to view:</p><ul>${reportLinks.join('')}</ul>`;
    res.send(generateHtmlShell('Report Server', htmlContent));
});

// =================== FIM DA ATUALIZAÇÃO DO LAYOUT ===================


// --- INICIALIZAÇÃO ---
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    initializeDatabase();
});
const http = require('http'), https = require('https'), PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';
const GMAIL_USER = process.env.GMAIL_USER || '';

async function fetchJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = { hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {} };
    const r = https.request(reqOpts, pr => {
      let d = ''; pr.on('data', c => d += c); pr.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function getGmailToken() {
  const data = new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString();
  const r = await fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }, body: data });
  return r.access_token;
}

async function downloadAttachment(messageId, attachmentId, token) {
  const r = await fetchJson(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + messageId + '/attachments/' + attachmentId,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  return r.data; // base64url encoded
}

async function procesarDJ(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { attachment_id, filename, message_id, from_email, subject } = JSON.parse(body);
      console.log('[DJ] Recibido:', filename, 'de', from_email);

      // 1. Obtener token de Gmail
      const token = await getGmailToken();
      console.log('[DJ] Token Gmail OK');

      // 2. Descargar el PDF
      const pdfBase64 = await downloadAttachment(message_id, attachment_id, token);
      console.log('[DJ] PDF descargado, tamanio:', pdfBase64.length);

      // 3. Procesar con Claude
      const claudePayload = JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64.replace(/-/g, '+').replace(/_/g, '/') } },
            { type: 'text', text: 'Extraé del PDF los siguientes datos y devolvé SOLO JSON sin backticks: { "cuit": "", "razon_social": "", "impuesto": "", "periodo": "", "fecha_presentacion": "", "nro_transaccion": "" }. El CUIT puede estar en formato 20-12345678-9 o sin guiones. El impuesto puede ser IVA, Ganancias, Monotributo, F931, Bienes Personales, etc. El periodo en formato YYYY-MM si es mensual o YYYY si es anual.' }
          ]
        }]
      });

      const claudeRes = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(claudePayload) },
        body: claudePayload
      });

      const raw = claudeRes.content[0].text.trim().replace(/```json|```/g, '').trim();
      const datos = JSON.parse(raw);
      console.log('[DJ] Claude extrajo:', JSON.stringify(datos));

      // 4. Buscar cliente por CUIT en Supabase
      const cuitLimpio = datos.cuit.replace(/[^0-9]/g, '');
      const clienteRes = await fetchJson(
        SUPABASE_URL + '/rest/v1/clientes?cuit=ilike.*' + cuitLimpio + '*&select=id,razon_social,email&activo=eq.true',
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
      );

      const cliente = Array.isArray(clienteRes) && clienteRes[0];
      console.log('[DJ] Cliente encontrado:', cliente ? cliente.razon_social : 'NO ENCONTRADO');

      // 5. Si encontramos el cliente, marcar vencimiento como presentado
      if (cliente) {
        // Buscar vencimiento
        const vencRes = await fetchJson(
          SUPABASE_URL + '/rest/v1/calendario_fiscal?cliente_id=eq.' + cliente.id + '&periodo=eq.' + datos.periodo + '&impuesto=ilike.*' + encodeURIComponent(datos.impuesto) + '*&select=id',
          { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
        );

        // Marcar como presentado en calendario_fiscal
        await fetchJson(
          SUPABASE_URL + '/rest/v1/calendario_fiscal?periodo=eq.' + datos.periodo + '&impuesto=ilike.*' + encodeURIComponent(datos.impuesto) + '*',
          {
            method: 'PATCH',
            headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ presentado: true, fecha_presentacion: datos.fecha_presentacion || new Date().toISOString().split('T')[0] })
          }
        );

        // Crear alerta
        await fetchJson(SUPABASE_URL + '/rest/v1/alertas', {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            cliente_id: cliente.id,
            tipo: 'sistema',
            titulo: cliente.razon_social + ' — DJ presentada: ' + datos.impuesto + ' ' + datos.periodo,
            descripcion: 'Presentación procesada automáticamente desde mail. Nro: ' + (datos.nro_transaccion || 'N/D'),
            severidad: 'info'
          })
        });

        // 6. Reenviar mail al cliente con el PDF adjunto
        if (cliente.email) {
          const mailPayload = JSON.stringify({
            destinatario: cliente.email,
            asunto: 'DJ presentada: ' + datos.impuesto + ' periodo ' + datos.periodo,
            html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px"><div style="border-bottom:3px solid #E8881A;padding-bottom:12px;margin-bottom:20px"><span style="font-size:24px;font-weight:bold;color:#E8881A">DM</span><span style="font-size:18px;color:#6B6B6B">&ASOC.</span><div style="font-size:10px;letter-spacing:2px;color:#9B9B9B">CONTADORES PÚBLICOS</div></div><p>Estimado/a <strong>' + cliente.razon_social + '</strong>,</p><p>Se adjunta al presente la DJ correspondiente al período <strong>' + datos.periodo + '</strong> del impuesto <strong>' + datos.impuesto + '</strong>.</p><p>La declaración jurada fue presentada exitosamente ante ARCA/AFIP.</p>' + (datos.nro_transaccion ? '<p><strong>Número de transacción:</strong> ' + datos.nro_transaccion + '</p>' : '') + '<p style="color:#999;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">DM & Asoc. Contadores Públicos</p></div>'
          });

          await fetchJson('https://gestorfiscal-proxy.onrender.com/send-mail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(mailPayload) },
            body: mailPayload
          });
          console.log('[DJ] Mail enviado a:', cliente.email);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        ok: true,
        datos,
        cliente: cliente ? { id: cliente.id, razon_social: cliente.razon_social } : null,
        mensaje: cliente ? 'DJ procesada y cliente notificado' : 'DJ procesada pero cliente no encontrado en el sistema (CUIT: ' + datos.cuit + ')'
      }));

    } catch(e) {
      console.error('[DJ] Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.url === '/procesar-dj' && req.method === 'POST') { procesarDJ(req, res); return; }
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('Proxy en puerto ' + PORT));

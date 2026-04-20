const http = require('http'), https = require('https'), PORT = 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const REGIMENES_IVA = {
  1: 'responsable_inscripto',
  2: 'exento',
  3: 'monotributo',
  4: 'no_inscripto',
  6: 'responsable_inscripto',
};

const CATEGORIAS_MONO = {
  'A':'A','B':'B','C':'C','D':'D','E':'E','F':'F',
  'G':'G','H':'H','I':'I','J':'J','K':'K'
};

function parseXML(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.url === '/leer-constancia' && req.method === 'POST') { leerConstancia(req, res); return; }
  if (req.url === '/send-mail' && req.method === 'POST') { sendMailHandler(req, res); return; }
  if (req.url === '/procesar-dj' && req.method === 'POST') { procesarDJ(req, res); return; }
  const match = req.url.match(/^\/afip\/(\d{11})$/);
  if (!match) { res.writeHead(404); res.end(JSON.stringify({error:'Usar /afip/CUIT'})); return; }
  const cuit = match[1];
  console.log('[AFIP] Consultando:', cuit);

  const postData = 'cuit=' + cuit + '&object=cuit_verifica';
  const options = {
    hostname: 'soft.sos-contador.com',
    path: '/back/xml.asp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Accept': 'application/xml, text/xml, */*; q=0.01',
      'Referer': 'https://soft.sos-contador.com/web/default.asp',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://soft.sos-contador.com',
    },
    timeout: 10000,
  };

  const r = https.request(options, pr => {
    let d = '';
    pr.on('data', c => d += c);
    pr.on('end', () => {
      try {
        const razon_social = parseXML(d, 'clipro');
        if (!razon_social) { res.writeHead(404); res.end(JSON.stringify({error:'CUIT no encontrado'})); return; }
        const idRegimen = parseXML(d, 'idtipo_condicioniva');
        const letra = parseXML(d, 'letra');
        const regimen = REGIMENES_IVA[parseInt(idRegimen)] || 'responsable_inscripto';
        const categoria_monotributo = regimen === 'monotributo' ? (CATEGORIAS_MONO[letra] || letra) : '';
        const result = { cuit, razon_social, regimen, categoria_monotributo, actividad: parseXML(d, 'actividad') };
        console.log('[AFIP] OK:', razon_social, '-', regimen);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'Error procesando respuesta'})); }
    });
  });
  r.on('error', e => { res.writeHead(502); res.end(JSON.stringify({error:e.message})); });
  r.end(postData);
});


const fs = require('fs');

// Endpoint: POST /leer-constancia
// Body: multipart con campo "pdf" (archivo)
async function leerConstancia(req, res) {
  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(body);
      const bodyStr = buffer.toString('binary');
      
      // Extraer el base64 del PDF del multipart
      const boundaryMatch = req.headers['content-type'].match(/boundary=(.+)/);
      if (!boundaryMatch) throw new Error('Sin boundary');
      const boundary = boundaryMatch[1];
      
      // Encontrar el contenido del archivo
      const parts = bodyStr.split('--' + boundary);
      let pdfBase64 = null;
      
      for (const part of parts) {
        if (part.includes('filename=') && part.includes('application/pdf')) {
          const dataStart = part.indexOf('\r\n\r\n') + 4;
          const dataEnd = part.lastIndexOf('\r\n');
          const pdfData = Buffer.from(part.slice(dataStart, dataEnd), 'binary');
          pdfBase64 = pdfData.toString('base64');
          break;
        }
      }
      
      if (!pdfBase64) throw new Error('No se encontró el PDF');

      // Llamar a Claude API
      const claudeRes = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
              },
              {
                type: 'text',
                text: 'Extraé los siguientes datos de esta constancia de inscripción de AFIP/ARCA y devolvé SOLO un JSON sin texto adicional ni backticks: { "razon_social": "", "cuit": "", "domicilio": "", "regimen": "responsable_inscripto|monotributo|exento|no_inscripto", "categoria_monotributo": "", "forma_juridica": "", "mes_cierre_ejercicio": "", "impuestos": [], "actividad_principal": "", "codigo_actividad": "" }'
              }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const r = https.request(options, pr => {
          let d = '';
          pr.on('data', c => d += c);
          pr.on('end', () => resolve(JSON.parse(d)));
        });
        r.on('error', reject);
        r.write(payload);
        r.end();
      });

      console.log('[CLAUDE] Respuesta:', JSON.stringify(claudeRes));
      const raw = claudeRes.content[0].text.trim();
      const text = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const datos = JSON.parse(text);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(datos));

    } catch(e) {
      console.error('[PDF] Error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({error: e.message}));
    }
  });
}


async function sendMailHandler(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { destinatario, asunto, html } = JSON.parse(body);
      const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
      if (!RESEND_API_KEY) {
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({ ok: true, msg: 'Resend no configurado - mail simulado' }));
        return;
      }
      const r = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ from: 'GestorFiscal <notificaciones@tuestudio.com.ar>', to: destinatario, subject: asunto, html });
        const opts = { hostname: 'api.resend.com', path: '/emails', method: 'POST', headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const req2 = https.request(opts, pr => { let d=''; pr.on('data',c=>d+=c); pr.on('end',()=>resolve(JSON.parse(d))); });
        req2.on('error', reject);
        req2.write(payload);
        req2.end();
      });
      res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
      res.end(JSON.stringify({ ok: true, id: r.id }));
    } catch(e) {
      res.writeHead(500, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}


async function procesarDJ(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { attachment_id, filename, message_id, from_email, subject } = JSON.parse(body);
      console.log('[DJ] Recibido:', filename, 'de', from_email);

      // 1. Descargar el PDF de Gmail via API
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(
        process.env.VITE_SUPABASE_URL || '',
        process.env.SUPABASE_SERVICE_KEY || ''
      );

      // Por ahora respondemos OK y logueamos
      // El procesamiento completo requiere Gmail API token
      console.log('[DJ] attachment_id:', attachment_id);
      console.log('[DJ] message_id:', message_id);

      res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
      res.end(JSON.stringify({ ok: true, msg: 'DJ recibida: ' + filename }));
    } catch(e) {
      console.error('[DJ] Error:', e.message);
      res.writeHead(500, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

server.listen(PORT, () => console.log('Proxy AFIP en http://localhost:' + PORT));

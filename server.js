/**
 * KERAPODO — Sistema de Ponche v2.0
 * Backend Node.js → Odoo XML-RPC (hr.attendance)
 * Hosting: Render.com
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ODOO_URL   = process.env.ODOO_URL   || 'https://kerapodo.softlink.com.do';
const ODOO_DB    = process.env.ODOO_DB    || 'prod';
const ODOO_USER  = process.env.ODOO_USER  || '';
const ODOO_PASS  = process.env.ODOO_PASS  || '';   // API key o contraseña
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'admin-kerapodo-2026';
const PORT       = process.env.PORT       || 3000;

// ── EMPLEADOS EN MEMORIA (PIN → datos) ───────────────────────────────────────
// Se cargan desde /admin/empleados y se almacenan en RAM.
// En Render.com, si el servidor reinicia se pierden; por eso el admin puede
// recargarlos en cualquier momento desde el panel de la tablet.
let empleadosPorPIN = {};
// Ejemplo de estructura:
// { "1234": { odoo_id: 4, nombre: "Alba Iris De Los Santos", sucursal_default: "Centro" } }

// ── HELPER XML-RPC ────────────────────────────────────────────────────────────
function xmlrpcCall(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>
    ${params.map(p => `<param><value>${toXmlValue(p)}</value></param>`).join('\n    ')}
  </params>
</methodCall>`;

    const url = new URL(ODOO_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parser = new XMLParser({ ignoreAttributes: false });
          const parsed = parser.parse(data);
          const value = extractValue(parsed?.methodResponse?.params?.param?.value);
          resolve(value);
        } catch (e) {
          reject(new Error('XML parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function toXmlValue(v) {
  if (v === null || v === false) return '<boolean>0</boolean>';
  if (v === true) return '<boolean>1</boolean>';
  if (typeof v === 'number' && Number.isInteger(v)) return `<int>${v}</int>`;
  if (typeof v === 'number') return `<double>${v}</double>`;
  if (typeof v === 'string') return `<string>${v}</string>`;
  if (Array.isArray(v)) {
    return `<array><data>${v.map(x => `<value>${toXmlValue(x)}</value>`).join('')}</data></array>`;
  }
  if (typeof v === 'object') {
    const members = Object.entries(v).map(([k, val]) =>
      `<member><name>${k}</name><value>${toXmlValue(val)}</value></member>`
    ).join('');
    return `<struct>${members}</struct>`;
  }
  return `<string>${String(v)}</string>`;
}

function extractValue(node) {
  if (!node) return null;
  if (node.int !== undefined) return parseInt(node.int);
  if (node.i4 !== undefined) return parseInt(node.i4);
  if (node.double !== undefined) return parseFloat(node.double);
  if (node.boolean !== undefined) return node.boolean === '1' || node.boolean === 1;
  if (node.string !== undefined) return node.string;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return node;
  if (node.array?.data?.value) {
    const vals = node.array.data.value;
    return (Array.isArray(vals) ? vals : [vals]).map(extractValue);
  }
  if (node.struct?.member) {
    const members = Array.isArray(node.struct.member) ? node.struct.member : [node.struct.member];
    const result = {};
    members.forEach(m => { result[m.name] = extractValue(m.value); });
    return result;
  }
  return node;
}

// ── ODOO AUTH ─────────────────────────────────────────────────────────────────
let odooUID = null;
let odooAuthError = null;

async function odooLogin() {
  try {
    const uid = await xmlrpcCall('/xmlrpc/2/common', 'authenticate', [
      ODOO_DB, ODOO_USER, ODOO_PASS, {}
    ]);
    if (!uid || uid === false) throw new Error('Credenciales inválidas');
    odooUID = uid;
    odooAuthError = null;
    console.log(`✅ Odoo autenticado. UID: ${uid}`);
    return uid;
  } catch (e) {
    odooAuthError = e.message;
    console.error('❌ Error Odoo auth:', e.message);
    return null;
  }
}

async function odooExecute(model, method, args, kwargs = {}) {
  if (!odooUID) await odooLogin();
  if (!odooUID) throw new Error('Sin conexión a Odoo: ' + odooAuthError);
  return xmlrpcCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, odooUID, ODOO_PASS, model, method, args, kwargs
  ]);
}

// ── MIDDLEWARE ADMIN ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── HELPER FECHA ISO EN RD ────────────────────────────────────────────────────
function ahoraUTC() {
  // Odoo almacena en UTC. RD = UTC-4
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS
// ═══════════════════════════════════════════════════════════════════════════════

// Salud del servidor
app.get('/', async (req, res) => {
  const uid = await odooLogin();
  res.json({
    sistema: 'Kerapodo Ponche v2.0',
    estado: 'activo',
    odoo_conexion: uid ? '✅' : '❌',
    odoo_error: odooAuthError || null,
    empleados_cargados: Object.keys(empleadosPorPIN).length,
    timestamp: new Date().toISOString(),
  });
});

// ── PONCHE ────────────────────────────────────────────────────────────────────
/**
 * POST /ponche
 * Body: { pin, sucursal, tipo_ponche? }
 * tipo_ponche: "auto" (detecta entrada/salida) | "entrada" | "salida" | "asistido"
 */
app.post('/ponche', async (req, res) => {
  const { pin, sucursal, tipo_ponche = 'auto' } = req.body;

  if (!pin || !sucursal) {
    return res.status(400).json({ ok: false, error: 'Falta PIN o sucursal' });
  }

  const empleado = empleadosPorPIN[pin];
  if (!empleado) {
    return res.status(404).json({ ok: false, error: 'PIN incorrecto' });
  }

  try {
    const ahora = ahoraUTC();

    // Verificar si hay un ponche abierto (sin check_out)
    const registrosAbiertos = await odooExecute('hr.attendance', 'search_read',
      [[['employee_id', '=', empleado.odoo_id], ['check_out', '=', false]]],
      { fields: ['id', 'check_in', 'employee_id'], limit: 1 }
    );

    let accion, attendance_id;

    if (registrosAbiertos && registrosAbiertos.length > 0) {
      // SALIDA — hay registro abierto
      const registro = registrosAbiertos[0];
      await odooExecute('hr.attendance', 'write',
        [[registro.id], {
          check_out: ahora,
          reason: tipo_ponche === 'asistido' ? 'Ponche asistido' : ''
        }]
      );
      attendance_id = registro.id;
      accion = 'salida';
    } else {
      // ENTRADA — crear nuevo registro
      attendance_id = await odooExecute('hr.attendance', 'create', [{
        employee_id: empleado.odoo_id,
        check_in: ahora,
        reason: tipo_ponche === 'asistido' ? 'Ponche asistido' : '',
      }]);
      accion = 'entrada';
    }

    console.log(`[PONCHE] ${empleado.nombre} → ${accion.toUpperCase()} | ${sucursal} | ${ahora}`);

    return res.json({
      ok: true,
      accion,
      nombre: empleado.nombre,
      sucursal,
      hora: ahora,
      attendance_id,
      asistido: tipo_ponche === 'asistido',
    });

  } catch (e) {
    console.error('[PONCHE ERROR]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Consultar estado actual de un empleado por PIN
app.post('/estado', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'Falta PIN' });

  const empleado = empleadosPorPIN[pin];
  if (!empleado) return res.status(404).json({ error: 'PIN incorrecto' });

  try {
    const abiertos = await odooExecute('hr.attendance', 'search_read',
      [[['employee_id', '=', empleado.odoo_id], ['check_out', '=', false]]],
      { fields: ['check_in'], limit: 1 }
    );

    const dentro = abiertos && abiertos.length > 0;
    return res.json({
      nombre: empleado.nombre,
      dentro,
      check_in: dentro ? abiertos[0].check_in : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

// Ver empleados cargados en memoria
app.get('/admin/empleados', requireAdmin, (req, res) => {
  const lista = Object.entries(empleadosPorPIN).map(([pin, e]) => ({
    pin,
    odoo_id: e.odoo_id,
    nombre: e.nombre,
  }));
  res.json({ total: lista.length, empleados: lista });
});

// Agregar o actualizar un empleado con PIN
app.post('/admin/pin', requireAdmin, (req, res) => {
  const { odoo_id, nombre, pin } = req.body;
  if (!odoo_id || !nombre || !pin) {
    return res.status(400).json({ error: 'Faltan campos: odoo_id, nombre, pin' });
  }
  if (pin.length < 4 || pin.length > 6) {
    return res.status(400).json({ error: 'PIN debe tener 4-6 dígitos' });
  }
  // Verificar que el PIN no esté en uso por otro empleado
  const existente = empleadosPorPIN[pin];
  if (existente && existente.odoo_id !== odoo_id) {
    return res.status(409).json({ error: `PIN ${pin} ya está asignado a ${existente.nombre}` });
  }
  // Quitar PIN anterior del mismo empleado si tenía uno diferente
  for (const [p, e] of Object.entries(empleadosPorPIN)) {
    if (e.odoo_id === odoo_id && p !== pin) {
      delete empleadosPorPIN[p];
    }
  }
  empleadosPorPIN[pin] = { odoo_id: parseInt(odoo_id), nombre, pin };
  console.log(`[ADMIN] PIN asignado: ${nombre} → ${pin}`);
  res.json({ ok: true, mensaje: `PIN asignado a ${nombre}` });
});

// Cargar lista de empleados desde Odoo (para ver los IDs)
app.get('/admin/odoo-empleados', requireAdmin, async (req, res) => {
  try {
    const empleados = await odooExecute('hr.employee', 'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'name', 'job_id', 'work_location_id'], order: 'name asc' }
    );
    res.json({ total: empleados.length, empleados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Eliminar PIN
app.delete('/admin/pin/:pin', requireAdmin, (req, res) => {
  const { pin } = req.params;
  if (empleadosPorPIN[pin]) {
    const nombre = empleadosPorPIN[pin].nombre;
    delete empleadosPorPIN[pin];
    res.json({ ok: true, mensaje: `PIN de ${nombre} eliminado` });
  } else {
    res.status(404).json({ error: 'PIN no encontrado' });
  }
});

// Ver asistencias del día actual
app.get('/admin/asistencias-hoy', requireAdmin, async (req, res) => {
  try {
    // Calcular inicio del día en UTC (RD = UTC-4)
    const hoy = new Date();
    hoy.setHours(hoy.getHours() + 4); // convertir a RD
    const inicioRD = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    inicioRD.setHours(inicioRD.getHours() - 4); // volver a UTC
    const inicioStr = inicioRD.toISOString().replace('T', ' ').substring(0, 19);

    const asistencias = await odooExecute('hr.attendance', 'search_read',
      [[['check_in', '>=', inicioStr]]],
      { fields: ['employee_id', 'check_in', 'check_out', 'worked_hours'], order: 'check_in desc', limit: 200 }
    );
    res.json({ fecha: inicioStr, total: asistencias.length, asistencias });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Carga masiva de PINs (array de empleados)
app.post('/admin/carga-masiva', requireAdmin, (req, res) => {
  const { empleados } = req.body; // [{ odoo_id, nombre, pin }]
  if (!Array.isArray(empleados)) {
    return res.status(400).json({ error: 'Enviar array de empleados' });
  }
  let cargados = 0, errores = [];
  empleados.forEach(e => {
    if (!e.odoo_id || !e.nombre || !e.pin) {
      errores.push(`Incompleto: ${JSON.stringify(e)}`);
      return;
    }
    empleadosPorPIN[e.pin] = { odoo_id: parseInt(e.odoo_id), nombre: e.nombre };
    cargados++;
  });
  res.json({ ok: true, cargados, errores });
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
odooLogin().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🦶 KERAPODO Ponche v2.0`);
    console.log(`🚀 Puerto: ${PORT}`);
    console.log(`📡 Odoo: ${ODOO_URL} (DB: ${ODOO_DB})`);
    console.log(`👥 Empleados cargados: ${Object.keys(empleadosPorPIN).length}`);
    console.log(`🔑 Admin key configurada: ${ADMIN_KEY !== 'admin-kerapodo-2026' ? '✅' : '⚠️  usar default — cambiar en producción'}\n`);
  });
});

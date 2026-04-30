'use strict';
const express     = require('express');
const xmlrpc      = require('xmlrpc');
const cors        = require('cors');
const path        = require('path');

const app  = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG DESDE ENV ──────────────────────────────────────────────────────────
const ODOO_URL  = process.env.ODOO_URL  || 'https://kerapodo.softlink.com.do';
const ODOO_DB   = process.env.ODOO_DB   || 'prod';
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASS || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'Kp@2026!';
const PORT      = process.env.PORT      || 10000;

// ── HELPER: fecha UTC en formato Odoo "YYYY-MM-DD HH:MM:SS" ──────────────────
function nowOdoo() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Convierte "YYYY-MM-DD" (hora RD) a UTC Odoo string
function rdDateToUTC(fechaRD, isStart) {
  const [y, m, d] = fechaRD.split('-').map(Number);
  // RD = UTC-4: inicio del día RD (00:00) = 04:00 UTC misma fecha
  //             fin del día RD (23:59)    = 03:59:59 UTC día siguiente
  const offset = isStart ? 0 : 1;
  const h      = isStart ? 4 : 3;
  const min    = isStart ? 0 : 59;
  const sec    = isStart ? 0 : 59;
  const dt     = new Date(Date.UTC(y, m - 1, d + offset, h, min, sec));
  const pad    = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())} ` +
         `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

// Fecha de hoy en RD (UTC-4) en formato YYYY-MM-DD
function todayRD() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

// ── XMLRPC CLIENT ─────────────────────────────────────────────────────────────
const urlObj    = new URL(ODOO_URL);
const useSSL    = urlObj.protocol === 'https:';
const host      = urlObj.hostname;
const port      = urlObj.port ? parseInt(urlObj.port) : (useSSL ? 443 : 80);
const clientOpt = { host, port, path: '/xmlrpc/2/common', ...(useSSL ? { secure: true } : {}) };
const objOpt    = { host, port, path: '/xmlrpc/2/object',  ...(useSSL ? { secure: true } : {}) };

const commonClient = useSSL ? xmlrpc.createSecureClient(clientOpt) : xmlrpc.createClient(clientOpt);
const objectClient = useSSL ? xmlrpc.createSecureClient(objOpt)    : xmlrpc.createClient(objOpt);

function xmlCall(client, method, params) {
  return new Promise((res, rej) =>
    client.methodCall(method, params, (err, val) => err ? rej(err) : res(val))
  );
}

let uid = null;

async function getUID() {
  if (uid) return uid;
  uid = await xmlCall(commonClient, 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]);
  console.log(`[qt4zk] ✅ Odoo UID: ${uid}`);
  return uid;
}

async function odooExecute(model, method, args, kwargs = {}) {
  const u = await getUID();
  return xmlCall(objectClient, 'execute_kw', [ODOO_DB, u, ODOO_PASS, model, method, args, kwargs]);
}

// ── CACHE DE EMPLEADOS ────────────────────────────────────────────────────────
let empleados = [];

async function cargarEmpleados() {
  try {
    const lista = await odooExecute('hr.employee', 'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'name', 'barcode'], limit: 500 }
    );
    empleados = (lista || []).map(e => ({
      odoo_id : e.id,
      nombre  : e.name,
      pin     : e.barcode || null
    })).filter(e => e.pin);
    console.log(`[qt4zk] 👥 Empleados con PIN: ${empleados.length}`);
  } catch (err) {
    console.error('[qt4zk] ❌ Error cargando empleados:', err.message);
  }
}

cargarEmpleados();
setInterval(cargarEmpleados, 5 * 60 * 1000); // recarga cada 5 min

// ── MIDDLEWARE ADMIN ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ sistema: 'Kerapodo Ponche v3.0', estado: 'activo', empleados_con_pin: empleados.length });
});

// ── PONCHE ────────────────────────────────────────────────────────────────────
app.post('/ponche', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, msg: 'PIN requerido' });

  const e = empleados.find(x => x.pin === String(pin));
  if (!e) return res.status(404).json({ ok: false, msg: 'PIN no encontrado' });

  try {
    // Buscar si tiene entrada abierta (sin check_out)
    const abiertos = await odooExecute('hr.attendance', 'search_read',
      [[['employee_id', '=', e.odoo_id], ['check_out', '=', false]]],
      { fields: ['id', 'check_in'], limit: 1 }
    );

    const ahora = nowOdoo(); // "YYYY-MM-DD HH:MM:SS" UTC
    let attendance_id, mensaje, tipo;

    if (abiertos && abiertos.length > 0) {
      // ── SALIDA ──
      const registro = abiertos[0];
      attendance_id = await odooExecute('hr.attendance', 'write',
        [[registro.id], { check_out: ahora }]
      );
      console.log(`[PONCHE] ${e.nombre} → SALIDA  | check_out: ${ahora} | write result: ${attendance_id}`);
      mensaje = 'SALIDA REGISTRADA';
      tipo    = 'salida';
    } else {
      // ── ENTRADA ──
      attendance_id = await odooExecute('hr.attendance', 'create',
        [{ employee_id: e.odoo_id, check_in: ahora }]
      );
      console.log(`[PONCHE] ${e.nombre} → ENTRADA | check_in: ${ahora} | create result: ${attendance_id}`);
      mensaje = 'ENTRADA REGISTRADA';
      tipo    = 'entrada';
    }

    // Verificar que Odoo devolvió algo válido
    if (!attendance_id) {
      console.error(`[PONCHE-ERROR] Odoo devolvió null para ${e.nombre}. Formato: "${ahora}"`);
      return res.status(500).json({ ok: false, msg: 'Error en Odoo — contacte al administrador' });
    }

    // Hora local RD para mostrar en pantalla
    const horaRD = new Date(Date.now() - 4 * 3600 * 1000)
      .toISOString().substring(11, 16);

    res.json({ ok: true, nombre: e.nombre, tipo, mensaje, hora: horaRD });

  } catch (err) {
    console.error(`[PONCHE-EXCEPTION] ${e.nombre}:`, err.message);
    res.status(500).json({ ok: false, msg: 'Error interno: ' + err.message });
  }
});

// ── REPORTE HOY ───────────────────────────────────────────────────────────────
app.get('/admin/reporte-hoy', requireAdmin, async (req, res) => {
  const hoy = todayRD();
  const desde = rdDateToUTC(hoy, true);
  const hasta  = rdDateToUTC(hoy, false);

  try {
    const regs = await odooExecute('hr.attendance', 'search_read',
      [[['check_in', '>=', desde], ['check_in', '<=', hasta]]],
      { fields: ['employee_id', 'check_in', 'check_out', 'worked_hours'], order: 'check_in asc', limit: 500 }
    );
    console.log(`[REPORTE-HOY] ${desde} → ${hasta} | Registros: ${(regs||[]).length}`);
    res.json({ ok: true, fecha: hoy, registros: regs || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── REPORTE POR RANGO ─────────────────────────────────────────────────────────
app.get('/admin/reporte', requireAdmin, async (req, res) => {
  try {
    const hoy      = todayRD();
    const fechaDesde = req.query.desde || hoy;
    const fechaHasta = req.query.hasta  || hoy;
    const empId     = req.query.empleado_id ? parseInt(req.query.empleado_id) : null;

    const desde = rdDateToUTC(fechaDesde, true);
    const hasta  = rdDateToUTC(fechaHasta, false);

    const filtro = [['check_in', '>=', desde], ['check_in', '<=', hasta]];
    if (empId) filtro.push(['employee_id', '=', empId]);

    const regs = await odooExecute('hr.attendance', 'search_read',
      [filtro],
      { fields: ['employee_id', 'check_in', 'check_out', 'worked_hours'], order: 'employee_id asc,check_in asc', limit: 2000 }
    );
    console.log(`[REPORTE-RANGO] ${desde} → ${hasta} | Registros: ${(regs||[]).length}`);

    // Agrupar por empleado
    const porEmp = {};
    (regs || []).forEach(r => {
      const id     = Array.isArray(r.employee_id) ? r.employee_id[0] : r.employee_id;
      const nombre = Array.isArray(r.employee_id) ? r.employee_id[1] : `Empleado ${id}`;
      if (!porEmp[id]) porEmp[id] = { id, nombre, registros: [], totalHoras: 0 };
      porEmp[id].registros.push(r);
      porEmp[id].totalHoras += r.worked_hours || 0;
    });

    res.json({
      ok: true, desde: fechaDesde, hasta: fechaHasta,
      total: (regs||[]).length,
      empleados: Object.values(porEmp)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── LISTA DE EMPLEADOS (para filtros) ─────────────────────────────────────────
app.get('/admin/empleados', requireAdmin, (req, res) => {
  res.json({ ok: true, empleados: empleados.map(e => ({ id: e.odoo_id, nombre: e.nombre })) });
});

// ── DEBUG: ver últimos registros en Odoo ──────────────────────────────────────
app.get('/admin/debug-odoo', requireAdmin, async (req, res) => {
  try {
    const regs = await odooExecute('hr.attendance', 'search_read',
      [[]],
      { fields: ['employee_id', 'check_in', 'check_out', 'worked_hours'], order: 'id desc', limit: 10 }
    );
    res.json({ ok: true, total: (regs||[]).length, muestra: regs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🟢 Kerapodo Ponche v3.0 escuchando en puerto ${PORT}`));

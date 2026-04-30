/**
 * KERAPODO — Sistema de Ponche v3.0
 * Con sistema de almuerzo, descuentos y banco de tiempo
 */

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL  = process.env.ODOO_URL  || '';
const ODOO_DB   = process.env.ODOO_DB   || 'prod';
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASS || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-kerapodo-2026';
const PORT      = process.env.PORT      || 3000;
const PINES_URL = process.env.PINES_URL || 'https://raw.githubusercontent.com/herassme/kerapodo-ponche/main/pines.json';

let empleadosPorPIN = {};

// ── HORARIOS ──────────────────────────────────────────────────────────────────
const HORARIOS = {
  // 0=Dom, 1=Lun, 2=Mar, 3=Mie, 4=Jue, 5=Vie, 6=Sab
  semana: { dias: [1,2,3,4,5], entrada: '09:00', salida: '18:00', extraDesde: '18:30', almuerzo: 60 },
  finde:  { dias: [0,6],       entrada: '09:00', salida: '15:00', extraDesde: '15:30', almuerzo: 60 },
};

function getHorarioHoy() {
  const dia = diaRD !== undefined ? diaRD() : new Date().getDay();
  return HORARIOS.finde.dias.includes(dia) ? HORARIOS.finde : HORARIOS.semana;
}

function horaAMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutosAHora(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function horaLocalRD(fechaUTC) {
  // Odoo guarda en UTC, RD = UTC-4
  const d = new Date(fechaUTC.replace(' ', 'T') + 'Z');
  d.setHours(d.getHours() - 4);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ahoraUTC() {
  return new Date().toISOString().replace('T',' ').substring(0,19);
}

function ahoraRD() {
  // RD = UTC-4
  const d = new Date();
  d.setHours(d.getHours() - 4);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function diaRD() {
  // Dia de la semana en RD (0=Dom ... 6=Sab)
  const d = new Date();
  d.setHours(d.getHours() - 4);
  return d.getDay();
}

// ── INICIO DEL DÍA EN RD ─────────────────────────────────────────────────────
function inicioDiaUTC() {
  // RD = UTC-4. Medianoche en RD = 04:00 UTC del mismo dia
  const ahoraRDms = Date.now() - (4 * 60 * 60 * 1000);
  const d = new Date(ahoraRDms);
  // Construir fecha como "YYYY-MM-DD 04:00:00" en UTC
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day} 04:00:00`;
}

// ── DESCRIPTORES FACIALES ────────────────────────────────────────────────────
// Guardados en memoria. Al reiniciar se pierden — el kiosko los recarga automáticamente.
// Los descriptores son arrays de 128 números Float32 (~512 bytes c/u)
let descriptoresFaciales = {};

// ── AUTO-CARGA PINES ──────────────────────────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function cargarPinesDesdeGitHub() {
  try {
    const data = await fetchURL(PINES_URL);
    const json = JSON.parse(data);
    if (Array.isArray(json.empleados)) {
      json.empleados.forEach(e => {
        if (e.pin && e.odoo_id && e.nombre)
          empleadosPorPIN[e.pin] = { odoo_id: parseInt(e.odoo_id), nombre: e.nombre };
      });
      console.log(`✅ ${Object.keys(empleadosPorPIN).length} PINs cargados`);
    }
  } catch(e) { console.error('❌ PINs:', e.message); }
}

// ── XML-RPC ───────────────────────────────────────────────────────────────────
function xmlrpcCall(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param><value>${toXmlValue(p)}</value></param>`).join('')}</params></methodCall>`;
    const url = new URL(ODOO_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = { hostname:url.hostname, port:url.port||(isHttps?443:80), path:url.pathname, method:'POST', headers:{'Content-Type':'text/xml','Content-Length':Buffer.byteLength(body)} };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = new XMLParser({
            ignoreAttributes: false,
            isArray: (name, jpath) => {
              // Siempre tratar <value> dentro de <data> como array
              if (name === 'value' && jpath.includes('array.data')) return true;
              if (name === 'member') return true;
              return false;
            }
          });
          const parsed = p.parse(data);
          const paramValue = parsed?.methodResponse?.params?.param?.value;
          resolve(extractValue(paramValue)); }
        catch(e) { reject(new Error('XML: '+e.message)); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function toXmlValue(v) {
  if (v===null||v===false) return '<boolean>0</boolean>';
  if (v===true) return '<boolean>1</boolean>';
  if (typeof v==='number'&&Number.isInteger(v)) return `<int>${v}</int>`;
  if (typeof v==='number') return `<double>${v}</double>`;
  if (typeof v==='string') return `<string>${v}</string>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x=>`<value>${toXmlValue(x)}</value>`).join('')}</data></array>`;
  if (typeof v==='object') return `<struct>${Object.entries(v).map(([k,val])=>`<member><name>${k}</name><value>${toXmlValue(val)}</value></member>`).join('')}</struct>`;
  return `<string>${String(v)}</string>`;
}

function extractValue(n) {
  if (n === null || n === undefined) return null;
  // Tipos primitivos directos (fast-xml-parser a veces devuelve números nativos)
  if (typeof n === 'number') return n;
  if (typeof n === 'string') return n;
  if (typeof n === 'boolean') return n;
  // Objeto con #text (fast-xml-parser wrappea valores numéricos así)
  if (n['#text'] !== undefined) {
    const v = n['#text'];
    return typeof v === 'number' ? v : (isNaN(Number(v)) ? v : Number(v));
  }
  if (n.int  !== undefined) return typeof n.int  === 'number' ? n.int  : parseInt(n.int);
  if (n.i4   !== undefined) return typeof n.i4   === 'number' ? n.i4   : parseInt(n.i4);
  if (n.i8   !== undefined) return typeof n.i8   === 'number' ? n.i8   : parseInt(n.i8);
  if (n.double !== undefined) return typeof n.double === 'number' ? n.double : parseFloat(n.double);
  if (n.boolean !== undefined) return n.boolean === '1' || n.boolean === 1 || n.boolean === true;
  if (n.string  !== undefined) return n.string === false ? '' : String(n.string ?? '');
  if (n.nil     !== undefined) return null;
  if (n.array !== undefined) {
    if (!n.array?.data || n.array.data.value === undefined) return [];
    const v = n.array.data.value;
    return (Array.isArray(v) ? v : [v]).map(extractValue);
  }
  if (n.struct?.member) {
    const m = Array.isArray(n.struct.member) ? n.struct.member : [n.struct.member];
    const r = {};
    m.forEach(x => r[x.name] = extractValue(x.value));
    return r;
  }
  return n;
}

let odooUID=null, odooAuthError=null;
async function odooLogin() {
  try {
    const uid = await xmlrpcCall('/xmlrpc/2/common','authenticate',[ODOO_DB,ODOO_USER,ODOO_PASS,{}]);
    if (!uid||uid===false) throw new Error('Credenciales inválidas');
    odooUID=uid; odooAuthError=null;
    console.log(`✅ Odoo UID: ${uid}`); return uid;
  } catch(e) { odooAuthError=e.message; console.error('❌ Odoo:',e.message); return null; }
}


// Obtener XML raw de Odoo sin parsear
function xmlrpcCallRaw(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param><value>${toXmlValue(p)}</value></param>`).join('')}</params></methodCall>`;
    const url = new URL(ODOO_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');
    const options = { hostname:url.hostname, port:url.port||(isHttps?443:80), path:url.pathname, method:'POST', headers:{'Content-Type':'text/xml','Content-Length':Buffer.byteLength(body)} };
    const req = lib.request(options, res => {
      let data='';
      res.on('data', c => data+=c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Parsear XML de respuesta de hr.attendance.search_read manualmente
function parseAttendanceXml(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const results = [];
  
  // Extraer todos los structs (cada uno es un registro)
  const structRegex = /<struct>([\s\S]*?)<\/struct>/g;
  let structMatch;
  
  while ((structMatch = structRegex.exec(xml)) !== null) {
    const structContent = structMatch[1];
    const record = {};
    
    // Extraer members
    const memberRegex = /<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let memberMatch;
    
    while ((memberMatch = memberRegex.exec(structContent)) !== null) {
      const name = memberMatch[1].trim();
      const valueContent = memberMatch[2].trim();
      
      if (name === 'id') {
        record.id = parseInt(valueContent.replace(/<\/?[^>]+>/g, '')) || 0;
      } else if (name === 'check_in') {
        const strMatch = valueContent.match(/<string>(.*?)<\/string>/);
        record.check_in = strMatch ? strMatch[1] : (valueContent.includes('false') ? null : valueContent.replace(/<\/?[^>]+>/g, '').trim());
      } else if (name === 'check_out') {
        const strMatch = valueContent.match(/<string>(.*?)<\/string>/);
        const val = strMatch ? strMatch[1] : valueContent.replace(/<\/?[^>]+>/g, '').trim();
        record.check_out = (val === 'false' || val === '0' || !val) ? false : val;
      } else if (name === 'employee_id') {
        // Array [id, name]
        const intMatch = valueContent.match(/<int>(.*?)<\/int>|<i4>(.*?)<\/i4>/);
        const strMatch = valueContent.match(/<string>(.*?)<\/string>/g);
        if (intMatch) {
          const empId = parseInt(intMatch[1] || intMatch[2]);
          const empName = strMatch && strMatch[1] ? strMatch[1].replace(/<\/?[^>]+>/g,'') : '';
          record.employee_id = [empId, empName];
        }
      }
    }
    
    if (record.id) {
      results.push(record);
    }
  }
  
  return results;
}

async function odooExecute(model,method,args,kwargs={}) {
  if (!odooUID) await odooLogin();
  if (!odooUID) throw new Error('Sin Odoo: '+odooAuthError);
  return xmlrpcCall('/xmlrpc/2/object','execute_kw',[ODOO_DB,odooUID,ODOO_PASS,model,method,args,kwargs]);
}

function requireAdmin(req,res,next) {
  if ((req.headers['x-admin-key']||req.query.adminKey)!==ADMIN_KEY) return res.status(401).json({error:'No autorizado'});
  next();
}

// ── ESTADO DEL EMPLEADO HOY ───────────────────────────────────────────────────
async function getEstadoEmpleado(odoo_id) {
  const inicioStr = inicioDiaUTC();

  const registros = await odooExecute('hr.attendance','search_read',
    [[['employee_id','=',odoo_id],['check_in','>=',inicioStr]]],
    {fields:['id','check_in','check_out'],order:'check_in asc'}
  );

  // Sin registros hoy → siempre es primera entrada (sin importar la hora)
  // Proteger contra null y filtrar registros mal formados
  const regsValidos = Array.isArray(registros) ? registros.filter(r => r && r.check_in !== undefined) : [];
  if (regsValidos.length === 0) return { estado: 'sin_entrada', registros: [] };

  const ultimo = regsValidos[regsValidos.length - 1];
  const totalRegistros = regsValidos.length;
  const horaActual = horaAMinutos(ahoraRD());
  const corteAlmuerzo = horaAMinutos('16:00');

  if (!ultimo.check_out) {
    // Tiene registro abierto → está dentro
    if (totalRegistros === 1) {
      // Primera entrada del día — ¿sale a almorzar o salida final?
      if (horaActual < corteAlmuerzo) {
        return { estado: 'en_trabajo', registros, ultimo }; // botón: Salida a Almorzar
      } else {
        return { estado: 'regreso_almuerzo', registros, ultimo }; // botón: Salida Final (saltó almuerzo)
      }
    }
    // Segundo registro abierto → regresó del almuerzo, próximo paso es salida final
    return { estado: 'regreso_almuerzo', registros, ultimo };
  } else {
    // Todos los registros cerrados
    if (totalRegistros === 1) {
      // Salió del primer bloque → está en almuerzo
      return { estado: 'en_almuerzo', registros, ultimo };
    }
    // 2+ registros cerrados → jornada completada
    return { estado: 'salio', registros, ultimo };
  }
}

// ── CALCULAR DESCUENTOS Y BANCO ───────────────────────────────────────────────
function calcularTiempo(registros, horario) {
  let minutosTrabajados = 0;
  let minutosAlmuerzo = 0;
  let excesosAlmuerzo = 0;
  let descuentoTarde = 0;
  let bancoExtra = 0;

  const entradaPermitida = horaAMinutos(horario.entrada);
  const salidaPermitida  = horaAMinutos(horario.salida);
  const extraDesde       = horaAMinutos(horario.extraDesde);

  registros.forEach((r, i) => {
    if (!r.check_in || !r.check_out) return;
    const inicio = horaAMinutos(horaLocalRD(r.check_in));
    const fin    = horaAMinutos(horaLocalRD(r.check_out));
    const duracion = fin - inicio;

    if (r.reason === 'salida_almuerzo') {
      // Es el bloque de almuerzo
      minutosAlmuerzo = duracion;
      if (duracion > horario.almuerzo) excesosAlmuerzo = duracion - horario.almuerzo;
    } else {
      minutosTrabajados += duracion;
      // Primer registro = verificar llegada tarde
      if (i === 0 && inicio > entradaPermitida) descuentoTarde = inicio - entradaPermitida;
      // Último registro = verificar tiempo extra
      if (!registros[i+1] || registros[i+1].reason !== 'salida_almuerzo') {
        if (fin > extraDesde) bancoExtra = fin - extraDesde;
        else if (fin < salidaPermitida) { /* salida anticipada — no calculamos aquí, se ve en horas trabajadas */ }
      }
    }
  });

  const totalDescuentos = descuentoTarde + excesosAlmuerzo;
  const horasEfectivas  = minutosTrabajados - totalDescuentos;

  return { minutosTrabajados, minutosAlmuerzo, excesosAlmuerzo, descuentoTarde, bancoExtra, horasEfectivas };
}

// ── RUTAS ─────────────────────────────────────────────────────────────────────
app.get('/', async (req,res) => {
  const uid = await odooLogin();
  res.json({ sistema:'Kerapodo Ponche v3.0', estado:'activo', odoo_conexion:uid?'✅':'❌', odoo_error:odooAuthError||null, empleados_cargados:Object.keys(empleadosPorPIN).length, timestamp:new Date().toISOString() });
});

// Servir kiosko HTML
app.get('/kiosko', (req,res) => res.sendFile(__dirname + '/kiosko.html'));

// Verificar contraseña admin (para dispositivos sin config en localStorage)
app.post('/admin/verificar', (req,res) => {
  const {key} = req.body;
  if(key === ADMIN_KEY) {
    res.json({ok:true, adminKey: ADMIN_KEY, servidor: ODOO_URL});
  } else {
    res.status(401).json({ok:false, error:'Contraseña incorrecta'});
  }
});
app.get('/reporte', (req,res) => res.sendFile(__dirname + '/reporte.html'));
app.get('/admin-panel', (req,res) => res.sendFile(__dirname + '/admin-panel.html'));

// ── DIAGNÓSTICO ODOO ─────────────────────────────────────────────────────────
app.get('/admin/debug-odoo', requireAdmin, async (req,res) => {
  try {
    // Traer los últimos 5 registros de asistencia sin filtro
    const regs = await odooExecute('hr.attendance','search_read',
      [[]],
      {fields:['employee_id','check_in','check_out'],order:'id desc',limit:5}
    );
    res.json({ok:true, total:regs.length, muestra:regs});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// ── FACIAL: guardar descriptor ─────────────────────────────────────────────
app.post('/admin/facial/guardar', requireAdmin, (req,res) => {
  const {pin, descriptor, nombre} = req.body;
  if(!pin || !descriptor || !Array.isArray(descriptor)) {
    return res.status(400).json({error:'Faltan datos: pin y descriptor (array)'});
  }
  descriptoresFaciales[pin] = {descriptor, nombre, updated_at: new Date().toISOString()};
  console.log(`[FACIAL] Descriptor guardado: ${nombre||pin}`);
  res.json({ok:true, mensaje:`Descriptor de ${nombre||pin} guardado`});
});

// ── FACIAL: obtener descriptor de un empleado ──────────────────────────────
app.get('/admin/facial/:pin', requireAdmin, (req,res) => {
  const {pin} = req.params;
  const data = descriptoresFaciales[pin];
  if(!data) return res.status(404).json({ok:false, error:'Sin descriptor registrado'});
  res.json({ok:true, pin, descriptor: data.descriptor, nombre: data.nombre, updated_at: data.updated_at});
});

// ── FACIAL: obtener todos los pins con descriptor ──────────────────────────
app.get('/admin/facial', requireAdmin, (req,res) => {
  const lista = Object.entries(descriptoresFaciales).map(([pin, d]) => ({
    pin, nombre: d.nombre, updated_at: d.updated_at
  }));
  res.json({total: lista.length, empleados: lista});
});

// ── FACIAL: eliminar descriptor ────────────────────────────────────────────
app.delete('/admin/facial/:pin', requireAdmin, (req,res) => {
  const {pin} = req.params;
  if(!descriptoresFaciales[pin]) return res.status(404).json({error:'Sin descriptor'});
  const nombre = descriptoresFaciales[pin].nombre;
  delete descriptoresFaciales[pin];
  res.json({ok:true, mensaje:`Descriptor de ${nombre||pin} eliminado`});
});

// ── ESTADO DEL EMPLEADO (para que el kiosko sepa qué botón mostrar) ───────────
app.post('/estado', async (req,res) => {
  const {pin} = req.body;
  if (!pin) return res.status(400).json({error:'Falta PIN'});
  if (Object.keys(empleadosPorPIN).length===0) await cargarPinesDesdeGitHub();
  const e = empleadosPorPIN[pin];
  if (!e) return res.status(404).json({error:'PIN incorrecto'});
  try {
    if (!odooUID) await odooLogin();

    // Buscar entrada abierta (sin check_out) — sin límite de fecha
    const xmlAbierto = await xmlrpcCallRaw('/xmlrpc/2/object','execute_kw',
      [ODOO_DB, odooUID, ODOO_PASS, 'hr.attendance', 'search_read',
        [[['employee_id','=',e.odoo_id],['check_out','=',false]]],
        {fields:['id','check_in'], order:'check_in desc', limit:1}
      ]
    );
    const abiertos = parseAttendanceXml(xmlAbierto);
    const tieneAbierto = abiertos.length > 0;

    // Buscar registros de hoy para saber si ya completó la jornada
    const xmlHoy = await xmlrpcCallRaw('/xmlrpc/2/object','execute_kw',
      [ODOO_DB, odooUID, ODOO_PASS, 'hr.attendance', 'search_read',
        [[['employee_id','=',e.odoo_id],['check_in','>=',inicioDiaUTC()]]],
        {fields:['id','check_in','check_out'], order:'check_in asc', limit:10}
      ]
    );
    const regsHoy = parseAttendanceXml(xmlHoy);

    let estado;
    if (!tieneAbierto && regsHoy.length === 0) {
      estado = 'sin_entrada';       // → botón Entrada
    } else if (tieneAbierto && regsHoy.length <= 1) {
      estado = 'en_trabajo';        // → botón Salida a Almorzar
    } else if (!tieneAbierto && regsHoy.length === 1) {
      estado = 'en_almuerzo';       // → botón Regreso de Almuerzo
    } else if (tieneAbierto && regsHoy.length >= 2) {
      estado = 'regreso_almuerzo';  // → botón Salida Final
    } else {
      estado = 'salio';             // Jornada completada
    }

    res.json({ ok:true, nombre:e.nombre, estado, registros: regsHoy });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── PONCHE PRINCIPAL ──────────────────────────────────────────────────────────
app.post('/ponche', async (req,res) => {
  const {pin, accion} = req.body;
  if (!pin) return res.status(400).json({ok:false,error:'Falta PIN'});
  if (Object.keys(empleadosPorPIN).length===0) await cargarPinesDesdeGitHub();
  const e = empleadosPorPIN[pin];
  if (!e) return res.status(404).json({ok:false,error:'PIN incorrecto'});

  try {
    const ahora   = ahoraUTC();
    const horario = getHorarioHoy();
    const horaRD  = ahoraRD();
    let attendance_id, mensaje = '', alertas = [];

    // ── AUTO-DETECTAR: buscar si tiene entrada abierta en Odoo ──────────────
    const xmlAbiertos = await xmlrpcCallRaw('/xmlrpc/2/object','execute_kw',
      [ODOO_DB, odooUID, ODOO_PASS, 'hr.attendance', 'search_read',
        [[['employee_id','=',e.odoo_id],['check_out','=',false]]],
        {fields:['id','check_in'], order:'check_in desc', limit:1}
      ]
    );
    const abiertos = parseAttendanceXml(xmlAbiertos);
    const tieneAbierto = Array.isArray(abiertos) && abiertos.length > 0;

    if (!tieneAbierto) {
      // ── ENTRADA ────────────────────────────────────────────────────────────
      const minutosEntrada   = horaAMinutos(horaRD);
      const minutosPermitidos = horaAMinutos(horario.entrada);
      if (minutosEntrada > minutosPermitidos) {
        const retraso = minutosEntrada - minutosPermitidos;
        alertas.push(`⚠️ Llegada tarde: ${retraso} minutos`);
      }
      attendance_id = await odooExecute('hr.attendance','create',[{
        employee_id: e.odoo_id, check_in: ahora
      }]);
      mensaje = 'ENTRADA REGISTRADA';

    } else {
      // ── SALIDA ─────────────────────────────────────────────────────────────
      const reg = abiertos[0];
      const regId = parseInt(reg.id);
      const minSalida = horaAMinutos(horaRD);
      const minExtra  = horaAMinutos(horario.extraDesde);
      if (minSalida > minExtra) {
        const extra = minSalida - minExtra;
        alertas.push(`✅ Tiempo extra: ${extra} minutos acreditados`);
      }
      await odooExecute('hr.attendance','write',[[regId],{check_out:ahora}]);
      attendance_id = regId;
      mensaje = 'SALIDA REGISTRADA';
    }

    console.log(`[PONCHE] ${e.nombre} → ${tieneAbierto ? 'SALIDA' : 'ENTRADA'} | ${ahora} | id: ${attendance_id}`);

    const tipo = tieneAbierto ? 'salida' : 'entrada';
    return res.json({ ok: true, tipo, mensaje, nombre: e.nombre, hora: horaRD, attendance_id, alertas });

  } catch(err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ALERTA ALMUERZO NO PONCHADO ───────────────────────────────────────────────
// Se llama automáticamente a las 2:00 PM para empleados sin almuerzo
app.post('/admin/alerta-almuerzo', requireAdmin, async (req,res) => {
  try {
    const inicioStr = inicioDiaUTC();

    // Buscar empleados con entrada pero sin almuerzo
    const registros = await odooExecute('hr.attendance','search_read',
      [[['check_in','>=',inicioStr],['reason','=','entrada']]],
      {fields:['employee_id','check_in','check_out']}
    );

    const sinAlmuerzo = [];
    for (const r of registros) {
      const tieneAlmuerzo = await odooExecute('hr.attendance','search_count',
        [[['employee_id','=',r.employee_id[0]],['check_in','>=',inicioStr],['reason','=','salida_almuerzo']]]
      );
      if (!tieneAlmuerzo) sinAlmuerzo.push(r.employee_id[1]);
    }

    // Crear nota en Odoo (chatter) — simplificado como registro especial
    if (sinAlmuerzo.length > 0) {
      console.log(`[ALERTA] Sin almuerzo: ${sinAlmuerzo.join(', ')}`);
    }

    res.json({ok:true, sin_almuerzo: sinAlmuerzo, total: sinAlmuerzo.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── REPORTE DEL DÍA ───────────────────────────────────────────────────────────
app.get('/admin/reporte-hoy', requireAdmin, async (req,res) => {
  try {
    // Calcular inicio del dia en RD (UTC-4)
    const ahoraUTCms = Date.now();
    const ahoraRDms  = ahoraUTCms - (4 * 60 * 60 * 1000);
    const dRD        = new Date(ahoraRDms);
    // Inicio del dia RD en UTC
    const inicioRD   = new Date(Date.UTC(dRD.getUTCFullYear(), dRD.getUTCMonth(), dRD.getUTCDate(), 4, 0, 0));
    const inicioStr  = inicioRD.toISOString().replace('T',' ').substring(0,19);
    const horario = getHorarioHoy();

    const xmlRegs = await xmlrpcCallRaw('/xmlrpc/2/object','execute_kw',
      [ODOO_DB, odooUID, ODOO_PASS, 'hr.attendance', 'search_read',
        [[['check_in','>=',inicioStr]]],
        {fields:['employee_id','check_in','check_out'], order:'employee_id asc,check_in asc'}
      ]
    );
    const regs = parseAttendanceXml(xmlRegs);

    // Agrupar por empleado
    const porEmpleado = {};
    regs.forEach(r => {
      if (!r.employee_id) return;
      const id = Array.isArray(r.employee_id) ? r.employee_id[0] : r.employee_id;
      const nombre = Array.isArray(r.employee_id) ? r.employee_id[1] : 'Desconocido';
      if (!porEmpleado[id]) porEmpleado[id] = { nombre, registros: [] };
      porEmpleado[id].registros.push(r);
    });

    // Calcular para cada empleado
    const resumen = Object.values(porEmpleado).map(emp => {
      const calc = calcularTiempo(emp.registros, horario);
      const tieneAlmuerzo = emp.registros.length > 1;
      return {
        nombre: emp.nombre,
        ...calc,
        sin_almuerzo: !tieneAlmuerzo,
        horas_efectivas_fmt: minutosAHora(Math.max(0, calc.horasEfectivas)),
        banco_fmt: calc.bancoExtra > 0 ? `+${calc.bancoExtra} min` : '0',
        descuento_fmt: (calc.descuentoTarde + calc.excesosAlmuerzo) > 0 ? `-${calc.descuentoTarde + calc.excesosAlmuerzo} min` : '0',
      };
    });

    res.json({ fecha: inicioStr, horario, total: resumen.length, empleados: resumen });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── REPORTE POR RANGO ────────────────────────────────────────────────────────
app.get('/admin/reporte-rango', requireAdmin, async (req,res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;

    function rdFechaAUTC(fechaRD, esInicio) {
      const [y,m,d] = fechaRD.split('-').map(Number);
      if (esInicio) return new Date(Date.UTC(y,m-1,d,4,0,0)).toISOString().replace('T',' ').substring(0,19);
      else          return new Date(Date.UTC(y,m-1,d+1,3,59,59)).toISOString().replace('T',' ').substring(0,19);
    }

    const ahoraRDms = Date.now() - 4*3600000;
    const hoyRD = new Date(ahoraRDms);
    const hoyStr = `${hoyRD.getUTCFullYear()}-${String(hoyRD.getUTCMonth()+1).padStart(2,'0')}-${String(hoyRD.getUTCDate()).padStart(2,'0')}`;

    const fechaDesde = desde || hoyStr;
    const fechaHasta = hasta || hoyStr;
    const desdeUTC   = rdFechaAUTC(fechaDesde, true);
    const hastaUTC   = rdFechaAUTC(fechaHasta, false);

    const filtro = [['check_in','>=',desdeUTC],['check_in','<=',hastaUTC]];
    if (empleado_id) filtro.push(['employee_id','=',parseInt(empleado_id)]);

    console.log('[REPORTE-RANGO] Buscando desde', desdeUTC, 'hasta', hastaUTC);

    const xmlRango = await xmlrpcCallRaw('/xmlrpc/2/object','execute_kw',
      [ODOO_DB, odooUID, ODOO_PASS, 'hr.attendance', 'search_read',
        [filtro],
        {fields:['employee_id','check_in','check_out'], order:'employee_id asc,check_in asc', limit:5000}
      ]
    );
    const regs = parseAttendanceXml(xmlRango);
    console.log('[REPORTE-RANGO] Registros encontrados:', regs.length);

    function horaAMin(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
    function minAHora(min){ if(!min||min<0)return'0:00'; return `${Math.floor(min/60)}:${String(min%60).padStart(2,'0')}`; }
    function horaLocalRD(fechaUTC){
      const d=new Date(fechaUTC.replace(' ','T')+'Z');
      d.setHours(d.getHours()-4);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    function diaStr(fechaUTC){
      const d=new Date(fechaUTC.replace(' ','T')+'Z');
      d.setHours(d.getHours()-4);
      return d.toISOString().substring(0,10);
    }
    function esFinde(fechaUTC){
      const d=new Date(fechaUTC.replace(' ','T')+'Z');
      d.setHours(d.getHours()-4);
      return [0,6].includes(d.getDay());
    }

    // Agrupar por empleado → por dia
    const porEmp = {};
    regs.forEach(r => {
      if (!r.employee_id || !r.check_in) return;
      const id     = Array.isArray(r.employee_id) ? r.employee_id[0] : r.employee_id;
      const nombre = Array.isArray(r.employee_id) ? r.employee_id[1] : '?';
      if (!porEmp[id]) porEmp[id] = { id, nombre, dias:{} };
      const dia = diaStr(r.check_in);
      if (!porEmp[id].dias[dia]) porEmp[id].dias[dia] = [];
      porEmp[id].dias[dia].push(r);
    });

    // ── SISTEMA DE CALIFICACIÓN ──────────────────────────────────────
    function calcularCalificacion(diasTrabajados, diasTarde, diasSinAlmuerzo, diasExcesoAlm, diasIncompletos) {
      if (diasTrabajados === 0) return { puntos:0, letra:'N/A', descripcion:'Sin registros', color:'#9aa3b5' };
      
      let totalDescuentos = 0;
      totalDescuentos += diasTarde        * 5;
      totalDescuentos += diasSinAlmuerzo  * 2;
      totalDescuentos += diasExcesoAlm    * 3;
      totalDescuentos += diasIncompletos  * 5;

      // Máximo de descuento posible = diasTrabajados * 15 (todos los descuentos en cada día)
      const maxDesc = diasTrabajados * 15;
      const puntosBase = 100;
      // Descuento proporcional al período
      const descPorcentual = Math.min(100, Math.round((totalDescuentos / (diasTrabajados * 10)) * 100));
      const puntos = Math.max(0, puntosBase - descPorcentual);

      let letra, descripcion, color;
      if (puntos >= 95)      { letra='A+'; descripcion='Excelente asistencia';    color='#0d7a55'; }
      else if (puntos >= 85) { letra='A';  descripcion='Muy buena asistencia';    color='#2d9e6b'; }
      else if (puntos >= 70) { letra='B';  descripcion='Asistencia regular';      color='#b45309'; }
      else if (puntos >= 50) { letra='C';  descripcion='Necesita mejorar';        color='#e07820'; }
      else                   { letra='D';  descripcion='Asistencia deficiente';   color='#c0392b'; }

      return { puntos, letra, descripcion, color, totalDescuentos, desglose:{
        tardanza:     diasTarde * 5,
        sinAlmuerzo:  diasSinAlmuerzo * 2,
        excesoAlm:    diasExcesoAlm * 3,
        incompletos:  diasIncompletos * 5,
      }};
    }

    const resumen = Object.values(porEmp).map(emp => {
      let totalMin=0, totalDesc=0, totalBanco=0;
      let diasTrabajados=0, diasTarde=0, diasSinAlmuerzo=0, diasExceso=0, diasIncompletos=0;
      const detalleDias = [];

      Object.entries(emp.dias).forEach(([dia, regsD]) => {
        const finde = regsD[0] && esFinde(regsD[0].check_in);
        const horario = finde
          ? { entrada:'09:00', salida:'15:00', extraDesde:'15:30', almuerzo:60 }
          : { entrada:'09:00', salida:'18:00', extraDesde:'18:30', almuerzo:60 };

        // Primer y último registro del día
        const primero = regsD[0];
        const ultimo  = regsD[regsD.length-1];
        if (!primero.check_in) return;

        const horaEntrada = horaLocalRD(primero.check_in);
        const horaSalida  = ultimo.check_out ? horaLocalRD(ultimo.check_out) : null;

        const minEntrada  = horaAMin(horaEntrada);
        const minPermitido = horaAMin(horario.entrada);
        const minSalida   = horaSalida ? horaAMin(horaSalida) : null;
        const minExtraDesde = horaAMin(horario.extraDesde);

        // Calcular minutos trabajados (suma de todos los bloques)
        let minTrabajoD = 0;
        regsD.forEach(r => {
          if (r.check_in && r.check_out) {
            const ini = new Date(r.check_in.replace(' ','T')+'Z').getTime();
            const fin = new Date(r.check_out.replace(' ','T')+'Z').getTime();
            minTrabajoD += Math.round((fin - ini) / 60000);
          }
        });

        // Registro incompleto: sin check_in o sin check_out en último registro
        const sinEntrada = !primero.check_in;
        const sinSalida  = ultimo.check_in && !ultimo.check_out;
        const incompleto = sinEntrada || sinSalida;

        // Descuentos y banco
        const descTarde   = !incompleto && minEntrada > minPermitido ? minEntrada - minPermitido : 0;
        const bancoExtra  = minSalida && minSalida > minExtraDesde ? minSalida - minExtraDesde : 0;
        const tieneAlm    = regsD.length > 1;

        // Exceso almuerzo
        let excesAlm = 0;
        if (regsD.length >= 2 && regsD[0].check_out && regsD[1].check_in) {
          const finBloque1 = new Date(regsD[0].check_out.replace(' ','T')+'Z').getTime();
          const iniBloque2 = new Date(regsD[1].check_in.replace(' ','T')+'Z').getTime();
          const minAlm = Math.round((iniBloque2 - finBloque1) / 60000);
          if (minAlm > horario.almuerzo) excesAlm = minAlm - horario.almuerzo;
        }

        const descTotal = descTarde + excesAlm;
        totalMin   += minTrabajoD;
        totalDesc  += descTotal;
        totalBanco += bancoExtra;
        diasTrabajados++;
        if (descTarde > 0)  diasTarde++;
        if (!tieneAlm)      diasSinAlmuerzo++;
        if (excesAlm > 0)   diasExceso++;
        if (incompleto)     diasIncompletos++;

        // Calcular duración de almuerzo
        let durAlmuerzo = 0;
        if (regsD.length >= 2 && regsD[0].check_out && regsD[1].check_in) {
          const finB1 = new Date(regsD[0].check_out.replace(' ','T')+'Z').getTime();
          const iniB2 = new Date(regsD[1].check_in.replace(' ','T')+'Z').getTime();
          durAlmuerzo = Math.round((iniB2 - finB1) / 60000);
        }

        detalleDias.push({
          dia,
          hora_entrada:       sinEntrada ? '—' : horaEntrada,
          hora_salida:        sinSalida  ? 'Sin salida' : (horaSalida || '—'),
          min_entrada:        sinEntrada ? null : minEntrada,
          min_salida:         sinSalida  ? null : minSalida,
          minutos_trabajados: minTrabajoD,
          horas_fmt:          minAHora(minTrabajoD),
          desc_tarde:         descTarde,
          desc_exceso:        excesAlm,
          banco_extra:        bancoExtra,
          sin_almuerzo:       !tieneAlm,
          dur_almuerzo:       durAlmuerzo,
          incompleto,
          sin_entrada:        sinEntrada,
          sin_salida:         sinSalida,
          es_finde:           finde,
        });
      });

      const puntualidad = diasTrabajados > 0 ? Math.round(((diasTrabajados - diasTarde) / diasTrabajados) * 100) : 100;

      return {
        id: emp.id, nombre: emp.nombre,
        dias_trabajados:  diasTrabajados,
        total_minutos:    totalMin,
        horas_totales:    minAHora(totalMin),
        total_descuentos: totalDesc,
        desc_fmt:         totalDesc > 0 ? `-${minAHora(totalDesc)}` : '—',
        total_banco:      totalBanco,
        banco_fmt:        totalBanco > 0 ? `+${minAHora(totalBanco)}` : '—',
        horas_efectivas:  minAHora(Math.max(0, totalMin - totalDesc)),
        puntualidad,
        dias_tarde:       diasTarde,
        dias_sin_almuerzo: diasSinAlmuerzo,
        dias_exceso_alm:  diasExceso,
        detalle_dias:     detalleDias,
        // Promedios
        promedio_entrada: (()=>{
          const validos = detalleDias.filter(d=>d.min_entrada!==null).map(d=>d.min_entrada);
          if(!validos.length) return '—';
          const avg = Math.round(validos.reduce((a,b)=>a+b,0)/validos.length);
          return `${String(Math.floor(avg/60)).padStart(2,'0')}:${String(avg%60).padStart(2,'0')}`;
        })(),
        promedio_salida: (()=>{
          const validos = detalleDias.filter(d=>d.min_salida!==null).map(d=>d.min_salida);
          if(!validos.length) return '—';
          const avg = Math.round(validos.reduce((a,b)=>a+b,0)/validos.length);
          return `${String(Math.floor(avg/60)).padStart(2,'0')}:${String(avg%60).padStart(2,'0')}`;
        })(),
        promedio_almuerzo: (()=>{
          const validos = detalleDias.filter(d=>d.dur_almuerzo>0).map(d=>d.dur_almuerzo);
          if(!validos.length) return '—';
          const avg = Math.round(validos.reduce((a,b)=>a+b,0)/validos.length);
          return `${Math.floor(avg/60)?Math.floor(avg/60)+'h ':''}${avg%60}min`;
        })(),
        // Calificación
        calificacion: calcularCalificacion(diasTrabajados, diasTarde, diasSinAlmuerzo, diasExceso, diasIncompletos),
        dias_incompletos: diasIncompletos,
        // Alertas
        alertas: [
          ...(diasIncompletos > 0  ? [`${diasIncompletos} día(s) con ponche incompleto`] : []),
          ...(diasTarde >= 3       ? [`Llegó tarde ${diasTarde} días en el período`] : []),
          ...(diasSinAlmuerzo >= 2 ? [`Sin registro de almuerzo ${diasSinAlmuerzo} días`] : []),
          ...(diasExceso >= 2      ? [`Exceso de almuerzo ${diasExceso} días`] : []),
          ...(puntualidad < 80     ? [`Puntualidad por debajo del 80%`] : []),
        ]
      };
    });

    // KPIs globales
    const kpis = {
      total_empleados: resumen.length,
      promedio_horas:  resumen.length ? Math.round(resumen.reduce((a,e)=>a+e.total_minutos,0)/resumen.length) : 0,
      empleados_tarde: resumen.filter(e=>e.dias_tarde>0).length,
      empleados_alerta: resumen.filter(e=>e.alertas.length>0).length,
      puntualidad_promedio: resumen.length ? Math.round(resumen.reduce((a,e)=>a+e.puntualidad,0)/resumen.length) : 100,
    };

    res.json({ ok:true, desde:fechaDesde, hasta:fechaHasta, kpis, empleados:resumen });
  } catch(e) {
    console.error('[REPORTE RANGO]', e.message);
    res.status(500).json({error:e.message});
  }
});

// ── RUTAS ADMIN BÁSICAS ───────────────────────────────────────────────────────
app.get('/admin/empleados', requireAdmin, (req,res) => {
  res.json({total:Object.keys(empleadosPorPIN).length, empleados:Object.entries(empleadosPorPIN).map(([pin,e])=>({pin,odoo_id:e.odoo_id,nombre:e.nombre}))});
});

app.post('/admin/recargar', requireAdmin, async (req,res) => {
  empleadosPorPIN = {};
  await cargarPinesDesdeGitHub();
  res.json({ok:true, cargados:Object.keys(empleadosPorPIN).length});
});

app.post('/admin/carga-masiva', requireAdmin, (req,res) => {
  const {empleados} = req.body;
  if (!Array.isArray(empleados)) return res.status(400).json({error:'Enviar array'});
  let cargados=0;
  empleados.forEach(e => {
    if (e.odoo_id&&e.nombre&&e.pin) { empleadosPorPIN[e.pin]={odoo_id:parseInt(e.odoo_id),nombre:e.nombre}; cargados++; }
  });
  res.json({ok:true,cargados});
});

app.get('/admin/odoo-empleados', requireAdmin, async (req,res) => {
  try {
    const e=await odooExecute('hr.employee','search_read',[[['active','=',true]]],{fields:['id','name','job_id'],order:'name asc'});
    res.json({total:e.length,empleados:e});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/admin/asistencias-hoy', requireAdmin, async (req,res) => {
  try {
    const a=await odooExecute('hr.attendance','search_read',[[['check_in','>=',inicioDiaUTC()]]],{fields:['employee_id','check_in','check_out','worked_hours','reason'],order:'check_in desc',limit:200});
    res.json({total:a.length,asistencias:a});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
async function arrancar() {
  await odooLogin();
  await cargarPinesDesdeGitHub();
  app.listen(PORT, () => {
    console.log(`\n🦶 Kerapodo Ponche v3.0 — Puerto ${PORT}`);
    console.log(`📡 Odoo: ${ODOO_URL}`);
    console.log(`👥 Empleados: ${Object.keys(empleadosPorPIN).length}\n`);
  });
}
arrancar();

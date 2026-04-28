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
        try { const p = new XMLParser({ignoreAttributes:false}); resolve(extractValue(p.parse(data)?.methodResponse?.params?.param?.value)); }
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
  if (!n) return null;
  if (n.int!==undefined) return parseInt(n.int);
  if (n.i4!==undefined) return parseInt(n.i4);
  if (n.double!==undefined) return parseFloat(n.double);
  if (n.boolean!==undefined) return n.boolean==='1'||n.boolean===1;
  if (n.string!==undefined) return n.string;
  if (typeof n==='string'||typeof n==='number') return n;
  if (n.array?.data?.value) { const v=n.array.data.value; return (Array.isArray(v)?v:[v]).map(extractValue); }
  if (n.struct?.member) { const m=Array.isArray(n.struct.member)?n.struct.member:[n.struct.member]; const r={}; m.forEach(x=>r[x.name]=extractValue(x.value)); return r; }
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
  // Buscar registros de hoy
  const hoy = new Date();
  hoy.setHours(hoy.getHours() + 4); // RD time
  const inicioRD = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  inicioRD.setHours(inicioRD.getHours() - 4); // back to UTC
  const inicioStr = inicioRD.toISOString().replace('T',' ').substring(0,19);

  const registros = await odooExecute('hr.attendance','search_read',
    [[['employee_id','=',odoo_id],['check_in','>=',inicioStr]]],
    {fields:['id','check_in','check_out','reason'],order:'check_in asc'}
  );

  // Analizar estado
  if (!registros || registros.length === 0) return { estado: 'sin_entrada', registros: [] };

  const ultimo = registros[registros.length - 1];

  // Si el último registro tiene check_out y reason=almuerzo → está en almuerzo
  if (ultimo.check_out && ultimo.reason === 'salida_almuerzo') return { estado: 'en_almuerzo', registros, ultimo };

  // Si el último registro NO tiene check_out → está dentro
  if (!ultimo.check_out) {
    // ¿Ya almorzó? Buscar si hay algún registro con reason=salida_almuerzo cerrado
    const yaAlmorzo = registros.some(r => r.reason === 'salida_almuerzo' && r.check_out);
    return { estado: yaAlmorzo ? 'regreso_almuerzo' : 'en_trabajo', registros, ultimo };
  }

  // Todos los registros tienen check_out → salió
  return { estado: 'salio', registros, ultimo };
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

// ── ESTADO DEL EMPLEADO (para que el kiosko sepa qué botón mostrar) ───────────
app.post('/estado', async (req,res) => {
  const {pin} = req.body;
  if (!pin) return res.status(400).json({error:'Falta PIN'});
  if (Object.keys(empleadosPorPIN).length===0) await cargarPinesDesdeGitHub();
  const e = empleadosPorPIN[pin];
  if (!e) return res.status(404).json({error:'PIN incorrecto'});
  try {
    const estado = await getEstadoEmpleado(e.odoo_id);
    res.json({ ok:true, nombre:e.nombre, ...estado });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── PONCHE PRINCIPAL ──────────────────────────────────────────────────────────
app.post('/ponche', async (req,res) => {
  const {pin, sucursal, accion} = req.body;
  // accion: 'entrada' | 'salida_almuerzo' | 'regreso_almuerzo' | 'salida_final'
  if (!pin||!sucursal) return res.status(400).json({ok:false,error:'Falta PIN o sucursal'});
  if (Object.keys(empleadosPorPIN).length===0) await cargarPinesDesdeGitHub();
  const e = empleadosPorPIN[pin];
  if (!e) return res.status(404).json({ok:false,error:'PIN incorrecto'});

  try {
    const ahora   = ahoraUTC();
    const horario = getHorarioHoy();
    const horaRD  = ahoraRD();
    let attendance_id, mensaje = '', alertas = [];

    switch(accion) {
      case 'entrada': {
        // Verificar llegada tarde
        const minutosEntrada = horaAMinutos(horaRD);
        const minutosPermitidos = horaAMinutos(horario.entrada);
        if (minutosEntrada > minutosPermitidos) {
          const retraso = minutosEntrada - minutosPermitidos;
          alertas.push(`⚠️ Llegada tarde: ${retraso} minutos`);
        }
        attendance_id = await odooExecute('hr.attendance','create',[{
          employee_id: e.odoo_id, check_in: ahora, reason: 'entrada'
        }]);
        mensaje = 'ENTRADA REGISTRADA';
        break;
      }

      case 'salida_almuerzo': {
        // Cerrar registro actual y marcarlo como almuerzo
        const abiertos = await odooExecute('hr.attendance','search_read',
          [[['employee_id','=',e.odoo_id],['check_out','=',false]]],
          {fields:['id'],limit:1}
        );
        if (!abiertos||abiertos.length===0) return res.json({ok:false,error:'No hay entrada activa'});
        await odooExecute('hr.attendance','write',[[abiertos[0].id],{check_out:ahora, reason:'salida_almuerzo'}]);
        attendance_id = abiertos[0].id;
        mensaje = 'SALIDA A ALMORZAR';
        break;
      }

      case 'regreso_almuerzo': {
        // Verificar exceso de almuerzo
        const bloqueAlmuerzo = await odooExecute('hr.attendance','search_read',
          [[['employee_id','=',e.odoo_id],['reason','=','salida_almuerzo'],['check_out','!=',false]]],
          {fields:['check_out'],order:'check_out desc',limit:1}
        );
        if (bloqueAlmuerzo&&bloqueAlmuerzo.length>0) {
          const salidaAlm = new Date(bloqueAlmuerzo[0].check_out.replace(' ','T')+'Z');
          const ahora2    = new Date();
          const minAlm    = Math.round((ahora2 - salidaAlm) / 60000);
          if (minAlm > horario.almuerzo) {
            const exceso = minAlm - horario.almuerzo;
            alertas.push(`⚠️ Exceso de almuerzo: ${exceso} minutos serán descontados`);
            // Crear nota en Odoo
            await odooExecute('hr.attendance','create',[{
              employee_id: e.odoo_id, check_in: ahora, reason: `regreso_almuerzo|exceso:${exceso}`
            }]);
          } else {
            await odooExecute('hr.attendance','create',[{
              employee_id: e.odoo_id, check_in: ahora, reason: 'regreso_almuerzo'
            }]);
          }
        } else {
          await odooExecute('hr.attendance','create',[{
            employee_id: e.odoo_id, check_in: ahora, reason: 'regreso_almuerzo'
          }]);
        }
        mensaje = 'REGRESO DE ALMUERZO';
        break;
      }

      case 'salida_final': {
        const abiertos = await odooExecute('hr.attendance','search_read',
          [[['employee_id','=',e.odoo_id],['check_out','=',false]]],
          {fields:['id'],limit:1}
        );
        if (!abiertos||abiertos.length===0) return res.json({ok:false,error:'No hay entrada activa'});

        // Verificar tiempo extra
        const minSalida = horaAMinutos(horaRD);
        const minExtra  = horaAMinutos(horario.extraDesde);
        if (minSalida > minExtra) {
          const extra = minSalida - minExtra;
          alertas.push(`✅ Tiempo extra: ${extra} minutos acreditados`);
          await odooExecute('hr.attendance','write',[[abiertos[0].id],{check_out:ahora, reason:`salida_final|extra:${extra}`}]);
        } else {
          await odooExecute('hr.attendance','write',[[abiertos[0].id],{check_out:ahora, reason:'salida_final'}]);
        }
        attendance_id = abiertos[0].id;
        mensaje = 'SALIDA REGISTRADA';
        break;
      }

      default:
        return res.status(400).json({ok:false,error:'Acción no válida'});
    }

    console.log(`[PONCHE] ${e.nombre} → ${accion.toUpperCase()} | ${sucursal} | ${horaRD}`);
    return res.json({ok:true, accion, mensaje, nombre:e.nombre, sucursal, hora:horaRD, attendance_id, alertas});

  } catch(err) {
    console.error('[ERROR]',err.message);
    return res.status(500).json({ok:false,error:err.message});
  }
});

// ── ALERTA ALMUERZO NO PONCHADO ───────────────────────────────────────────────
// Se llama automáticamente a las 2:00 PM para empleados sin almuerzo
app.post('/admin/alerta-almuerzo', requireAdmin, async (req,res) => {
  try {
    const hoy = new Date();
    hoy.setHours(hoy.getHours() + 4);
    const inicioRD = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    inicioRD.setHours(inicioRD.getHours() - 4);
    const inicioStr = inicioRD.toISOString().replace('T',' ').substring(0,19);

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
    const hoy = new Date();
    hoy.setHours(hoy.getHours() + 4);
    const inicioRD = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    inicioRD.setHours(inicioRD.getHours() - 4);
    const inicioStr = inicioRD.toISOString().replace('T',' ').substring(0,19);
    const horario = getHorarioHoy();

    const registros = await odooExecute('hr.attendance','search_read',
      [[['check_in','>=',inicioStr]]],
      {fields:['employee_id','check_in','check_out','reason'],order:'employee_id asc,check_in asc'}
    );

    // Agrupar por empleado
    const porEmpleado = {};
    registros.forEach(r => {
      const id = r.employee_id[0];
      const nombre = r.employee_id[1];
      if (!porEmpleado[id]) porEmpleado[id] = { nombre, registros: [] };
      porEmpleado[id].registros.push(r);
    });

    // Calcular para cada empleado
    const resumen = Object.values(porEmpleado).map(emp => {
      const calc = calcularTiempo(emp.registros, horario);
      const tieneAlmuerzo = emp.registros.some(r => r.reason === 'salida_almuerzo');
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
    const hoy=new Date(); hoy.setHours(hoy.getHours()+4);
    const ini=new Date(hoy.getFullYear(),hoy.getMonth(),hoy.getDate()); ini.setHours(ini.getHours()-4);
    const a=await odooExecute('hr.attendance','search_read',[[['check_in','>=',ini.toISOString().replace('T',' ').substring(0,19)]]],{fields:['employee_id','check_in','check_out','worked_hours','reason'],order:'check_in desc',limit:200});
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

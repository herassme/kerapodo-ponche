/**
 * KERAPODO — Sistema de Ponche v2.1
 * PINs persistentes en archivo JSON (sobreviven reinicios)
 */
 
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
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
const PINS_FILE = path.join(__dirname, 'pines.json');
 
function cargarPines() {
  try {
    if (fs.existsSync(PINS_FILE)) return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  } catch(e) { console.error('Error cargando pines:', e.message); }
  return {};
}
function guardarPines(p) {
  try { fs.writeFileSync(PINS_FILE, JSON.stringify(p, null, 2), 'utf8'); }
  catch(e) { console.error('Error guardando pines:', e.message); }
}
 
let empleadosPorPIN = cargarPines();
console.log(`📂 PINs en disco: ${Object.keys(empleadosPorPIN).length}`);
 
function xmlrpcCall(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param><value>${toXmlValue(p)}</value></param>`).join('')}</params></methodCall>`;
    const url = new URL(ODOO_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = { hostname: url.hostname, port: url.port||(isHttps?443:80), path: url.pathname, method: 'POST', headers: { 'Content-Type':'text/xml','Content-Length':Buffer.byteLength(body) } };
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
  } catch(e) { odooAuthError=e.message; console.error('❌ Odoo auth:',e.message); return null; }
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
function ahoraUTC() { return new Date().toISOString().replace('T',' ').substring(0,19); }
 
app.get('/', async (req,res) => {
  const uid = await odooLogin();
  res.json({ sistema:'Kerapodo Ponche v2.1', estado:'activo', odoo_conexion:uid?'✅':'❌', odoo_error:odooAuthError||null, empleados_cargados:Object.keys(empleadosPorPIN).length, timestamp:new Date().toISOString() });
});
 
app.post('/ponche', async (req,res) => {
  const {pin,sucursal} = req.body;
  if (!pin||!sucursal) return res.status(400).json({ok:false,error:'Falta PIN o sucursal'});
  const e = empleadosPorPIN[pin];
  if (!e) return res.status(404).json({ok:false,error:'PIN incorrecto'});
  try {
    const ahora = ahoraUTC();
    const abiertos = await odooExecute('hr.attendance','search_read',[[['employee_id','=',e.odoo_id],['check_out','=',false]]],{fields:['id'],limit:1});
    let accion, attendance_id;
    if (abiertos&&abiertos.length>0) {
      await odooExecute('hr.attendance','write',[[abiertos[0].id],{check_out:ahora}]);
      attendance_id=abiertos[0].id; accion='salida';
    } else {
      attendance_id=await odooExecute('hr.attendance','create',[{employee_id:e.odoo_id,check_in:ahora}]);
      accion='entrada';
    }
    console.log(`[PONCHE] ${e.nombre} → ${accion.toUpperCase()} | ${sucursal} | ${ahora}`);
    return res.json({ok:true,accion,nombre:e.nombre,sucursal,hora:ahora,attendance_id});
  } catch(err) { console.error('[ERROR]',err.message); return res.status(500).json({ok:false,error:err.message}); }
});
 
app.get('/admin/empleados', requireAdmin, (req,res) => {
  res.json({total:Object.keys(empleadosPorPIN).length, empleados:Object.entries(empleadosPorPIN).map(([pin,e])=>({pin,odoo_id:e.odoo_id,nombre:e.nombre}))});
});
 
app.post('/admin/pin', requireAdmin, (req,res) => {
  const {odoo_id,nombre,pin} = req.body;
  if (!odoo_id||!nombre||!pin) return res.status(400).json({error:'Faltan campos'});
  const ex = empleadosPorPIN[pin];
  if (ex&&ex.odoo_id!==odoo_id) return res.status(409).json({error:`PIN ${pin} ya asignado a ${ex.nombre}`});
  for (const [p,e] of Object.entries(empleadosPorPIN)) { if (e.odoo_id===odoo_id&&p!==pin) delete empleadosPorPIN[p]; }
  empleadosPorPIN[pin]={odoo_id:parseInt(odoo_id),nombre};
  guardarPines(empleadosPorPIN);
  res.json({ok:true,mensaje:`PIN asignado a ${nombre}`});
});
 
app.post('/admin/carga-masiva', requireAdmin, (req,res) => {
  const {empleados} = req.body;
  if (!Array.isArray(empleados)) return res.status(400).json({error:'Enviar array'});
  let cargados=0, errores=[];
  empleados.forEach(e => {
    if (!e.odoo_id||!e.nombre||!e.pin) { errores.push(`Incompleto: ${JSON.stringify(e)}`); return; }
    empleadosPorPIN[e.pin]={odoo_id:parseInt(e.odoo_id),nombre:e.nombre};
    cargados++;
  });
  guardarPines(empleadosPorPIN);
  console.log(`[ADMIN] ${cargados} PINs guardados en disco`);
  res.json({ok:true,cargados,errores});
});
 
app.delete('/admin/pin/:pin', requireAdmin, (req,res) => {
  const {pin}=req.params;
  if (!empleadosPorPIN[pin]) return res.status(404).json({error:'PIN no encontrado'});
  const nombre=empleadosPorPIN[pin].nombre;
  delete empleadosPorPIN[pin];
  guardarPines(empleadosPorPIN);
  res.json({ok:true,mensaje:`PIN de ${nombre} eliminado`});
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
    const a=await odooExecute('hr.attendance','search_read',[[['check_in','>=',ini.toISOString().replace('T',' ').substring(0,19)]]],{fields:['employee_id','check_in','check_out','worked_hours'],order:'check_in desc',limit:200});
    res.json({total:a.length,asistencias:a});
  } catch(e) { res.status(500).json({error:e.message}); }
});
 
odooLogin().then(()=>{
  app.listen(PORT,()=>{
    console.log(`\n🦶 Kerapodo Ponche v2.1 — Puerto ${PORT}`);
    console.log(`📡 Odoo: ${ODOO_URL}`);
    console.log(`👥 Empleados: ${Object.keys(empleadosPorPIN).length}`);
    console.log(`💾 PINs en: ${PINS_FILE}\n`);
  });
});
 

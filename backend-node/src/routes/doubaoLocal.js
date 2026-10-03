const express = require('express');
const fs = require('fs'), path = require('path');
const response = require('../response');
const { requireRole } = require('../middleware/auth');
const { buildCredential } = require('../services/doubaoLocalBridge');
function launcherScript(connector, connection) {
  const encode = value => Buffer.from(value).toString('base64');
  return '@echo off\r\n' +
    'setlocal EnableExtensions\r\n' +
    'set "WORK=%TEMP%\\doubao-local-connector-%RANDOM%%RANDOM%"\r\n' +
    'mkdir "%WORK%" >nul 2>&1\r\n' +
    `set "CONNECTOR_B64=${encode(connector)}"\r\n` +
    `set "CONNECTION_B64=${encode(JSON.stringify(connection))}"\r\n` +
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=$env:CONNECTOR_B64; [IO.File]::WriteAllBytes((Join-Path $env:WORK \'connector.cjs\'),[Convert]::FromBase64String($b))"\r\n' +
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=$env:CONNECTION_B64; [IO.File]::WriteAllBytes((Join-Path $env:WORK \'connection.json\'),[Convert]::FromBase64String($b))"\r\n' +
    'node "%WORK%\\connector.cjs" "%WORK%\\connection.json"\r\n' +
    'set "EXIT=%ERRORLEVEL%"\r\n' +
    'rmdir /s /q "%WORK%" >nul 2>&1\r\n' +
    'if not "%EXIT%"=="0" pause\r\n' +
    'exit /b %EXIT%\r\n';
}
function transport(bridge) {
  const router=express.Router();
  router.use((req,res,next)=>{
    const a=bridge.authenticate(String(req.headers.authorization||'').replace(/^Bearer /,''));
    if(!a)return res.status(401).json({error:'Invalid Doubao connection credential'});
    req.connector=a;res.set('Cache-Control','no-store');next();
  });
  // A multipart request can contain up to 48 MB of reference images; the
  // bridge serializes it as base64 JSON, so allow the encoded envelope here.
  router.use(express.json({limit:'70mb'}));
  router.use((req,res,next)=>{
    if(!/^[a-f0-9-]{36}$/.test(req.body?.clientId||''))return res.status(400).json({error:'Invalid client'});next();
  });
  router.post('/poll',(req,res)=>bridge.poll(req.connector,req.body.clientId,req.body.managerOnline,res));
  router.post('/permission',(req,res)=>res.json({enabled:bridge.isEnabled(req.connector.config_id)}));
  router.post('/check/:id',(req,res)=>res.json({allowed:bridge.permitted(req.connector,req.params.id,req.body.clientId)}));
  router.post('/result/:id',(req,res)=>{
    try {const accepted=bridge.result(req.connector,req.params.id,req.body.clientId,req.body);res.json({accepted});}
    catch(e){res.status(400).json({error:e.message});}
  });
  return router;
}
function management(router,bridge) {
  const check=(fn)=>(req,res)=>{try{fn(req,res);}catch(e){response.badRequest(res,e.message);}};
  function connectionServer() {
    if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
    if (process.env.NODE_ENV !== 'production') return `http://127.0.0.1:${Number(process.env.PORT) || 5680}`;
    return '';
  }
  router.get('/ai-configs/:id/local-access',check((req,res)=>response.success(res,{...bridge.status(req.params.id,req.user.organization.id),can_control:req.user.role==='owner'})));
  router.put('/ai-configs/:id/local-access',requireRole('owner'),check((req,res)=>response.success(res,bridge.setEnabled(req.params.id,req.user.organization.id,req.user.id,req.body.enabled))));
  router.post('/ai-configs/:id/local-credential',requireRole('owner'),check((req,res)=>{
    const server=connectionServer();
    if(!server)throw new Error('连接凭证需要线上 HTTPS 地址');
    const pairing=bridge.pair(req.params.id,req.user.organization.id,req.user.id);
    response.success(res,{credential:buildCredential(server,pairing.token),server:new URL(server).origin});
  }));
  router.post('/ai-configs/:id/local-connector',requireRole('owner'),check((req,res)=>{
    const server=connectionServer();
    if(!server)throw new Error('连接程序需要线上 HTTPS 地址');
    const pairing=bridge.pair(req.params.id,req.user.organization.id,req.user.id);
    const connector=fs.readFileSync(path.join(__dirname,'../../scripts/doubao-connector.cjs'),'utf8');
    res.set('Cache-Control','no-store').attachment('doubao-local-connector.cmd').type('application/octet-stream').send(launcherScript(connector,{server,...pairing}));
  }));
}
module.exports={transport,management,launcherScript};

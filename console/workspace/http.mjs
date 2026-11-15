import express from 'express';
import {WorkspaceError} from './service.mjs';

export function installWorkspaceRoutes(app,requireAction,service){
  const wrap=fn=>async(req,res)=>{
    try{res.json(await fn(req));}
    catch(error){
      if(error instanceof WorkspaceError)return res.status(error.status).json({code:error.code,error:error.message===error.code?'The private workspace request was refused: '+error.code:error.message});
      if(error?.status&&error?.code)return res.status(error.status).json({code:error.code,error:error.message});
      console.error(JSON.stringify({event:'workspace_error',message:String(error?.message||error).slice(0,200)}));
      res.status(503).json({code:'WORKSPACE_UNAVAILABLE',error:'The private workspace is unavailable. Nothing was changed.'});
    }
  };
  const raw=express.raw({type:'application/octet-stream',limit:8388624+1024});
  app.get('/api/workspace',requireAction('read'),wrap(req=>service.overview(req.actor)));
  app.post('/api/workspace',requireAction('edit'),wrap(req=>service.create(req.actor,req.body||{})));
  app.post('/api/workspace/enrollments',requireAction('edit'),wrap(req=>service.requestEnrollment(req.actor,req.body||{})));
  app.get('/api/workspace/enrollments/:id',requireAction('edit'),wrap(req=>service.enrollment(req.actor,req.params.id)));
  app.post('/api/workspace/enrollments/:id/certificate',requireAction('edit'),wrap(req=>service.certifyEnrollment(req.actor,req.params.id,req.body?.certificate)));
  app.post('/api/workspace/reset',requireAction('edit'),wrap(req=>service.reset(req.actor,req.body||{})));
  app.post('/api/workspace/devices',requireAction('edit'),wrap(req=>service.requestDevice(req.actor,req.body||{})));
  app.get('/api/workspace/devices/:id',requireAction('edit'),wrap(req=>service.device(req.actor,req.params.id)));
  app.post('/api/workspace/commits',requireAction('edit'),wrap(req=>service.commit(req.actor,req.body||{})));
  app.post('/api/workspace/messages',requireAction('edit'),wrap(req=>service.application(req.actor,req.body||{})));
  app.get('/api/workspace/log',requireAction('edit'),wrap(req=>service.log(req.actor,{deviceId:String(req.query.device||''),after:Number(req.query.after||0)})));
  app.put('/api/workspace/drafts/:id',requireAction('edit'),wrap(req=>service.putDraft(req.actor,req.params.id,req.body?.sealed)));
  app.get('/api/workspace/drafts/:id',requireAction('edit'),wrap(req=>service.getDraft(req.actor,req.params.id)));
  app.delete('/api/workspace/drafts/:id',requireAction('edit'),wrap(req=>service.deleteDraft(req.actor,req.params.id)));
  app.post('/api/workspace/objects',requireAction('edit'),wrap(req=>service.createObject(req.actor,req.body||{})));
  app.get('/api/workspace/objects/:id',requireAction('edit'),wrap(req=>service.objectStatus(req.actor,req.params.id)));
  app.put('/api/workspace/objects/:id/chunks/:index',requireAction('edit'),raw,wrap(req=>service.putChunk(req.actor,req.params.id,Number(req.params.index),
    Buffer.isBuffer(req.body)?new Uint8Array(req.body.buffer,req.body.byteOffset,req.body.length):null,String(req.get('x-chunk-sha256')||''))));
  app.get('/api/workspace/objects/:id/chunks/:index',requireAction('edit'),async(req,res)=>{
    try{const c=await service.getChunk(req.actor,req.params.id,Number(req.params.index));res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-Chunk-Sha256',c.sha256);res.end(Buffer.from(c.body));}
    catch(error){res.status(error instanceof WorkspaceError?error.status:503).json({code:error.code||'WORKSPACE_UNAVAILABLE',error:'Chunk unavailable.'});}
  });
}

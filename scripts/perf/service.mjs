import { buildApp } from '../../server/src/app.ts';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { stats } from './common.mjs';

const temp=process.env.HDM_PERF_TEMP;
if(!temp || !process.send) throw new Error('Only the isolated perf runner may start this service');
const {app,db}=await buildApp({databasePath:resolve(temp,'mall.sqlite'),uploadsPath:resolve(temp,'uploads'),
  publicUrl:'http://127.0.0.1', mockPayments:false, testMode:false, logger:true,
  trustedProxies:['127.0.0.1']});
let cpu=process.cpuUsage(), wall=performance.now(), timings=[];
const delay=monitorEventLoopDelay({resolution:10}); delay.enable();
app.addHook('onResponse',async(req,reply)=>{ timings.push({route:req.routeOptions.url,status:reply.statusCode,ms:reply.elapsedTime}); });
await app.listen({host:'127.0.0.1',port:0});
const port=app.server.address().port;
if(port===3103) { await app.close(); throw new Error('Forbidden port selected'); }
process.send({type:'ready',port,pid:process.pid});
let closing=false;
async function close(){if(closing)return;closing=true;delay.disable();await app.close();process.exit(0);}
process.on('message',async msg=>{
  if(msg.action==='reset'){cpu=process.cpuUsage();wall=performance.now();timings=[];delay.reset();process.send({type:'ack',id:msg.id});}
  if(msg.action==='stats'){
    const usage=process.cpuUsage(cpu),elapsed=performance.now()-wall;
    process.send({type:'stats',id:msg.id,data:{cpuMs:(usage.user+usage.system)/1000,elapsedMs:elapsed,
      oneCorePercent:(usage.user+usage.system)/(elapsed*10),rssBytes:process.memoryUsage().rss,
      eventLoopMs:{p50:delay.percentile(50)/1e6,p95:delay.percentile(95)/1e6,p99:delay.percentile(99)/1e6,max:delay.max/1e6},
      serverResponseMs:stats(timings.map(t=>t.ms)),responses:timings.length}});
  }
  if(msg.action==='race-prepare') {
    const sku='hdm-200-b', current=db.one('SELECT stock FROM skus WHERE id=?',sku).stock;
    db.transaction(()=>{
      db.run('UPDATE skus SET stock=10 WHERE id=?',sku);
      if(current!==10)db.run("INSERT INTO inventory_movements(sku_id,actor_id,kind,delta,balance,business_key,created,reason) VALUES(?,'perf-merchant','adjust',?,10,?,?,?)",sku,10-current,'perf-adjust:'+msg.id,Date.now(),'隔离并发库存测试调整');
    });
    process.send({type:'ack',id:msg.id,data:{stock:10}});
  }
  if(msg.action==='race-check') {
    const sku='hdm-200-b';
    const orders=db.all('SELECT id,request_key FROM orders WHERE request_key LIKE ?',msg.prefix+'%');
    const reservations=db.one("SELECT COUNT(*) n FROM inventory_movements WHERE kind='reserve' AND order_id IN (SELECT id FROM orders WHERE request_key LIKE ?)",msg.prefix+'%').n;
    process.send({type:'ack',id:msg.id,data:{stock:db.one('SELECT stock FROM skus WHERE id=?',sku).stock,orders:orders.length,reservations}});
  }
  if(msg.action==='integrity')process.send({type:'ack',id:msg.id,data:{integrity:db.one('PRAGMA integrity_check'),foreignKeys:db.all('PRAGMA foreign_key_check'),
    negativeStock:db.one('SELECT COUNT(*) n FROM skus WHERE stock<0').n,version:db.one('PRAGMA user_version').user_version,
    counts:db.one('SELECT COUNT(*) orders FROM orders')}});
  if(msg.action==='stop')await close();
});
process.on('disconnect',close);
process.on('SIGTERM',close);
process.on('SIGINT',close);

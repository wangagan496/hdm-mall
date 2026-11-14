import { randomBytes, scryptSync } from 'node:crypto';
import { Database } from '../../server/src/database.ts';
import { sha } from './common.mjs';

export function addProducts(db, start, end) {
  for(let i=start;i<=end;i++) {
    const parent='perf-category-'+((i-1)%10), id='hdm-'+i;
    db.run('INSERT OR IGNORE INTO categories(id,name,parent_id,source_key) VALUES(?,?,NULL,?)',parent,'分类'+((i-1)%10),'parent:'+parent);
    db.run('INSERT INTO products(id,name,category,picture,description) VALUES(?,?,?,?,?)', id,'测量商品'+String(i).padStart(5,'0'),'分类'+((i-1)%10),'/assets/product.svg','合成压测商品，非真实交易');
    db.run('INSERT INTO categories VALUES(?,?,?,?)','perf-child-'+i,'测量商品'+i,parent,'child:'+i);
    db.run('INSERT INTO product_categories VALUES(?,?)',id,'perf-child-'+i);
    for(const [suffix,price] of [['a',1000],['b',1500]]) {
      const sku=id+'-'+suffix;
      db.run('INSERT INTO skus(id,product_id,spec,price,stock) VALUES(?,?,?,?,?)',sku,id,suffix,price,100000);
      db.run("INSERT INTO inventory_movements(sku_id,kind,delta,balance,business_key,created) VALUES(?,'opening',100000,100000,?,?)",sku,'opening:'+sku,Date.now()-180*86400000);
    }
  }
}

export function seed(path) {
  const db = new Database(path), now=Date.now();
  const password = randomBytes(24).toString('hex');
  const users=[];
  for(let i=0;i<=500;i++) {
    const id=i===500?'perf-merchant':'perf-user-'+i, account=i===500?'perf_merchant':'perf_user_'+i;
    const salt=randomBytes(16).toString('hex'), hash=scryptSync(password,salt,64).toString('hex');
    const token=randomBytes(32).toString('hex');
    db.run('INSERT INTO users(id,account,password,nickname,role) VALUES(?,?,?,?,?)',id,account,salt+':'+hash,account,i===500?'merchant':'buyer');
    db.run('INSERT INTO sessions VALUES(?,?,?)',sha(token),id,now+86400000);
    const addressId='perf-address-'+i;
    const address={receiver:'合成用户',contact:'10000000000',address:'合成地址'+i,fullLocation:'压测区域',isDefault:0};
    db.run('INSERT INTO addresses VALUES(?,?,?)',addressId,id,JSON.stringify(address));
    users.push({id,account,token,addressId});
  }
  db.transaction(()=>{
    addProducts(db,1,200);
    for(let i=0;i<500;i++) db.run('INSERT INTO relations VALUES(?,?,?,?,?)','perf-relation-'+i,users[i].id,users[(i+1)%500].id,'accepted',now-86400000);
    const balances=new Map();
    for(let i=0;i<20000;i++) {
      const id='history-'+String(i).padStart(5,'0'), u=users[i%500], round=Math.floor(i/500);
      const slot=round%20, state=slot<12?5:slot<16?6:slot<18?3:2;
      const created=now-((20000-i)*600000+3600000), paid=state===6?null:created+1000;
      const family=round%5===0, payer=paid===null?null:users[(i%500+(family?1:0))%500].id;
      const received=state===5?created+86400000:null;
      db.run(`INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires,invited_payer,paid_by,paid_at,received_by,received_at,shipped_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,u.id,state,2500,JSON.stringify({receiver:'合成用户',contact:'10000000000',address:'合成历史地址'}),'seed-'+id,'{}',created,created+900000,family?users[(i%500+1)%500].id:null,payer,paid,received?u.id:null,received,[3,5].includes(state)?created+2000:null);
      for(const [offset,suffix,price] of [[0,'a',1000],[1,'b',1500]]) {
        const product='hdm-'+((i*17+offset)%200+1), sku=product+'-'+suffix;
        db.run('INSERT INTO order_items(order_id,sku_id,product_id,name,picture,spec,price,count) VALUES(?,?,?,?,?,?,?,1)',id,sku,product,'历史商品','/assets/product.svg',suffix,price);
        const before=balances.get(sku)??100000, balance=before-1;
        db.run("INSERT INTO inventory_movements(sku_id,order_id,actor_id,kind,delta,balance,business_key,created) VALUES(?,?,?,'reserve',-1,?,?,?)",sku,id,u.id,balance,'reserve:'+id+':'+sku,created);
        if(state===6) db.run("INSERT INTO inventory_movements(sku_id,order_id,actor_id,kind,delta,balance,business_key,created) VALUES(?,?,?,'cancel',1,?,?,?)",sku,id,u.id,before,'cancel:'+id+':'+sku,created+1000);
        balances.set(sku,state===6?before:balance);
      }
      if(paid!==null) db.run("INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,channel_paid_at) VALUES(?,?,?,2500,'succeeded',?,?,?)",'payment-'+id,id,payer,paid,created+900000,paid);
      if(state===5) db.run('INSERT INTO evaluations VALUES(?,5,?,?)',id,'合成商品评价数据',received+1000);
    }
    for(const [sku,balance] of balances) db.run('UPDATE skus SET stock=? WHERE id=?',balance,sku);
  });
  const counts=Object.fromEntries(['users','products','skus','orders','order_items','payments','evaluations','categories','relations','inventory_movements'].map(t=>[t,db.one('SELECT COUNT(*) n FROM '+t).n]));
  const integrity=db.one('PRAGMA integrity_check'), foreignKeys=db.all('PRAGMA foreign_key_check');
  const states=db.all('SELECT state,COUNT(*) n FROM orders GROUP BY state');
  db.close();
  return { password, buyers:users.slice(0,500), merchant:users[500], counts, states, integrity, foreignKeys, createdAt:now };
}

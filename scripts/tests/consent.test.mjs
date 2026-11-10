import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execute,sourceOf} from './native-harness.mjs'
const path='mixed-development-h5/commons/storage/src/main/ets/ConsentManager.ets'
test('CD-L08 协议为独立文字链接，两个选择共用同一按钮样式且不可遮罩关闭',()=>{
 const s=sourceOf('mixed-development-h5/commons/storage/src/main/ets/ConsentDialog.ets')
 assert.match(s,/Text\('隐私政策全文'\)/);assert.match(s,/Text\('用户协议全文'\)/)
 assert.match(s,/ForEach\(\['不同意', '同意'\]/)
 assert.match(s,/autoCancel: false/)
 assert.match(s,/Row\(\{ space: 12 \}\)/)
 assert.match(s,/Text\('隐私与协议'\).*fontColor\('#222222'\)/)
 assert.match(s,/Text\(params.message\).*fontColor\('#222222'\)/)
})

test('CD-L10 同意弹层仅显式选择后关闭，重复点击只结算一次并释放内容',async()=>{
 let params,options,closes=0,disposed=0
 const source=sourceOf('mixed-development-h5/commons/storage/src/main/ets/ConsentDialog.ets')
 const logic=source.slice(source.indexOf('export function showConsentDialog'))
 const {showConsentDialog}=execute(logic,{}, {
  ComponentContent:class {constructor(_ui,_builder,value){params=value}dispose(){disposed++}},
  ConsentDialogParams:class {constructor(message,choose){this.message=message;this.choose=choose}},
  wrapBuilder:x=>x,consentDialogContent:()=>{},DialogAlignment:{Center:0}
 })
 const ui={getPromptAction:()=>({openCustomDialog:async(_content,value)=>{options=value},closeCustomDialog:async()=>{closes++}})}
 let resolved=false;const answer=showConsentDialog(ui,'test').then(index=>{resolved=true;return index})
 assert.equal(options.autoCancel,false);options.onWillDismiss({dismiss(){throw new Error('must not dismiss')}})
 await Promise.resolve();assert.equal(resolved,false)
 params.choose(2);params.choose(3);assert.equal(await answer,2);assert.equal(closes,1);assert.equal(disposed,1)
})
function fixture(){
 const data=new Map(),calls=[],choices=[]
 const store={getSync:(k,d)=>data.get(k)??d,putSync:(k,v)=>data.set(k,v),deleteSync:k=>data.delete(k),flush:async()=>{}}
 const deps={'./StoreManager':{storeManager:{getStore:()=>store}},'network':{RequestAxios:{postWithSession:async(...v)=>calls.push(v)}},'@kit.ArkTS':{util:{generateRandomUUID:()=>crypto.randomUUID(),TextDecoder:{create:()=>new TextDecoder()}}}}
 deps['./ConsentDialog']={showConsentDialog:async(_ui,message)=>{calls.push({message,autoCancel:false});return choices.shift()}}
 const {ConsentManager,CONSENT_VERSION}=execute(sourceOf(path),deps,{AppStorage:{setOrCreate(){}}})
 const ui={showAlertDialog:opts=>{calls.push(opts);opts.buttons[choices.shift()].action()},getPromptAction:()=>({showToast:opts=>calls.push(opts),showDialog:async opts=>{calls.push(opts);return {index:choices.shift()}}})}
 return {manager:new ConsentManager(),data,calls,choices,ui,CONSENT_VERSION}
}
test('CD-L01 首次不同意不落同意记录，再次同意持久化版本时间并续接',async()=>{
 const f=fixture();f.choices.push(2)
 assert.equal(await f.manager.request(f.ui,'startup'),false);assert.equal(f.manager.accepted(),false)
 f.choices.push(3);assert.equal(await f.manager.request(f.ui,'login'),true);assert.equal(f.manager.accepted(),true)
 assert.equal(f.manager.record().version,f.CONSENT_VERSION);assert.equal(f.manager.record().source,'login')
 assert.equal(f.calls[0].autoCancel,false)
 const count=f.calls.length;assert.equal(await f.manager.request(f.ui,'login'),true);assert.equal(f.calls.length,count)
})
test('CD-L02 协议更新重新询问；上报沿同号，撤回后清本地',async()=>{
 const f=fixture();await f.manager.accept('startup');const current=f.manager.record()
 await f.manager.report('test-session','user-1');await f.manager.report('test-session','user-1')
 assert.equal(f.calls[0][1].requestKey,f.calls[1][1].requestKey)
 f.data.set('privacyConsent',JSON.stringify({...current,version:'2026-01-01'}));f.choices.push(2)
 assert.equal(await f.manager.request(f.ui,'startup'),false);assert.match(f.calls[2].message,/协议有更新/)
 await f.manager.accept('login');await f.manager.withdraw('test-session');assert.equal(f.manager.accepted(),false)
 assert.equal(f.calls.at(-1)[0],'/member/consents/withdraw')
})

test('CD-L03 旧夹具会话上报401后，新登录固定使用新凭证并可重试上报',async()=>{
 const data=new Map(),calls=[]
 const store={getSync:(k,d)=>data.get(k)??d,putSync:(k,v)=>data.set(k,v),deleteSync:k=>data.delete(k),flush:async()=>{}}
 const deps={'./StoreManager':{storeManager:{getStore:()=>store}},'network':{RequestAxios:{postWithSession:async(url,body,token)=>{
  calls.push({url,body,token})
  if(token==='expired-fixture-session')throw Object.assign(new Error('expired'),{httpStatus:401})
 }}},'@kit.ArkTS':{util:{generateRandomUUID:()=>crypto.randomUUID()}}}
 const {ConsentManager}=execute(sourceOf(path),deps,{AppStorage:{setOrCreate(){}}})
 const manager=new ConsentManager();await manager.accept('startup')
 await assert.rejects(manager.report('expired-fixture-session','old-fixture-user'),{httpStatus:401})
 assert.equal(manager.accepted(),true)
 await manager.report('new-login-session','new-fixture-user')
 await manager.report('new-login-session','new-fixture-user')
 assert.deepEqual(calls.map(c=>c.token),['expired-fixture-session','new-login-session','new-login-session'])
 assert.notEqual(calls[0].body.requestKey,calls[1].body.requestKey)
 assert.equal(calls[1].body.requestKey,calls[2].body.requestKey)
})

test('CD-L11 首启从phone打开协议时明确读取mine模块全文',async()=>{
 const f=fixture(),modules=[],files=[]
 const resourceManager={getRawFileContent:async name=>{files.push(name);return {decodeToString:()=>''}}}
 const ui={getHostContext:()=>({resourceManager:{getRawFileContent:async()=>{throw new Error('phone has no agreement rawfile')}},createModuleContext:name=>{modules.push(name);return {resourceManager}}}),getPromptAction:()=>({showDialog:async()=>({index:0})})}
 // Feed actual UTF-8 bytes through the same decoder used in production.
 resourceManager.getRawFileContent=async name=>{files.push(name);return new TextEncoder().encode(sourceOf('mixed-development-h5/features/mine/src/main/resources/rawfile/'+name))}
 // The platform decoder's API name differs from the standard TextDecoder.
 const data=new Map(),shown=[]
 const {ConsentManager}=execute(sourceOf(path),{'./StoreManager':{storeManager:{getStore:()=>({getSync:(k,d)=>data.get(k)??d})}},'@kit.ArkTS':{util:{TextDecoder:{create:()=>({decodeToString:bytes=>new TextDecoder().decode(bytes)})}}}},{AppStorage:{setOrCreate(){}}})
 ui.getPromptAction=()=>({showDialog:async opts=>{shown.push(opts);return {index:0}}})
 const manager=new ConsentManager();await manager.openDocument(ui,'privacy');await manager.openDocument(ui,'terms')
 assert.deepEqual(modules,['mine','mine']);assert.deepEqual(files,['privacy-policy.txt','user-agreement.txt'])
 assert.match(shown[0].message,/隐私/);assert.match(shown[1].message,/用户/);assert.equal(manager.accepted(),false)
})

test('CD-L12 协议读取失败仍重新显示选择，不产生默认同意',async()=>{
 const f=fixture();f.manager.openDocument=async()=>{throw new Error('resource unavailable')};f.choices.push(0,2)
 assert.equal(await f.manager.request(f.ui,'startup'),false)
 assert.equal(f.manager.accepted(),false)
 assert.ok(f.calls.some(c=>c.message==='协议读取失败，请重试'))
 assert.equal(f.choices.length,0)
})

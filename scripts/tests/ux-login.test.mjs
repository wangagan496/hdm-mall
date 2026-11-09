import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,sourceOf,deferred} from './native-harness.mjs'
const path='mixed-development-h5/features/mine/src/main/ets/presentation/views/LoginView.ets'
function page(){class Controller{setAgreementStatus(){return this}setEnabled(){return this}onClickLoginWithHuaweiIDButton(){return this}}
 return new (pageMethods(path,'LoginView',{}, {loginComponentManager:{LoginWithHuaweiIDButtonController:Controller,AgreementStatus:{}},GlobalVariable:{},util:{TextDecoder:{create:()=>({decodeToString:bytes=>new TextDecoder().decode(bytes)})}}}))()}
test('UX11 未同意登录只高亮定位，不toast不登录不自动勾选',async()=>{
 const p=page();let toast=0,scroll=0;p.safeToast=()=>toast++;p.agreementScroller={scrollEdge:()=>scroll++};p.showTermsError=()=>{p.termsError=true;scroll++}
 await p.submitAccountLogin();assert.equal(p.termsError,true);assert.equal(p.hasAcceptedTerms,false);assert.equal(toast,0);assert.equal(scroll,1)
 p.toggleTerms();assert.equal(p.hasAcceptedTerms,true);assert.equal(p.termsError,false);p.toggleTerms();assert.equal(p.hasAcceptedTerms,false)
})
test('UX11 离线正文链接不改变同意，关闭后迟到读取不覆盖',async()=>{
 const p=page(),d=deferred();let requested='';p.getUIContext=()=>({getHostContext:()=>({resourceManager:{getRawFileContent:name=>{requested=name;return d.promise}}})})
 const task=p.openAgreement('privacy');assert.equal(p.documentTitle,'隐私政策');assert.equal(requested,'privacy-policy.txt');assert.equal(p.hasAcceptedTerms,false)
 p.closeAgreement();d.resolve(new TextEncoder().encode('草案'));await task;assert.equal(p.documentTitle,'');assert.equal(p.documentText,'')
})
test('UX11 协议正文如实标注草案、经营主体待确认及注销将提供',()=>{
 for(const name of ['privacy-policy','user-agreement']){const text=sourceOf('mixed-development-h5/features/mine/src/main/resources/rawfile/'+name+'.txt');assert.match(text,/草案/);assert.match(text,/待经营主体确认/);assert.match(text,/将提供.*注销/)}
 const s=sourceOf(path);assert.match(s,/terms-row/);assert.match(s,/minHeight:44/);assert.match(s,/openAgreement\('privacy'\)/);assert.match(s,/openAgreement\('terms'\)/)
})

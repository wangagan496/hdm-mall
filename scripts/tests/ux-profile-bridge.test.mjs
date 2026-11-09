import {test} from 'node:test'
import assert from 'node:assert/strict'
import {sourceOf,execute} from './native-harness.mjs'
test('UX12 原生返回先握手保存，成功直接离开，失败可保留草稿且旧账号回应无效',()=>{
 const source=sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/WebView.ets')
 const bridge=source.slice(source.indexOf('class HDMWebBridge'),source.indexOf('@Builder')).replace('class HDMWebBridge','export class HDMWebBridge')
 const body=source.slice(source.indexOf('struct WebView {'),source.indexOf('  build()')).replace('struct WebView','export class WebView').replace(/@\w+(?:\([^)]*\))?\s*/g,'')+'\n}'
 let token='a',closed=0;const timers=new Map(),dialogs=[],scripts=[];let next=0
 const globals={auth:{getUserInfo:()=>({token})},GlobalVariable:{},$rawfile:()=>'',webview:{WebviewController:class{}},setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id)}
 const {HDMWebBridge}=execute(bridge,{},globals)
 const {WebView}=execute(body,{}, {...globals,HDMWebBridge})
 const p=new WebView();p.controller={runJavaScript:script=>{scripts.push(script);return Promise.resolve('')}};p.getUIContext=()=>({showAlertDialog:d=>dialogs.push(d)})
 p.bridgeObject.setProfileDirty(true,'a');p.confirmLeave(()=>closed++);p.confirmLeave(()=>closed++)
 assert.equal(scripts.length,1);assert.equal(dialogs.length,0);assert.equal(closed,0)
 p.bridgeObject.completeProfileFlush(p.leaveSequence,'a',true);assert.equal(closed,1);assert.equal(timers.size,0)
 p.bridgeObject.setProfileDirty(true,'a');p.confirmLeave(()=>closed++)
 p.bridgeObject.setProfileDraftRetained('a',true);p.bridgeObject.completeProfileFlush(p.leaveSequence,'a',false)
 assert.equal(dialogs[0].secondaryButton.value,'保留草稿退出');dialogs[0].secondaryButton.action();assert.equal(closed,2)
 p.bridgeObject.setProfileDirty(true,'a');p.confirmLeave(()=>closed++);token='b'
 p.bridgeObject.completeProfileFlush(p.leaveSequence,'a',true);assert.equal(closed,2);p.aboutToDisappear();assert.equal(timers.size,0)
})

import { createHash } from 'node:crypto'
import { z } from 'zod'

export const policyFields={
  returnPolicy:z.enum(['standard','law-excluded','confirm-required']),
  returnPolicyReason:z.enum(['','custom','perishable','digital','periodical','unsealed','activated','near-expiry','defect']),
  returnPolicyNote:z.string().trim().max(100)
}
export const returnPolicySchema=z.object(policyFields).strict().refine(p=>{
  if(p.returnPolicy==='standard')return p.returnPolicyReason===''&&p.returnPolicyNote===''
  const reasons=p.returnPolicy==='law-excluded'?['custom','perishable','digital','periodical']:['unsealed','activated','near-expiry','defect']
  return reasons.includes(p.returnPolicyReason)&&(p.returnPolicyReason==='defect'?p.returnPolicyNote.length>=5:p.returnPolicyNote==='')
},'请选择适用的退货规则，有瑕疵时请填写5到100字说明')
export type ReturnPolicy=z.infer<typeof returnPolicySchema>
export interface PolicyRow {return_policy:ReturnPolicy['returnPolicy'];return_policy_reason:ReturnPolicy['returnPolicyReason'];return_policy_note:string;return_policy_confirmed?:number}
export function presentPolicy(row:PolicyRow):ReturnPolicy {
 return {returnPolicy:row.return_policy,returnPolicyReason:row.return_policy_reason,returnPolicyNote:row.return_policy_note}
}
export function policyToken(items:({skuId:string}&ReturnPolicy)[]) {
 return createHash('sha256').update(JSON.stringify([...items].sort((a,b)=>a.skuId.localeCompare(b.skuId)).map(i=>[i.skuId,i.returnPolicy,i.returnPolicyReason,i.returnPolicyNote]))).digest('hex')
}
export function canReturnNoReason(item:PolicyRow) {
 return item.return_policy==='standard'||item.return_policy==='confirm-required'&&(!item.return_policy_confirmed||['unsealed','activated'].includes(item.return_policy_reason))
}
export function requiresCondition(item:PolicyRow) {
 return item.return_policy==='confirm-required'&&item.return_policy_confirmed===1&&['unsealed','activated'].includes(item.return_policy_reason)
}

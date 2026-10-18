export const MARKER = "dsh-mobile every plugin install requires approval (R2)"
const BODY = "async function M(t,r){if((t?.name??t?.tool?.name)!==\"dshmarketplace_install\")return;let e=t?.arguments?.fullName;if(typeof e!==\"string\"||!e.trim())return{kind:\"deny\",reason:\"Plugin identity is required\"};let a;try{a=((await r({q:e,limit:5}))?.results??[]).find(i=>i?.fullName===e)}catch{return{kind:\"deny\",reason:\"Cannot verify plugin identity; retry after catalogue recovery\"}}if(!a)return{kind:\"deny\",reason:\"Plugin was not found in the catalogue\"};return{kind:\"ask\",reason:[`Install ${a.name}? ${a.fullName} — ${g(a,\"en\")}`,`Detected: ${(a.riskFlags??[]).join(\", \")||\"no flags (not a safety guarantee)\"}.`,\"Plugins execute with this agent's permissions. Explicit approval is required for every installation.\",a.url].join(\"\\n\")}}function b(t=c){return async(r,n)=>{if((r?.name??r?.tool?.name)!==\"dshmarketplace_install\")return typeof n===\"function\"?n():{kind:\"allow\"};try{return await M(r,t)??{kind:\"deny\",reason:\"Installation authorization unavailable\"}}catch{return{kind:\"deny\",reason:\"Installation authorization failed\"}}}}"

export function patchInstallApproval(source) {
  const start = source.indexOf("async function M(")
  const end = source.indexOf("var H=", start)
  if (start < 0 || end <= start) throw new Error("marketplace approval anchors changed")
  return source.slice(0, start) + BODY + "/* " + MARKER + " */" + source.slice(end)
}

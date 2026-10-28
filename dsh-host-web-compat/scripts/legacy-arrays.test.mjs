import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const match = source.match(/\/\/ rc\.3 client uses these[\s\S]*?`([\s\S]*?)`,/)
assert.ok(match, 'production array shim must be present')
function context(setup = '') {
  const ctx = {}
  runInNewContext(`delete Array.prototype.toSorted; delete Array.prototype.findLast; delete Array.prototype.findLastIndex; ${setup}`, ctx)
  assert.equal(runInNewContext('typeof Array.prototype.toSorted', ctx), 'undefined')
  runInNewContext(match[1], ctx)
  return ctx
}
const evalIn = (ctx, code) => runInNewContext(code, ctx)

test('sorting is nonmutating and materializes sparse entries', () => {
  const ctx = context()
  assert.equal(evalIn(ctx, `(()=>{const a=[3,,1]; const b=a.toSorted((x,y)=>x-y);return a[0]===3 && !(1 in a) && b[0]===1 && b[1]===3 && (2 in b) && b[2]===undefined})()`), true)
  assert.equal(evalIn(ctx, `Array.prototype.toSorted.call({0:'b',1:'a',length:2}).join('')`), 'ab')
})
test('reverse search visits holes and supports thisArg and generic receivers', () => {
  const ctx = context()
  assert.equal(evalIn(ctx, `(()=>{const seen=[];const a=[1,,3]; const i=a.findLastIndex(function(v,k){seen.push(k);return v===undefined}, {});return i===1 && seen.join(',')==='2,1' && a.findLast(v=>v===1)===1})()`), true)
  assert.equal(evalIn(ctx, `Array.prototype.findLast.call({0:1,1:2,length:2},function(v){return v===this.x},{x:2})`), 2)
})
test('methods are nonenumerable, reject invalid receivers and callbacks, and preserve native methods', () => {
  const ctx = context(`Array.prototype.findLast = function(){return 42}`)
  assert.equal(evalIn(ctx, `[1].findLast(()=>true)`), 42)
  assert.equal(evalIn(ctx, `Object.getOwnPropertyDescriptor(Array.prototype,'toSorted').enumerable`), false)
  assert.equal(evalIn(ctx, `(()=>{try{Array.prototype.toSorted.call(null);return false}catch(e){return e instanceof TypeError}})()`), true)
  assert.equal(evalIn(ctx, `(()=>{try{[].findLastIndex(null);return false}catch(e){return e instanceof TypeError}})()`), true)
  assert.equal(evalIn(ctx, `(()=>{try{[].toSorted(null);return false}catch(e){return e instanceof TypeError}})()`), true)
  assert.equal(evalIn(ctx, `(()=>{try{Array.prototype.findLastIndex.call({length:1n},()=>false);return false}catch(e){return e instanceof TypeError}})()`), true)
})

test('existing at and replaceAll shims do not pollute for-in enumeration', () => {
  const at = source.match(/`(if\(typeof Array\.prototype\.at[\s\S]*?)`,/);
  const replaceAll = source.match(/`(if\(typeof String\.prototype\.replaceAll[\s\S]*?)`,/);
  assert.ok(at && replaceAll)
  const ctx = {}
  runInNewContext('delete Array.prototype.at; delete String.prototype.replaceAll', ctx)
  runInNewContext(at[1] + ';' + replaceAll[1], ctx)
  assert.equal(evalIn(ctx, `Object.getOwnPropertyDescriptor(Array.prototype,'at').enumerable`), false)
  assert.equal(evalIn(ctx, `Object.getOwnPropertyDescriptor(String.prototype,'replaceAll').enumerable`), false)
  assert.equal(evalIn(ctx, `[1,2].at(-1)`), 2)
  assert.equal(evalIn(ctx, `'aba'.replaceAll('a','x')`), 'xbx')
})

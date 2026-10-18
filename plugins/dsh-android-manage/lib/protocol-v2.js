import { decodeEntities, parseBoundsToBox } from './ui-tree.js';
export const FLAG = {
    clickable: 1,
    scrollable: 2,
    editable: 4,
    checked: 8,
    visible: 16,
    focused: 32,
    selected: 64,
    enabled: 128,
};
/** 列式载荷的最小形状判定（引擎据此在 V1 兼容路径与 V2 之间分流）。 */
export function isV2Payload(data) {
    return data !== null && typeof data === 'object' && !Array.isArray(data) &&
        data.v === 2;
}
const isIntArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
/** 常数广播取值（§S2.3）：长度 1 且 n>1 ⇒ 整列同值。 */
const pick = (arr, i, n) => (arr.length === 1 && n > 1 ? arr[0] : arr[i]);
const sym = (S, k) => (k < 0 ? '' : (S[k] ?? ''));
/** V2 解码。任何结构问题都返回 ok:false（失败关闭；绝不静默产出空节点表）。 */
export function decodeV2(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data))
        return { ok: false, error: 'data 不是对象' };
    const d = data;
    if (d.v !== 2)
        return { ok: false, error: `不支持的协议版本 v=${String(d.v)}（本引擎支持 v=2）` };
    const gen = Number(d.gen);
    const rot = Number(d.rot ?? 0);
    const scr = d.scr;
    if (!Number.isFinite(gen))
        return { ok: false, error: 'gen 缺失或非数字' };
    if (!isIntArray(scr) || scr.length !== 2)
        return { ok: false, error: 'scr 必须是 [宽, 高]' };
    const str = d.str;
    if (!Array.isArray(str) || !str.every((s) => typeof s === 'string'))
        return { ok: false, error: 'str 必须是字符串数组' };
    const S = str;
    const n = Number(d.n);
    if (!Number.isInteger(n) || n < 0)
        return { ok: false, error: 'n 必须是非负整数' };
    const view = d.view === 'target' ? 'target' : 'all';
    const truncated = d.truncated === true;
    const rawCount = Number(d.raw ?? n);
    if (!Number.isInteger(rawCount) || rawCount < n) {
        return { ok: false, error: `raw 必须是不小于 n=${n} 的整数（收到 ${String(d.raw)}）` };
    }
    if (n === 0) {
        return {
            ok: true,
            value: {
                gen, rotation: rot, screen: { w: scr[0], h: scr[1] }, rawCount, view, truncated,
                rows: [], origRow: new Int32Array(0), actionableAncestor: new Int32Array(0), subtreeEnd: new Int32Array(0),
            },
        };
    }
    const cols = {};
    for (const key of ['d', 'p', 'f', 'c', 'k', 'r', 'w', 't', 's']) {
        const col = d[key];
        if (!isIntArray(col))
            return { ok: false, error: `${key} 必须是整数数组` };
        if (col.length !== 1 && col.length !== n) {
            return { ok: false, error: `${key} 长度 ${col.length} 既不是 1（广播）也不是 n=${n}` };
        }
        cols[key] = col;
    }
    const b = d.b;
    if (!isIntArray(b) || b.length !== n * 4) {
        return { ok: false, error: `b 长度必须为 4n=${n * 4}（收到 ${Array.isArray(b) ? b.length : '非数组'}）` };
    }
    // FX-206.1（P0）：句柄必须指回**壳侧 walk 全量行表**的原始行号。载荷行下标 fi 只是列内位置，
    // 壳侧 resolveTarget 用 rows[handle] 索引全量表；两者只在「没有节点被过滤」时偶然相等
    // （探针 393 行 → 86 行下 86/86 全错位）。缺列即失败关闭：宁可不给清单，也不能给出会点错的句柄。
    const o = d.o;
    if (!isIntArray(o))
        return { ok: false, error: 'o 必须是整数数组（载荷行下标 → 原始行号映射）——壳侧编码器过旧，请更新 APK' };
    if (o.length !== 1 && o.length !== n) {
        return { ok: false, error: `o 长度 ${o.length} 既不是 1（广播）也不是 n=${n}` };
    }
    const origRow = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const src = pick(o, i, n);
        if (!Number.isInteger(src) || src < 0 || src >= rawCount) {
            return { ok: false, error: `o[${i}]=${src} 越界：原始行号必须落在 [0, rawCount=${rawCount}) 内` };
        }
        if (i > 0 && src <= origRow[i - 1]) {
            return { ok: false, error: `o 必须严格递增（第 ${i} 项 ${src} 不大于前一项 ${origRow[i - 1]}）` };
        }
        origRow[i] = src;
    }
    const rows = new Array(n);
    const actionableAncestor = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const flag = pick(cols.f, i, n);
        const x = b[i * 4];
        const y = b[i * 4 + 1];
        const w = b[i * 4 + 2];
        const h = b[i * 4 + 3];
        rows[i] = {
            id: 'n' + i,
            parentId: '', // 下方预序 + 深度一次补齐（FX-212.5）；祖先回退走 actionableAncestor
            text: sym(S, pick(cols.t, i, n)),
            desc: sym(S, pick(cols.s, i, n)),
            rid: sym(S, pick(cols.r, i, n)),
            type: sym(S, pick(cols.c, i, n)),
            x, y, w, h,
            cx: x + Math.floor(w / 2),
            cy: y + Math.floor(h / 2),
            depth: pick(cols.d, i, n),
            clickable: (flag & FLAG.clickable) !== 0,
            scrollable: (flag & FLAG.scrollable) !== 0,
            editable: (flag & FLAG.editable) !== 0,
            checked: (flag & FLAG.checked) !== 0,
            visible: (flag & FLAG.visible) !== 0,
            pkg: sym(S, pick(cols.k, i, n)),
            windowId: sym(S, pick(cols.w, i, n)),
        };
        actionableAncestor[i] = pick(cols.p, i, n);
    }
    // 子树区间：预序 + 深度 ⇒ 首个更浅或同深的后续行（单调栈，O(n)）。
    // 同一栈顺手重建父链（FX-212.5）：V2 不发父 id，但预序 + 深度可无损得到最近祖先行，
    // 下游 render 的 ^nX、detailRecord.parentId 与 ui_detail 的 parentLabel 因此不再恒空。
    const subtreeEnd = new Int32Array(n).fill(n);
    const stk = [];
    for (let i = 0; i < n; i++) {
        const di = rows[i].depth;
        while (stk.length > 0 && rows[stk[stk.length - 1]].depth >= di)
            subtreeEnd[stk.pop()] = i;
        rows[i].parentId = stk.length > 0 ? 'n' + stk[stk.length - 1] : '';
        stk.push(i);
    }
    return {
        ok: true,
        value: {
            gen, rotation: rot, screen: { w: scr[0], h: scr[1] }, rawCount, view, truncated,
            rows, origRow, actionableAncestor, subtreeEnd,
        },
    };
}
/**
 * V2 解码结果 → 工具层缓存形状。
 *
 * `origPath` 槽位在 V2 下承载**行句柄**（十进制字符串）：无障碍动作回指不再发原始路径，
 * 改发 `row`（§S5.1 DD-10）。句柄值 = 载荷行下标经 `o` 列映射回的**原始行号**（FX-206.1），
 * 壳侧 resolveTarget 用它索引 walk 全量行表。`byOrig` 以行句柄为键，`parentByOrig` 留空（不再用于 V2）。
 */
export function cacheFromV2(v) {
    const byId = new Map();
    const byOrig = new Map();
    v.rows.forEach((n, i) => {
        const handle = String(v.origRow[i]);
        const withOrig = { ...n, origPath: handle };
        v.rows[i] = withOrig;
        const entry = { n: withOrig, parentOrig: '', origPath: handle };
        byId.set(withOrig.id, entry);
        byOrig.set(handle, entry);
    });
    return { nodes: v.rows, byId, byOrig, parentByOrig: new Map() };
}
/** XML 布尔属性：visible-to-user / enabled 是**反向判据**（缺省 true），其余缺省 false。 */
const attrFlag = (at, key) => key === 'visible-to-user' || key === 'enabled' ? at[key] !== 'false' : at[key] === 'true';
/** XML 原始节点 → 编码行（含零尺寸节点；与壳侧 Kotlin 的 walk 逐字同规则）。 */
export function rowsFromRaw(raw) {
    return raw.map((r) => {
        const at = r.attrs;
        const box = parseBoundsToBox(at.bounds);
        const depth = r.id === '' ? 0 : r.id.split('.').length - 1;
        let flag = 0;
        if (attrFlag(at, 'clickable'))
            flag |= FLAG.clickable;
        if (attrFlag(at, 'scrollable'))
            flag |= FLAG.scrollable;
        if (attrFlag(at, 'editable'))
            flag |= FLAG.editable;
        if (attrFlag(at, 'checked'))
            flag |= FLAG.checked;
        if (attrFlag(at, 'visible-to-user'))
            flag |= FLAG.visible;
        if (attrFlag(at, 'focused'))
            flag |= FLAG.focused;
        if (attrFlag(at, 'selected'))
            flag |= FLAG.selected;
        if (attrFlag(at, 'enabled'))
            flag |= FLAG.enabled;
        return {
            text: decodeEntities(at.text ?? '').trim(),
            desc: decodeEntities(at['content-desc'] ?? '').trim(),
            cls: at.class ?? '',
            pkg: at.package ?? '',
            rid: decodeEntities(at['resource-id'] ?? ''),
            windowId: at['window-id'] ?? '',
            depth,
            x: box.x, y: box.y, w: box.w, h: box.h, flag,
        };
    });
}
/**
 * 从**正确解析**的 XML 节点表编码为 V2（ADB 路径用）。
 * 与 Kotlin 编码器同规则：骨架闭包（view=all：正尺寸 ∪ 全部祖先）→ 仅叶子去重 → 符号表 + 广播。
 */
export function encodeV2FromRaw(raw, rotation, screen, gen, view = 'all') {
    return encodeV2(rowsFromRaw(raw), view, gen, rotation, screen.w, screen.h);
}
/** 行表 → V2 载荷（与壳侧 `ControlProtocolV2.encode` 同一规则；跨语言门禁比对的就是这一层）。
 * `o` 列 = 载荷每行的**原始行号**（动作回指句柄）；严格递增，故仅 n=1 时长度为 1。 */
export function encodeV2(rowsIn, view, gen, rotation, width, height) {
    const rows = rowsIn;
    const n = rows.length;
    const actionable = (r) => (r.flag & (FLAG.clickable | FLAG.editable | FLAG.scrollable)) !== 0;
    // 2. 行集：骨架闭包
    const keep = new Array(n).fill(false);
    const ancStack = [];
    for (let i = 0; i < n; i++) {
        while (ancStack.length > 0 && rows[ancStack[ancStack.length - 1]].depth >= rows[i].depth)
            ancStack.pop();
        const hasArea = rows[i].w > 0 && rows[i].h > 0;
        const inSet = view === 'target'
            ? hasArea && (actionable(rows[i]) || rows[i].text !== '' || rows[i].desc !== '')
            : hasArea;
        if (inSet) {
            keep[i] = true;
            for (const a of ancStack)
                keep[a] = true;
        }
        ancStack.push(i);
    }
    // 3. 子树区间 + 下一个保留行（判「行集内是否为叶子」）
    const subtreeEnd = new Array(n).fill(n);
    const st = [];
    for (let i = 0; i < n; i++) {
        while (st.length > 0 && rows[st[st.length - 1]].depth >= rows[i].depth)
            subtreeEnd[st.pop()] = i;
        st.push(i);
    }
    const nextKept = new Array(n).fill(n);
    let nxt = n;
    for (let i = n - 1; i >= 0; i--) {
        nextKept[i] = nxt;
        if (keep[i])
            nxt = i;
    }
    // 4. 行集 + 仅叶子去重（DD-5：骨架连接点永不参与去重 ⇒ 深度跳变 0%）
    const out = [];
    const seen = new Set();
    for (let i = 0; i < n; i++) {
        if (!keep[i])
            continue;
        const leafInSet = nextKept[i] >= subtreeEnd[i];
        if (leafInSet) {
            const r = rows[i];
            const key = [r.text, r.desc, r.cls, r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)].join('\u0000');
            if (seen.has(key))
                continue;
            seen.add(key);
        }
        out.push(i);
    }
    // 5. 符号表 + 各列
    const symIndex = new Map();
    const str = [];
    const symOf = (s) => {
        if (s === '')
            return -1;
        const hit = symIndex.get(s);
        if (hit !== undefined)
            return hit;
        const i = str.length;
        symIndex.set(s, i);
        str.push(s);
        return i;
    };
    const d = [];
    const p = [];
    const b = [];
    const f = [];
    const c = [];
    const k = [];
    const r = [];
    const w = [];
    const t = [];
    const s = [];
    const stk = []; // 行集内的祖先（out 下标）
    for (let fi = 0; fi < out.length; fi++) {
        const row = rows[out[fi]];
        while (stk.length > 0 && rows[out[stk[stk.length - 1]]].depth >= row.depth)
            stk.pop();
        let anc = -1;
        for (let j = stk.length - 1; j >= 0; j--) {
            if (actionable(rows[out[stk[j]]])) {
                anc = stk[j];
                break;
            }
        }
        d.push(row.depth);
        p.push(anc);
        b.push(row.x, row.y, row.w, row.h);
        f.push(row.flag);
        c.push(symOf(row.cls.split('.').pop() ?? ''));
        k.push(symOf(row.pkg));
        r.push(symOf(row.rid));
        w.push(symOf(row.windowId));
        t.push(symOf(row.text));
        s.push(symOf(row.desc));
        stk.push(fi);
    }
    return {
        v: 2,
        gen,
        rot: rotation,
        scr: [width, height],
        raw: n,
        view,
        n: out.length,
        str,
        d: broadcast(d), p: broadcast(p), b, o: broadcast(out), f: broadcast(f),
        c: broadcast(c), k: broadcast(k), r: broadcast(r), w: broadcast(w),
        t: broadcast(t), s: broadcast(s),
    };
}
/** 常数广播（§S2.3 D3）：整列同值且 n>1 时只发 1 个元素。`b` 不参与（长度固定 4n）。 */
function broadcast(col) {
    if (col.length > 1 && col.every((v) => v === col[0]))
        return [col[0]];
    return col;
}

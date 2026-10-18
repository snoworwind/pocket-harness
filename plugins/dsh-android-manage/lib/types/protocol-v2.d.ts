/**
 * 控制协议 V2（列式载荷）——解码器（引擎侧）+ 编码器（ADB 路径）。
 *
 * 规范：docs/review/20260910-a11y/DESIGN-PROTOCOL-V2.md §S2（字段）、§S5.2（解码）、§S5.3（XML 编码）。
 * 壳侧 Kotlin 编码器与之逐字同规则（`ControlProtocolV2.kt`）；两路的等价性由跨语言往返门禁锁定
 * （§S6.2 T2：Kotlin 编码 → TS 解码 vs TS 编码 → TS 解码，逐字段相同）。
 *
 * 体积动机（实测冻结口径）：V1 426 B/节点 → V2 54.7 B/行；探针 86 行 = 4,705 B（V1 同场景 37,052 B）。
 * 压缩来自四件事：列式（不重复字段名）、符号表（字符串只发一次）、常数广播（整列同值只发 1 个）、
 * 整数句柄（句柄 = **原始行号**，随 `o` 列显式发出；载荷行下标只是列内位置）。
 */
import type { UiNode, NodeEntry } from './ui-tree.js';
export declare const FLAG: {
    readonly clickable: 1;
    readonly scrollable: 2;
    readonly editable: 4;
    readonly checked: 8;
    readonly visible: 16;
    readonly focused: 32;
    readonly selected: 64;
    readonly enabled: 128;
};
export type V2View = 'all' | 'target';
export interface V2Decoded {
    gen: number;
    rotation: number;
    screen: {
        w: number;
        h: number;
    };
    rawCount: number;
    view: V2View;
    /** 壳侧建树预算耗尽（E2 的 `truncated`）：真值透出，呈现面据此渲染，不再写死「未截断」。 */
    truncated: boolean;
    /** 与 V1 公开节点同形（resolveRef / render / 工具面零改动）。 */
    rows: UiNode[];
    /** 载荷行下标 → 原始行号（壳侧 walk 全量行表下标）。动作回指的 row 句柄取此列（FX-206.1）。 */
    origRow: Int32Array;
    /** 行下标 → 最近可操作祖先行下标（-1 = 无）。C2 祖先回退的直接答案。 */
    actionableAncestor: Int32Array;
    /** 行下标 → 子树结束下标（开区间）。C1 的 @nX 区域限定用它。 */
    subtreeEnd: Int32Array;
}
export type DecodeResult = {
    ok: true;
    value: V2Decoded;
} | {
    ok: false;
    error: string;
};
/** 列式载荷的最小形状判定（引擎据此在 V1 兼容路径与 V2 之间分流）。 */
export declare function isV2Payload(data: unknown): boolean;
/** V2 解码。任何结构问题都返回 ok:false（失败关闭；绝不静默产出空节点表）。 */
export declare function decodeV2(data: unknown): DecodeResult;
/**
 * V2 解码结果 → 工具层缓存形状。
 *
 * `origPath` 槽位在 V2 下承载**行句柄**（十进制字符串）：无障碍动作回指不再发原始路径，
 * 改发 `row`（§S5.1 DD-10）。句柄值 = 载荷行下标经 `o` 列映射回的**原始行号**（FX-206.1），
 * 壳侧 resolveTarget 用它索引 walk 全量行表。`byOrig` 以行句柄为键，`parentByOrig` 留空（不再用于 V2）。
 */
export declare function cacheFromV2(v: V2Decoded): {
    nodes: UiNode[];
    byId: Map<string, NodeEntry>;
    byOrig: Map<string, NodeEntry>;
    parentByOrig: Map<string, string>;
};
/** XML 原始节点（parseUiTreeXml 的产物形状）。 */
interface EncRawNode {
    attrs: Record<string, string>;
    id: string;
    parentId: string;
}
/** 编码器输入行（纯数据）：`rowsFromRaw` 的产物，也是跨语言门禁的 canonical 形态。 */
export interface EncRow {
    text: string;
    desc: string;
    cls: string;
    pkg: string;
    rid: string;
    windowId: string;
    depth: number;
    x: number;
    y: number;
    w: number;
    h: number;
    flag: number;
}
/** XML 原始节点 → 编码行（含零尺寸节点；与壳侧 Kotlin 的 walk 逐字同规则）。 */
export declare function rowsFromRaw(raw: EncRawNode[]): EncRow[];
/**
 * 从**正确解析**的 XML 节点表编码为 V2（ADB 路径用）。
 * 与 Kotlin 编码器同规则：骨架闭包（view=all：正尺寸 ∪ 全部祖先）→ 仅叶子去重 → 符号表 + 广播。
 */
export declare function encodeV2FromRaw(raw: EncRawNode[], rotation: number, screen: {
    w: number;
    h: number;
}, gen: number, view?: V2View): Record<string, unknown>;
/** 行表 → V2 载荷（与壳侧 `ControlProtocolV2.encode` 同一规则；跨语言门禁比对的就是这一层）。
 * `o` 列 = 载荷每行的**原始行号**（动作回指句柄）；严格递增，故仅 n=1 时长度为 1。 */
export declare function encodeV2(rowsIn: EncRow[], view: V2View, gen: number, rotation: number, width: number, height: number): Record<string, unknown>;
export {};

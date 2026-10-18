/**
 * UI 树解析与剪枝（ADB 2.0 Phase A，PRD-0.13.2 §3.2）。
 *
 * 输入：uiautomator dump 的 hierarchy XML（厂商 ROM 噪音容忍——调用方以
 * 「UI hierchary dumped to:」为成功信号，segfault/非零退出码属噪音）。
 * 输出：紧凑语义节点表（可交互 + 关键文本节点，去重、剪裁、封顶），供模型
 * 以语义目标（id/text/desc 引用）驱动 android_ui_click / android_ui_scroll。
 *
 * token 策略：只保留可交互 + 有文本/描述节点、剪属性、截断长文本、封顶
 * 节点数——树清单远便宜于截图，大页面宁可截断也不反超（调研 §4）。
 */
export interface UiNode {
    /** 深度路径 id（如 "0.1.2"），同一次 dump 内稳定，作语义点击引用。 */
    id: string;
    /** 父节点 id（可点击祖先回退用）；根节点为空串。 */
    parentId: string;
    text: string;
    desc: string;
    /** resource-id（截 60）。 */
    rid: string;
    /** class 短名（截 24）。 */
    type: string;
    /** 原始边界 left/top（0.13.5：协作轮反馈「精确滑动锚点要自己换算」→ 直接给边界）。 */
    x: number;
    y: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
    /** 层级深度（原始路径段数，根=0；用于渲染缩进树）。 */
    depth: number;
    clickable: boolean;
    scrollable: boolean;
    editable: boolean;
    checked: boolean;
    /** 节点是否对用户可见（`visible-to-user != false`；用于判断遮挡/滚动容器外）。 */
    visible: boolean;
    /** 所属应用包名（多窗口/浮窗归属；XML 路径为空）。 */
    pkg: string;
    /** 所属窗口 id（多窗口归属；XML 路径为空）。 */
    windowId: string;
    /** 内部字段：原始 XML 路径 id（仅用于子树作用域匹配 `@nX`，不对外渲染）。 */
    origPath?: string;
}
export interface UiTree {
    screen: {
        w: number;
        h: number;
    };
    rotation: number;
    nodes: UiNode[];
    rawCount: number;
}
/**
 * 剪枝上限（0.13.5 W4 起**取消截断**——用户拍板：语义树应尽可能结构化且完整地暴露信息，
 * 「复杂多控件环境下截断等于没有用」）。0 = 不限制；保留常量是为了将来按需收紧。
 */
export declare const PRUNE_LIMITS: {
    readonly maxNodes: 0;
    readonly maxText: 0;
    readonly maxDesc: 0;
    readonly maxRid: 0;
    readonly maxType: 0;
};
/** 内部节点索引条目：公开节点 + 原始路径父链信息（祖先回退 / 无障碍动作回指用）。 */
export interface NodeEntry {
    n: UiNode;
    parentOrig: string;
    /** 该节点自身的原始路径 id（"0.2.1"）——无障碍通道按路径回指壳侧节点。 */
    origPath: string;
}
export declare function decodeEntities(s: string): string;
/** bounds="[x1,y1][x2,y2]" → {x,y,w,h}；畸形/缺省按零尺寸（0,0,0,0）——V2 编码保留零尺寸节点做骨架。 */
export declare function parseBoundsToBox(b: string | undefined): {
    x: number;
    y: number;
    w: number;
    h: number;
};
interface RawNode {
    attrs: Record<string, string>;
    id: string;
    parentId: string;
}
/**
 * 解析 hierarchy XML → 原始节点表（含深度路径 id 与父 id）。
 * 单一栈机：开标签下钻、自闭合同层计数、闭标签归位；对厂商畸形输出
 * （属性缺省/坏 bounds）按节点丢弃，不中断整体解析。
 *
 * 0.13.8 P0-2（产线 bug 修复）：原实现只匹配 `<node ...>` 开标签、从不处理
 * `</node>` 出栈——兄弟节点被错误地压成子节点，depth/父链/`@nX` 区域限定/
 * findActionableAncestor 全部失真（实测最大深度 91 vs 正确 19）。现显式匹配
 * `</node>` 归位；畸形 XML（多余闭标签）按容错弹栈处理。
 */
export declare function parseUiTreeXml(xml: string): {
    raw: RawNode[];
    rotation: number;
};
/**
 * 解析结果结构自检（0.13.8 P0-2）：解析结果与源 XML 自相矛盾时**响亮拒绝**，
 * 绝不静默产出错树（错误树比没有树更危险）。
 * 检查：① 节点标签计数与解析产出一一对应；② 根节点必为 "0"；
 * ③ 栈未完全归位（未闭合的开标签）视为畸形——按容错放行但由调用方标记。
 */
export declare function checkUiTreeParse(xml: string, raw: RawNode[]): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function pruneNodes(raw: RawNode[], limits?: typeof PRUNE_LIMITS): {
    nodes: UiNode[];
    rawCount: number;
    byId: Map<string, NodeEntry>;
    byOrig: Map<string, NodeEntry>;
    /** 原始 XML 路径 id → 父路径 id（**含被剪掉的中间层**，祖先回退用）。 */
    parentByOrig: Map<string, string>;
};
/** 解析语义引用（"id:n3" / "text:设置" / "desc:搜索" / "rid:..."；裸数字按 id）。
 *
 *  0.13.5（用户指出的误判风险）：同名节点**必须保留**，但解析到多个候选时**绝不静默挑一个**——
 *  返回 ok:false 并列出全部候选（id/类型/坐标），让模型改用 `id:nN` 精确引用。
 *  两种消歧后缀：
 *    - `text:新建会话#2`  —— 取 dump 顺序里的第 2 个匹配（1 基）
 *    - `text:新建会话@n5` —— 只在 n5 的子树内匹配（区域限定，避免侧边栏/主区同名互相污染）
 */
export declare function resolveRef(byId: Map<string, NodeEntry>, nodes: UiNode[], ref: string,
/** V2 专用：子树池提供者（预序区间切片）。缺省 = V1 的 origPath 前缀匹配。 */
scopePool?: (scopeId: string) => UiNode[] | null): {
    ok: true;
    node: UiNode;
    matches?: UiNode[];
} | {
    ok: false;
    error: string;
    matches?: UiNode[];
};
/** 沿父链（原始 XML 路径）找第一个可点击/可编辑祖先——目标节点不可点时的回退。
 *
 *  注意两套 id 的边界：模型看到/引用的是重编号后的公开 id（n0/n1…），而 byOrig 以
 *  **原始 XML 路径 id**（"0.2.1"）为键。旧实现用 `byOrig.get(node.id)` 查公开 id，
 *  永远查不到 → 祖先回退静默失效（2026-09-08 修复）。入口必须走 byId（公开 id → 条目），
 *  再沿 parentByOrig 的全量父链上溯，跳过被剪枝的中间层。 */
export declare function findActionableAncestor(byId: Map<string, NodeEntry>, byOrig: Map<string, NodeEntry>, parentByOrig: Map<string, string>, node: UiNode): UiNode | null;
/** V2 下的祖先回退（§S2.6 C2）：`actionableAncestor` 查表，O(1)——语义与
 *  `findActionableAncestor` 等价（壳侧编码时已按同一规则上溯，DD-8）。 */
export declare function actionableAncestorV2(v: {
    rows: UiNode[];
    actionableAncestor: Int32Array;
}, node: UiNode): UiNode | null;
/** V2 下的 `@nX` 区域限定：子树 = 预序连续区间（§S2.6），O(1) 切片替代 origPath 前缀匹配。 */
export declare function scopePoolV2(v: {
    rows: UiNode[];
    subtreeEnd: Int32Array;
}, scopeId: string): UiNode[] | null;
export {};

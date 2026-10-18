import type { UiNode } from './ui-tree.js';
/** 文件名前缀（与 dsh-tmp 里的其它临时产物区分；LRU 清理按此前缀）。 */
export declare const DETAIL_PREFIX = "ui-detail-";
/** 确定性句柄 → 文件名（句柄里的异常字符剔除，保证可作文件名）。 */
export declare function detailFileName(handle: string): string;
/**
 * 单行明细记录：把 `UiNode` 的全部字段摊平给模型（渲染里压缩过的 type/rid、坐标四元组等都在）。
 * `extra` 放派生信息（如祖先链、子树范围）——按需传入，避免默认结果变胖。
 */
export declare function detailRecord(n: UiNode, extra?: Record<string, unknown>): Record<string, unknown>;
/**
 * 写出明细文件（JSONL：首行 meta，其余一行一节点）。返回文件路径。
 * 写入是幂等的：同一句柄重复写覆盖同一条路径（不给旧屏留下第二份副本）。
 */
export declare function writeDetailStore(dir: string, handle: string, rows: Array<Record<string, unknown>>, meta: Record<string, unknown>): string;
/** 分页切片 + 诚实报告省略量（对齐上游 output-retention 的口径：丢了几个必须说清）。 */
export declare function pageRows<T>(rows: T[], offset: number, limit: number): {
    page: T[];
    offset: number;
    omitted: number;
};

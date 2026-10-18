/**
 * 虚拟屏截图的 **SurfaceFlinger token 反查**（0.14.1 块G F6）。
 *
 * ## 真因（设备实测：MuMu x86_64 模拟器 / Android 15 / API 35）
 *
 * `screencap -d <id>` 吃的是 **SurfaceFlinger display token**，不是 `DisplayManager` 的 displayId。
 * 两者是**不同的 id 空间**，此前在本仓代码与文档里被当作同一个数：
 *
 * | 来源 | 主屏 | 虚拟屏 |
 * |---|---|---|
 * | `dumpsys display` 的 `mDisplayId`（DisplayManager） | 0 | 2 / 3（动态） |
 * | `dumpsys SurfaceFlinger` 的 `Display <n>`（SF token） | 4619827820427265280 | 11529215046816944610 |
 *
 * 实测（uid=2000 shell，Shizuku 传输身份）：
 *   `screencap -d 3`                   → `Failed to take screenshot. Status: -2`（虚拟屏，无文件）
 *   `screencap -d 2`                   → 同上（无文件）
 *   `screencap -d 11529215046816944610` → 成功 91,363 B，解出 675x1200 RGBA（虚拟屏像素）
 *   `screencap -p`（无参）              → 成功 256,766 B，900x1600（**真实屏**，与上面不是同一画面）
 *
 * 因此 `android_screenshot {screenId:"virtual-1"}` 的 ADB 回落路径此前用 displayId 传 `-d`，
 * **必然失败**——这正是「传了 screenId 但 id 空间错」（0.13.8 修的是「完全忽略 screenId」）。
 *
 * ## 两个必须写进代码的硬约束
 *
 * 1. **token 超出安全整型**：`11529215046816944610 > 2^53`（JS `Number` 精度）且 `> 2^63-1`
 *    （Kotlin `Long` 上界）。故 token **全程按字符串处理**，绝不 `Number()`/`parseInt`——
 *    一旦转数就会变成 `...944000`，与真实 token 不等，回归「传了 id 但抓不到」。
 * 2. **fail-closed**：反查不到就**明确报错**，**不得**回落到 displayId 硬试、**不得**回落无参
 *    `screencap`（那正是 0.13.8 修过的「抓真实屏却以为在抓虚拟屏」的旧缺陷）。
 */
/** 单条 SF 虚拟屏登记：product alias -> SF token（字符串，见文件头约束 1）。 */
export interface VdTokenEntry {
    /** 产品别名，如 `virtual-1`。 */
    alias: string;
    /** SurfaceFlinger display token（十进制字符串）。 */
    token: string;
}
/**
 * 解析 SF 的 `Virtual Display <token>` + 紧随的 `name="DSH <alias>"` 配对。
 *
 * 输入取自受支持的抽取命令（输出很小，避免 `dumpsys SurfaceFlinger` 全文超 16 KiB 上限）：
 * ```
 * dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'
 * ```
 * 真实输出形态（逐字，设备实测）：
 * ```
 *     name="mumuscreen000"
 * Virtual Display 11529215046816944610
 *     name="DSH virtual-1"
 * ```
 *
 * 纯函数：无 IO、无全局态，可离线单测（含真实设备输出夹具）。
 */
export declare function parseVirtualDisplayTokens(sfDump: string): VdTokenEntry[];
/**
 * 按产品别名反查 SF token。查不到返回 `null`（**调用方必须 fail-closed**，见文件头约束 2）。
 *
 * 大小写与空白按产品别名规整（别名由壳侧分配，形如 `virtual-N`）。
 */
export declare function resolveVirtualDisplayToken(sfDump: string, alias: string | undefined): string | null;
/** 反查失败时的结构化文案（必须点名「alias 解析不到 SF token」，且说明不回落）。 */
export declare function vdTokenMissingText(alias: string): string;

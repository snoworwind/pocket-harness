/**
 * dsh-android-manage — 手机管理工具面（PRD F1.6）
 *
 * 定位：以 ADB（安卓调试桥）优先的观察-动作-等待-再观察闭环；工具经授权会话执行，
 * 按可用权限自动降级（未授权 → 失败关闭：返回引导，不静默降级、不绕行）。
 *
 * 工具集（全部经 ctx.androidPrivilege 前置校验 + 审计）：
 *  - android_screenshot      截屏（接既有视觉链路读图；授权通道执行 screencap）
 *  - android_ui_tree         控件树（uiautomator）：**无障碍关时的控件树来源**，与 ui_dump 同形、可 ref 操作
 *  - android_device_info     设备与屏幕信息 + 前台应用（dumpsys 为只读面）
 *  - android_act_input       输入事件（点按/滑动/按键/文本）——高风险动作类，主屏审批前不执行
 *  - android_ui_dump         语义控件清单（ADB 2.0 Phase A：解析+剪枝+编号，紧凑 JSON）
 *  - android_ui_click        语义点击（按 id/text/desc 引用，bounds 中心 tap；不可点回退祖先）
 *  - android_ui_scroll       语义滚动（按节点或屏幕方向/fraction swipe）
 *  - android_ui_input        语义文本输入（ASCII 走 input text；非 ASCII 走 ADBKeyboard 广播）
 *  调用序（PRD-0.13.2 §3.2）：无障碍开 → android_ui_dump；无障碍关（纯 Shizuku）→ android_ui_tree；两者失败再截图兜底。
 *
 * 边界声明（PRD F1.6）：仅操作已授权设备；不做账号接管/验证码/支付/绕过风控；
 * 不隐藏 ADB 或自动化信号。敏感操作（截图/界面树）默认提供脱敏选项（文本脱敏摘要模式）。
 *
 * 执行通道说明：本版经 ctx.androidPrivilege 状态机与审计面落地（桥执行实现随壳侧 adbShell 原语
 * 就绪后接通）；未授权时全部工具返回引导——与 PRD "未授权时全部失败关闭" 语义一致。
 */
import { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-android-manage";
export declare const inject: readonly ["tools", "webServer", "androidPrivilege"];
export declare function apply(ctx: Context, _config?: Record<string, unknown>): void;

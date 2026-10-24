// auto-approve.mjs — connect to the phone engine mux stream and auto-approve
// every pending approval (test harness only; real usage goes through the UI).
//
// 坑 537（R3-34）：本脚本把人工审批面整体短路（每条 approval/requested 一律回
// allowed-once），且不区分工具与范围。只允许在显式确认下运行——对准鉴权弱/未启用的
// 引擎实例会把设备控制类高危操作的全部审批吞掉。缺 DSH_AUTO_APPROVE_CONFIRM=1 即退出。
if (process.env.DSH_AUTO_APPROVE_CONFIRM !== '1') {
  console.error('[auto-approve] refuse to run: this short-circuits every human approval.')
  console.error('[auto-approve] set DSH_AUTO_APPROVE_CONFIRM=1 only for isolated test engines.')
  process.exit(2)
}
const BASE = process.env.DSH_ENGINE_URL ?? 'http://127.0.0.1:3081'

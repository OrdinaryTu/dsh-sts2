/**
 * 外置 watchdog：盯着 autoplay runner 的进程和心跳。
 *
 * - runner 进程没了，且不是正常退出原因 → 自动重启
 * - runner 进程还活着但心跳超过 5 分钟没更新 → 视为卡死，重启
 * - 手动 stop 文件 / max_runs / too_many_errors 等正常结束 → 自己退出
 *
 * 不经过模型，不调用游戏 API，只读状态文件和杀/起 node 进程。
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const DIR = dirname(fileURLToPath(import.meta.url))
const RUNNER_SCRIPT = join(DIR, 'autoplay.mjs')
const RUNNER_STATUS = join(DIR, 'autoplay-status.json')
const RUNNER_STOP = join(DIR, 'autoplay.stop')
const WATCHDOG_STATUS = join(DIR, 'autoplay-watchdog.json')
const WATCHDOG_LOG = join(DIR, 'autoplay-watchdog.log')
const STARTED_AT = Date.now()
const PID = process.pid
const CHECK_MS = 10_000
const STALE_MS = 5 * 60_000
const START_GRACE_MS = 15_000
const MAX_RESTARTS_PER_HOUR = 6

let restarts = 0
let restartWindowStart = Date.now()
let lastRestartAt = null
let lastRestartMs = 0
let stopped = null

function log(message) {
  try {
    appendFileSync(WATCHDOG_LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

function writeStatus(extra = {}) {
  try {
    writeFileSync(WATCHDOG_STATUS, JSON.stringify({
      pid: PID,
      started_at: new Date(STARTED_AT).toISOString(),
      updated_at: new Date().toISOString(),
      restarts,
      last_restart_at: lastRestartAt,
      stopped,
      ...extra,
    }, null, 2))
  } catch {}
}

function readRunnerStatus() {
  try { return JSON.parse(readFileSync(RUNNER_STATUS, 'utf8')) } catch { return null }
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function terminalReason(status) {
  const reason = status?.stopped
  return reason === 'max_runs' || reason === 'too_many_errors' || reason === 'profile_mismatch' || reason === 'stop_file'
}

function spawnRunner(status) {
  const args = [RUNNER_SCRIPT, '--max-minutes', '0', '--max-runs', String(status?.max_runs || 4)]
  if (status?.run_id && status.run_id !== 'run_unknown') args.push('--run', String(status.run_id))
  const child = spawn(process.execPath, args, {
    cwd: DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  lastRestartAt = new Date().toISOString()
  lastRestartMs = Date.now()
  log(`runner restarted pid=${child.pid} run=${status?.run_id || 'unknown'}`)
  return child.pid
}

function canRestart() {
  const now = Date.now()
  if (now - restartWindowStart > 60 * 60_000) {
    restartWindowStart = now
    restarts = 0
  }
  return restarts < MAX_RESTARTS_PER_HOUR
}

log(`watchdog start pid=${PID}`)
writeStatus({ screen: 'watching' })

while (true) {
  if (existsSync(RUNNER_STOP)) {
    stopped = 'stop_file'
    break
  }

  const status = readRunnerStatus()
  const pid = Number(status?.pid || 0)
  const alive = isAlive(pid)
  const updated = status?.updated_at ? Date.parse(status.updated_at) : 0
  const age = updated ? Date.now() - updated : Number.POSITIVE_INFINITY
  const sinceStart = Date.now() - STARTED_AT
  const sinceRestart = lastRestartMs ? Date.now() - lastRestartMs : Number.POSITIVE_INFINITY
  const grace = sinceStart < START_GRACE_MS || sinceRestart < START_GRACE_MS

  if (terminalReason(status)) {
    stopped = status.stopped
    break
  }

  if (!status || !pid) {
    log('runner status missing; waiting')
  } else if (!alive && !grace) {
    if (canRestart()) {
      restarts++
      log(`runner pid=${pid} gone (stopped=${status.stopped ?? 'null'} screen=${status.screen ?? '?'}); restarting`)
      try { spawnRunner(status) } catch (error) { log(`restart failed: ${String(error?.message || error)}`) }
    } else {
      stopped = 'restart_limit'
      log(`runner gone but restart limit reached (${restarts}/${MAX_RESTARTS_PER_HOUR}/hour)`)
      break
    }
  } else if (alive && age > STALE_MS) {
    if (canRestart()) {
      restarts++
      log(`runner pid=${pid} alive but heartbeat stale ${Math.round(age / 1000)}s on ${status.screen ?? '?'}; killing and restarting`)
      try { process.kill(pid) } catch {}
      try { spawnRunner(status) } catch (error) { log(`restart failed: ${String(error?.message || error)}`) }
    } else {
      stopped = 'restart_limit'
      log(`runner stale but restart limit reached (${restarts}/${MAX_RESTARTS_PER_HOUR}/hour)`)
      break
    }
  }

  writeStatus({
    screen: 'watching',
    runner_pid: pid || null,
    runner_alive: alive,
    runner_screen: status?.screen ?? null,
    runner_age_seconds: updated ? Math.round(age / 1000) : null,
  })

  await new Promise((resolve) => setTimeout(resolve, CHECK_MS))
}

writeStatus({ screen: 'stopped' })
log(`watchdog stop pid=${PID} reason=${stopped || 'done'} restarts=${restarts}`)

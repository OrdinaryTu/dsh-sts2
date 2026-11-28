/**
 * 杀戮尖塔 2 控制插件。
 *
 * 游戏侧：STS2 AI Agent mod（v0.18.0，适配游戏 v0.111.x）在 8080–8090 里挑一个端口，
 * 暴露 GET /health、GET /state、POST /action。这里不碰存档，只负责：
 * - 自动发现端口；
 * - 把 {ok,data} 信封拆开给模型看；
 * - 动作前确认 active profile 是 2（给小鱼用的存档），否则拒绝，防止误碰主存档。
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const SERVICE = 'sts2-ai-agent'
const PORTS = Array.from({ length: 11 }, (_, index) => 8080 + index)
const ENV_BASE = process.env.DSH_STS2_URL ? process.env.DSH_STS2_URL.replace(/\/$/, '') : null
const EXPECTED_PROFILE = Number(process.env.DSH_STS2_PROFILE || 2)
const GAME_APP_ID = process.env.DSH_STS2_APPID || '2868840'
const GAME_EXE = process.env.DSH_STS2_EXE || 'E:\\SteamLibrary\\steamapps\\common\\Slay the Spire 2\\SlayTheSpire2.exe'
const MODS_DIR = join(dirname(GAME_EXE), 'mods')
const MOD_BACKUP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'mod-backup')
const MOD_FILES = ['STS2AIAgent.dll', 'STS2AIAgent.pck', 'mod_id.json']
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const RUNNER_SCRIPT = `${PLUGIN_DIR}\\autoplay.mjs`
const RUNNER_STATUS = `${PLUGIN_DIR}\\autoplay-status.json`
const RUNNER_LOG = `${PLUGIN_DIR}\\autoplay.log`
const RUNNER_STOP = `${PLUGIN_DIR}\\autoplay.stop`
const WATCHDOG_SCRIPT = `${PLUGIN_DIR}\\watchdog.mjs`
const WATCHDOG_STATUS = `${PLUGIN_DIR}\\autoplay-watchdog.json`
const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readPid(file) {
  try { return Number(JSON.parse(readFileSync(file, 'utf8'))?.pid) || null } catch { return null }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function ensureWatchdog() {
  const existing = readPid(WATCHDOG_STATUS)
  if (pidAlive(existing)) return { pid: existing, already_running: true }
  const child = spawn('node', [WATCHDOG_SCRIPT], {
    cwd: PLUGIN_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid, already_running: false }
}

function stopWatchdog() {
  const pid = readPid(WATCHDOG_STATUS)
  if (!pid) return null
  try { process.kill(pid) } catch {}
  return pid
}

function startRunnerProcess({ runId = '', maxMinutes = 0, maxRuns = 4 } = {}) {
  const existing = readPid(RUNNER_STATUS)
  if (pidAlive(existing)) {
    const watchdog = ensureWatchdog()
    return { ok: true, already_running: true, pid: existing, watchdog_pid: watchdog.pid, run_id: runId, max_minutes: maxMinutes, max_runs: maxRuns, status: RUNNER_STATUS, log: RUNNER_LOG }
  }
  if (existsSync(RUNNER_STOP)) unlinkSync(RUNNER_STOP)
  if (existsSync(RUNNER_STATUS)) unlinkSync(RUNNER_STATUS)
  const child = spawn('node', [RUNNER_SCRIPT, '--run', runId, '--max-minutes', String(maxMinutes), '--max-runs', String(maxRuns)], {
    cwd: PLUGIN_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  const watchdog = ensureWatchdog()
  return { ok: true, pid: child.pid, watchdog_pid: watchdog.pid, run_id: runId, max_minutes: maxMinutes, max_runs: maxRuns, status: RUNNER_STATUS, log: RUNNER_LOG }
}

let cached = { base: null, at: 0 }
let launchedByAgent = false
let modLaunchInProgress = false
let modLaunchGuardUntil = 0

async function request(url, { method = 'GET', body, timeout = 8000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: response.status, json }
}

async function probe(base) {
  try {
    const result = await request(`${base}/health`, { timeout: 1200 })
    return result.json?.data?.service === SERVICE ? base : null
  } catch {
    return null
  }
}

async function findBase(force = false) {
  if (!force && cached.base && Date.now() - cached.at < 20_000) return cached.base
  const candidates = []
  if (ENV_BASE) candidates.push(ENV_BASE)
  if (cached.base) candidates.push(cached.base)
  for (const port of PORTS) candidates.push(`http://${HOST}:${port}`)
  const unique = [...new Set(candidates)]
  const results = await Promise.all(unique.map(probe))
  const base = results.find(Boolean) || null
  if (!base) {
    cached = { base: null, at: 0 }
    throw new Error('找不到 STS2 AI Agent API（端口 8080–8090）。确认游戏在运行，mods/STS2AIAgent 已加载；日志里应有 "Loaded 1 mods" 和 "Listening on http://127.0.0.1:8081/"。')
  }
  cached = { base, at: Date.now() }
  return base
}

async function withBase(path, options) {
  let base = await findBase()
  try {
    return { base, response: await request(`${base}${path}`, options) }
  } catch {
    base = await findBase(true)
    return { base, response: await request(`${base}${path}`, options) }
  }
}

async function getHealth() {
  const { base, response } = await withBase('/health', { timeout: 5000 })
  if (!response.json?.ok) throw new Error(`/health 失败：${response.json?.error?.message || response.status}`)
  return { base, data: response.json.data }
}

async function getState() {
  const { base, response } = await withBase('/state', { timeout: 12_000 })
  if (!response.json?.ok) {
    throw new Error(`/state 失败：${response.json?.error?.message || `HTTP ${response.status}`}`)
  }
  return { base, data: response.json.data }
}

async function act(action, params = {}) {
  const body = { action, ...params }
  let base = await findBase()
  let response
  try {
    response = await request(`${base}/action`, { method: 'POST', body, timeout: 25_000 })
  } catch {
    base = await findBase(true)
    response = await request(`${base}/action`, { method: 'POST', body, timeout: 25_000 })
  }
  if (response.json?.ok) return { ok: true, base, data: response.json.data }
  const error = response.json?.error || { code: 'internal_error', message: `HTTP ${response.status}` }
  return { ok: false, base, status: response.status, code: error.code, error: error.message, details: error.details || null }
}

const GUIDE = [
  '杀戮尖塔2 控制指南（STS2 AI Agent，role=human，保存路径 profile2）',
  '',
  '循环：sts2_state 读状态 → 从 available_actions 里选一个动作 → sts2_act → 再读 state。一次只做一个动作；动作返回 pending 时等它变 completed。',
  '',
  '屏幕与动作：',
  '- MAIN_MENU：open_character_select；invite_ai_teammate 不要碰。',
  '- CHARACTER_SELECT：select_character {option_index}（option_index 取 character_select.characters[].index）；embark 开始；选错了 unready。',
  '- COMBAT：play_card {card_index, target_index?}（card_index 是 hand 下标；target_index 取 enemies[].index，没有就用数组下标）；end_turn；use_potion {option_index, target_index?}；discard_potion {option_index}。',
  '- MAP：choose_map_node {option_index}（取 map.available_nodes[].index）。',
  '- REWARD：claim_reward {option_index}（取 reward.rewards[].index）；卡牌奖励用 resolve_rewards {option_index} 或 {card_index}；collect_rewards_and_proceed 收完走人。',
  '- EVENT：choose_event_option {option_index}（取 event.options[].index）。',
  '- REST：choose_rest_option {option_index}（取 rest.options[].index）。',
  '- SHOP：看 shop 与 available_actions；买牌/遗物/药水用对应 buy_*，没有就 proceed。',
  '- CHEST：拿遗物看 chest 与 available_actions；拿完 proceed。',
  '- CARD_SELECTION / CARDS_VIEW：select_cards / close_cards_view；不确定就先读 available_actions。',
  '',
  '错误：',
  '409 invalid_action：当前屏幕不能用；重新读 state。409 action_in_flight：上一个动作还没完，等它返回再重试，不要连发。409 invalid_target：下标越界，重读 state。',
  '',
  '基本策略：',
  '1. 战斗先看敌人 intents 与 lethal_risks；能斩杀就斩杀，否则按格挡/伤害效率出牌。',
  '2. 能量用完再 end_turn；不要在会被打死时结束回合。',
  '3. 地图看血量和牌组：血少走休息/商店，血多再考虑精英；奖励优先补牌组短板。',
  '3.5 普通小怪可以用 sts2_autofight 一次自动打最多 N 回合（默认 8）；Boss、精英和要留药水的战斗手动打。',
  '4. 选牌围绕已有遗物和关键词，不要什么都拿；药水留给精英/Boss。',
  '',
  '每次动作前插件会检查 native_profile_id；不是 2 会拒绝，避免弄到主存档。',
].join('\n')

function compactState(view) {
  if (!view || typeof view !== 'object') return view
  const result = { ...view }
  if (result.map) {
    result.map = {
      open: result.map.open,
      current: result.map.current,
      options: result.map.options,
      boss_node: result.map.boss_node,
      route_advice: result.map.route_advice,
    }
  }
  if (result.run) {
    const run = { ...result.run }
    delete run.players
    delete run.piles
    result.run = run
  }
  if (result.combat) {
    const combat = { ...result.combat }
    delete combat.players
    result.combat = combat
  }
  return result
}

function briefState(view) {
  if (!view || typeof view !== 'object') return view
  const out = {
    screen: view.screen,
    turn: view.turn,
    actions: view.available_actions,
    run: view.run ? {
      floor: view.run.floor,
      hp: view.run.hp,
      gold: view.run.gold,
      deck: (view.run.deck || []).map((card) => card.line),
    } : null,
  }
  if (view.combat) {
    const combat = view.combat
    out.player = combat.player ? { hp: combat.player.hp, energy: combat.player.energy, block: combat.player.block } : null
    out.hand = (combat.hand || []).map((card) => ({
      i: card.i,
      line: card.line,
      cost: card.energy_cost,
      playable: card.playable,
      target: card.target,
      targets: card.targets,
    }))
    out.enemies = (combat.enemies || []).map((enemy) => ({
      i: enemy.i,
      name: enemy.name,
      hp: enemy.hp,
      block: enemy.block,
      intent: (enemy.intents || []).map((intent) => intent.label).join('/'),
      powers: (enemy.powers || []).length,
    }))
    out.threat = combat.threat ? {
      incoming: combat.threat.incoming,
      block_needed: combat.threat.block_needed,
      lethal: combat.threat.lethal,
    } : null
  }
  if (view.map?.options) out.map_options = view.map.options
  if (view.modal) out.modal = { type: view.modal.type, confirm: view.modal.confirm_label, dismiss: view.modal.dismiss_label }
  if (view.character_select) out.characters = view.character_select.characters
  if (view.reward) out.reward = view.reward
  if (view.event) out.event = view.event
  if (view.rest) out.rest = view.rest
  if (view.shop) out.shop = view.shop
  if (view.selection) out.selection = view.selection
  if (view.game_over) out.game_over = view.game_over
  return out
}

// ---- fast combat: a deliberately small heuristic, not a full AI ----

const POWER_PRIORITY = [
  'DEMON_FORM', 'PYRE', 'INFLAME', 'HELLRAISER', 'INFINITE_BLADES', 'NOXIOUS_FUMES', 'VICIOUS', 'FEEL_NO_PAIN',
  'RUPTURE', 'BARRICADE', 'JUGGERNAUT', 'COMBUST', 'DARK_EMBRACE',
  'EVOLVE', 'FIRE_BREATHING',
]

function hpNumber(text) {
  const n = Number(String(text ?? '').split('/')[0])
  return Number.isFinite(n) ? n : 0
}

function cardType(card) {
  return String(card?.type ?? card?.card_type ?? '').toLowerCase()
}

function cardCost(card) {
  const n = Number(card?.energy_cost ?? card?.cost ?? 0)
  return Number.isFinite(n) ? n : 0
}

function cardValue(card, name) {
  const values = Array.isArray(card?.values) ? card.values : []
  const hit = values.find((v) => String(v.name || '').toLowerCase() === String(name).toLowerCase())
  return Number(hit?.preview ?? hit?.current_value ?? hit?.base_value ?? 0) || 0
}

function cardBlock(card) { return cardValue(card, 'Block') }
function cardDamage(card) { return cardValue(card, 'Damage') }
function cardVuln(card) { return cardValue(card, 'VulnerablePower') }
function cardWeak(card) { return cardValue(card, 'WeakPower') }
function isAttack(card) { return cardType(card) === 'attack' }
function isPower(card) { return cardType(card) === 'power' }

function enemyHp(enemy) { return hpNumber(enemy?.hp) }

function enemyAttack(enemy) {
  const intents = Array.isArray(enemy?.intents) ? enemy.intents : []
  const total = intents.reduce((sum, item) => sum + Number(item.total_damage ?? item.damage ?? 0), 0)
  return total > 0 ? total : Number(enemy?.intent) || 0
}

function enemyHasPower(enemy, id) {
  return (enemy?.powers || []).some((p) => String(p).toUpperCase().startsWith(String(id).toUpperCase()))
}

function playerHasPower(player, id) {
  const key = String(id).toUpperCase()
  return (player?.powers || []).some((p) => {
    const text = String(p).toUpperCase()
    return text.startsWith(`${key}_POWER`) || text.startsWith(key)
  })
}

function pickBlock(hand, energy, need, hp) {
  if (need <= 0) return null
  const options = hand
    .filter((card) => cardBlock(card) > 0 && cardCost(card) <= energy)
    .filter((card) => !(String(card.card_id || '').includes('BLOOD_WALL') && hp <= 3))
    .sort((a, b) => {
      const av = cardBlock(a) / Math.max(1, cardCost(a))
      const bv = cardBlock(b) / Math.max(1, cardCost(b))
      return bv - av || cardBlock(b) - cardBlock(a)
    })
  return options[0] || null
}

function pickPower(hand, energy, player) {
  for (const id of POWER_PRIORITY) {
    const card = hand.find((c) => String(c.card_id || '').toUpperCase().startsWith(id) && cardCost(c) <= energy && !playerHasPower(player, id))
    if (card) return card
  }
  return null
}

function targetForCard(card, enemies) {
  const vs = (card?.vs || []).filter((item) => enemies.some((enemy) => enemy.i === item.enemy))
  if (vs.length) {
    if (cardVuln(card) > 0 || cardWeak(card) > 0) {
      const debuffTarget = [...enemies].sort((a, b) => enemyHp(b) - enemyHp(a) || enemyAttack(b) - enemyAttack(a))[0]
      if (debuffTarget) return debuffTarget.i
    }
    return [...vs].sort((a, b) => Number(b.damage || 0) - Number(a.damage || 0) || a.enemy - b.enemy)[0].enemy
  }
  return [...enemies].sort((a, b) => enemyAttack(b) - enemyAttack(a) || enemyHp(a) - enemyHp(b))[0]?.i ?? null
}

function chooseCard(view) {
  const combat = view?.combat || {}
  const player = combat.player || {}
  const energy = Number(player.energy || 0)
  const block = Number(player.block || 0)
  const hp = hpNumber(player.hp)
  const hpMax = Number(String(player.hp ?? '').split('/')[1]) || hp
  const lowHp = hpMax > 0 && hp <= hpMax * 0.45
  const incoming = Number(combat.threat?.incoming || 0)
  const lethal = Boolean(combat.threat?.lethal) || (incoming > 0 && incoming >= hp)
  const enemies = (combat.enemies || []).filter((enemy) => enemy.alive !== false && enemy.hittable !== false)
  const hand = (combat.hand || []).filter((card) => card.playable !== false && cardCost(card) <= energy)

  if (!hand.length || !enemies.length) return null

  // 1. Finish a kill if any card does it.
  for (const card of hand) {
    if (!isAttack(card)) continue
    const kill = (card.vs || [])
      .filter((item) => item.kills && enemies.some((enemy) => enemy.i === item.enemy))
      .sort((a, b) => Number(b.damage || 0) - Number(a.damage || 0))[0]
    if (kill) return { card_index: card.i, target_index: kill.enemy, reason: 'kill' }
  }

  // 2. Only block first when this hit is genuinely dangerous; otherwise race.
  const mustBlock = lethal || (incoming > 0 && (hp <= incoming + 6 || lowHp))
  if (mustBlock) {
    const blocker = pickBlock(hand, energy, incoming - block, hp)
    if (blocker) return { card_index: blocker.i, reason: 'block' }
  }

  // 3. Safe to invest in a power.
  const safeForPower = incoming === 0 || block >= incoming || hp > incoming + 15
  if (safeForPower) {
    const power = pickPower(hand, energy, player)
    if (power) return { card_index: power.i, reason: 'power' }
  }

  // 4. Apply vulnerable / weak on a healthy target.
  const needsDebuff = enemies.some((enemy) => !enemyHasPower(enemy, 'VULNERABLE'))
  if (needsDebuff) {
    const debuffs = hand
      .filter((card) => cardVuln(card) > 0 || cardWeak(card) > 0)
      .filter((card) => isAttack(card) || cardBlock(card) > 0)
      .sort((a, b) => {
        const av = (cardVuln(a) > 0 ? 10 : 0) + cardBlock(a) / 10 - cardCost(a)
        const bv = (cardVuln(b) > 0 ? 10 : 0) + cardBlock(b) / 10 - cardCost(b)
        return bv - av
      })
    if (debuffs[0]) return { card_index: debuffs[0].i, target_index: targetForCard(debuffs[0], enemies), reason: 'debuff' }
  }

  // 5. A lethal hit still needs cover even if a debuff was tempting.
  if (mustBlock && incoming > block) {
    const blocker = pickBlock(hand, energy, incoming - block, hp)
    if (blocker) return { card_index: blocker.i, reason: 'block' }
  }

  // 6. Highest damage per energy; X-cost AoE is credited by enemy count.
  const attacks = hand.filter(isAttack)
  if (attacks.length) {
    const scored = attacks.map((card) => {
      const vs = (card.vs || []).filter((item) => enemies.some((enemy) => enemy.i === item.enemy))
      const damage = vs.length ? Math.max(...vs.map((item) => Number(item.damage || 0))) : cardDamage(card)
      const isX = String(card.line || '').includes('[X费]')
      const cost = isX ? Math.max(1, energy) : Math.max(1, cardCost(card))
      const aoe = String(card.card_id || '').includes('WHIRLWIND') && enemies.length > 1 ? enemies.length : 1
      return { card, score: (damage * aoe) / cost }
    }).sort((a, b) => b.score - a.score)
    return { card_index: scored[0].card.i, target_index: targetForCard(scored[0].card, enemies), reason: 'attack' }
  }

  // 7. If there is nothing to attack with, use leftover energy on block.
  if (incoming > block) {
    const blocker = pickBlock(hand, energy, incoming - block, hp)
    if (blocker) return { card_index: blocker.i, reason: 'block' }
  }

  // 8. Cycle with a draw skill instead of ending the turn with unused energy.
  const drawCard = hand.find((card) =>
    /抽\d*张牌/.test(String(card.line || ''))
    && !/失去\d*点生命/.test(String(card.line || ''))
    && cardCost(card) <= energy)
  if (drawCard) return { card_index: drawCard.i, reason: 'draw' }

  return null
}

function handSelectionScore(card) {
  const line = String(card?.line || '')
  if (/毒雾|猛扑|恶魔|祭品|全知|神化/.test(line)) return 100
  if (String(card?.type || '').toLowerCase() === 'power') return 90
  if (/防御|生存者|耸肩|血墙|铁斩波/.test(line)) return 30
  if (/打击/.test(line)) return 10
  return 20
}

function pickHandSelection(view) {
  const selection = view?.selection
  if (!selection || selection.kind !== 'combat_hand_select') return null
  const cards = selection.cards || []
  if (!cards.length) return null
  const discard = /丢弃|discard/i.test(String(selection.prompt || ''))
  const sorted = [...cards].sort((a, b) => handSelectionScore(a) - handSelectionScore(b))
  return (discard ? sorted[0] : sorted[sorted.length - 1])?.i ?? null
}

async function readView() {
  const { data } = await getState()
  return { data, view: data.agent_view || data }
}

async function waitCombatReady(timeout = 12000) {
  const deadline = Date.now() + timeout
  let view = null
  while (Date.now() < deadline) {
    const current = await readView()
    view = current.view
    if (view.screen !== 'COMBAT') return view
    const actions = view.available_actions || []
    if (actions.includes('play_card') && (view.combat?.hand || []).length > 0) return view
    await sleep(250)
  }
  return view
}

async function waitNextTurn(previousTurn, timeout = 15000) {
  const deadline = Date.now() + timeout
  let view = null
  while (Date.now() < deadline) {
    const current = await readView()
    view = current.view
    if (view.screen !== 'COMBAT') return view
    const actions = view.available_actions || []
    if (view.turn !== previousTurn && actions.includes('play_card')) return view
    if (actions.includes('play_card') && (view.combat?.hand || []).length > 0) return view
    await sleep(300)
  }
  return view
}

async function autoFight({ maxTurns = 8, stopHp = 0 } = {}) {
  const initial = await getState()
  const initialData = initial.data
  if (Number(initialData.native_profile_id) !== EXPECTED_PROFILE) {
    throw new Error(`当前存档是 ${initialData.native_profile_id}，不是 ${EXPECTED_PROFILE}；拒绝自动战斗。`)
  }
  const startView = initialData.agent_view || initialData
  if (startView.screen !== 'COMBAT') throw new Error(`当前不是战斗：${startView.screen}`)
  const hpStart = hpNumber(startView.combat?.player?.hp)
  let view = startView
  let turns = 0
  let cards = 0
  let stopped = null

  for (; turns < maxTurns; turns++) {
    const ready = await waitCombatReady(12000)
    view = ready
    if (!ready || ready.screen !== 'COMBAT') break
    const currentData = await readView()
    if (Number(currentData.data.native_profile_id) !== EXPECTED_PROFILE) {
      throw new Error(`存档在战斗中被切到 ${currentData.data.native_profile_id}；停止自动战斗。`)
    }
    if (hpNumber(view.combat?.player?.hp) <= stopHp) { stopped = 'stop_hp'; break }

    let misses = 0
    for (let guard = 0; guard < 20; guard++) {
      const { view: current } = await readView()
      view = current
      if (current.screen === 'CARD_SELECTION') {
        const pick = pickHandSelection(current)
        if (pick !== null) {
          const selected = await act('select_deck_card', { option_index: pick })
          if (!selected.ok) {
            return { ok: false, turns, cards, error: selected.error || selected.code, screen: current.screen, final: briefState(current) }
          }
          continue
        }
      }
      if (current.screen !== 'COMBAT') break
      const choice = chooseCard(current)
      if (!choice) break
      const result = await act('play_card', choice.target_index === undefined
        ? { card_index: choice.card_index }
        : { card_index: choice.card_index, target_index: choice.target_index })
      if (!result.ok) {
        if (result.status === 409 && ['invalid_action', 'invalid_target', 'action_in_flight'].includes(result.code)) {
          misses++
          if (misses >= 3) break
          await sleep(500)
          continue
        }
        return { ok: false, turns, cards, error: result.error || result.code, screen: current.screen, final: briefState(current) }
      }
      cards++
    }

    const afterCards = await readView()
    view = afterCards.view
    if (view.screen !== 'COMBAT') break
    const previousTurn = view.turn
    let end = await act('end_turn', {})
    if (!end.ok && end.status === 409 && end.code === 'action_in_flight') {
      await sleep(800)
      end = await act('end_turn', {})
    }
    if (!end.ok && end.status !== 409) {
      return { ok: false, turns, cards, error: end.error || end.code, screen: view.screen, final: briefState(view) }
    }
    view = await waitNextTurn(previousTurn, 15000)
  }

  return {
    ok: true,
    turns,
    cards,
    stopped,
    screen: view?.screen,
    hp_start: hpStart,
    hp_now: hpNumber(view?.combat?.player?.hp),
    final: view ? briefState(view) : null,
  }
}

async function gameProcessRunning() {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq SlayTheSpire2.exe', '/NH'], { windowsHide: true, timeout: 5000 })
    return /SlayTheSpire2\.exe/i.test(String(stdout || ''))
  } catch {
    return false
  }
}

function modPaths(name) {
  return {
    active: join(MODS_DIR, name),
    disabled: join(MODS_DIR, `${name}.disabled`),
    backup: join(MOD_BACKUP_DIR, name),
  }
}

function modGateStatus() {
  const active = MOD_FILES.filter((name) => existsSync(join(MODS_DIR, name)))
  const disabled = MOD_FILES.filter((name) => existsSync(join(MODS_DIR, `${name}.disabled`)))
  return { mods_dir: MODS_DIR, active, disabled, enabled: active.length > 0 }
}

async function ensureModDisabled() {
  if (await gameProcessRunning()) {
    return { ok: false, reason: 'game_running', ...modGateStatus() }
  }
  mkdirSync(MOD_BACKUP_DIR, { recursive: true })
  for (const name of MOD_FILES) {
    const paths = modPaths(name)
    if (!existsSync(paths.active)) continue
    try {
      if (!existsSync(paths.backup)) copyFileSync(paths.active, paths.backup)
      renameSync(paths.active, paths.disabled)
    } catch (error) {
      return { ok: false, reason: 'rename_failed', error: String(error?.message || error), ...modGateStatus() }
    }
  }
  return { ok: true, reason: 'disabled', ...modGateStatus() }
}

async function ensureModEnabled() {
  if (await gameProcessRunning()) {
    return { ok: false, reason: 'game_running', ...modGateStatus() }
  }
  for (const name of MOD_FILES) {
    const paths = modPaths(name)
    if (existsSync(paths.disabled)) {
      try {
        renameSync(paths.disabled, paths.active)
      } catch (error) {
        return { ok: false, reason: 'rename_failed', error: String(error?.message || error), ...modGateStatus() }
      }
    }
  }
  return { ok: true, reason: 'enabled', ...modGateStatus() }
}

async function launchGame() {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', `steam://rungameid/${GAME_APP_ID}`], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {}
  for (let i = 0; i < 8; i++) {
    await sleep(750)
    if (await gameProcessRunning()) return 'steam'
  }
  if (existsSync(GAME_EXE)) {
    try {
      const child = spawn(GAME_EXE, [], { cwd: dirname(GAME_EXE), detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      for (let i = 0; i < 8; i++) {
        await sleep(750)
        if (await gameProcessRunning()) return 'exe'
      }
    } catch {}
  }
  return 'requested'
}

async function waitForAgentApi(timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const { base, data } = await getHealth()
      return { base, health: data, waited_ms: Date.now() - started }
    } catch {}
    await sleep(2000)
  }
  return null
}

export const inject = ['tools']

export function apply(ctx) {
  const outputSchema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    additionalProperties: true,
  }
  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  // 手动启动游戏时不允许 mod 自动加载；sts2_launch 真正启动前才启用。
  let modGateBusy = false
  const syncModGate = async () => {
    if (modGateBusy) return
    if (modLaunchInProgress || Date.now() < modLaunchGuardUntil) return
    modGateBusy = true
    try {
      if (!(await gameProcessRunning())) await ensureModDisabled()
    } catch {}
    finally { modGateBusy = false }
  }
  const modGateTimer = setInterval(syncModGate, 4000)
  modGateTimer.unref?.()
  ctx.effect(() => {
    void syncModGate()
    return () => clearInterval(modGateTimer)
  })

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_status',
    description: '查看杀戮尖塔2是否可控制：mod 健康、游戏版本、当前屏幕、存档 profile、可用动作。开始玩或卡住时先调它。',
    parameters: { type: 'object', properties: {} },
    output: { schema: outputSchema, render: renderJson },
    async execute() {
      try {
        const { base, data: health } = await getHealth()
        const { data: state } = await getState()
        return {
          ok: true,
          base,
          expected_profile: EXPECTED_PROFILE,
          profile: state.native_profile_id,
          screen: state.screen,
          session: state.session,
          run_id: state.run_id,
          actions: state.available_actions,
          health: {
            status: health.status,
            mod: health.mod_version,
            game: health.game_version,
            role: health.instance_role,
            play_running: health.play_running,
            compatibility_missing: health.compatibility?.reflected_members_missing ?? null,
          },
        }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_launch',
    description: '启动《杀戮尖塔2》并等待 STS2 AI Agent mod API 就绪。游戏已经开着就只等待，不会自动接管。若由这里真正启动游戏，默认同时启动 autoplay runner。',
    parameters: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '最多等待多少秒，默认 90，范围 10–180' },
        autoplay: { type: 'boolean', description: '真正启动游戏后是否同时启动 runner，默认 true；游戏已经开着时不会启动' },
      },
    },
    output: { schema: outputSchema, render: renderJson },
    async execute(args) {
      const waitSeconds = Math.min(180, Math.max(10, Number(args?.wait_seconds ?? 90) || 90))
      modLaunchInProgress = true
      modLaunchGuardUntil = Date.now() + 180_000
      try {
        const alreadyRunning = await gameProcessRunning()
        if (alreadyRunning) launchedByAgent = false
        let method = null
        let modGate = null
        if (!alreadyRunning) {
          modGate = await ensureModEnabled()
          if (!modGate.ok) {
            return {
              ok: false,
              already_running: false,
              launched: false,
              error: `STS2 AI Agent mod 无法启用：${modGate.reason || 'unknown'}`,
              mod_gate: modGate,
            }
          }
          method = await launchGame()
        }
        const started = Date.now()
        const api = await waitForAgentApi(waitSeconds * 1000)
        const runningNow = await gameProcessRunning()
        if (!alreadyRunning && !runningNow) await ensureModDisabled()
        if (!alreadyRunning && runningNow) launchedByAgent = true
        if (!api) {
          return {
            ok: false,
            already_running: alreadyRunning,
            launched: !alreadyRunning,
            method,
            mod_gate: modGate,
            game_running: runningNow,
            waited_ms: Date.now() - started,
            error: `游戏${runningNow ? '已启动' : '还没起来'}，但 mod API 在 ${waitSeconds} 秒内没有响应。`,
            hint: '看 %APPDATA%\\SlayTheSpire2\\logs\\godot.log 是否有 "Loaded 1 mods" / "Listening on http://127.0.0.1:8081/"；确认 mods\\STS2AIAgent.dll/.pck 还在。',
          }
        }
        let screen = null
        let runId = ''
        try {
          const { data } = await getState()
          screen = data.screen
          runId = String(data.run_id || '')
        } catch {}
        let autoplay = null
        if (!alreadyRunning && runningNow && args?.autoplay !== false) {
          try {
            autoplay = startRunnerProcess({ runId, maxMinutes: 0, maxRuns: 4 })
          } catch (error) {
            autoplay = { ok: false, error: String(error?.message || error) }
          }
        }
        return {
          ok: true,
          already_running: alreadyRunning,
          launched: !alreadyRunning,
          method,
          mod_gate: modGate,
          waited_ms: Date.now() - started,
          base: api.base,
          screen,
          autoplay,
          health: {
            status: api.health.status,
            mod: api.health.mod_version,
            game: api.health.game_version,
            role: api.health.instance_role,
          },
        }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      } finally {
        modLaunchInProgress = false
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_state',
    description: '读取杀戮尖塔2状态。默认返回 agent_view 紧凑视图（screen/session/available_actions/run/combat/map/reward），足够出牌；需要完整原始字段时传 full=true。每次动作后都重新读。',
    parameters: {
      type: 'object',
      properties: { full: { type: 'boolean', description: 'true 返回完整原始状态；默认紧凑视图' } },
    },
    output: { schema: outputSchema, render: renderJson },
    async execute(args) {
      try {
        const { base, data } = await getState()
        const view = args?.full ? data : (data.agent_view || data)
        const result = args?.full ? view : compactState(view)
        return { ok: true, base, full: Boolean(args?.full), ...result }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_act',
    description: [
      '对杀戮尖塔2执行一个动作。action 必须出现在 sts2_state 的 available_actions 里；params 是该动作的参数对象。',
      '常用：play_card {card_index, target_index?}；end_turn {}；choose_map_node {option_index}；claim_reward {option_index}；choose_event_option {option_index}；select_character {option_index}；embark {}。',
      '动作前会检查当前存档是否为 2，不是就拒绝。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '动作名，如 play_card / end_turn / choose_map_node' },
        params: { type: 'object', description: '动作参数对象，如 {card_index:0,target_index:0}', additionalProperties: true },
      },
      required: ['action'],
    },
    output: { schema: outputSchema, render: renderJson },
    async execute(args) {
      const action = String(args?.action || '').trim()
      if (!action) return { ok: false, error: '缺少 action' }
      const params = args?.params && typeof args.params === 'object' ? args.params : {}
      try {
        const { data: state } = await getState()
        if (Number(state.native_profile_id) !== EXPECTED_PROFILE) {
          return {
            ok: false,
            error: `当前存档是 ${state.native_profile_id}，不是 ${EXPECTED_PROFILE}；拒绝执行以免碰主存档。先切回存档 ${EXPECTED_PROFILE}。`,
          }
        }
        const result = await act(action, params)
        let final = result
        if (!result.ok && result.status === 409 && (result.code === 'action_in_flight' || (result.code === 'invalid_action' && action === 'end_turn'))) {
          await sleep(800)
          final = await act(action, params)
        }
        if (!final.ok) return final
        const data = final.data || {}
        return {
          ok: true,
          base: final.base,
          action: data.action ?? action,
          status: data.status,
          stable: data.stable,
          message: data.message,
          state: briefState(data.state?.agent_view || data.state),
        }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_brief',
    description: '紧凑状态：屏幕、可用动作、手牌/敌人意图/威胁、地图选项、奖励/事件选项。连续打很多回合时用它，省上下文。',
    parameters: { type: 'object', properties: {} },
    output: { schema: outputSchema, render: renderJson },
    async execute() {
      try {
        const { base, data } = await getState()
        return { ok: true, base, ...briefState(data.agent_view || data) }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_autofight',
    description: '快速战斗：自动打当前战斗最多 max_turns 回合（普通小怪用；Boss/精英手动）。策略：能斩杀先斩杀，扛不住先格挡，安全时开形态/上易伤，再按伤害和能量出牌。返回回合数、出牌数和最终状态。',
    parameters: {
      type: 'object',
      properties: {
        max_turns: { type: 'number', description: '最多打几个玩家回合，默认 8，范围 1–20' },
        stop_hp: { type: 'number', description: '玩家血量降到该值时停手，默认 0（不设阈值）' },
      },
    },
    output: { schema: outputSchema, render: renderJson },
    async execute(args) {
      const maxTurns = Math.min(20, Math.max(1, Number(args?.max_turns ?? 8) || 8))
      const stopHp = Math.max(0, Number(args?.stop_hp ?? 0) || 0)
      try {
        return await autoFight({ maxTurns, stopHp })
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_guide',
    description: '杀戮尖塔2的出牌/地图/奖励动作速查和基本策略。开始玩之前读一次。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { guide: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: String(value?.guide || '') }],
    },
    async execute() {
      return { guide: GUIDE }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_runner_start',
    description: '启动常驻 autoplay runner。默认只允许在她自己通过 sts2_launch 真正启动游戏后使用；用户手动开的游戏需要 force=true 才会接管。失败会自动重开，默认最多玩 4 局。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '可选，指定 run_id；默认当前局' },
        max_minutes: { type: 'number', description: '最多运行多少分钟，默认 0（不限时）' },
        max_runs: { type: 'number', description: '最多玩几局（含当前局），默认 4' },
        force: { type: 'boolean', description: '允许接管用户手动启动的游戏，默认 false' },
      },
    },
    output: { schema: outputSchema, render: renderJson },
    async execute(args) {
      try {
        if (!existsSync(RUNNER_SCRIPT)) return { ok: false, error: `runner 脚本不存在：${RUNNER_SCRIPT}` }
        const previousPid = readPid(RUNNER_STATUS)
        if (pidAlive(previousPid)) {
          const watchdog = ensureWatchdog()
          return { ok: true, already_running: true, pid: previousPid, watchdog_pid: watchdog.pid, status: RUNNER_STATUS, log: RUNNER_LOG }
        }
        if (!launchedByAgent && args?.force !== true) {
          return {
            ok: false,
            error: '这局是用户手动启动的；按约定不自动接管。确实要接管时传 force=true。',
            hint: '由她启动游戏请用 sts2_launch，它会自动启动 runner。',
          }
        }
        const { data } = await getState()
        if (Number(data.native_profile_id) !== EXPECTED_PROFILE) return { ok: false, error: `当前存档是 ${data.native_profile_id}，不是 ${EXPECTED_PROFILE}；拒绝启动 runner。` }
        const runId = String(args?.run_id || data.run_id || '')
        const maxMinutes = Math.max(0, Number(args?.max_minutes ?? 0) || 0)
        const maxRuns = Math.max(1, Number(args?.max_runs ?? 4) || 4)
        return startRunnerProcess({ runId, maxMinutes, maxRuns })
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_runner_status',
    description: '查看常驻 autoplay runner 的心跳：状态文件、当前屏幕/楼层/血量、最近日志。',
    parameters: { type: 'object', properties: {} },
    output: { schema: outputSchema, render: renderJson },
    async execute() {
      try {
        let status = null
        if (existsSync(RUNNER_STATUS)) {
          try { status = JSON.parse(readFileSync(RUNNER_STATUS, 'utf8')) } catch {}
        }
        let log = ''
        if (existsSync(RUNNER_LOG)) {
          const text = readFileSync(RUNNER_LOG, 'utf8')
          log = text.split('\n').slice(-30).join('\n')
        }
        let watchdog = null
        if (existsSync(WATCHDOG_STATUS)) {
          try { watchdog = JSON.parse(readFileSync(WATCHDOG_STATUS, 'utf8')) } catch {}
        }
        return { ok: true, status_file: RUNNER_STATUS, log_file: RUNNER_LOG, status, watchdog, log }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'sts2_runner_stop',
    description: '停止常驻 autoplay runner：写 stop 标记并结束进程。',
    parameters: { type: 'object', properties: {} },
    output: { schema: outputSchema, render: renderJson },
    async execute() {
      try {
        writeFileSync(RUNNER_STOP, String(Date.now()))
        let pid = null
        if (existsSync(RUNNER_STATUS)) {
          try { pid = JSON.parse(readFileSync(RUNNER_STATUS, 'utf8'))?.pid ?? null } catch {}
        }
        if (pid) {
          try { process.kill(pid) } catch {}
        }
        const watchdogPid = stopWatchdog()
        launchedByAgent = false
        let modGate = null
        try { modGate = await ensureModDisabled() } catch (error) { modGate = { ok: false, error: String(error?.message || error) } }
        return { ok: true, stopped: Boolean(pid), pid, watchdog_pid: watchdogPid, mod_gate: modGate, stop_file: RUNNER_STOP }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))
}

export { autoFight, getState, act, briefState, pickHandSelection, hpNumber }

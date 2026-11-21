/**
 * 常驻 autoplay runner。
 *
 * 直接调用插件暴露的 HTTP/状态函数，不经过模型回合：
 *   node autoplay.mjs --run <run_id> --max-minutes 180
 *
 * 处理：COMBAT / REWARD / MAP / EVENT / REST / SHOP / CHEST / CARD_SELECTION。
 * 只在 GAME_OVER、MAIN_MENU、存档不匹配、超时或 autoplay.stop 时退出。
 * 心跳写到 autoplay-status.json，过程写到 autoplay.log。
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autoFight, getState, act, pickHandSelection, hpNumber } from './index.js'

const DIR = dirname(fileURLToPath(import.meta.url))
const STATUS_FILE = join(DIR, 'autoplay-status.json')
const LOG_FILE = join(DIR, 'autoplay.log')
const STOP_FILE = join(DIR, 'autoplay.stop')
const startedAt = Date.now()
const pid = process.pid

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

let runId = String(arg('--run', ''))
const maxMinutes = Math.max(0, Number(arg('--max-minutes', '0')) || 0)
const maxRuns = Math.max(1, Number(arg('--max-runs', '4')) || 4)
let runsStarted = runId && runId !== 'run_unknown' ? 1 : 0
let lastCharacter = null
let characterChoice = null
let actions = 0
let fights = 0
let errors = 0
let lastAction = 'start'
let stopped = null
// 卡住检测：同一个界面状态太久没变化，就换个选项试，试完还不行就退出。
let lastScreenKey = null
let sameScreenCount = 0
let selectionTry = 0
const SAME_SCREEN_LIMIT = 40
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try { appendFileSync(LOG_FILE, `${line}\n`) } catch {}
}

function writeStatus(extra = {}) {
  const payload = {
    pid,
    run_id: runId,
    runs_started: runsStarted,
    max_runs: maxRuns,
    last_action: lastAction,
    actions,
    fights,
    updated_at: new Date().toISOString(),
    started_at: new Date(startedAt).toISOString(),
    stopped,
    ...extra,
  }
  try { writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2)) } catch {}
}

function shouldStop() {
  if (existsSync(STOP_FILE)) { stopped = 'stop_file'; return true }
  if (maxMinutes > 0 && Date.now() - startedAt > maxMinutes * 60_000) { stopped = 'max_minutes'; return true }
  return false
}

async function doAction(action, params, label) {
  const result = await act(action, params)
  actions++
  lastAction = label || action
  if (!result.ok) {
    log(`action failed ${action} ${JSON.stringify(params || {})}: ${result.code || ''} ${result.error || ''}`)
    return result
  }
  log(`${action} ${JSON.stringify(params || {})}`)
  return result
}

function rewardScore(card) {
  const type = String(card?.type || '').toLowerCase()
  const line = String(card?.line || '')
  const rarity = String(card?.rarity || '')
  let score = type === 'power' ? 100 : type === 'attack' ? 60 : 40
  if (/rare|稀有/i.test(rarity)) score += 15
  if (/诅咒|curse|伤口|wound/i.test(line)) score -= 200
  if (/中毒|poison/i.test(line)) score += 10
  return score
}

function pickRewardCard(cards) {
  if (!Array.isArray(cards) || !cards.length) return null
  return [...cards].sort((a, b) => rewardScore(b) - rewardScore(a))[0]?.i ?? null
}

async function handleReward(view) {
  const reward = view.reward || {}
  if (Array.isArray(reward.cards) && reward.cards.length) {
    const pick = pickRewardCard(reward.cards)
    if (pick !== null) return doAction('choose_reward_card', { option_index: pick }, 'reward-card')
    if ((view.available_actions || []).includes('skip_reward_cards')) return doAction('skip_reward_cards', {}, 'skip-card')
  }
  const claimable = (reward.rewards || []).find((item) => item.claimable)
  if (claimable) return doAction('claim_reward', { option_index: claimable.i }, 'claim-reward')
  if (reward.can_proceed || (view.available_actions || []).includes('collect_rewards_and_proceed')) {
    return doAction('collect_rewards_and_proceed', {}, 'leave-reward')
  }
  if ((view.available_actions || []).includes('resolve_rewards')) return doAction('resolve_rewards', {}, 'resolve-rewards')
  return null
}

function mapScore(line) {
  const text = String(line || '')
  if (/RestSite|休息/i.test(text)) return 0
  if (/Shop|商店/i.test(text)) return 1
  if (/Unknown|未知/i.test(text)) return 2
  if (/Monster|普通/i.test(text)) return 3
  if (/Elite|精英/i.test(text)) return 4
  return 5
}

async function handleMap(view) {
  const options = view.map?.options || []
  if (!options.length) return null
  const pick = [...options].sort((a, b) => mapScore(a.line) - mapScore(b.line))[0]
  return doAction('choose_map_node', { option_index: pick.i }, 'map')
}

async function handleEvent(view) {
  const options = (view.event?.options || []).filter((item) => !item.locked)
  if (!options.length) return null
  const pick = options.find((item) => item.proceed) || options[0]
  return doAction('choose_event_option', { option_index: pick.i }, 'event')
}

async function handleRest(view) {
  const options = view.rest?.options || []
  if (options.length) {
    const pick = options.find((item) => /回复|休息|治疗|恢复|heal|rest/i.test(String(item.line || '')))
      || options.find((item) => /锻造|升级|smith|upgrade/i.test(String(item.line || '')))
      || options[0]
    return doAction('choose_rest_option', { option_index: pick.i }, 'rest')
  }
  // 休息/锻造完成后 REST 界面只剩 proceed；不按会永远停在这里。
  if ((view.available_actions || []).includes('proceed')) {
    return doAction('proceed', {}, 'rest-proceed')
  }
  return null
}

async function handleShop(view) {
  if ((view.available_actions || []).includes('proceed')) return doAction('proceed', {}, 'shop-proceed')
  return null
}

async function handleChest(view) {
  const actions = view.available_actions || []
  if ((view.chest?.relics || []).length && actions.includes('choose_treasure_relic')) {
    return doAction('choose_treasure_relic', { option_index: 0 }, 'chest-relic')
  }
  if (actions.includes('open_chest')) return doAction('open_chest', {}, 'chest-open')
  if (actions.includes('proceed')) return doAction('proceed', {}, 'chest-proceed')
  return null
}

async function handleCardsView(view) {
  const actions = view.available_actions || view.actions || []
  if (actions.includes('close_cards_view')) return doAction('close_cards_view', {}, 'close-cards')
  if (actions.includes('proceed')) return doAction('proceed', {}, 'cards-proceed')
  return null
}

async function handleSelection(view) {
  const selection = view.selection
  if (!selection) return null
  const cards = selection.cards || []
  if (!cards.length) return null
  let index = null
  if (selection.kind === 'combat_hand_select') {
    index = pickHandSelection(view, selectionTry)
  } else {
    const discard = /丢弃|discard/i.test(String(selection.prompt || ''))
    const sorted = [...cards].sort((a, b) => rewardScore(a) - rewardScore(b))
    const ordered = discard ? sorted : [...sorted].reverse()
    // 选过一次界面没动，就换下一张；全试完还没动，交给外层卡住检测退出。
    index = ordered[selectionTry % ordered.length]?.i ?? null
    selectionTry++
  }
  if (index === null) return null
  const result = await doAction('select_deck_card', { option_index: index }, `select-${selection.kind}`)
  await sleep(300)
  return result
}

async function handleGameOver(view) {
  const actions = view.available_actions || view.actions || []
  if (actions.includes('continue_game_over')) return doAction('continue_game_over', {}, 'gameover-continue')
  if (actions.includes('return_to_main_menu')) return doAction('return_to_main_menu', {}, 'gameover-menu')
  return null
}

async function handleMainMenu(view) {
  const actions = view.available_actions || view.actions || []
  if (actions.includes('open_character_select')) return doAction('open_character_select', {}, 'menu-character')
  return null
}

async function handleTimeline(view) {
  const actions = view.available_actions || view.actions || []
  if (actions.includes('close_main_menu_submenu')) return doAction('close_main_menu_submenu', {}, 'timeline-close')
  return null
}

async function handleCharacterSelect(view) {
  const actions = view.available_actions || view.actions || []
  const characters = view.characters || view.character_select?.characters || []
  const unlocked = characters.filter((item) => !item.locked)
  if (!unlocked.length) return null
  if (characterChoice === null || !unlocked.some((item) => item.i === characterChoice)) {
    // 她自己在可用角色里挑；尽量不和上一局重复。
    const pool = unlocked.filter((item) => item.i !== lastCharacter)
    const source = pool.length ? pool : unlocked
    const chosen = source[Math.floor(Math.random() * source.length)]
    characterChoice = chosen.i
    log(`character choice ${chosen.line} (${chosen.i})`)
  }
  const target = characters.find((item) => item.i === characterChoice)
  const current = characters.find((item) => item.selected)
  if (actions.includes('select_character') && target && current?.i !== target.i) {
    return doAction('select_character', { option_index: target.i }, 'select-character')
  }
  if (actions.includes('embark')) {
    if (runsStarted >= maxRuns) {
      stopped = 'max_runs'
      return { stop: true }
    }
    const result = await doAction('embark', {}, 'embark')
    if (result?.ok) {
      runsStarted++
      lastCharacter = characterChoice
      characterChoice = null
    }
    return result
  }
  return null
}

async function step() {
  const { data } = await getState()
  const view = data.agent_view || data
  const expectedProfile = Number(process.env.DSH_STS2_PROFILE || 2)
  if (Number(data.native_profile_id) !== expectedProfile) {
    stopped = 'profile_mismatch'
    return { stop: true }
  }
  // 一局结束后重开时 run_id 会变；跟随当前局，而不是因此退出。
  if (data.run_id) runId = String(data.run_id)
  const summary = {
    screen: view.screen,
    floor: data.run?.floor ?? view.run?.floor ?? null,
    hp: data.run?.hp ?? view.run?.hp ?? null,
    gold: data.run?.gold ?? view.run?.gold ?? null,
  }
  writeStatus(summary)
  // 同一个界面、同楼层、同血量、同回合重复太多次 = 卡住，不能一直空转。
  const screenKey = `${view.screen}|${summary.floor ?? ''}|${summary.hp ?? ''}|${data.turn ?? ''}`
  if (screenKey === lastScreenKey) {
    sameScreenCount++
  } else {
    lastScreenKey = screenKey
    sameScreenCount = 0
    selectionTry = 0
  }
  if (sameScreenCount > 0 && sameScreenCount % 10 === 0) {
    log(`same screen ${view.screen} repeated ${sameScreenCount} times`)
  }
  if (sameScreenCount > SAME_SCREEN_LIMIT) {
    stopped = `stuck_on_${view.screen}`
    log(`stuck on ${view.screen}: ${sameScreenCount} repeats without progress, stopping`)
    return { stop: true }
  }
  if (view.screen === 'GAME_OVER') return handleGameOver(view)
  if (view.screen === 'MAIN_MENU') return handleMainMenu(view)
  if (view.screen === 'TIMELINE') return handleTimeline(view)
  if (view.screen === 'CHARACTER_SELECT') return handleCharacterSelect(view)
  if (view.screen === 'COMBAT') {
    fights++
    const result = await autoFight({ maxTurns: 8, stopHp: 0 })
    lastAction = `autofight(${result?.turns ?? '?'}t/${result?.cards ?? '?'}c)`
    log(`autofight turns=${result?.turns} cards=${result?.cards} screen=${result?.screen} hp=${result?.hp_now}`)
    return result
  }
  if (view.screen === 'REWARD') return handleReward(view)
  if (view.screen === 'MAP') return handleMap(view)
  if (view.screen === 'EVENT') return handleEvent(view)
  if (view.screen === 'REST') return handleRest(view)
  if (view.screen === 'SHOP') return handleShop(view)
  if (view.screen === 'CHEST') return handleChest(view)
  if (view.screen === 'CARD_PILE' || view.screen === 'CARDS_VIEW') return handleCardsView(view)
  if (view.screen === 'CARD_SELECTION') return handleSelection(view)
  log(`waiting on screen ${view.screen}`)
  return null
}

log(`runner start pid=${pid} run=${runId} max_minutes=${maxMinutes} max_runs=${maxRuns} runs_started=${runsStarted}`)
writeStatus({ screen: 'starting' })

while (true) {
  if (shouldStop()) break
  try {
    const result = await step()
    errors = 0
    if (result?.stop) break
  } catch (error) {
    errors++
    log(`loop error (${errors}): ${String(error?.message || error)}`)
    if (errors >= 5) { stopped = 'too_many_errors'; break }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    continue
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

writeStatus({ screen: 'stopped' })
log(`runner stop pid=${pid} reason=${stopped || 'done'} actions=${actions} fights=${fights}`)

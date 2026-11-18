import { defaultCategory, localDay, noteIdentity, nodeText, hasContent } from './notes.mjs'

function shiftedDay(now, offset) {
  const day = new Date(now)
  day.setDate(day.getDate() + offset)
  return localDay(day)
}

function dateMentions(question, now) {
  const result = []
  const matches = question.matchAll(/(?:(\d{4})\s*[年./-]\s*)?(\d{1,2})\s*[月./-]\s*(\d{1,2})(?:\s*[日号])?/g)
  for (const [, year, month, day] of matches) {
    const date = new Date(Number(year ?? now.getFullYear()), Number(month) - 1, Number(day))
    if (date.getMonth() + 1 === Number(month) && date.getDate() === Number(day)) result.push(localDay(date))
  }
  for (const [word, offset] of [['今天', 0], ['昨天', -1], ['前天', -2], ['明天', 1]]) {
    if (question.includes(word)) result.push(shiftedDay(now, offset))
  }
  return [...new Set(result)].sort()
}

export function scopedNotes(data, request, now = new Date()) {
  const question = String(request?.question ?? '').trim()
  if (!question || question.length > 4000) throw new Error('请输入 1 至 4000 字的问题')
  const categories = data.categories
  const selected = categories.find(item => item.id === request.category)?.id ?? defaultCategory
  const named = categories.filter(item => question.includes(item.name)).map(item => item.id)
  const allCategories = request.categoryScope === 'all' || (request.categoryScope !== 'current'
    && /(?:全部|所有|各个|每个|各)(?:分类|标签页?|选项卡)|跨分类/.test(question))
  const ids = allCategories ? categories.map(item => item.id) : request.categoryScope !== 'current' && named.length ? named : [selected]
  const today = localDay(now)
  const currentDay = /^\d{4}-\d{2}-\d{2}$/.test(request.date ?? '') ? request.date : today
  const dates = dateMentions(question, now)
  const relative = /(?:近|最近|过去)\s*(\d{1,3}|三|七|十|两|二|一)\s*天/.exec(question)
  const counts = { 一: 1, 二: 2, 两: 2, 三: 3, 七: 7, 十: 10 }
  let from, until, days
  const allDates = /全部日期|所有日期|全部历史|所有历史|历来|从开始到现在/.test(question)
    || (!dates.length && !relative && /(?:全部|所有)(?:的)?便签|历史(?:便签|记录)/.test(question))
  if (request.scope === 'history' || (request.scope !== 'current' && allDates)) {
    // No date filter.
  } else if (request.scope === 'current') days = [currentDay]
  else if (dates.length > 1 && /到|至|之间|[—–~～]/.test(question)) [from, until] = [dates.at(0), dates.at(-1)]
  else if (dates.length) days = dates
  else if (relative || /最近一周|过去一周|本周|上周/.test(question)) {
    const count = Math.max(1, Number(relative?.[1]) || counts[relative?.[1]] || 7)
    const weekday = (now.getDay() + 6) % 7
    if (question.includes('上周')) [from, until] = [shiftedDay(now, -weekday - 7), shiftedDay(now, -weekday - 1)]
    else [from, until] = [shiftedDay(now, question.includes('本周') ? -weekday : 1 - count), today]
  } else days = [currentDay]
  const entries = Object.entries(data.notes).map(([key, doc]) => ({ ...noteIdentity(key), doc }))
    .filter(({ date, category, doc }) => ids.includes(category) && hasContent(doc)
      && (!days || days.includes(date)) && (!from || date >= from) && (!until || date <= until))
    .sort((a, b) => a.date.localeCompare(b.date) || ids.indexOf(a.category) - ids.indexOf(b.category))
    .map(({ date, category, doc }) => ({ date, category: categories.find(item => item.id === category).name, text: nodeText(doc, true) }))
  return { question, entries, label: (days?.join('、') || (from ? from + ' 至 ' + until : '全部日期')) + ' · '
    + ids.map(id => categories.find(item => item.id === id).name).join('、') }
}

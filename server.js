// server.js
require('dotenv').config()

const { execFile } = require('child_process')
const { randomUUID } = require('crypto')
const https = require('https')
const { URL } = require('url')
const { sendEmail } = require('./mailer')
const { query, run } = require('./db')

function pad2(n) { return String(n).padStart(2, '0') }
function toMySQLDateTime(input) {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}
function nowMySQL() { return toMySQLDateTime(new Date()) }
function normStr(s) { return (s == null ? '' : String(s)).trim() }
function normFp(s) { return normStr(s).toUpperCase() }
function toMySQLFromCert(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : toMySQLDateTime(d)
}
function normalizeFetched(info) {
  return {
    is_valid: Number(info.is_valid ? 1 : 0),
    valid_from: toMySQLFromCert(info.valid_from) || null,
    valid_to: toMySQLFromCert(info.valid_to) || null,
    issuer_cn: normStr(info.issuer_cn) || null,
    subject_cn: normStr(info.subject_cn) || null,
    fingerprint256: normFp(info.fingerprint256) || null
  }
}
function normalizeDbRow(row) {
  let vf = row.valid_from, vt = row.valid_to
  if (vf && !(typeof vf === 'string')) vf = toMySQLDateTime(vf)
  if (vt && !(typeof vt === 'string')) vt = toMySQLDateTime(vt)
  return {
    is_valid: Number(row.is_valid ? 1 : 0),
    valid_from: vf || null,
    valid_to: vt || null,
    issuer_cn: normStr(row.issuer_cn) || null,
    subject_cn: normStr(row.subject_cn) || null,
    fingerprint256: normFp(row.fingerprint256) || null
  }
}

console.log('=== PassieUptimeRobot Starting ===')
console.log('Initializing database (MySQL)...')

async function migrate() {
  const dbName = process.env.DB_NAME
  const col = await query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='target_urls' AND COLUMN_NAME='ssl_days_remaining'`,
    [dbName]
  )
  if (!col.length) {
    await run('ALTER TABLE target_urls ADD COLUMN ssl_days_remaining INT NULL', [])
  }
}

function checkWithCurl(url, timeoutSeconds) {
  return new Promise(resolve => {
    const start = Date.now()
    const to = Math.max(1, Number(timeoutSeconds || 30))
    const MARK = '___CURL_HTTP_CODE___'
    execFile(
      'curl',
      ['-sS', '-L', '-A', 'PassieUptimeRobot/1.0', '--max-time', String(to), url, '-w', `\n${MARK}:%{http_code}\n`],
      { timeout: to * 1000 },
      (err, stdout, stderr) => {
        const duration = Date.now() - start
        const out = String(stdout || '')
        const errStr = String(stderr || '').trim()
        const idx = out.lastIndexOf(`\n${MARK}:`)
        let body = '', code = 0
        if (idx !== -1) {
          body = out.slice(0, idx).trim()
          const rest = out.slice(idx).split(':')[1] || '0'
          code = parseInt(rest, 10) || 0
        }
        const up = code >= 200 && code < 400
        if (err && code === 0 && !body && errStr) body = errStr
        const maxLen = 8192
        const response = up ? null : (body || null)
        resolve({ up, code, time: duration, response: response ? response.slice(0, maxLen) : null })
      }
    )
  })
}

function daysLeftFrom(validTo) {
  if (!validTo) return null
  const t = new Date(validTo).getTime()
  if (Number.isNaN(t)) return null
  const diff = t - Date.now()
  return Math.ceil(diff / 86400000)
}

function fetchSslInfo(targetUrl) {
  return new Promise(resolve => {
    let u
    try { u = new URL(targetUrl) } catch { return resolve(null) }
    if (u.protocol !== 'https:') return resolve(null)
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      method: 'GET',
      path: u.pathname === '' ? '/' : (u.pathname + (u.search || '')),
      servername: u.hostname,
      rejectUnauthorized: false,
      timeout: 10000,
      headers: { 'User-Agent': 'PassieUptimeRobot/1.0' },
      agent: false
    }, res => {
      const sock = res.socket
      const cert = sock.getPeerCertificate(true)
      const is_valid = sock.authorized ? 1 : 0
      const valid_from = cert.valid_from || null
      const valid_to = cert.valid_to || null
      const info = {
        is_valid,
        valid_from,
        valid_to,
        issuer_cn: (cert.issuer && (cert.issuer.CN || cert.issuer.commonName)) || null,
        subject_cn: (cert.subject && (cert.subject.CN || cert.subject.commonName)) || null,
        fingerprint256: cert.fingerprint256 || null,
        days_left: daysLeftFrom(valid_to)
      }
      res.resume()
      res.on('end', () => resolve(info))
    })
    req.on('timeout', () => { req.destroy(new Error('SSL timeout')) })
    req.on('error', () => resolve(null))
    req.end()
  })
}

function formatDurationSeconds(totalSeconds) {
  let s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (s || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

async function listEnabled() {
  return await query(
    'SELECT id, url, name, refresh_seconds, timeout_seconds, ssl_expiration_days, last_checked_unix FROM target_urls WHERE enabled=1 ORDER BY id',
    []
  )
}

async function upsertTarget(url, name) {
  await run('INSERT IGNORE INTO target_urls (url, name, enabled) VALUES (?, ?, 1)', [url, name])
}

async function insertStat(targetId, isUp, iso, unix, timeMs, statusCode, response) {
  const ts = toMySQLDateTime(iso)
  const res = await run(
    'INSERT INTO target_url_stats (target_url_id, is_up, checked_at, checked_at_unix, response_time_ms, status_code, response) VALUES (?,?,?,?,?,?,?)',
    [targetId, isUp ? 1 : 0, ts, unix, timeMs, statusCode, response ?? null]
  )
  return res.insertId
}

async function selectPrevStat(targetId) {
  const rows = await query('SELECT is_up FROM target_url_stats WHERE target_url_id=? ORDER BY id DESC LIMIT 1', [targetId])
  return rows[0] || null
}

async function selectLatestStatFull(targetId) {
  const rows = await query('SELECT id, is_up, checked_at_unix, response_time_ms, status_code FROM target_url_stats WHERE target_url_id=? ORDER BY id DESC LIMIT 1', [targetId])
  return rows[0] || null
}

async function selectPrevStatBefore(targetId, beforeId) {
  const rows = await query('SELECT id, is_up FROM target_url_stats WHERE target_url_id=? AND id < ? ORDER BY id DESC LIMIT 1', [targetId, beforeId])
  return rows[0] || null
}

async function selectPrevFullBefore(targetId, beforeId) {
  const rows = await query('SELECT id, is_up, checked_at_unix FROM target_url_stats WHERE target_url_id=? AND id < ? ORDER BY id DESC LIMIT 1', [targetId, beforeId])
  return rows[0] || null
}

async function markUp(targetId, iso, unix) {
  await run('UPDATE target_urls SET last_up=?, last_checked_unix=? WHERE id=?', [toMySQLDateTime(iso), unix, targetId])
}

async function markDown(targetId, iso, unix) {
  await run('UPDATE target_urls SET last_down=?, last_checked_unix=? WHERE id=?', [toMySQLDateTime(iso), unix, targetId])
}

async function markChecked(targetId, unix) {
  await run('UPDATE target_urls SET last_checked_unix=? WHERE id=?', [unix, targetId])
}

async function selectLatestSsl(targetId) {
  const rows = await query('SELECT * FROM target_url_ssl WHERE target_url_id=? ORDER BY id DESC LIMIT 1', [targetId])
  return rows[0] || null
}

async function selectLatestInvalidSsl(targetId) {
  const rows = await query('SELECT * FROM target_url_ssl WHERE target_url_id=? AND is_valid=0 ORDER BY id DESC LIMIT 1', [targetId])
  return rows[0] || null
}

async function insertSsl(targetId, info) {
  const res = await run(
    'INSERT INTO target_url_ssl (target_url_id, is_valid, valid_from, valid_to, issuer_cn, subject_cn, fingerprint256, days_left, created_at, last_checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      targetId,
      info.is_valid ? 1 : 0,
      toMySQLFromCert(info.valid_from),
      toMySQLFromCert(info.valid_to),
      normStr(info.issuer_cn) || null,
      normStr(info.subject_cn) || null,
      normFp(info.fingerprint256) || null,
      info.days_left != null ? info.days_left : null,
      nowMySQL(),
      nowMySQL()
    ]
  )
  return res.insertId
}

async function updateSslCheckedAt(id, daysLeft) {
  await run('UPDATE target_url_ssl SET last_checked_at=?, days_left=? WHERE id=?', [nowMySQL(), daysLeft, id])
}

async function updateTargetSslDaysRemaining(targetId, daysLeft) {
  await run('UPDATE target_urls SET ssl_days_remaining=? WHERE id=?', [daysLeft, targetId])
}

async function listUsersForTarget(targetId) {
  return await query(
    `SELECT u.id, u.name, u.email
     FROM target_url_user tu
     JOIN users u ON u.id = tu.user_id
     WHERE tu.target_url_id = ? AND tu.enabled = 1`,
    [targetId]
  )
}

async function insertNotification(userId, targetId, changeType, changeKey, message) {
  const res = await run(
    'INSERT IGNORE INTO notifications (user_id, target_url_id, change_type, change_key, message, created_at) VALUES (?,?,?,?,?,?)',
    [userId, targetId, changeType, changeKey, message, nowMySQL()]
  )
  return res.affectedRows
}

async function notifyUserAboutChange(target, changeType, changeKey, message, subjectOverride) {
  const users = await listUsersForTarget(target.id)
  const subject = subjectOverride || `[PassieUptimeRobot] ${target.name}`
  console.log(`notify scan site="${target.name}" users=${users.length} type=${changeType} key=${changeKey}`)
  for (const u of users) {
    try {
      const inserted = await insertNotification(u.id, target.id, changeType, changeKey, message)
      if (inserted > 0) {
        console.log(`\x1b[31mEMAIL QUEUED\x1b[0m user=${u.email} type=${changeType} key=${changeKey}`)
        sendEmail(u.email, subject, `${target.name} (${target.url})\n${message}\nKey: ${changeKey}\nTime: ${nowMySQL()}`).catch(e => {
          console.error(`email ERROR user=${u.email} -> ${e.message}`)
        })
      } else {
        console.log(`notify SKIP (duplicate) user=${u.email} type=${changeType} key=${changeKey}`)
      }
    } catch (e) {
      console.error(`notify ERROR user=${u.email} -> ${e.message}`)
    }
  }
  if (users.length === 0) {
    console.log(`notify no-linked-users site="${target.name}" type=${changeType} key=${changeKey}`)
  }
}

function maybeNotifySslExpiry(target, sslInfoOrRow) {
  if (!sslInfoOrRow) return
  const daysLeft = sslInfoOrRow.days_left
  const threshold = Number(target.ssl_expiration_days || 30)
  if (daysLeft == null) return
  if (daysLeft <= threshold && daysLeft >= 0 && Number(sslInfoOrRow.is_valid) === 1) {
    const key = `ssl_expiry:${daysLeft}`
    const msg = `SSL expires in ${daysLeft} day(s)`
    const subject = `SSL will expire in ${daysLeft} days`
    notifyUserAboutChange(target, 'ssl_expiry', key, msg, subject)
  }
}

async function backfillNotificationsForTarget(target) {
  const latest = await selectLatestStatFull(target.id)
  if (latest && Number(latest.is_up) === 0) {
    let streakStartId = latest.id
    let prev = await selectPrevStatBefore(target.id, streakStartId)
    while (prev && Number(prev.is_up) === 0) {
      streakStartId = prev.id
      prev = await selectPrevStatBefore(target.id, streakStartId)
    }
    const key = `stat:${streakStartId}`
    await notifyUserAboutChange(target, 'uptime', key, `Site is DOWN (HTTP ${latest.status_code ?? 0}, latest check)`, 'Website is DOWN')
  }
  const ssl = await selectLatestSsl(target.id)
  if (ssl && Number(ssl.is_valid) === 0) {
    const key = `ssl:${ssl.id}`
    await notifyUserAboutChange(target, 'ssl', key, `SSL INVALID: expires=${ssl.valid_to || 'n/a'}, days_left=${ssl.days_left ?? 'n/a'}`, 'SSL is EXPIRED')
  }
  if (ssl) {
    maybeNotifySslExpiry(target, ssl)
  }
}

async function maybeUpdateSsl(target, runId) {
  const label = `run=${runId} ssl site="${target.name}" url=${target.url}`
  const nowUnix = Math.floor(Date.now() / 1000)
  const raw = await fetchSslInfo(target.url)
  if (!raw) {
    await updateTargetSslDaysRemaining(target.id, null)
    return
  }
  await updateTargetSslDaysRemaining(target.id, raw.days_left)
  const latest = await selectLatestSsl(target.id)
  const cur = normalizeFetched(raw)
  if (!latest) {
    const id = await insertSsl(target.id, raw)
    const key = `ssl:${id}`
    console.log(`${label} initial SSL record saved (valid=${cur.is_valid} exp=${cur.valid_to || 'n/a'} days_left=${raw.days_left ?? 'n/a'})`)
    if (!cur.is_valid) {
      await notifyUserAboutChange(target, 'ssl', key, `SSL INVALID: expires=${cur.valid_to || 'n/a'}, days_left=${raw.days_left ?? 'n/a'}`, 'SSL is EXPIRED')
    }
    maybeNotifySslExpiry(target, raw)
  } else {
    const prev = normalizeDbRow(latest)
    const changed =
      prev.is_valid !== cur.is_valid ||
      prev.valid_from !== cur.valid_from ||
      prev.valid_to !== cur.valid_to ||
      prev.issuer_cn !== cur.issuer_cn ||
      prev.subject_cn !== cur.subject_cn ||
      prev.fingerprint256 !== cur.fingerprint256
    if (changed) {
      const id = await insertSsl(target.id, raw)
      const key = `ssl:${id}`
      console.log(`${label} SSL state changed -> new record (valid=${cur.is_valid} exp=${cur.valid_to || 'n/a'} days_left=${raw.days_left ?? 'n/a'})`)
      if (cur.is_valid) {
        const lastInvalid = await selectLatestInvalidSsl(target.id)
        let dur = null
        if (lastInvalid && lastInvalid.created_at) {
          const start = Math.floor(new Date(lastInvalid.created_at).getTime() / 1000)
          dur = nowUnix - start
        }
        const extra = dur != null ? ` It was invalid for ${formatDurationSeconds(dur)}.` : ''
        await notifyUserAboutChange(target, 'ssl', key, `SSL changed: valid=1, expires=${cur.valid_to || 'n/a'}, days_left=${raw.days_left ?? 'n/a'}.${extra}`, 'SSL is WORKING')
      } else {
        await notifyUserAboutChange(target, 'ssl', key, `SSL changed: valid=0, expires=${cur.valid_to || 'n/a'}, days_left=${raw.days_left ?? 'n/a'}`, 'SSL is EXPIRED')
      }
      maybeNotifySslExpiry(target, raw)
    } else {
      await updateSslCheckedAt(latest.id, raw.days_left)
      console.log(`${label} SSL unchanged (valid=${cur.is_valid} exp=${cur.valid_to || 'n/a'} days_left=${raw.days_left ?? 'n/a'})`)
      maybeNotifySslExpiry(target, raw)
    }
  }
}

async function findDownStreakStartUnix(targetId, latestUpStatId) {
  let prev = await selectPrevFullBefore(targetId, latestUpStatId)
  if (!prev || Number(prev.is_up) !== 0) return null
  let downStart = prev
  while (prev && Number(prev.is_up) === 0) {
    downStart = prev
    prev = await selectPrevFullBefore(targetId, prev.id)
  }
  return downStart.checked_at_unix || null
}

async function performCheck(target, runId) {
  const nowIso = new Date()
  const nowUnix = Math.floor(nowIso.getTime() / 1000)
  const label = `run=${runId} site="${target.name}" url=${target.url}`
  console.log(`${label} checking`)
  const prev = await selectPrevStat(target.id)
  const prevUp = prev ? Number(prev.is_up) : null
  await markChecked(target.id, nowUnix)
  const { up, code, time, response } = await checkWithCurl(target.url, target.timeout_seconds)
  const statId = await insertStat(target.id, up, nowIso, nowUnix, time, code, response)
  if (up) {
    console.log(`${label} UP http=${code} time=${time}ms`)
    await markUp(target.id, nowIso, nowUnix)
  } else {
    const preview = response ? ` resp=${JSON.stringify(response.slice(0, 200))}` : ''
    console.log(`${label} DOWN http=${code} time=${time}ms${preview}`)
    await markDown(target.id, nowIso, nowUnix)
  }
  const currUp = up ? 1 : 0
  if (prevUp === null) {
    if (!currUp) {
      const key = `stat:${statId}`
      await notifyUserAboutChange(target, 'uptime', key, `FIRST CHECK: Site is DOWN (HTTP ${code}, ${time}ms)`, 'Website is DOWN')
    }
  } else if (prevUp !== currUp) {
    if (currUp) {
      const startUnix = await findDownStreakStartUnix(target.id, statId)
      const dur = startUnix ? (nowUnix - startUnix) : null
      const extra = dur != null ? ` It was down for ${formatDurationSeconds(dur)}.` : ''
      const key = `stat:${statId}`
      await notifyUserAboutChange(target, 'uptime', key, `Site is UP (HTTP ${code}, ${time}ms).${extra}`, 'Website is UP')
    } else {
      const key = `stat:${statId}`
      await notifyUserAboutChange(target, 'uptime', key, `Site is DOWN (HTTP ${code}, ${time}ms)`, 'Website is DOWN')
    }
  }
  if (/^https:/i.test(target.url)) {
    await maybeUpdateSsl(target, runId)
  } else {
    await updateTargetSslDaysRemaining(target.id, null)
  }
}

async function seedFromEnv() {
  const seed = process.env.TARGET_URLS
  if (!seed) return
  const urls = seed.split(',').map(s => s.trim()).filter(Boolean)
  for (const u of urls) {
    const name = u.replace(/^https?:\/\//, '').split('/')[0] || u
    await upsertTarget(u, name)
  }
}

const inFlight = new Set()

async function schedulerTick() {
  await seedFromEnv()
  const runId = randomUUID().slice(0, 8)
  const now = Math.floor(Date.now() / 1000)
  const rows = await listEnabled()
  if (!rows.length) return
  for (const row of rows) {
    const last = row.last_checked_unix || 0
    const due = now - last >= (row.refresh_seconds || 60)
    const key = `${row.id}`
    if (due && !inFlight.has(key)) {
      inFlight.add(key)
      performCheck(row, runId).catch(err => {
        console.error(`run=${runId} site="${row.name}" err`, err && err.message ? err.message : err)
      }).finally(() => {
        inFlight.delete(key)
      })
    }
  }
}

async function main() {
  console.log('PassieUptimeRobot application starting (MySQL)...')
  await migrate()
  await seedFromEnv()
  const initialTargets = await listEnabled()
  for (const t of initialTargets) {
    await backfillNotificationsForTarget(t)
  }
  console.log('Scheduler loop: tick every 1 second; per-site refresh respected.')
  await schedulerTick()
  setInterval(schedulerTick, 1000)
}

if (require.main === module) main()

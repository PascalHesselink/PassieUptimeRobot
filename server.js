require('dotenv').config()

const Database = require('better-sqlite3')
const { execFile } = require('child_process')
const { randomUUID } = require('crypto')
const https = require('https')
const { URL } = require('url')
const { sendEmail } = require('./mailer')

console.log('=== PassieUptimeRobot Starting ===')
console.log('Initializing database...')

const db = new Database('monitor.db')
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS target_urls (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_seconds INTEGER NOT NULL DEFAULT 60,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  ssl_expiration_days INTEGER NOT NULL DEFAULT 30,
  last_checked_unix INTEGER,
  last_up TEXT,
  last_down TEXT
);
CREATE TABLE IF NOT EXISTS target_url_user (
  id INTEGER PRIMARY KEY,
  target_url_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(target_url_id, user_id),
  FOREIGN KEY(target_url_id) REFERENCES target_urls(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS target_url_stats (
  id INTEGER PRIMARY KEY,
  target_url_id INTEGER NOT NULL,
  is_up INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  checked_at_unix INTEGER,
  response_time_ms INTEGER,
  status_code INTEGER,
  response TEXT,
  FOREIGN KEY(target_url_id) REFERENCES target_urls(id)
);
CREATE TABLE IF NOT EXISTS target_url_ssl (
  id INTEGER PRIMARY KEY,
  target_url_id INTEGER NOT NULL,
  is_valid INTEGER NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  issuer_cn TEXT,
  subject_cn TEXT,
  fingerprint256 TEXT,
  days_left INTEGER,
  created_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  FOREIGN KEY(target_url_id) REFERENCES target_urls(id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  target_url_id INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  change_key TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, target_url_id, change_type, change_key),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(target_url_id) REFERENCES target_urls(id)
);
`)

function ensureColumn(table, column, type) {
    const row = db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === column)
    if (!row) {
        console.log(`Migrating: adding ${column} to ${table}...`)
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
        console.log(`Migration complete: ${table}.${column}`)
    }
}

ensureColumn('target_urls', 'name', 'TEXT NOT NULL DEFAULT ""')
ensureColumn('target_urls', 'refresh_seconds', 'INTEGER NOT NULL DEFAULT 60')
ensureColumn('target_urls', 'timeout_seconds', 'INTEGER NOT NULL DEFAULT 30')
ensureColumn('target_urls', 'ssl_expiration_days', 'INTEGER NOT NULL DEFAULT 30')
ensureColumn('target_urls', 'last_checked_unix', 'INTEGER')
ensureColumn('target_url_stats', 'response_time_ms', 'INTEGER')
ensureColumn('target_url_stats', 'checked_at_unix', 'INTEGER')
ensureColumn('target_url_stats', 'status_code', 'INTEGER')
ensureColumn('target_url_stats', 'response', 'TEXT')
ensureColumn('target_url_ssl', 'days_left', 'INTEGER')

console.log('Database ready.')

const upsertTarget = db.prepare('INSERT OR IGNORE INTO target_urls (url, name, enabled) VALUES (?, ?, 1)')
const listEnabled = db.prepare('SELECT id, url, name, refresh_seconds, timeout_seconds, ssl_expiration_days, last_checked_unix FROM target_urls WHERE enabled = 1 ORDER BY id')
const insertStat = db.prepare(`
  INSERT INTO target_url_stats (target_url_id, is_up, checked_at, checked_at_unix, response_time_ms, status_code, response)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const selectPrevStat = db.prepare('SELECT is_up FROM target_url_stats WHERE target_url_id = ? ORDER BY id DESC LIMIT 1')
const selectLatestStatFull = db.prepare('SELECT id, is_up, checked_at_unix, response_time_ms, status_code FROM target_url_stats WHERE target_url_id = ? ORDER BY id DESC LIMIT 1')
const selectPrevStatBefore = db.prepare('SELECT id, is_up FROM target_url_stats WHERE target_url_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
const selectPrevFullBefore = db.prepare('SELECT id, is_up, checked_at_unix FROM target_url_stats WHERE target_url_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
const markUp = db.prepare('UPDATE target_urls SET last_up = ?, last_checked_unix = ? WHERE id = ?')
const markDown = db.prepare('UPDATE target_urls SET last_down = ?, last_checked_unix = ? WHERE id = ?')
const markChecked = db.prepare('UPDATE target_urls SET last_checked_unix = ? WHERE id = ?')

const selectLatestSsl = db.prepare('SELECT * FROM target_url_ssl WHERE target_url_id = ? ORDER BY id DESC LIMIT 1')
const selectLatestInvalidSsl = db.prepare('SELECT * FROM target_url_ssl WHERE target_url_id = ? AND is_valid = 0 ORDER BY id DESC LIMIT 1')
const insertSsl = db.prepare(`
  INSERT INTO target_url_ssl (
    target_url_id, is_valid, valid_from, valid_to, issuer_cn, subject_cn, fingerprint256, days_left, created_at, last_checked_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)
`)
const updateSslCheckedAt = db.prepare('UPDATE target_url_ssl SET last_checked_at = ?, days_left = ? WHERE id = ?')

const listUsersForTarget = db.prepare(`
  SELECT u.id, u.name, u.email
  FROM target_url_user tu
  JOIN users u ON u.id = tu.user_id
  WHERE tu.target_url_id = ? AND tu.enabled = 1
`)
const insertNotification = db.prepare(`
  INSERT OR IGNORE INTO notifications (user_id, target_url_id, change_type, change_key, message, created_at)
  VALUES (?,?,?,?,?,?)
`)

function checkWithCurl(url, timeoutSeconds) {
    return new Promise(resolve => {
        const start = Date.now()
        const to = Math.max(1, Number(timeoutSeconds || 30))
        const MARK = '___CURL_HTTP_CODE___'
        execFile(
            'curl',
            [
                '-sS', '-L',
                '--fail-with-body',
                '-A', 'PassieUptimeRobot/1.0',
                '--max-time', String(to),
                url,
                '-w', `\n${MARK}:%{http_code}\n`
            ],
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
    const expMs = new Date(validTo).getTime()
    if (Number.isNaN(expMs)) return null
    const diff = expMs - Date.now()
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

function notifyUserAboutChange(target, changeType, changeKey, message, subjectOverride) {
    const users = listUsersForTarget.all(target.id)
    const nowIso = new Date().toISOString()
    const subject = subjectOverride || `[PassieUptimeRobot] ${target.name}`
    console.log(`notify scan site="${target.name}" users=${users.length} type=${changeType} key=${changeKey}`)
    for (const u of users) {
        try {
            const res = insertNotification.run(u.id, target.id, changeType, changeKey, message, nowIso)
            if (res.changes > 0) {
                console.log(`\x1b[31mEMAIL QUEUED\x1b[0m user=${u.email} type=${changeType} key=${changeKey}`)
                sendEmail(u.email, subject, `${target.name} (${target.url})\n${message}\nKey: ${changeKey}\nTime: ${nowIso}`).catch(e => {
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

function backfillNotificationsForTarget(target) {
    const latest = selectLatestStatFull.get(target.id)
    if (latest && Number(latest.is_up) === 0) {
        let streakStartId = latest.id
        let prev = selectPrevStatBefore.get(target.id, streakStartId)
        while (prev && Number(prev.is_up) === 0) {
            streakStartId = prev.id
            prev = selectPrevStatBefore.get(target.id, streakStartId)
        }
        const key = `stat:${streakStartId}`
        notifyUserAboutChange(
            target,
            'uptime',
            key,
            `Site is DOWN (HTTP ${latest.status_code ?? 0}, latest check)`,
            'Website is DOWN'
        )
    }
    const ssl = selectLatestSsl.get(target.id)
    if (ssl && Number(ssl.is_valid) === 0) {
        const key = `ssl:${ssl.id}`
        notifyUserAboutChange(
            target,
            'ssl',
            key,
            `SSL INVALID: expires=${ssl.valid_to || 'n/a'}, days_left=${ssl.days_left ?? 'n/a'}`,
            'SSL is EXPIRED'
        )
    }
    if (ssl) {
        maybeNotifySslExpiry(target, ssl)
    }
}

async function maybeUpdateSsl(target, runId) {
    const label = `run=${runId} ssl site="${target.name}" url=${target.url}`
    const nowIso = new Date().toISOString()
    const nowUnix = Math.floor(Date.now() / 1000)
    const info = await fetchSslInfo(target.url)
    if (!info) return
    const latest = selectLatestSsl.get(target.id)
    if (!latest) {
        const r = insertSsl.run(target.id, info.is_valid, info.valid_from, info.valid_to, info.issuer_cn, info.subject_cn, info.fingerprint256, info.days_left, nowIso, nowIso)
        const key = `ssl:${r.lastInsertRowid}`
        console.log(`${label} initial SSL record saved (valid=${info.is_valid} exp=${info.valid_to || 'n/a'} days_left=${info.days_left ?? 'n/a'})`)
        if (!info.is_valid) {
            notifyUserAboutChange(target, 'ssl', key, `SSL INVALID: expires=${info.valid_to || 'n/a'}, days_left=${info.days_left ?? 'n/a'}`, 'SSL is EXPIRED')
        }
        maybeNotifySslExpiry(target, info)
    } else {
        const changed =
            Number(latest.is_valid) !== Number(info.is_valid) ||
            String(latest.valid_from || '') !== String(info.valid_from || '') ||
            String(latest.valid_to || '') !== String(info.valid_to || '') ||
            String(latest.issuer_cn || '') !== String(info.issuer_cn || '') ||
            String(latest.subject_cn || '') !== String(info.subject_cn || '') ||
            String(latest.fingerprint256 || '') !== String(info.fingerprint256 || '')
        if (changed) {
            const r = insertSsl.run(target.id, info.is_valid, info.valid_from, info.valid_to, info.issuer_cn, info.subject_cn, info.fingerprint256, info.days_left, nowIso, nowIso)
            const key = `ssl:${r.lastInsertRowid}`
            console.log(`${label} SSL state changed -> new record (valid=${info.is_valid} exp=${info.valid_to || 'n/a'} days_left=${info.days_left ?? 'n/a'})`)
            if (info.is_valid) {
                const lastInvalid = selectLatestInvalidSsl.get(target.id)
                let dur = null
                if (lastInvalid && lastInvalid.created_at) {
                    const start = Math.floor(new Date(lastInvalid.created_at).getTime() / 1000)
                    dur = nowUnix - start
                }
                const extra = dur != null ? ` It was invalid for ${formatDurationSeconds(dur)}.` : ''
                notifyUserAboutChange(target, 'ssl', key, `SSL changed: valid=1, expires=${info.valid_to || 'n/a'}, days_left=${info.days_left ?? 'n/a'}.${extra}`, 'SSL is WORKING')
            } else {
                const subject = info.days_left != null && info.days_left <= 0 ? 'SSL is EXPIRED' : 'SSL is EXPIRED'
                notifyUserAboutChange(target, 'ssl', key, `SSL changed: valid=0, expires=${info.valid_to || 'n/a'}, days_left=${info.days_left ?? 'n/a'}`, subject)
            }
            maybeNotifySslExpiry(target, info)
        } else {
            updateSslCheckedAt.run(nowIso, info.days_left, latest.id)
            console.log(`${label} SSL unchanged (valid=${info.is_valid} exp=${info.valid_to || 'n/a'} days_left=${info.days_left ?? 'n/a'})`)
            maybeNotifySslExpiry(target, info)
        }
    }
}

function findDownStreakStartUnix(targetId, latestUpStatId) {
    let prev = selectPrevFullBefore.get(targetId, latestUpStatId)
    if (!prev || Number(prev.is_up) !== 0) return null
    let downStart = prev
    while (prev && Number(prev.is_up) === 0) {
        downStart = prev
        prev = selectPrevFullBefore.get(targetId, prev.id)
    }
    return downStart.checked_at_unix || null
}

async function performCheck(target, runId) {
    const nowIso = new Date().toISOString()
    const nowUnix = Math.floor(Date.now() / 1000)
    const label = `run=${runId} site="${target.name}" url=${target.url}`
    console.log(`${label} checking`)
    const prev = selectPrevStat.get(target.id)
    const prevUp = prev ? Number(prev.is_up) : null
    markChecked.run(nowUnix, target.id)
    const { up, code, time, response } = await checkWithCurl(target.url, target.timeout_seconds)
    const res = insertStat.run(target.id, up ? 1 : 0, nowIso, nowUnix, time, code, response)
    const statId = res.lastInsertRowid
    if (up) {
        console.log(`${label} UP http=${code} time=${time}ms`)
        markUp.run(nowIso, nowUnix, target.id)
    } else {
        const preview = response ? ` resp=${JSON.stringify(response.slice(0, 200))}` : ''
        console.log(`${label} DOWN http=${code} time=${time}ms${preview}`)
        markDown.run(nowIso, nowUnix, target.id)
    }
    const currUp = up ? 1 : 0
    if (prevUp === null) {
        if (!currUp) {
            const key = `stat:${statId}`
            notifyUserAboutChange(target, 'uptime', key, `FIRST CHECK: Site is DOWN (HTTP ${code}, ${time}ms)`, 'Website is DOWN')
        }
    } else if (prevUp !== currUp) {
        if (currUp) {
            const startUnix = findDownStreakStartUnix(target.id, statId)
            const dur = startUnix ? (nowUnix - startUnix) : null
            const extra = dur != null ? ` It was down for ${formatDurationSeconds(dur)}.` : ''
            const key = `stat:${statId}`
            notifyUserAboutChange(target, 'uptime', key, `Site is UP (HTTP ${code}, ${time}ms).${extra}`, 'Website is UP')
        } else {
            const key = `stat:${statId}`
            notifyUserAboutChange(target, 'uptime', key, `Site is DOWN (HTTP ${code}, ${time}ms)`, 'Website is DOWN')
        }
    }
    if (/^https:/i.test(target.url)) {
        await maybeUpdateSsl(target, runId)
    }
}

function seedFromEnv() {
    const seed = process.env.TARGET_URLS
    if (!seed) return
    const urls = seed.split(',').map(s => s.trim()).filter(Boolean)
    const insert = db.transaction(arr => {
        for (const u of arr) {
            const name = u.replace(/^https?:\/\//, '').split('/')[0] || u
            upsertTarget.run(u, name)
        }
    })
    insert(urls)
}

const inFlight = new Set()

function schedulerTick() {
    seedFromEnv()
    const runId = randomUUID().slice(0, 8)
    const now = Math.floor(Date.now() / 1000)
    const rows = listEnabled.all()
    if (rows.length === 0) return
    for (const row of rows) {
        backfillNotificationsForTarget(row)
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
    console.log('PassieUptimeRobot application starting...')
    seedFromEnv()
    console.log('Scheduler loop: tick every 1 second; backfills notifications; per-site refresh respected.')
    schedulerTick()
    setInterval(schedulerTick, 1_000)
}

if (require.main === module) main()

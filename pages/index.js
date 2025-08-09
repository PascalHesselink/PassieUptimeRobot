// pages/index.js
const { query } = require('../db')
const { toMySQLDateTime } = require('../lib/time')

function timeAgo(ms){
  if(ms==null) return ''
  const diff = Date.now()-ms
  if(diff<0) return 'in the future'
  const s = Math.floor(diff/1000)
  const m = Math.floor(s/60)
  const h = Math.floor(m/60)
  const d = Math.floor(h/24)
  if(d>0) return `${d}d ${h%24}h ago`
  if(h>0) return `${h}h ${m%60}m ago`
  if(m>0) return `${m}m ${s%60}s ago`
  return `${s}s ago`
}
function fmtDateCell(value){
  if(!value) return '-'
  const d = new Date(value)
  if(Number.isNaN(d.getTime())) return '-'
  return `${toMySQLDateTime(d)}<br><small>${timeAgo(d.getTime())}</small>`
}
function fmtUnixCell(unix){
  if(unix==null) return '-'
  const ms = Number(unix)*1000
  return `${toMySQLDateTime(new Date(ms))}<br><small>${timeAgo(ms)}</small>`
}
function stateLabel(isUp){
  if(isUp==null) return 'unknown'
  return Number(isUp)===1 ? 'UP' : 'DOWN'
}
function sslLabel(v){
  if(v==null) return 'unknown'
  return Number(v)===1 ? 'VALID' : 'INVALID'
}
function durationCell(startUnix){
  if(startUnix==null) return '-'
  const ms = Number(startUnix)*1000
  return `<small>${timeAgo(ms)}</small>`
}

module.exports = function(app){
  app.get('/', async (req,res) => {
    const rows = await query(
      `WITH latest_stat AS (
         SELECT s1.*
         FROM target_url_stats s1
         JOIN (
           SELECT target_url_id, MAX(id) AS max_id
           FROM target_url_stats
           GROUP BY target_url_id
         ) m ON m.target_url_id = s1.target_url_id AND s1.id = m.max_id
       ),
       latest_ssl AS (
         SELECT ts.*
         FROM target_url_ssl ts
         JOIN (
           SELECT target_url_id, MAX(id) AS max_id
           FROM target_url_ssl
           GROUP BY target_url_id
         ) ms ON ms.target_url_id = ts.target_url_id AND ts.id = ms.max_id
       )
       SELECT
         t.id, t.name, t.url, t.last_up, t.last_down, t.last_checked_unix,
         ls.is_up, ls.id AS ls_id, ls.checked_at_unix AS latest_checked_unix,
         (
           SELECT MIN(s2.checked_at_unix)
           FROM target_url_stats s2
           WHERE s2.target_url_id = t.id
             AND s2.id > COALESCE((
               SELECT MAX(s1.id)
               FROM target_url_stats s1
               WHERE s1.target_url_id = t.id
                 AND s1.id < ls.id
                 AND s1.is_up <> ls.is_up
             ), 0)
         ) AS state_since_unix,
         lssl.is_valid AS ssl_is_valid,
         lssl.days_left AS ssl_days_left,
         lssl.created_at AS ssl_last_change
       FROM target_urls t
       LEFT JOIN latest_stat ls ON ls.target_url_id = t.id
       LEFT JOIN latest_ssl lssl ON lssl.target_url_id = t.id
       WHERE t.enabled = 1
       ORDER BY t.id`, []
    )

    const rowsHtml = rows.map(r => {
      return `<tr>
        <td>${r.id}</td>
        <td>${r.name || '-'}</td>
        <td><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.url}</a></td>
        <td>${stateLabel(r.is_up)}</td>
        <td>${durationCell(r.state_since_unix)}</td>
        <td>${fmtDateCell(r.last_up)}</td>
        <td>${fmtDateCell(r.last_down)}</td>
        <td>${fmtUnixCell(r.last_checked_unix)}</td>
        <td>${sslLabel(r.ssl_is_valid)}</td>
        <td>${r.ssl_days_left == null ? '-' : `${r.ssl_days_left} days`}</td>
        <td>${fmtDateCell(r.ssl_last_change)}</td>
      </tr>`
    }).join('\n')

    res.setHeader('Content-Type','text/html; charset=utf-8')
    res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PassieUptimeRobot Stats</title>
</head>
<body>
<h1>PassieUptimeRobot Stats</h1>
<table border="1" cellspacing="0" cellpadding="6">
  <thead>
    <tr>
      <th>ID</th>
      <th>Name</th>
      <th>URL</th>
      <th>Current State</th>
      <th>State Duration</th>
      <th>Last Up</th>
      <th>Last Down</th>
      <th>Last Checked</th>
      <th>SSL State</th>
      <th>SSL Days Left</th>
      <th>Last SSL Change</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml || '<tr><td colspan="11">No targets</td></tr>'}
  </tbody>
</table>
</body>
</html>`)
  })
}

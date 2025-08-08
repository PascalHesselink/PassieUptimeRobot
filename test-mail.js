// test-mail.js
require('dotenv').config()
const readline = require('readline/promises')
const { stdin: input, stdout: output } = require('node:process')
const { sendEmail } = require('./mailer')
const { query } = require('./db')

async function main() {
  const users = await query('SELECT id, name, email FROM users ORDER BY id', [])
  if (!users.length) {
    console.log('No users found.')
    process.exit(1)
  }
  console.log('\nUsers:')
  for (const u of users) console.log(`  ${u.id}: ${u.name} <${u.email}>`)
  const rl = readline.createInterface({ input, output })
  const idInput = await rl.question('\nEnter user ID to send test email: ')
  const id = parseInt(String(idInput).trim(), 10)
  const target = users.find(u => u.id === id)
  if (!target) {
    console.log('Invalid user ID.')
    rl.close()
    process.exit(1)
  }
  const defSubject = '[PassieUptimeRobot] Test email'
  const defBody = 'This is a test email from PassieUptimeRobot.'
  const subj = await rl.question(`Subject [${defSubject}]: `)
  const body = await rl.question(`Message [${defBody}]: `)
  rl.close()
  const subject = subj.trim() ? subj : defSubject
  const text = body.trim() ? body : defBody
  await sendEmail(target.email, subject, text)
  console.log('Done.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

/**
 * Runs the hosted Supabase security advisor, preserves its raw output, then
 * applies the repository's narrow release policy.
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  ACCEPTED_SECURITY_ADVISOR_WARNING,
  evaluateSecurityAdvisorFindings,
} from '../src/cloud/securityAdvisorPolicy.mjs'

function parseAdvisorOutput(output) {
  for (let offset = output.indexOf('{'); offset >= 0; offset = output.indexOf('{', offset + 1)) {
    try {
      const parsed = JSON.parse(output.slice(offset).trim())
      if (parsed !== null && typeof parsed === 'object' && 'results' in parsed) return parsed
    } catch {
      // Supabase may print progress before the JSON document; try the next `{`.
    }
  }
  throw new Error('Supabase advisor output did not contain a valid JSON results document')
}

const command = spawnSync(
  'supabase',
  ['db', 'advisors', '--linked', '--type', 'security', '--level', 'warn'],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
)

if (command.stdout) process.stdout.write(command.stdout)
if (command.stderr) process.stderr.write(command.stderr)

if (command.error) {
  console.error(`Security advisor release gate: FAIL — advisor command could not run: ${command.error.message}`)
  process.exit(1)
}
if (command.status !== 0) {
  console.error(`Security advisor release gate: FAIL — advisor command exited ${String(command.status)}`)
  process.exit(command.status ?? 1)
}

let report
try {
  report = parseAdvisorOutput(command.stdout)
} catch (cause) {
  console.error(`Security advisor release gate: FAIL — ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exit(1)
}

const result = evaluateSecurityAdvisorFindings(report.results)
for (const finding of result.accepted) {
  console.log(
    `Accepted WARN: ${finding.name} — Supabase Free-plan pilot residual; public signup remains disabled and onboarding remains invitation-only.`,
  )
}
for (const finding of result.blocked) {
  console.error(`Blocking ${finding.level}: ${finding.name} — ${finding.reason}`)
}

if (!result.pass) {
  console.error('Security advisor release gate: FAIL')
  process.exit(1)
}

if (result.accepted.length === 0) {
  console.log('Security advisor release gate: PASS — no WARN or ERROR findings.')
} else {
  console.log(
    `Security advisor release gate: PASS — only ${ACCEPTED_SECURITY_ADVISOR_WARNING} is present as the one approved warning.`,
  )
}

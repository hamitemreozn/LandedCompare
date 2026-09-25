/**
 * Repository release policy for hosted Supabase security-advisor findings.
 *
 * The advisor remains the source of truth and its raw output is always shown.
 * This module only decides whether that output may pass the release gate.
 */

export const ACCEPTED_SECURITY_ADVISOR_WARNING = 'auth_leaked_password_protection'

/**
 * @param {unknown} findings
 * @returns {{ pass: boolean, accepted: Array<{ name: string, level: string }>, blocked: Array<{ name: string, level: string, reason: string }> }}
 */
export function evaluateSecurityAdvisorFindings(findings) {
  if (!Array.isArray(findings)) {
    return {
      pass: false,
      accepted: [],
      blocked: [{ name: '<invalid-advisor-output>', level: 'UNKNOWN', reason: 'results is not an array' }],
    }
  }

  const accepted = []
  const blocked = []

  for (const finding of findings) {
    if (finding === null || typeof finding !== 'object') {
      blocked.push({ name: '<invalid-finding>', level: 'UNKNOWN', reason: 'finding is not an object' })
      continue
    }

    const name = typeof finding.name === 'string' ? finding.name : '<missing-name>'
    const level = typeof finding.level === 'string' ? finding.level.toUpperCase() : 'UNKNOWN'

    if (level === 'WARN' && name === ACCEPTED_SECURITY_ADVISOR_WARNING) {
      accepted.push({ name, level })
    } else if (level === 'WARN') {
      blocked.push({ name, level, reason: 'warning is not an approved exception' })
    } else if (level === 'ERROR') {
      blocked.push({ name, level, reason: 'advisor error' })
    } else {
      blocked.push({ name, level, reason: 'unexpected severity or malformed finding' })
    }
  }

  if (accepted.length > 1) {
    blocked.push({
      name: ACCEPTED_SECURITY_ADVISOR_WARNING,
      level: 'WARN',
      reason: `approved warning appeared ${accepted.length} times; at most one is allowed`,
    })
  }

  return { pass: blocked.length === 0, accepted, blocked }
}
